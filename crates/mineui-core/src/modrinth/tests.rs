//! Unit tests for Find mods (§3.5a, §6.3b). Network-free: Modrinth answers
//! come from recorded fixtures (`tests/fixtures/modrinth-*.json`, fetched
//! 2026-11-10) or are built here; downloads come from a local socket.

use super::*;

const SEARCH_FIXTURE: &str =
    include_str!("../../tests/fixtures/modrinth-search-chunky-fabric-1.21.1.json");
const CHUNKY_VERSIONS: &str =
    include_str!("../../tests/fixtures/modrinth-versions-chunky-fabric-1.21.1.json");
const FABRIC_API_VERSIONS: &str =
    include_str!("../../tests/fixtures/modrinth-versions-fabric-api-1.21.1.json");
const VERSION_FILES: &str = include_str!("../../tests/fixtures/modrinth-version-files-sha1.json");

const CHUNKY: &str = "fALzjamp";
const FABRIC_API: &str = "P7dR8mSH";

fn fabric() -> ServerMods {
    server_mods(&support_for(false, Some("fabric"), Some("1.21.1"))).unwrap()
}

/* ---------- a scripted Modrinth ---------- */

#[derive(Default)]
struct FakeSource {
    /// Project id or slug → its versions (already "filtered" by Modrinth).
    projects: HashMap<String, Vec<Version>>,
    versions: HashMap<String, Version>,
    titles: HashMap<String, String>,
    calls: std::sync::Mutex<Vec<String>>,
}

impl FakeSource {
    fn with(mut self, project: &str, title: &str, versions: Vec<Version>) -> Self {
        for v in &versions {
            self.versions.insert(v.id.clone(), v.clone());
        }
        self.projects.insert(project.into(), versions);
        self.titles.insert(project.into(), title.into());
        self
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl VersionSource for FakeSource {
    async fn project_versions(
        &self,
        project: &str,
        _loaders: &[String],
        _mc_version: &str,
    ) -> Result<Option<Vec<Version>>> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("project {project}"));
        Ok(self.projects.get(project).cloned())
    }
    async fn version(&self, id: &str) -> Result<Option<Version>> {
        self.calls.lock().unwrap().push(format!("version {id}"));
        Ok(self.versions.get(id).cloned())
    }
    async fn title(&self, project: &str) -> Option<String> {
        self.titles.get(project).cloned()
    }
}

fn dep(project: Option<&str>, version: Option<&str>, kind: &str) -> Dependency {
    Dependency {
        version_id: version.map(str::to_string),
        project_id: project.map(str::to_string),
        file_name: None,
        dependency_type: kind.into(),
    }
}

fn required(project: &str) -> Dependency {
    dep(Some(project), None, "required")
}

/// A version with one primary jar on the CDN.
fn ver(id: &str, project: &str, kind: &str, date: &str, deps: Vec<Dependency>) -> Version {
    Version {
        id: id.into(),
        project_id: project.into(),
        version_number: format!("{id}-number"),
        version_type: kind.into(),
        status: Some("listed".into()),
        date_published: date.into(),
        game_versions: vec!["1.21.1".into()],
        loaders: vec!["fabric".into()],
        dependencies: deps,
        files: vec![VersionFile {
            hashes: Hashes {
                sha512: Some("a".repeat(128)),
                sha1: None,
            },
            url: format!(
                "https://cdn.modrinth.com/data/{project}/versions/{id}/{project}-{id}.jar"
            ),
            filename: format!("{project}-{id}.jar"),
            primary: true,
            size: 10,
        }],
    }
}

const D1: &str = "2025-01-01T00:00:00Z";
const D2: &str = "2025-06-01T00:00:00Z";
const D3: &str = "2026-01-01T00:00:00Z";

/* ---------- §3.5a table ---------- */

#[test]
fn loader_tags_per_server_type() {
    let mods = ModTarget::Mods;
    let plugins = ModTarget::Plugins;
    for (kind, target, loaders) in [
        ("FABRIC", mods, vec!["fabric"]),
        ("quilt", mods, vec!["quilt", "fabric"]),
        ("Forge", mods, vec!["forge"]),
        ("NEOFORGE", mods, vec!["neoforge"]),
        ("PAPER", plugins, vec!["paper", "spigot", "bukkit"]),
        (
            "PURPUR",
            plugins,
            vec!["purpur", "paper", "spigot", "bukkit"],
        ),
    ] {
        let s = support_for(false, Some(kind), Some("1.21.1"));
        assert!(s.supported, "{kind}");
        assert_eq!(s.target, Some(target), "{kind}");
        assert_eq!(s.loaders, loaders, "{kind}");
        assert_eq!(s.server_type.as_deref(), Some(kind.to_lowercase().as_str()));
        assert_eq!(s.mc_version.as_deref(), Some("1.21.1"));
        assert!(s.reason.is_none());
    }
}

#[test]
fn servers_that_cannot_load_mods_say_why() {
    for (simple, kind, version, says) in [
        (true, Some("vanilla"), Some("1.21.1"), "on this computer"),
        (false, Some("VANILLA"), Some("1.21.1"), "Vanilla"),
        (false, Some("MODRINTH"), Some("1.21.1"), "modpack"),
        (false, Some("AUTO_CURSEFORGE"), None, "modpack"),
        (false, Some("SPIGOT"), Some("1.21.1"), "SPIGOT"),
        (false, None, Some("1.21.1"), "what type"),
        (false, Some("FABRIC"), None, "which Minecraft version"),
        (
            false,
            Some("FABRIC"),
            Some("LATEST"),
            "which Minecraft version",
        ),
    ] {
        let s = support_for(simple, kind, version);
        assert!(!s.supported, "{kind:?}");
        assert!(s.target.is_none() && s.loaders.is_empty());
        let reason = s.reason.clone().unwrap();
        assert!(reason.contains(says), "{kind:?}: {reason}");
        let err = server_mods(&s).unwrap_err();
        assert_eq!(err.code(), "WRONG_MODE");
        assert_eq!(err.to_string(), reason);
    }
}

#[test]
fn support_serializes_camel_case() {
    let v = serde_json::to_value(support_for(false, Some("PAPER"), Some("1.21.4"))).unwrap();
    assert_eq!(v["target"], "plugins");
    assert_eq!(v["serverType"], "paper");
    assert_eq!(v["mcVersion"], "1.21.4");
    assert!(v["reason"].is_null());
}

#[tokio::test]
async fn a_server_on_this_computer_is_not_supported_and_needs_no_network() {
    let tmp = tempfile::tempdir().unwrap();
    let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let s = support(&core).await.unwrap();
    assert!(!s.supported);
    assert_eq!(s.server_type.as_deref(), Some("vanilla"));
    assert_eq!(
        search(&core, "sodium", None, None)
            .await
            .unwrap_err()
            .code(),
        "WRONG_MODE"
    );
    assert_eq!(
        install(&core, "sodium").await.unwrap_err().code(),
        "WRONG_MODE"
    );
    // Input checks come first.
    let long = "x".repeat(MAX_QUERY_CHARS + 1);
    assert_eq!(
        search(&core, &long, None, None).await.unwrap_err().code(),
        "INVALID_INPUT"
    );
    assert_eq!(
        install(&core, "../etc").await.unwrap_err().code(),
        "INVALID_INPUT"
    );
    let log = crate::audit::recent(&core, Some(5)).await.unwrap();
    assert!(log
        .entries
        .iter()
        .any(|e| e.action == "mod.install" && !e.ok));
}

/* ---------- search ---------- */

#[test]
fn facets_per_target() {
    let f: serde_json::Value = serde_json::from_str(&facets(&fabric())).unwrap();
    assert_eq!(
        f,
        serde_json::json!([
            ["project_type:mod"],
            ["categories:fabric"],
            ["versions:1.21.1"],
            ["server_side:required", "server_side:optional"]
        ])
    );
    let quilt = server_mods(&support_for(false, Some("quilt"), Some("1.20.1"))).unwrap();
    let f: serde_json::Value = serde_json::from_str(&facets(&quilt)).unwrap();
    assert_eq!(
        f[1],
        serde_json::json!(["categories:quilt", "categories:fabric"])
    );
    assert_eq!(f[2], serde_json::json!(["versions:1.20.1"]));
    let purpur = server_mods(&support_for(false, Some("purpur"), Some("1.21.4"))).unwrap();
    let f: serde_json::Value = serde_json::from_str(&facets(&purpur)).unwrap();
    assert_eq!(f[0], serde_json::json!(["project_type:plugin"]));
    assert_eq!(
        f[1],
        serde_json::json!([
            "categories:purpur",
            "categories:paper",
            "categories:spigot",
            "categories:bukkit"
        ])
    );
}

#[test]
fn parses_a_real_search_page() {
    let page = parse_search(SEARCH_FIXTURE, 0, 3).unwrap();
    assert_eq!(page.total_hits, 5);
    assert_eq!((page.offset, page.limit), (0, 3));
    let slugs: Vec<&str> = page.hits.iter().map(|h| h.slug.as_str()).collect();
    assert_eq!(slugs, ["chunky", "chunkyborder", "chunky-offline"]);
    let chunky = &page.hits[0];
    assert_eq!(chunky.project_id, CHUNKY);
    assert_eq!(chunky.title, "Chunky");
    assert_eq!(chunky.author, "pop4959");
    assert_eq!(chunky.client_side, ModClientSide::Optional);
    assert!(chunky.icon_url.is_some() && chunky.downloads > 0);
    assert!(!chunky.installed);
    let v = serde_json::to_value(chunky).unwrap();
    assert_eq!(v["projectId"], CHUNKY);
    assert_eq!(v["clientSide"], "optional");
}

#[test]
fn search_drops_client_only_hits_and_rejects_garbage() {
    let body = r#"{"hits":[
        {"project_id":"aaaa","slug":"a","title":"A","server_side":"unsupported","client_side":"required"},
        {"project_id":"bbbb","title":"B","server_side":"optional","client_side":"required","icon_url":""}
    ],"offset":0,"limit":2,"total_hits":2}"#;
    let page = parse_search(body, 0, 2).unwrap();
    assert_eq!(page.hits.len(), 1);
    let b = &page.hits[0];
    assert_eq!(b.slug, "bbbb", "a missing slug falls back to the id");
    assert_eq!(b.client_side, ModClientSide::Required);
    assert!(b.icon_url.is_none());
    assert_eq!(
        parse_search("<html>rate limited</html>", 0, 1)
            .unwrap_err()
            .code(),
        "DOWNLOAD_FAILED"
    );
}

#[test]
fn sha1sum_lines() {
    let out = "6c8098fc0f124c7b6492de60db0108747f7f9821  /data/mods/Chunky-Fabric-1.4.23.jar\n\
584D303F646287EE6BE059ECB2FC451255BE9EE9  /data/mods/fabric api+1.jar.disabled\n\
\\0123  /data/mods/escaped\n\
garbage\n\
6c8098fc0f124c7b6492de60db0108747f7f9821  /data/plugins/x.jar\n\
6c8098fc0f124c7b6492de60db0108747f7f9821  /data/mods/sub/x.jar\n";
    let parsed = parse_sha1sum(out, "/data/mods");
    assert_eq!(
        parsed,
        vec![
            (
                "6c8098fc0f124c7b6492de60db0108747f7f9821".to_string(),
                "Chunky-Fabric-1.4.23.jar".to_string()
            ),
            (
                "584d303f646287ee6be059ecb2fc451255be9ee9".to_string(),
                "fabric api+1.jar.disabled".to_string()
            ),
        ]
    );
}

#[test]
fn version_files_fixture_maps_hashes_to_projects() {
    let answer: HashMap<String, VersionProject> = serde_json::from_str(VERSION_FILES).unwrap();
    assert_eq!(
        answer["6c8098fc0f124c7b6492de60db0108747f7f9821"].project_id,
        CHUNKY
    );
    assert_eq!(
        answer["584d303f646287ee6be059ecb2fc451255be9ee9"].project_id,
        FABRIC_API
    );
    assert_eq!(answer.len(), 2, "an unknown hash is simply absent");
}

/* ---------- version choice ---------- */

#[test]
fn chooses_newest_release_from_real_versions() {
    let chunky = parse_versions(CHUNKY_VERSIONS).unwrap();
    let v = choose_version(&chunky, "1.21.1", &fabric().loaders).unwrap();
    assert_eq!(v.version_number, "1.4.23");
    let api = parse_versions(FABRIC_API_VERSIONS).unwrap();
    let v = choose_version(&api, "1.21.1", &fabric().loaders).unwrap();
    assert_eq!(v.version_number, "0.116.18+1.21.1");
    assert!(choose_version(&api, "1.20.1", &fabric().loaders).is_none());
    let forge = vec!["forge".to_string()];
    assert!(choose_version(&api, "1.21.1", &forge).is_none());
}

#[test]
fn release_beats_beta_beats_alpha_then_newest() {
    let loaders = fabric().loaders;
    let versions = vec![
        ver("alpha-new", "p", "alpha", D3, vec![]),
        ver("beta-new", "p", "beta", D3, vec![]),
        ver("release-old", "p", "release", D1, vec![]),
        ver("release-mid", "p", "release", D2, vec![]),
    ];
    assert_eq!(
        choose_version(&versions, "1.21.1", &loaders).unwrap().id,
        "release-mid"
    );
    assert_eq!(
        choose_version(&versions[..2], "1.21.1", &loaders)
            .unwrap()
            .id,
        "beta-new"
    );
    assert_eq!(
        choose_version(&versions[..1], "1.21.1", &loaders)
            .unwrap()
            .id,
        "alpha-new"
    );
}

#[test]
fn incompatible_versions_are_ignored() {
    let loaders = fabric().loaders;
    let mut wrong_mc = ver("wrong-mc", "p", "release", D3, vec![]);
    wrong_mc.game_versions = vec!["1.21".into()];
    let mut wrong_loader = ver("wrong-loader", "p", "release", D3, vec![]);
    wrong_loader.loaders = vec!["forge".into()];
    let mut not_jar = ver("not-jar", "p", "release", D3, vec![]);
    not_jar.files[0].filename = "pack.zip".into();
    let mut draft = ver("draft", "p", "release", D3, vec![]);
    draft.status = Some("draft".into());
    let ok = ver("ok", "p", "beta", D1, vec![]);
    let all = vec![wrong_mc, wrong_loader, not_jar, draft, ok];
    assert_eq!(choose_version(&all, "1.21.1", &loaders).unwrap().id, "ok");
    assert!(choose_version(&all[..4], "1.21.1", &loaders).is_none());
}

#[test]
fn preferred_loader_wins_among_releases() {
    let quilt = server_mods(&support_for(false, Some("quilt"), Some("1.21.1"))).unwrap();
    let fabric_build = ver("fabric-build", "p", "release", D3, vec![]);
    let mut quilt_build = ver("quilt-build", "p", "release", D1, vec![]);
    quilt_build.loaders = vec!["quilt".into()];
    let all = vec![fabric_build.clone(), quilt_build];
    assert_eq!(
        choose_version(&all, "1.21.1", &quilt.loaders).unwrap().id,
        "quilt-build"
    );
    // A Quilt server still takes a Fabric-only mod.
    assert_eq!(
        choose_version(&[fabric_build], "1.21.1", &quilt.loaders)
            .unwrap()
            .id,
        "fabric-build"
    );
}

/* ---------- dependency resolution ---------- */

#[tokio::test]
async fn real_chunky_needs_fabric_api() {
    let source = FakeSource::default()
        .with("chunky", "Chunky", parse_versions(CHUNKY_VERSIONS).unwrap())
        .with(
            FABRIC_API,
            "Fabric API",
            parse_versions(FABRIC_API_VERSIONS).unwrap(),
        );
    let plan = plan_install(&source, &fabric(), "chunky", &InstalledIndex::default())
        .await
        .unwrap();
    let files: Vec<(&str, bool)> = plan
        .files
        .iter()
        .map(|f| (f.filename.as_str(), f.dependency()))
        .collect();
    assert_eq!(
        files,
        [
            ("Chunky-Fabric-1.4.23.jar", false),
            ("fabric-api-0.116.18+1.21.1.jar", true)
        ]
    );
    let chunky = &plan.files[0];
    assert_eq!(chunky.project_id, CHUNKY);
    assert_eq!(chunky.url.host_str(), Some("cdn.modrinth.com"));
    assert_eq!(chunky.sha512.len(), 128);
    assert_eq!(
        chunky.sha1.as_deref(),
        Some("6c8098fc0f124c7b6492de60db0108747f7f9821")
    );
    assert_eq!(plan.files[1].needed_by.as_deref(), Some(CHUNKY));
    assert!(plan.already_installed.is_empty());
}

#[tokio::test]
async fn resolves_transitively_breadth_first() {
    let source = FakeSource::default()
        .with(
            "a",
            "A",
            vec![ver(
                "a1",
                "a",
                "release",
                D1,
                vec![required("b"), required("c")],
            )],
        )
        .with(
            "b",
            "B",
            vec![ver("b1", "b", "release", D1, vec![required("d")])],
        )
        .with(
            "c",
            "C",
            vec![ver(
                "c1",
                "c",
                "release",
                D1,
                vec![
                    required("d"),
                    dep(Some("e"), None, "optional"),
                    dep(Some("f"), None, "incompatible"),
                    dep(Some("g"), None, "embedded"),
                ],
            )],
        )
        .with("d", "D", vec![ver("d1", "d", "release", D1, vec![])]);
    let plan = plan_install(&source, &fabric(), "a", &InstalledIndex::default())
        .await
        .unwrap();
    let ids: Vec<&str> = plan.files.iter().map(|f| f.project_id.as_str()).collect();
    assert_eq!(
        ids,
        ["a", "b", "c", "d"],
        "d once, optional ones not followed"
    );
    assert_eq!(plan.files[3].needed_by.as_deref(), Some("b"));
}

#[tokio::test]
async fn a_cycle_ends_where_it_started() {
    let source = FakeSource::default()
        .with(
            "a",
            "A",
            vec![ver("a1", "a", "release", D1, vec![required("b")])],
        )
        .with(
            "b",
            "B",
            vec![ver("b1", "b", "release", D1, vec![required("a")])],
        );
    let plan = plan_install(&source, &fabric(), "a", &InstalledIndex::default())
        .await
        .unwrap();
    let ids: Vec<&str> = plan.files.iter().map(|f| f.project_id.as_str()).collect();
    assert_eq!(ids, ["a", "b"]);
    let project_calls = source
        .calls()
        .iter()
        .filter(|c| c.starts_with("project "))
        .count();
    assert_eq!(project_calls, 2);
}

#[tokio::test]
async fn a_pinned_version_is_used_as_named() {
    let old_b = ver("b-old", "b", "release", D1, vec![]);
    let new_b = ver("b-new", "b", "release", D3, vec![]);
    let source = FakeSource::default()
        .with(
            "a",
            "A",
            vec![ver(
                "a1",
                "a",
                "release",
                D1,
                vec![dep(Some("b"), Some("b-old"), "required")],
            )],
        )
        .with("b", "B", vec![new_b, old_b]);
    let plan = plan_install(&source, &fabric(), "a", &InstalledIndex::default())
        .await
        .unwrap();
    assert_eq!(plan.files[1].version_id, "b-old");
    assert!(source.calls().contains(&"version b-old".to_string()));

    // A pinned version made for another loader is refused, naming it.
    let mut forge_b = ver("b-forge", "b", "release", D1, vec![]);
    forge_b.loaders = vec!["forge".into()];
    let source = FakeSource::default()
        .with(
            "a",
            "A",
            vec![ver(
                "a1",
                "a",
                "release",
                D1,
                vec![dep(None, Some("b-forge"), "required")],
            )],
        )
        .with("b", "B", vec![forge_b]);
    let err = plan_install(&source, &fabric(), "a", &InstalledIndex::default())
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert!(
        err.to_string().contains("A needs B b-forge-number"),
        "{err}"
    );
    assert!(err.to_string().contains("Fabric"), "{err}");
}

#[tokio::test]
async fn installed_dependencies_are_skipped() {
    let source = FakeSource::default()
        .with(
            "a",
            "A",
            vec![ver(
                "a1",
                "a",
                "release",
                D1,
                vec![required("b"), required("c")],
            )],
        )
        .with("b", "B", vec![ver("b1", "b", "release", D1, vec![])])
        .with("c", "C", vec![ver("c1", "c", "release", D1, vec![])]);
    let mut installed = InstalledIndex::default();
    // b by project (any version, e.g. an older or disabled jar) ...
    installed
        .projects
        .insert("b".into(), "b-older.jar.disabled".into());
    // ... c by the exact file name.
    installed.filenames.insert("c-c1.jar".into());
    let plan = plan_install(&source, &fabric(), "a", &installed)
        .await
        .unwrap();
    let ids: Vec<&str> = plan.files.iter().map(|f| f.project_id.as_str()).collect();
    assert_eq!(ids, ["a"]);
    assert_eq!(plan.already_installed, ["b", "c"]);
    assert!(
        !source.calls().contains(&"project b".to_string()),
        "an installed project is not even looked up"
    );
}

#[tokio::test]
async fn the_mod_asked_for_is_never_installed_twice() {
    let source = FakeSource::default().with(
        "a",
        "Alpha Mod",
        vec![ver("a1", "a", "release", D1, vec![])],
    );
    let mut installed = InstalledIndex::default();
    installed.projects.insert("a".into(), "alpha.jar".into());
    let err = plan_install(&source, &fabric(), "a", &installed)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert_eq!(
        err.to_string(),
        "Alpha Mod is already installed (alpha.jar)"
    );

    let mut installed = InstalledIndex::default();
    installed.filenames.insert("a-a1.jar".into());
    let err = plan_install(&source, &fabric(), "a", &installed)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("already a file named a-a1.jar"),
        "{err}"
    );
}

#[tokio::test]
async fn missing_dependencies_fail_naming_them() {
    // Not on Modrinth at all.
    let source = FakeSource::default().with(
        "a",
        "Alpha",
        vec![ver("a1", "a", "release", D1, vec![required("gone")])],
    );
    let err = plan_install(&source, &fabric(), "a", &InstalledIndex::default())
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert!(err.to_string().contains("Alpha needs a project"), "{err}");
    assert!(err.to_string().contains("gone"), "{err}");

    // On Modrinth, but not for this version / loader.
    let mut forge_only = ver("b1", "b", "release", D1, vec![]);
    forge_only.loaders = vec!["forge".into()];
    let source = FakeSource::default()
        .with(
            "a",
            "Alpha",
            vec![ver("a1", "a", "release", D1, vec![required("b")])],
        )
        .with("b", "Beta Lib", vec![forge_only]);
    let err = plan_install(&source, &fabric(), "a", &InstalledIndex::default())
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "Alpha needs Beta Lib, which has no version for Minecraft 1.21.1 on Fabric"
    );

    // Only a file name, no project.
    let mut file_only = dep(None, None, "required");
    file_only.file_name = Some("secret-lib.jar".into());
    let source = FakeSource::default().with(
        "a",
        "Alpha",
        vec![ver("a1", "a", "release", D1, vec![file_only])],
    );
    let err = plan_install(&source, &fabric(), "a", &InstalledIndex::default())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("secret-lib.jar"), "{err}");

    // The mod itself.
    let source = FakeSource::default();
    let err = plan_install(&source, &fabric(), "nothing", &InstalledIndex::default())
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "Modrinth has no project called nothing");
    let mut old = ver("o1", "old", "release", D1, vec![]);
    old.game_versions = vec!["1.12.2".into()];
    let source = FakeSource::default().with("old", "Old Mod", vec![old]);
    let err = plan_install(&source, &fabric(), "old", &InstalledIndex::default())
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "Old Mod has no version for Minecraft 1.21.1 on Fabric"
    );
}

#[tokio::test]
async fn more_than_the_cap_is_refused() {
    // p0 → p1 → ... → p50: 51 files.
    let mut source = FakeSource::default();
    for i in 0..=MAX_FILES {
        let deps = if i < MAX_FILES {
            vec![required(&format!("p{}", i + 1))]
        } else {
            vec![]
        };
        let id = format!("p{i}");
        source = source.with(
            &id,
            &format!("P{i}"),
            vec![ver(&format!("v{i}"), &id, "release", D1, deps)],
        );
    }
    let err = plan_install(&source, &fabric(), "p0", &InstalledIndex::default())
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert!(err.to_string().contains("more than 50 files"), "{err}");
    // Exactly at the cap is fine.
    let plan = plan_install(&source, &fabric(), "p1", &InstalledIndex::default())
        .await
        .unwrap();
    assert_eq!(plan.files.len(), MAX_FILES);
}

#[tokio::test]
async fn bad_ids_are_refused_before_any_request() {
    let source = FakeSource::default();
    for id in ["", "../x", "a/b", "a b", &"x".repeat(65), "sodium?x=1"] {
        let err = plan_install(&source, &fabric(), id, &InstalledIndex::default())
            .await
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT", "{id:?}");
    }
    assert!(source.calls().is_empty());
}

/* ---------- §6.3b hosts and files ---------- */

#[test]
fn host_allowlist() {
    let ok = |u: &str| url_allowed(&reqwest::Url::parse(u).unwrap());
    assert!(ok("https://api.modrinth.com/v2/search"));
    assert!(ok("https://cdn.modrinth.com/data/x/y.jar"));
    assert!(!ok("http://cdn.modrinth.com/data/x/y.jar"));
    assert!(!ok("https://cdn.modrinth.com:8443/x"));
    assert!(!ok("https://user:pw@cdn.modrinth.com/x"));
    assert!(!ok("https://modrinth.com/x"));
    assert!(!ok("https://cdn.modrinth.com.evil.example/x"));
    assert!(!ok("https://github.com/x"));
}

#[test]
fn files_off_the_cdn_or_without_sha512_are_refused() {
    let mut off_cdn = ver("v", "p", "release", D1, vec![]);
    off_cdn.files[0].url = "https://evil.example/p.jar".into();
    assert_eq!(
        plan_file(&off_cdn, None).unwrap_err().code(),
        "DOWNLOAD_FAILED"
    );
    // The API host is allowlisted for requests, but files come from the CDN.
    let mut api_host = ver("v", "p", "release", D1, vec![]);
    api_host.files[0].url = "https://api.modrinth.com/p.jar".into();
    assert_eq!(
        plan_file(&api_host, None).unwrap_err().code(),
        "DOWNLOAD_FAILED"
    );
    let mut no_hash = ver("v", "p", "release", D1, vec![]);
    no_hash.files[0].hashes.sha512 = None;
    assert_eq!(
        plan_file(&no_hash, None).unwrap_err().code(),
        "DOWNLOAD_FAILED"
    );
    let mut short_hash = ver("v", "p", "release", D1, vec![]);
    short_hash.files[0].hashes.sha512 = Some("abc".into());
    assert_eq!(
        plan_file(&short_hash, None).unwrap_err().code(),
        "DOWNLOAD_FAILED"
    );
    let mut huge = ver("v", "p", "release", D1, vec![]);
    huge.files[0].size = crate::mods::MOD_MAX_BYTES + 1;
    assert_eq!(plan_file(&huge, None).unwrap_err().code(), "FILE_TOO_LARGE");
    let mut odd_name = ver("v", "p", "release", D1, vec![]);
    odd_name.files[0].filename = "My Mod (1).jar".into();
    assert_eq!(
        plan_file(&odd_name, None).unwrap().filename,
        "My_Mod_(1).jar"
    );
}

/// Serve fixed responses from a local socket, one per connection, keyed by
/// the request path.
async fn serve(routes: Vec<(&'static str, Vec<u8>, &'static str)>) -> std::net::SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
            let (body, head) = routes
                .iter()
                .find(|(p, _, _)| *p == path)
                .map(|(_, b, h)| (b.clone(), *h))
                .unwrap_or((Vec::new(), "HTTP/1.1 404 Not Found"));
            let response = format!(
                "{head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(response.as_bytes()).await;
            let _ = sock.write_all(&body).await;
            let _ = sock.flush().await;
        }
    });
    addr
}

#[tokio::test]
async fn redirects_off_the_modrinth_hosts_are_refused() {
    let addr = serve(vec![
        (
            "/to-evil",
            Vec::new(),
            "HTTP/1.1 302 Found\r\nLocation: https://evil.example/x.jar",
        ),
        (
            "/to-http-cdn",
            Vec::new(),
            "HTTP/1.1 302 Found\r\nLocation: http://cdn.modrinth.com/x.jar",
        ),
    ])
    .await;
    // The real policy on a client pointed at the local socket (the first
    // hop is local only because this is a test; the policy judges hops).
    let client = reqwest::Client::builder()
        .redirect(redirect_policy())
        .build()
        .unwrap();
    for path in ["/to-evil", "/to-http-cdn"] {
        let err = client
            .get(format!("http://{addr}{path}"))
            .send()
            .await
            .unwrap_err();
        assert!(err.is_redirect(), "{path}: {err}");
        let text = format!("{err:?}");
        assert!(text.contains("does not trust"), "{path}: {text}");
    }
}

fn planned(addr: std::net::SocketAddr, project: &str, name: &str, body: &[u8]) -> PlannedFile {
    use sha2::Digest;
    PlannedFile {
        project_id: project.into(),
        version_id: format!("{project}-v"),
        version_number: "1.0".into(),
        filename: name.into(),
        url: reqwest::Url::parse(&format!("http://{addr}/{name}")).unwrap(),
        sha512: hex::encode(sha2::Sha512::digest(body)),
        sha1: None,
        size: body.len() as u64,
        needed_by: None,
    }
}

async fn test_core() -> (tempfile::TempDir, std::sync::Arc<crate::Core>) {
    let tmp = tempfile::tempdir().unwrap();
    let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    (tmp, core)
}

#[tokio::test]
async fn a_sha512_mismatch_leaves_nothing_behind() {
    let addr = serve(vec![
        ("/good.jar", b"good bytes".to_vec(), "HTTP/1.1 200 OK"),
        ("/bad.jar", b"tampered bytes".to_vec(), "HTTP/1.1 200 OK"),
    ])
    .await;
    let (tmp, core) = test_core().await;
    let mut events = core.subscribe_events();
    let good = planned(addr, "good", "good.jar", b"good bytes");
    let mut bad = planned(addr, "bad", "bad.jar", b"the published bytes");
    bad.needed_by = Some("good".into());
    let names = HashMap::from([("bad".to_string(), "Bad Lib".to_string())]);
    let client = reqwest::Client::new();

    let err = download_plan(&core, &client, &[good.clone(), bad], &names)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "CHECKSUM_MISMATCH");
    assert!(err.to_string().starts_with("Bad Lib: "), "{err}");
    assert!(err.to_string().contains("sha512"), "{err}");
    let leftovers = std::fs::read_dir(tmp.path().join("data/tmp"))
        .unwrap()
        .count();
    assert_eq!(leftovers, 0, "the good file's temp copy is gone too");
    let mods = core.settings().await.simple.instance_dir.join("mods");
    assert!(!mods.exists(), "nothing was placed");

    // Progress events: kind "mod", the failing one ends in the same code.
    let mut last_error = None;
    while let Ok(ev) = events.try_recv() {
        if let crate::model::CoreEvent::DownloadProgress(p) = ev {
            assert_eq!(p.kind, DownloadKind::Mod);
            if let Some(e) = p.error {
                last_error = Some(e.code);
            }
        }
    }
    assert_eq!(last_error.as_deref(), Some("CHECKSUM_MISMATCH"));

    // The same good file alone downloads and verifies.
    let temps = download_plan(&core, &client, &[good], &names)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&temps[0].0).unwrap(), b"good bytes");
}

#[tokio::test]
async fn placing_on_this_computer_and_rolling_back() {
    let addr = serve(vec![
        ("/a.jar", b"aaa".to_vec(), "HTTP/1.1 200 OK"),
        ("/b.jar", b"bbb".to_vec(), "HTTP/1.1 200 OK"),
    ])
    .await;
    let (tmp, core) = test_core().await;
    let client = reqwest::Client::new();
    let files = vec![
        planned(addr, "a", "a.jar", b"aaa"),
        planned(addr, "b", "b.jar", b"bbb"),
    ];
    let mods = core.settings().await.simple.instance_dir.join("mods");

    // Success: both placed, staging and temps gone.
    let temps = download_plan(&core, &client, &files, &HashMap::new())
        .await
        .unwrap();
    stage_and_place(&core, ModTarget::Mods, &files, &temps)
        .await
        .unwrap();
    assert_eq!(std::fs::read(mods.join("a.jar")).unwrap(), b"aaa");
    assert_eq!(std::fs::read(mods.join("b.jar")).unwrap(), b"bbb");
    assert_eq!(
        std::fs::read_dir(tmp.path().join("data/tmp"))
            .unwrap()
            .count(),
        0
    );

    // Failure half way: b.jar cannot be written (a folder has that name), so
    // the a.jar this attempt placed is removed again and the folder stays.
    std::fs::remove_file(mods.join("a.jar")).unwrap();
    std::fs::remove_file(mods.join("b.jar")).unwrap();
    std::fs::create_dir(mods.join("b.jar")).unwrap();
    std::fs::write(mods.join("other.jar"), b"keep me").unwrap();
    let temps = download_plan(&core, &client, &files, &HashMap::new())
        .await
        .unwrap();
    let err = stage_and_place(&core, ModTarget::Mods, &files, &temps)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "IO");
    assert!(!mods.join("a.jar").exists());
    assert!(mods.join("b.jar").is_dir());
    assert_eq!(std::fs::read(mods.join("other.jar")).unwrap(), b"keep me");
    assert_eq!(
        std::fs::read_dir(tmp.path().join("data/tmp"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn installed_index_on_this_computer_matches_names() {
    let (_tmp, core) = test_core().await;
    // An empty folder needs no request at all.
    let index = installed_index(&core, &reqwest::Client::new(), ModTarget::Mods)
        .await
        .unwrap();
    assert!(index.filenames.is_empty() && index.projects.is_empty());
    // Cached answers are used for the same set of hashes (no network here).
    let mods = core.settings().await.simple.instance_dir.join("mods");
    std::fs::create_dir_all(&mods).unwrap();
    std::fs::write(mods.join("Some.jar.disabled"), b"x").unwrap();
    let hash = sha1_of_file(&mods.join("Some.jar.disabled")).unwrap();
    *core.modrinth_hashes.lock().unwrap() = Some(HashCache {
        hashes: vec![hash.clone()],
        projects: HashMap::from([(hash, "proj".to_string())]),
    });
    let index = installed_index(&core, &reqwest::Client::new(), ModTarget::Mods)
        .await
        .unwrap();
    assert!(index.has_file("some.jar.disabled"));
    assert_eq!(
        index.projects.get("proj").map(String::as_str),
        Some("Some.jar.disabled")
    );
}

#[test]
fn ids() {
    assert!(valid_id("P7dR8mSH"));
    assert!(valid_id("fabric-api"));
    assert!(valid_id("my_mod"));
    assert!(!valid_id(""));
    assert!(!valid_id("a.b"));
    assert!(!valid_id("%2e%2e"));
    assert!(!valid_id(&"a".repeat(65)));
}
