//! Minecraft versions per server type (contract §3.6, §6.3c, 2.13.0).
//!
//! `list_mc_versions` with a `serverType` returns the Mojang list restricted
//! to the versions that type publishes builds for, so the create form never
//! offers a version the itzg image cannot install ("Version 26.1.1 does not
//! exist" from `install-purpur`). Each type's list comes from one fixed URL
//! through a client that only talks https to those six hosts, redirects
//! included. The filter never blocks creation: whenever the type's list
//! cannot be had, the unfiltered list is returned and one line is logged.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{ContainerLoader, McVersion};

/// §6.3c rule 1: the only hosts these lists may come from, redirects included.
pub const ALLOWED_HOSTS: &[&str] = &[
    "fill.papermc.io",
    "api.purpurmc.org",
    "meta.fabricmc.net",
    "meta.quiltmc.org",
    "files.minecraftforge.net",
    "maven.neoforged.net",
];
/// §6.3c rule 3: most bytes read from one answer.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 5;
/// Same idea as the Mojang manifest cache (§3.6).
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
/// The image installs NeoForge for 1.20.1 from the older `net.neoforged:forge`
/// artifact, which the `neoforge` list does not include (§3.6).
const NEOFORGE_FORGE_LIKE: &str = "1.20.1";

/// One type's list, cached per profile on `Core`.
pub struct TypeCache {
    pub fetched_at: Instant,
    pub versions: HashSet<String>,
}

/// `serverType` from the wire: absent → `None`; a `ContainerLoader` wire
/// name → that loader; anything else → `INVALID_INPUT`.
pub fn parse_server_type(server_type: Option<&str>) -> Result<Option<ContainerLoader>> {
    let Some(raw) = server_type else {
        return Ok(None);
    };
    serde_json::from_value(serde_json::Value::String(raw.trim().to_string()))
        .map(Some)
        .map_err(|_| Error::InvalidInput(format!("unknown server type: {raw}")))
}

/// The fixed URL of a type's version list (§3.6 table); `None` for vanilla.
pub fn source_url(loader: ContainerLoader) -> Option<&'static str> {
    match loader {
        ContainerLoader::Vanilla => None,
        ContainerLoader::Paper => Some("https://fill.papermc.io/v3/projects/paper"),
        ContainerLoader::Purpur => Some("https://api.purpurmc.org/v2/purpur"),
        ContainerLoader::Fabric => Some("https://meta.fabricmc.net/v2/versions/game"),
        ContainerLoader::Quilt => Some("https://meta.quiltmc.org/v3/versions/game"),
        ContainerLoader::Forge => {
            Some("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json")
        }
        ContainerLoader::Neoforge => {
            Some("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")
        }
    }
}

/// For log lines.
fn type_name(loader: ContainerLoader) -> &'static str {
    match loader {
        ContainerLoader::Vanilla => "Vanilla",
        ContainerLoader::Paper => "Paper",
        ContainerLoader::Purpur => "Purpur",
        ContainerLoader::Fabric => "Fabric",
        ContainerLoader::Quilt => "Quilt",
        ContainerLoader::Forge => "Forge",
        ContainerLoader::Neoforge => "NeoForge",
    }
}

/* ---------- the host-allowlisted client (§6.3c rules 1-2) ---------- */

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

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            if !url_allowed(attempt.url()) {
                let host = attempt.url().host_str().unwrap_or("?").to_string();
                return attempt.error(format!("redirect to a host MineUI does not trust ({host})"));
            }
            attempt.follow()
        }))
        .connect_timeout(TIMEOUT)
        .timeout(TIMEOUT)
        .user_agent(crate::modpacks::user_agent())
        .build()
        .expect("reqwest client construction cannot fail with static config")
}

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(build_client);

/// §6.3c rule 3: read at most `max` bytes of a body as UTF-8.
pub(crate) async fn read_capped(mut response: reqwest::Response, max: usize) -> Result<String> {
    if response
        .content_length()
        .is_some_and(|len| len > max as u64)
    {
        return Err(Error::DownloadFailed(format!(
            "the answer is larger than {max} bytes"
        )));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not read the answer: {e}")))?
    {
        if body.len() + chunk.len() > max {
            return Err(Error::DownloadFailed(format!(
                "the answer is larger than {max} bytes"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body)
        .map_err(|_| Error::DownloadFailed("the answer is not valid UTF-8".into()))
}

/// One GET of the type's fixed URL, parsed. `INVALID_INPUT` for vanilla
/// (it has no list), `DOWNLOAD_FAILED` for everything else that goes wrong.
pub async fn fetch_supported(loader: ContainerLoader) -> Result<HashSet<String>> {
    let Some(url) = source_url(loader) else {
        return Err(Error::InvalidInput("vanilla has no list of its own".into()));
    };
    let url = reqwest::Url::parse(url)
        .map_err(|e| Error::Internal(format!("bad version list URL: {e}")))?;
    if !url_allowed(&url) {
        return Err(Error::Internal(format!(
            "not an allowed version list URL: {url}"
        )));
    }
    let response = CLIENT
        .get(url)
        .send()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not reach the list: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "the list answered HTTP {}",
            response.status().as_u16()
        )));
    }
    let body = read_capped(response, MAX_BODY_BYTES).await?;
    parse(loader, &body).map_err(Error::DownloadFailed)
}

/* ---------- parsers (one per type, §3.6 table) ---------- */

#[derive(Deserialize)]
struct PurpurProject {
    versions: Vec<String>,
}

#[derive(Deserialize)]
struct PaperProject {
    versions: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct MetaGameVersion {
    version: String,
}

#[derive(Deserialize)]
struct ForgePromotions {
    promos: HashMap<String, String>,
}

#[derive(Deserialize)]
struct MavenVersions {
    versions: Vec<String>,
}

/// §6.3c rule 3: what an id may look like before it is compared at all.
fn plausible_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// The Minecraft version a NeoForge version is built for (§3.6), or `None`
/// for a pre-release (`-beta`, `-alpha…`, `+…`) or an entry of another shape.
/// `A.B.n` → `1.A.B` (`1.A` when B is 0); `Y.A.B.n` → `Y.A.B` (`Y.A` when B
/// is 0) - NeoForge's versioning docs and the image's own resolver agree.
pub fn neoforge_mc_version(version: &str) -> Option<String> {
    if version.contains(['-', '+']) {
        return None;
    }
    let parts: Vec<&str> = version.split('.').collect();
    if !parts
        .iter()
        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    match parts.as_slice() {
        [minor, patch, _build] => Some(if *patch == "0" {
            format!("1.{minor}")
        } else {
            format!("1.{minor}.{patch}")
        }),
        [year, minor, patch, _build] => Some(if *patch == "0" {
            format!("{year}.{minor}")
        } else {
            format!("{year}.{minor}.{patch}")
        }),
        _ => None,
    }
}

fn json<T: serde::de::DeserializeOwned>(body: &str) -> std::result::Result<T, String> {
    serde_json::from_str(body).map_err(|e| format!("an answer MineUI cannot read: {e}"))
}

/// The Minecraft versions a type's answer names. Err when the answer cannot
/// be read or names none.
pub fn parse(loader: ContainerLoader, body: &str) -> std::result::Result<HashSet<String>, String> {
    let ids: Vec<String> = match loader {
        ContainerLoader::Vanilla => return Err("vanilla has no list of its own".into()),
        ContainerLoader::Purpur => json::<PurpurProject>(body)?.versions,
        ContainerLoader::Paper => json::<PaperProject>(body)?
            .versions
            .into_values()
            .flatten()
            .collect(),
        ContainerLoader::Fabric | ContainerLoader::Quilt => json::<Vec<MetaGameVersion>>(body)?
            .into_iter()
            .map(|v| v.version)
            .collect(),
        ContainerLoader::Forge => json::<ForgePromotions>(body)?
            .promos
            .into_keys()
            .filter_map(|key| {
                key.strip_suffix("-latest")
                    .or_else(|| key.strip_suffix("-recommended"))
                    .map(str::to_string)
            })
            .collect(),
        ContainerLoader::Neoforge => {
            let mut ids: Vec<String> = json::<MavenVersions>(body)?
                .versions
                .iter()
                .filter_map(|v| neoforge_mc_version(v))
                .collect();
            if !ids.is_empty() {
                ids.push(NEOFORGE_FORGE_LIKE.to_string());
            }
            ids
        }
    };
    let set: HashSet<String> = ids.into_iter().filter(|id| plausible_id(id)).collect();
    if set.is_empty() {
        return Err("the list names no Minecraft versions".into());
    }
    Ok(set)
}

/// The Mojang list restricted to `supported`, in Mojang order.
pub fn restrict(all: &[McVersion], supported: &HashSet<String>) -> Vec<McVersion> {
    all.iter()
        .filter(|v| supported.contains(&v.id))
        .cloned()
        .collect()
}

/* ---------- list_mc_versions with serverType (§3.6) ---------- */

/// `list_mc_versions` (§3.6): without `serverType` (or vanilla) the Mojang
/// list as before; with one, that list restricted to the type's builds, or
/// the unfiltered list when the type's list cannot be had.
pub async fn list_versions(
    core: &crate::Core,
    include_snapshots: bool,
    server_type: Option<&str>,
) -> Result<Vec<McVersion>> {
    let loader = parse_server_type(server_type)?;
    list_versions_with(core, include_snapshots, loader, fetch_supported).await
}

/// `list_versions` with the fetch injected (tests).
pub(crate) async fn list_versions_with<F, Fut>(
    core: &crate::Core,
    include_snapshots: bool,
    loader: Option<ContainerLoader>,
    fetch: F,
) -> Result<Vec<McVersion>>
where
    F: FnOnce(ContainerLoader) -> Fut,
    Fut: Future<Output = Result<HashSet<String>>>,
{
    let all = crate::mojang::list_versions(core, include_snapshots).await?;
    let Some(loader) = loader.filter(|l| *l != ContainerLoader::Vanilla) else {
        return Ok(all);
    };
    let Some(supported) = supported_versions(core, loader, fetch).await else {
        return Ok(all);
    };
    let restricted = restrict(&all, &supported);
    if restricted.is_empty() {
        eprintln!(
            "mineui: the {} versions list shares no version with Mojang's; showing every Minecraft version",
            type_name(loader)
        );
        return Ok(all);
    }
    Ok(restricted)
}

/// The type's list: a fresh cache, else a fetch, else a cache of any age,
/// else `None` (logged).
async fn supported_versions<F, Fut>(
    core: &crate::Core,
    loader: ContainerLoader,
    fetch: F,
) -> Option<HashSet<String>>
where
    F: FnOnce(ContainerLoader) -> Fut,
    Fut: Future<Output = Result<HashSet<String>>>,
{
    {
        let cache = core.loader_versions_cache.lock().await;
        if let Some(cached) = cache.get(&loader) {
            if cached.fetched_at.elapsed() < CACHE_TTL {
                return Some(cached.versions.clone());
            }
        }
    }
    // The lock is not held across the request: another type's list (or the
    // same one) can be read meanwhile.
    let fetched = fetch(loader).await;
    let mut cache = core.loader_versions_cache.lock().await;
    match fetched {
        Ok(versions) => {
            cache.insert(
                loader,
                TypeCache {
                    fetched_at: Instant::now(),
                    versions: versions.clone(),
                },
            );
            Some(versions)
        }
        Err(e) => match cache.get(&loader) {
            Some(stale) => {
                eprintln!(
                    "mineui: could not refresh the {} versions list ({e}); using the one from earlier",
                    type_name(loader)
                );
                Some(stale.versions.clone())
            }
            None => {
                eprintln!(
                    "mineui: could not get the {} versions list ({e}); showing every Minecraft version",
                    type_name(loader)
                );
                None
            }
        },
    }
}

#[cfg(test)]
mod tests;
