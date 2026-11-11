//! Find mods on Modrinth (contract §3.5a, §6.3b, 2.13.0): what a server can
//! load, search filtered to it, and installs of the newest compatible version
//! with its required dependencies.
//!
//! Every request goes through one client that only talks https to
//! `api.modrinth.com` and `cdn.modrinth.com`, redirects included. Every file
//! is checked against the sha512 Modrinth publishes, all files are downloaded
//! before any is placed, and a failed placement removes what it placed.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{
    AuditSource, DownloadKind, InstalledModFile, ModClientSide, ModInstall, ModSearchHit,
    ModSearchPage, ModSupport, ModTarget, ServerPhase,
};
use crate::settings::Mode;

/// §6.3b rule 2: the only hosts Find mods may touch, redirects included.
pub const ALLOWED_HOSTS: &[&str] = &["api.modrinth.com", "cdn.modrinth.com"];
/// Where version files must live (§6.3b rule 2).
pub const CDN_HOST: &str = "cdn.modrinth.com";
const API_BASE: &str = "https://api.modrinth.com/v2";
const MAX_REDIRECTS: usize = 5;
const API_TIMEOUT: Duration = Duration::from_secs(10);

pub const DEFAULT_LIMIT: u32 = 20;
pub const MAX_LIMIT: u32 = 50;
pub const MAX_OFFSET: u32 = 10_000;
pub const MAX_QUERY_CHARS: usize = 100;
/// §3.5a step 3: most files one install may bring in.
pub const MAX_FILES: usize = 50;
/// Most hashes sent to `version_files` in one lookup.
const MAX_HASHES: usize = 1000;

/// Constant hashing scripts, zero interpolation (§3.5a installed projects).
const HASH_MODS: &str = r#"for f in /data/mods/*; do [ -f "$f" ] || continue; sha1sum "$f"; done"#;
const HASH_PLUGINS: &str =
    r#"for f in /data/plugins/*; do [ -f "$f" ] || continue; sha1sum "$f"; done"#;

/* ---------- what the server can load (§3.5a table) ---------- */

/// The facts Find mods works from, for a server that can load mods or
/// plugins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerMods {
    pub target: ModTarget,
    pub mc_version: String,
    /// Modrinth loader tags, preferred first.
    pub loaders: Vec<String>,
    /// For messages: "Fabric", "NeoForge", "Paper", ...
    pub type_name: String,
}

/// `TYPE` (lowercase) → where files go and the loader tags it accepts.
pub fn loaders_for(server_type: &str) -> Option<(ModTarget, &'static [&'static str])> {
    match server_type {
        "fabric" => Some((ModTarget::Mods, &["fabric"])),
        "quilt" => Some((ModTarget::Mods, &["quilt", "fabric"])),
        "forge" => Some((ModTarget::Mods, &["forge"])),
        "neoforge" => Some((ModTarget::Mods, &["neoforge"])),
        "paper" => Some((ModTarget::Plugins, &["paper", "spigot", "bukkit"])),
        "purpur" => Some((ModTarget::Plugins, &["purpur", "paper", "spigot", "bukkit"])),
        _ => None,
    }
}

fn type_name(server_type: &str) -> String {
    match server_type {
        "fabric" => "Fabric".into(),
        "quilt" => "Quilt".into(),
        "forge" => "Forge".into(),
        "neoforge" => "NeoForge".into(),
        "paper" => "Paper".into(),
        "purpur" => "Purpur".into(),
        "vanilla" => "Vanilla".into(),
        other => other.to_ascii_uppercase(),
    }
}

/// §3.5a: support from what the server is. `simple` = a server on this
/// computer (always the vanilla jar today).
pub fn support_for(
    simple: bool,
    server_type: Option<&str>,
    mc_version: Option<&str>,
) -> ModSupport {
    let server_type = server_type.map(|t| t.trim().to_ascii_lowercase());
    let mc_version = mc_version
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("latest"))
        .map(str::to_string);
    let not = |reason: String| ModSupport {
        supported: false,
        target: None,
        server_type: server_type.clone(),
        mc_version: mc_version.clone(),
        loaders: Vec::new(),
        reason: Some(reason),
    };
    if simple {
        return not(
            "This server runs plain Minecraft on this computer, which cannot load mods or \
             plugins. A server in a container can."
                .into(),
        );
    }
    let Some(kind) = server_type.as_deref() else {
        return not("MineUI cannot tell what type of server this container runs.".into());
    };
    let Some((target, loaders)) = loaders_for(kind) else {
        return not(match kind {
            "vanilla" => {
                "This server runs plain Minecraft (Vanilla), which cannot load mods or plugins."
                    .into()
            }
            "modrinth" | "auto_curseforge" => "This server runs a modpack. The pack decides its \
                 mods, and MineUI cannot tell which mod loader it uses."
                .into(),
            other => format!(
                "MineUI cannot add mods to a {} server.",
                other.to_ascii_uppercase()
            ),
        });
    };
    if mc_version.is_none() {
        return not(
            "MineUI cannot tell which Minecraft version this server runs, so it cannot pick \
             mods that fit."
                .into(),
        );
    }
    ModSupport {
        supported: true,
        target: Some(target),
        server_type: server_type.clone(),
        mc_version: mc_version.clone(),
        loaders: loaders.iter().map(|l| l.to_string()).collect(),
        reason: None,
    }
}

/// `get_mod_support` (§3.5a): no network.
pub async fn support(core: &crate::Core) -> Result<ModSupport> {
    let settings = core.settings().await;
    if settings.active_mode == Mode::Simple {
        return Ok(support_for(
            true,
            Some("vanilla"),
            Some(settings.simple.mc_version.as_str()),
        ));
    }
    let (phase, identity) = crate::identity::probe(core).await;
    if phase? == ServerPhase::NotCreated {
        return Err(Error::ContainerNotFound(format!(
            "container '{}' does not exist",
            settings.advanced.container_name
        )));
    }
    Ok(support_for(
        false,
        identity.loader.as_deref(),
        identity.mc_version.as_deref(),
    ))
}

/// The server's facts, or `WRONG_MODE` with the reason it cannot load any.
pub fn server_mods(support: &ModSupport) -> Result<ServerMods> {
    match (support.supported, support.target, &support.mc_version) {
        (true, Some(target), Some(mc_version)) => Ok(ServerMods {
            target,
            mc_version: mc_version.clone(),
            loaders: support.loaders.clone(),
            type_name: type_name(support.server_type.as_deref().unwrap_or("")),
        }),
        _ => Err(Error::WrongMode(support.reason.clone().unwrap_or_else(
            || "This server cannot load mods or plugins.".into(),
        ))),
    }
}

/* ---------- the host-allowlisted client (§6.3b rule 2) ---------- */

/// https, no credentials, default port, allowlisted host.
pub fn url_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|h| ALLOWED_HOSTS.iter().any(|a| a.eq_ignore_ascii_case(h)))
}

/// Every redirect hop must pass `url_allowed` too.
fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        if !url_allowed(attempt.url()) {
            let host = attempt.url().host_str().unwrap_or("?").to_string();
            return attempt.error(format!("redirect to a host MineUI does not trust ({host})"));
        }
        attempt.follow()
    })
}

/// The client every Modrinth request and file goes through.
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(redirect_policy())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .user_agent(crate::modpacks::user_agent())
        .build()
        .expect("reqwest client construction cannot fail with static config")
}

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(build_client);

/// §6.3b rule 1: a project or version id / slug before it becomes a path
/// segment.
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn api_url(segments: &[&str]) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(API_BASE)
        .map_err(|e| Error::Internal(format!("bad Modrinth URL: {e}")))?;
    url.path_segments_mut()
        .map_err(|_| Error::Internal("bad Modrinth URL".into()))?
        .extend(segments);
    Ok(url)
}

/// GET (or POST with a JSON body) one API URL. `Ok(None)` = 404.
async fn api_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: reqwest::Url,
    body: Option<&serde_json::Value>,
    what: &str,
) -> Result<Option<T>> {
    if !url_allowed(&url) {
        return Err(Error::Internal(format!("not a Modrinth API URL: {url}")));
    }
    let request = match body {
        Some(body) => client.post(url).json(body),
        None => client.get(url),
    };
    let response = request
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not reach Modrinth: {e}")))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "Modrinth answered HTTP {} when asked for {what}",
            response.status().as_u16()
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not read Modrinth's answer: {e}")))?;
    serde_json::from_str(&text).map(Some).map_err(|e| {
        Error::DownloadFailed(format!(
            "Modrinth sent an answer MineUI cannot read ({what}): {e}"
        ))
    })
}

/* ---------- Modrinth's shapes ---------- */

#[derive(Debug, Clone, Deserialize)]
pub struct Version {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub version_number: String,
    #[serde(default)]
    pub version_type: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub date_published: String,
    #[serde(default)]
    pub game_versions: Vec<String>,
    #[serde(default)]
    pub loaders: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
    #[serde(default)]
    pub files: Vec<VersionFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Dependency {
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    pub dependency_type: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VersionFile {
    #[serde(default)]
    pub hashes: Hashes,
    pub url: String,
    pub filename: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Hashes {
    #[serde(default)]
    pub sha512: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
}

/// Parse a `/project/<id>/version` body.
pub fn parse_versions(body: &str) -> Result<Vec<Version>> {
    serde_json::from_str(body).map_err(|e| {
        Error::DownloadFailed(format!("Modrinth sent versions MineUI cannot read: {e}"))
    })
}

/* ---------- version choice (§3.5a step 2) ---------- */

/// The primary file: the one marked primary, else the first.
pub fn primary_file(version: &Version) -> Option<&VersionFile> {
    version
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| version.files.first())
}

fn is_jar(file: &VersionFile) -> bool {
    file.filename.to_ascii_lowercase().ends_with(".jar")
}

fn type_rank(version_type: &str) -> u8 {
    match version_type {
        "release" => 0,
        "beta" => 1,
        "alpha" => 2,
        _ => 3,
    }
}

/// Position of the version's best loader in the server's preference list.
fn loader_rank(version: &Version, loaders: &[String]) -> Option<usize> {
    loaders
        .iter()
        .position(|l| version.loaders.iter().any(|v| v.eq_ignore_ascii_case(l)))
}

fn published(version: &Version) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&version.date_published)
        .map(|d| d.timestamp_micros())
        .unwrap_or(i64::MIN)
}

/// Best version for this Minecraft version and these loaders: release over
/// beta over alpha, then the preferred loader, then the newest.
pub fn choose_version<'a>(
    versions: &'a [Version],
    mc_version: &str,
    loaders: &[String],
) -> Option<&'a Version> {
    versions
        .iter()
        .filter(|v| matches!(v.status.as_deref(), None | Some("listed")))
        .filter(|v| v.game_versions.iter().any(|g| g == mc_version))
        .filter(|v| primary_file(v).is_some_and(is_jar))
        .filter_map(|v| loader_rank(v, loaders).map(|rank| (v, rank)))
        .min_by(|(a, rank_a), (b, rank_b)| {
            type_rank(&a.version_type)
                .cmp(&type_rank(&b.version_type))
                .then(rank_a.cmp(rank_b))
                .then_with(|| published(b).cmp(&published(a)))
        })
        .map(|(v, _)| v)
}

/* ---------- what is installed (§3.5a installed projects) ---------- */

/// Files already in the target folder.
#[derive(Debug, Clone, Default)]
pub struct InstalledIndex {
    /// Lowercased name of every file in the folder.
    pub filenames: HashSet<String>,
    /// Project id → a file of that project in the folder.
    pub projects: HashMap<String, String>,
}

impl InstalledIndex {
    pub fn has_file(&self, name: &str) -> bool {
        self.filenames.contains(&name.to_ascii_lowercase())
    }
}

/// `version_files` answers for one set of hashes.
#[derive(Debug, Clone)]
pub struct HashCache {
    hashes: Vec<String>,
    projects: HashMap<String, String>,
}

/// `sha1sum` lines (`<40 hex>  <root>/<name>`) → (sha1, name).
pub fn parse_sha1sum(stdout: &str, root: &str) -> Vec<(String, String)> {
    let prefix = format!("{root}/");
    stdout
        .lines()
        .filter_map(|line| {
            let (hash, rest) = line.split_once(char::is_whitespace)?;
            if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            let path = rest.trim_start_matches([' ', '*']);
            let name = path.strip_prefix(&prefix)?;
            (!name.is_empty() && !name.contains('/'))
                .then(|| (hash.to_ascii_lowercase(), name.to_string()))
        })
        .collect()
}

fn sha1_of_file(path: &Path) -> std::io::Result<String> {
    use sha1::{Digest, Sha1};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// (sha1, filename) of every file in the target folder.
async fn file_hashes(core: &crate::Core, target: ModTarget) -> Result<Vec<(String, String)>> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let script = match target {
                ModTarget::Mods => HASH_MODS,
                ModTarget::Plugins => HASH_PLUGINS,
            };
            let out = crate::runtime::run_in_container(
                runtime.as_ref(),
                &settings.advanced.container_name,
                &["sh", "-c", script],
            )
            .await?;
            if !out.success() {
                return Err(Error::Io(format!(
                    "could not read the files in {}: {}",
                    crate::mods::container_root(target),
                    out.stderr.trim()
                )));
            }
            Ok(parse_sha1sum(
                &out.stdout,
                crate::mods::container_root(target),
            ))
        }
        Mode::Simple => {
            let dir = settings.simple.instance_dir.join(target.dir_name());
            tokio::task::spawn_blocking(move || {
                let mut found = Vec::new();
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    return found;
                };
                for entry in entries.flatten() {
                    if !entry.file_type().is_ok_and(|t| t.is_file()) {
                        continue;
                    }
                    if let Ok(hash) = sha1_of_file(&entry.path()) {
                        found.push((hash, entry.file_name().to_string_lossy().to_string()));
                    }
                }
                found
            })
            .await
            .map_err(|e| Error::Internal(format!("hashing task failed: {e}")))
        }
    }
}

#[derive(Debug, Deserialize)]
struct VersionProject {
    project_id: String,
}

/// Hash → project id, from `POST /v2/version_files` (cached per hash set).
async fn projects_for_hashes(
    core: &crate::Core,
    client: &reqwest::Client,
    hashes: &[String],
) -> Result<HashMap<String, String>> {
    let mut key: Vec<String> = hashes.to_vec();
    key.sort();
    if let Some(cache) = core.modrinth_hashes.lock().unwrap().as_ref() {
        if cache.hashes == key {
            return Ok(cache.projects.clone());
        }
    }
    let body = serde_json::json!({ "hashes": key, "algorithm": "sha1" });
    let answer: HashMap<String, VersionProject> = api_json(
        client,
        api_url(&["version_files"])?,
        Some(&body),
        "the installed files",
    )
    .await?
    .unwrap_or_default();
    let projects: HashMap<String, String> = answer
        .into_iter()
        .map(|(hash, v)| (hash.to_ascii_lowercase(), v.project_id))
        .collect();
    *core.modrinth_hashes.lock().unwrap() = Some(HashCache {
        hashes: key,
        projects: projects.clone(),
    });
    Ok(projects)
}

/// What is already in the target folder, by name and by Modrinth project.
pub async fn installed_index(
    core: &crate::Core,
    client: &reqwest::Client,
    target: ModTarget,
) -> Result<InstalledIndex> {
    let files = file_hashes(core, target).await?;
    let mut index = InstalledIndex::default();
    for (_, name) in &files {
        index.filenames.insert(name.to_ascii_lowercase());
    }
    let hashes: Vec<String> = files
        .iter()
        .take(MAX_HASHES)
        .map(|(h, _)| h.clone())
        .collect();
    if hashes.is_empty() {
        return Ok(index);
    }
    let projects = projects_for_hashes(core, client, &hashes).await?;
    for (hash, name) in &files {
        if let Some(project) = projects.get(hash) {
            index
                .projects
                .entry(project.clone())
                .or_insert_with(|| name.clone());
        }
    }
    Ok(index)
}

/* ---------- search (§3.5a search_mods) ---------- */

/// The search facets for this server (inner arrays OR, outer AND).
pub fn facets(server: &ServerMods) -> String {
    let project_type = match server.target {
        ModTarget::Mods => "project_type:mod",
        ModTarget::Plugins => "project_type:plugin",
    };
    let loaders: Vec<String> = server
        .loaders
        .iter()
        .map(|l| format!("categories:{l}"))
        .collect();
    serde_json::json!([
        [project_type],
        loaders,
        [format!("versions:{}", server.mc_version)],
        ["server_side:required", "server_side:optional"],
    ])
    .to_string()
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    hits: Vec<RawHit>,
    #[serde(default)]
    total_hits: u64,
}

#[derive(Debug, Deserialize)]
struct RawHit {
    project_id: String,
    #[serde(default)]
    slug: Option<String>,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    client_side: String,
    #[serde(default)]
    server_side: String,
}

fn client_side(value: &str) -> ModClientSide {
    match value {
        "required" => ModClientSide::Required,
        "optional" => ModClientSide::Optional,
        "unsupported" => ModClientSide::Unsupported,
        _ => ModClientSide::Unknown,
    }
}

/// Parse a `/v2/search` body; client-only hits are dropped.
pub fn parse_search(body: &str, offset: u32, limit: u32) -> Result<ModSearchPage> {
    let parsed: SearchResponse = serde_json::from_str(body)
        .map_err(|e| Error::DownloadFailed(format!("unexpected Modrinth response: {e}")))?;
    let hits = parsed
        .hits
        .into_iter()
        .filter(|h| h.server_side != "unsupported")
        .map(|h| ModSearchHit {
            slug: h.slug.unwrap_or_else(|| h.project_id.clone()),
            project_id: h.project_id,
            title: h.title,
            description: h.description,
            author: h.author,
            icon_url: h.icon_url.filter(|u| !u.is_empty()),
            downloads: h.downloads,
            client_side: client_side(&h.client_side),
            installed: false,
        })
        .collect();
    Ok(ModSearchPage {
        hits,
        offset,
        limit,
        total_hits: parsed.total_hits,
    })
}

/// One search request (no installed flags).
pub async fn search_page(
    client: &reqwest::Client,
    server: &ServerMods,
    query: &str,
    offset: u32,
    limit: u32,
) -> Result<ModSearchPage> {
    let index = if query.is_empty() {
        "downloads"
    } else {
        "relevance"
    };
    let mut url = api_url(&["search"])?;
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("facets", &facets(server))
        .append_pair("index", index)
        .append_pair("offset", &offset.to_string())
        .append_pair("limit", &limit.to_string());
    let response = client
        .get(url)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not reach Modrinth: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "Modrinth search returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not read Modrinth's response: {e}")))?;
    parse_search(&body, offset, limit)
}

/// `search_mods` (§3.5a).
pub async fn search(
    core: &crate::Core,
    query: &str,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<ModSearchPage> {
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(Error::InvalidInput(format!(
            "search text must be at most {MAX_QUERY_CHARS} characters"
        )));
    }
    let server = server_mods(&support(core).await?)?;
    let offset = offset.unwrap_or(0).min(MAX_OFFSET);
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let client = CLIENT.clone();
    let (page, installed) = tokio::join!(
        search_page(&client, &server, query, offset, limit),
        installed_index(core, &client, server.target)
    );
    let mut page = page?;
    // The installed flags are a nicety: a failed lookup leaves them false.
    if let Ok(installed) = installed {
        for hit in &mut page.hits {
            hit.installed = installed.projects.contains_key(&hit.project_id);
        }
    }
    Ok(page)
}

/* ---------- dependency resolution (§3.5a step 3) ---------- */

/// The calls the resolver makes; `Ok(None)` = Modrinth has no such thing.
#[async_trait]
pub trait VersionSource: Send + Sync {
    async fn project_versions(
        &self,
        project: &str,
        loaders: &[String],
        mc_version: &str,
    ) -> Result<Option<Vec<Version>>>;
    async fn version(&self, id: &str) -> Result<Option<Version>>;
    /// A project's title, for messages (best effort).
    async fn title(&self, project: &str) -> Option<String>;
}

/// The real Modrinth API.
pub struct LiveSource {
    pub client: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct ProjectInfo {
    id: String,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    title: String,
}

#[async_trait]
impl VersionSource for LiveSource {
    async fn project_versions(
        &self,
        project: &str,
        loaders: &[String],
        mc_version: &str,
    ) -> Result<Option<Vec<Version>>> {
        let mut url = api_url(&["project", project, "version"])?;
        url.query_pairs_mut()
            .append_pair("loaders", &serde_json::json!(loaders).to_string())
            .append_pair(
                "game_versions",
                &serde_json::json!([mc_version]).to_string(),
            )
            .append_pair("include_changelog", "false");
        api_json(&self.client, url, None, "a mod's versions").await
    }

    async fn version(&self, id: &str) -> Result<Option<Version>> {
        api_json(&self.client, api_url(&["version", id])?, None, "a version").await
    }

    async fn title(&self, project: &str) -> Option<String> {
        let url = api_url(&["project", project]).ok()?;
        let info: ProjectInfo = api_json(&self.client, url, None, "a project")
            .await
            .ok()??;
        Some(info.title).filter(|t| !t.is_empty())
    }
}

/// One file the install will place.
#[derive(Debug, Clone)]
pub struct PlannedFile {
    pub project_id: String,
    pub version_id: String,
    pub version_number: String,
    pub filename: String,
    pub url: reqwest::Url,
    pub sha512: String,
    pub sha1: Option<String>,
    pub size: u64,
    /// The project id that needed it; None for the one asked for.
    pub needed_by: Option<String>,
}

impl PlannedFile {
    pub fn dependency(&self) -> bool {
        self.needed_by.is_some()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    /// The project asked for first, then its dependencies (breadth first).
    pub files: Vec<PlannedFile>,
    /// Project ids of required dependencies that are already installed.
    pub already_installed: Vec<String>,
}

enum Want {
    Project(String),
    Version(String),
}

struct Item {
    want: Want,
    needed_by: Option<String>,
}

async fn name_of(source: &dyn VersionSource, project: &str) -> String {
    source
        .title(project)
        .await
        .unwrap_or_else(|| project.to_string())
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Turn a chosen version into a `PlannedFile` (§6.3b rules 2, 4, 5). Errors
/// do not name the mod; the caller puts its name in front (`about`).
fn plan_file(version: &Version, needed_by: Option<String>) -> Result<PlannedFile> {
    let no_jar = || Error::InvalidInput("it has no .jar file to install".into());
    let file = primary_file(version)
        .filter(|f| is_jar(f))
        .ok_or_else(no_jar)?;
    let filename = crate::validate::mod_filename(&file.filename, true)?;
    if !filename.to_ascii_lowercase().ends_with(".jar") {
        return Err(no_jar());
    }
    let url = reqwest::Url::parse(&file.url)
        .ok()
        .filter(|u| url_allowed(u) && u.host_str() == Some(CDN_HOST))
        .ok_or_else(|| {
            Error::DownloadFailed(format!(
                "the file is not on {CDN_HOST}, so MineUI will not download it"
            ))
        })?;
    let sha512 = file
        .hashes
        .sha512
        .as_deref()
        .map(str::to_ascii_lowercase)
        .filter(|h| is_hex(h, 128))
        .ok_or_else(|| {
            Error::DownloadFailed(
                "Modrinth gives no sha512 checksum for the file, so MineUI cannot check it".into(),
            )
        })?;
    let sha1 = file
        .hashes
        .sha1
        .as_deref()
        .map(str::to_ascii_lowercase)
        .filter(|h| is_hex(h, 40));
    if file.size > crate::mods::MOD_MAX_BYTES {
        return Err(Error::FileTooLarge(format!(
            "the file is {} bytes; the limit is {}",
            file.size,
            crate::mods::MOD_MAX_BYTES
        )));
    }
    Ok(PlannedFile {
        project_id: version.project_id.clone(),
        version_id: version.id.clone(),
        version_number: version.version_number.clone(),
        filename,
        url,
        sha512,
        sha1,
        size: file.size,
        needed_by,
    })
}

/// §3.5a steps 2-4: the files one install needs, breadth first.
pub async fn plan_install(
    source: &dyn VersionSource,
    server: &ServerMods,
    project: &str,
    installed: &InstalledIndex,
) -> Result<Plan> {
    if !valid_id(project) {
        return Err(Error::InvalidInput(format!(
            "not a Modrinth project id: {project}"
        )));
    }
    let on = format!("Minecraft {} on {}", server.mc_version, server.type_name);
    let mut queue = VecDeque::from([Item {
        want: Want::Project(project.to_string()),
        needed_by: None,
    }]);
    let mut visited: HashSet<String> = HashSet::new();
    let mut seen_versions: HashSet<String> = HashSet::new();
    let mut plan = Plan::default();

    while let Some(item) = queue.pop_front() {
        let is_root = item.needed_by.is_none();
        let version = match &item.want {
            Want::Project(id) => {
                if visited.contains(id) {
                    continue;
                }
                if !is_root && installed.projects.contains_key(id) {
                    visited.insert(id.clone());
                    plan.already_installed.push(id.clone());
                    continue;
                }
                let Some(versions) = source
                    .project_versions(id, &server.loaders, &server.mc_version)
                    .await?
                else {
                    return Err(Error::InvalidInput(match &item.needed_by {
                        None => format!("Modrinth has no project called {id}"),
                        Some(p) => format!(
                            "{} needs a project Modrinth does not have ({id})",
                            name_of(source, p).await
                        ),
                    }));
                };
                match choose_version(&versions, &server.mc_version, &server.loaders) {
                    Some(v) => v.clone(),
                    None => {
                        let name = name_of(source, id).await;
                        return Err(Error::InvalidInput(match &item.needed_by {
                            None => format!("{name} has no version for {on}"),
                            Some(p) => format!(
                                "{} needs {name}, which has no version for {on}",
                                name_of(source, p).await
                            ),
                        }));
                    }
                }
            }
            Want::Version(vid) => {
                if !seen_versions.insert(vid.clone()) {
                    continue;
                }
                let p = match &item.needed_by {
                    Some(p) => name_of(source, p).await,
                    None => String::new(),
                };
                let Some(v) = source.version(vid).await? else {
                    return Err(Error::InvalidInput(format!(
                        "{p} needs a version of another mod that Modrinth does not have ({vid})"
                    )));
                };
                if loader_rank(&v, &server.loaders).is_none() {
                    let name = name_of(source, &v.project_id).await;
                    return Err(Error::InvalidInput(format!(
                        "{p} needs {name} {}, which is not made for {}",
                        v.version_number, server.type_name
                    )));
                }
                v
            }
        };

        let pid = version.project_id.clone();
        if !valid_id(&pid) || !valid_id(&version.id) {
            return Err(Error::DownloadFailed(
                "Modrinth sent an id MineUI cannot use".into(),
            ));
        }
        if !visited.insert(pid.clone()) {
            continue;
        }
        if is_root {
            if let Some(file) = installed.projects.get(&pid) {
                return Err(Error::InvalidInput(format!(
                    "{} is already installed ({file})",
                    name_of(source, &pid).await
                )));
            }
        } else if installed.projects.contains_key(&pid) {
            plan.already_installed.push(pid);
            continue;
        }
        let file = match plan_file(&version, item.needed_by.clone()) {
            Ok(file) => file,
            Err(err) => return Err(about(err, &name_of(source, &pid).await)),
        };
        if installed.has_file(&file.filename) {
            if is_root {
                return Err(Error::InvalidInput(format!(
                    "there is already a file named {} in the {} folder",
                    file.filename,
                    server.target.dir_name()
                )));
            }
            plan.already_installed.push(pid);
            continue;
        }
        if plan
            .files
            .iter()
            .any(|f| f.filename.eq_ignore_ascii_case(&file.filename))
        {
            return Err(Error::InvalidInput(format!(
                "two of the files to install are both named {}",
                file.filename
            )));
        }

        for dep in version
            .dependencies
            .iter()
            .filter(|d| d.dependency_type == "required")
        {
            let want = match (&dep.version_id, &dep.project_id) {
                (Some(vid), _) if valid_id(vid) => Want::Version(vid.clone()),
                (None, Some(dep_pid)) if valid_id(dep_pid) => Want::Project(dep_pid.clone()),
                (Some(_), _) | (None, Some(_)) => {
                    return Err(Error::DownloadFailed(
                        "Modrinth sent an id MineUI cannot use".into(),
                    ))
                }
                (None, None) => {
                    return Err(Error::InvalidInput(format!(
                        "{} needs {}, which is not on Modrinth, so MineUI cannot install it",
                        name_of(source, &pid).await,
                        dep.file_name.as_deref().unwrap_or("a file")
                    )))
                }
            };
            queue.push_back(Item {
                want,
                needed_by: Some(pid.clone()),
            });
        }
        plan.files.push(file);
        if plan.files.len() > MAX_FILES {
            let root = name_of(source, &plan.files[0].project_id).await;
            return Err(Error::InvalidInput(format!(
                "{root} needs more than {MAX_FILES} files, more than MineUI installs at once"
            )));
        }
    }
    Ok(plan)
}

/* ---------- download, stage, place (§3.5a steps 5-6) ---------- */

/// The same error with the mod's name in front.
fn about(err: Error, name: &str) -> Error {
    match err {
        Error::DownloadFailed(m) => Error::DownloadFailed(format!("{name}: {m}")),
        Error::ChecksumMismatch(m) => Error::ChecksumMismatch(format!("{name}: {m}")),
        Error::FileTooLarge(m) => Error::FileTooLarge(format!("{name}: {m}")),
        Error::Io(m) => Error::Io(format!("{name}: {m}")),
        Error::InvalidInput(m) => Error::InvalidInput(format!("{name}: {m}")),
        other => other,
    }
}

/// Download every planned file to a temp file, each checked against its
/// sha512 (and sha1). On any failure every temp file is removed. Returns
/// (temp path, download id) per file, in order.
pub async fn download_plan(
    core: &crate::Core,
    client: &reqwest::Client,
    files: &[PlannedFile],
    names: &HashMap<String, String>,
) -> Result<Vec<(PathBuf, String)>> {
    let mut done: Vec<(PathBuf, String)> = Vec::new();
    for file in files {
        let download_id = uuid::Uuid::new_v4().to_string();
        let request = crate::download::DownloadRequest {
            url: file.url.clone(),
            kind: DownloadKind::Mod,
            filename: file.filename.clone(),
            download_id: download_id.clone(),
            max_bytes: Some(crate::mods::MOD_MAX_BYTES),
            expected_sha1: file.sha1.clone(),
            expected_sha256: None,
            expected_sha512: Some(file.sha512.clone()),
            client: Some(client.clone()),
            allow_private_hosts: false,
        };
        match crate::download::to_temp_file(core, &request).await {
            Ok(result) => done.push((result.temp_path, download_id)),
            Err(err) => {
                for (path, _) in &done {
                    let _ = tokio::fs::remove_file(path).await;
                }
                let name = names
                    .get(&file.project_id)
                    .map(String::as_str)
                    .unwrap_or(&file.filename);
                return Err(about(err, name));
            }
        }
    }
    Ok(done)
}

/// Remove files this install placed (never one that was there before: name
/// collisions were refused while planning).
async fn remove_placed(core: &crate::Core, target: ModTarget, names: &[String]) {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let Ok(runtime) = crate::runtime::resolve(&settings.advanced).await else {
                return;
            };
            let root = crate::mods::container_root(target);
            let paths: Vec<String> = names.iter().map(|n| format!("{root}/{n}")).collect();
            let mut argv: Vec<&str> = vec!["rm", "-f", "--"];
            argv.extend(paths.iter().map(String::as_str));
            let _ = crate::runtime::run_in_container(
                runtime.as_ref(),
                &settings.advanced.container_name,
                &argv,
            )
            .await;
        }
        Mode::Simple => {
            let dir = settings.simple.instance_dir.join(target.dir_name());
            for name in names {
                let _ = tokio::fs::remove_file(dir.join(name)).await;
            }
        }
    }
}

/// Move the downloads into a staging folder under their final names and
/// place them all; on failure remove what was placed. The staging folder and
/// temp files are always removed.
pub async fn stage_and_place(
    core: &crate::Core,
    target: ModTarget,
    files: &[PlannedFile],
    temps: &[(PathBuf, String)],
) -> Result<()> {
    let staging = core
        .paths
        .data_dir
        .join("tmp")
        .join(format!("modrinth-{}", uuid::Uuid::new_v4().simple()));
    let names: Vec<String> = files.iter().map(|f| f.filename.clone()).collect();
    let result = async {
        tokio::fs::create_dir_all(&staging)
            .await
            .map_err(|e| Error::Io(format!("could not create a staging folder: {e}")))?;
        for (file, (temp, _)) in files.iter().zip(temps) {
            tokio::fs::rename(temp, staging.join(&file.filename))
                .await
                .map_err(|e| Error::Io(format!("could not stage {}: {e}", file.filename)))?;
        }
        if let Err(err) = crate::mod_archive::place_dir(core, &staging, target, &names).await {
            remove_placed(core, target, &names).await;
            return Err(err);
        }
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    for (temp, _) in temps {
        let _ = tokio::fs::remove_file(temp).await;
    }
    result
}

/* ---------- install_mod (§3.5a) ---------- */

#[derive(Debug, Clone)]
struct Named {
    slug: String,
    title: String,
}

/// Slugs and titles of several projects in one call (best effort).
async fn project_names(client: &reqwest::Client, ids: &[String]) -> HashMap<String, Named> {
    if ids.is_empty() {
        return HashMap::new();
    }
    let Ok(mut url) = api_url(&["projects"]) else {
        return HashMap::new();
    };
    url.query_pairs_mut()
        .append_pair("ids", &serde_json::json!(ids).to_string());
    let answer: Option<Vec<ProjectInfo>> = api_json(client, url, None, "project names")
        .await
        .ok()
        .flatten();
    answer
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let slug = p.slug.unwrap_or_else(|| p.id.clone());
            let title = if p.title.is_empty() {
                slug.clone()
            } else {
                p.title
            };
            (p.id, Named { slug, title })
        })
        .collect()
}

async fn install_inner(core: &crate::Core, project: &str) -> Result<ModInstall> {
    let project = project.trim();
    if !valid_id(project) {
        return Err(Error::InvalidInput(format!(
            "not a Modrinth project id: {project}"
        )));
    }
    let server = server_mods(&support(core).await?)?;
    let client = CLIENT.clone();
    let installed = installed_index(core, &client, server.target).await?;
    let source = LiveSource {
        client: client.clone(),
    };
    let plan = plan_install(&source, &server, project, &installed).await?;

    let ids: Vec<String> = plan
        .files
        .iter()
        .map(|f| f.project_id.clone())
        .chain(plan.already_installed.iter().cloned())
        .collect();
    let names = project_names(&client, &ids).await;
    let named = |id: &str| {
        names.get(id).cloned().unwrap_or_else(|| Named {
            slug: id.to_string(),
            title: id.to_string(),
        })
    };
    let titles: HashMap<String, String> =
        ids.iter().map(|id| (id.clone(), named(id).title)).collect();

    let temps = download_plan(core, &client, &plan.files, &titles).await?;
    stage_and_place(core, server.target, &plan.files, &temps).await?;

    let mut result = ModInstall {
        target: server.target,
        installed: Vec::new(),
        already_installed: plan
            .already_installed
            .iter()
            .map(|id| named(id).title)
            .collect(),
    };
    for (file, (_, download_id)) in plan.files.iter().zip(&temps) {
        let n = named(&file.project_id);
        let mut detail = format!(
            "{}: {} {}",
            crate::mods::target_label(server.target),
            n.slug,
            file.version_number
        );
        if let Some(parent) = &file.needed_by {
            detail.push_str(&format!(", needed by {}", named(parent).slug));
        }
        crate::audit::record(
            core,
            AuditSource::User,
            "mod.install",
            Some(&file.filename),
            Some(&detail),
            None,
        )
        .await;
        result.installed.push(InstalledModFile {
            filename: file.filename.clone(),
            project_id: file.project_id.clone(),
            slug: n.slug,
            title: n.title,
            version_id: file.version_id.clone(),
            version_number: file.version_number.clone(),
            dependency: file.dependency(),
            download_id: download_id.clone(),
        });
    }
    Ok(result)
}

/// `install_mod` (§3.5a): audited as `mod.install` per placed file, or one
/// failed entry.
pub async fn install(core: &crate::Core, project_id: &str) -> Result<ModInstall> {
    let r = install_inner(core, project_id).await;
    if let Err(err) = &r {
        crate::audit::record(
            core,
            AuditSource::User,
            "mod.install",
            Some(project_id),
            None,
            Some(err),
        )
        .await;
    }
    r
}

#[cfg(test)]
mod tests;
