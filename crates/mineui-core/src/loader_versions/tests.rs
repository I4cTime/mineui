//! Fixtures are trimmed from the real answers of 2026-11-10.

use super::*;
use crate::mojang::{ManifestCache, VersionManifest};

const PURPUR: &str = include_str!("../../tests/fixtures/versions-purpur.json");
const PAPER: &str = include_str!("../../tests/fixtures/versions-paper.json");
const FABRIC: &str = include_str!("../../tests/fixtures/versions-fabric.json");
const QUILT: &str = include_str!("../../tests/fixtures/versions-quilt.json");
const FORGE: &str = include_str!("../../tests/fixtures/versions-forge.json");
const NEOFORGE: &str = include_str!("../../tests/fixtures/versions-neoforge.json");
const MANIFEST: &str = include_str!("../../tests/fixtures/mojang-manifest-trimmed.json");

fn set(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

fn sorted(set: &HashSet<String>) -> Vec<String> {
    let mut v: Vec<String> = set.iter().cloned().collect();
    v.sort();
    v
}

/// A core whose Mojang manifest cache is warm with the trimmed manifest, so
/// no request ever reaches Mojang.
async fn core_with_manifest() -> (tempfile::TempDir, std::sync::Arc<crate::Core>) {
    let tmp = tempfile::tempdir().unwrap();
    let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let manifest: VersionManifest = serde_json::from_str(MANIFEST).unwrap();
    *core.mojang_cache.lock().await = Some(ManifestCache {
        fetched_at: Instant::now(),
        manifest,
    });
    (tmp, core)
}

fn ids(versions: &[McVersion]) -> Vec<&str> {
    versions.iter().map(|v| v.id.as_str()).collect()
}

/* ---------- parsers ---------- */

#[test]
fn purpur_lists_its_versions() {
    let got = parse(ContainerLoader::Purpur, PURPUR).unwrap();
    assert!(got.contains("26.3") && got.contains("26.2") && got.contains("26.1.2"));
    assert!(got.contains("1.14.1") && got.contains("1.21.11"));
    // The reported bug: no Purpur build for 26.1.1 or 26.1.
    assert!(!got.contains("26.1.1"));
    assert!(!got.contains("26.1"));
}

#[test]
fn paper_flattens_the_families() {
    let got = parse(ContainerLoader::Paper, PAPER).unwrap();
    for id in [
        "26.3",
        "26.3-rc-3",
        "26.1.1",
        "26.1.2",
        "1.21.11-pre5",
        "1.7.10",
    ] {
        assert!(got.contains(id), "{id}");
    }
    // A family name is not a version unless it is also listed under itself.
    assert!(!got.contains("26.1"));
    assert!(!got.contains("1.21.2"));
}

#[test]
fn fabric_and_quilt_take_every_game_version() {
    let fabric = parse(ContainerLoader::Fabric, FABRIC).unwrap();
    for id in ["26.4-snapshot-8", "26.3", "26.3-rc-3", "26.1", "1.14"] {
        assert!(fabric.contains(id), "{id}");
    }
    let quilt = parse(ContainerLoader::Quilt, QUILT).unwrap();
    assert!(quilt.contains("26.3") && quilt.contains("1.21.1") && quilt.contains("1.14.4"));
    assert!(!quilt.contains("26.1.1"));
}

#[test]
fn forge_reads_the_promotion_keys() {
    let got = parse(ContainerLoader::Forge, FORGE).unwrap();
    assert_eq!(
        sorted(&got),
        vec!["1.20.1", "1.21.1", "1.21.11", "1.7.10", "26.1", "26.1.1", "26.1.2", "26.2", "26.3"]
    );
}

#[test]
fn neoforge_mapping_follows_both_schemes() {
    let cases = [
        // Before 26: A.B.n -> 1.A.B, 1.A when B is 0.
        ("21.1.209", Some("1.21.1")),
        ("21.0.167", Some("1.21")),
        ("20.4.251", Some("1.20.4")),
        ("21.11.42", Some("1.21.11")),
        // 26 and later: Y.A.B.n -> Y.A.B, Y.A when B is 0.
        ("26.1.2.40", Some("26.1.2")),
        ("26.3.0.102", Some("26.3")),
        ("26.1.0.5", Some("26.1")),
        // Pre-releases are not installed by the image's default.
        ("26.1.0.19-beta", None),
        ("20.2.3-beta", None),
        ("26.1.0.0-alpha.1+snapshot-1", None),
        ("0.25w14craftmine.3-beta", None),
        // Other shapes.
        ("21.1", None),
        ("21.1.x", None),
        ("26.1.2.3.4", None),
        ("", None),
    ];
    for (neo, mc) in cases {
        assert_eq!(neoforge_mc_version(neo).as_deref(), mc, "{neo}");
    }
}

#[test]
fn neoforge_keeps_released_lines_and_adds_1_20_1() {
    let got = parse(ContainerLoader::Neoforge, NEOFORGE).unwrap();
    assert_eq!(
        sorted(&got),
        vec!["1.20.1", "1.20.2", "1.20.4", "1.21", "1.21.1", "1.21.11", "26.2", "26.3"]
    );
    // 1.20.3: only betas (20.3.8-beta) in the fixture, as in the real list.
    assert!(!got.contains("1.20.3"));
    // Only betas in the fixture for these: not creatable with the default.
    assert!(!got.contains("26.1") && !got.contains("26.1.1") && !got.contains("26.1.2"));
}

#[test]
fn unreadable_or_empty_answers_are_errors() {
    assert!(parse(ContainerLoader::Purpur, "<html>").is_err());
    assert!(parse(ContainerLoader::Purpur, r#"{"versions":[]}"#).is_err());
    assert!(parse(ContainerLoader::Paper, r#"{"versions":["26.3"]}"#).is_err());
    assert!(parse(ContainerLoader::Fabric, r#"{"version":"26.3"}"#).is_err());
    assert!(parse(ContainerLoader::Forge, r#"{"promos":{"homepage":"x"}}"#).is_err());
    // Only pre-releases: nothing to offer, and no 1.20.1 on its own.
    assert!(parse(
        ContainerLoader::Neoforge,
        r#"{"versions":["26.3.0.1-beta"]}"#
    )
    .is_err());
    assert!(parse(ContainerLoader::Vanilla, PURPUR).is_err());
    // Implausible ids are dropped before anything is compared.
    let got = parse(
        ContainerLoader::Purpur,
        r#"{"versions":["26.3","a b","<x>"]}"#,
    )
    .unwrap();
    assert_eq!(sorted(&got), vec!["26.3"]);
}

#[test]
fn server_type_wire_names() {
    assert_eq!(parse_server_type(None).unwrap(), None);
    assert_eq!(
        parse_server_type(Some("purpur")).unwrap(),
        Some(ContainerLoader::Purpur)
    );
    assert_eq!(
        parse_server_type(Some("neoforge")).unwrap(),
        Some(ContainerLoader::Neoforge)
    );
    assert_eq!(
        parse_server_type(Some("vanilla")).unwrap(),
        Some(ContainerLoader::Vanilla)
    );
    for bad in ["spigot", "PURPUR", "", "modrinth"] {
        assert!(
            matches!(parse_server_type(Some(bad)), Err(Error::InvalidInput(_))),
            "{bad}"
        );
    }
}

#[test]
fn every_source_is_on_the_allowlist() {
    for loader in [
        ContainerLoader::Paper,
        ContainerLoader::Purpur,
        ContainerLoader::Fabric,
        ContainerLoader::Quilt,
        ContainerLoader::Forge,
        ContainerLoader::Neoforge,
    ] {
        let url = reqwest::Url::parse(source_url(loader).unwrap()).unwrap();
        assert!(url_allowed(&url), "{url}");
    }
    assert_eq!(source_url(ContainerLoader::Vanilla), None);
    for bad in [
        "http://api.purpurmc.org/v2/purpur",
        "https://api.purpurmc.org:8443/v2/purpur",
        "https://user@api.purpurmc.org/v2/purpur",
        "https://api.purpurmc.org.evil.example/v2/purpur",
        "https://127.0.0.1/v2/purpur",
    ] {
        assert!(!url_allowed(&reqwest::Url::parse(bad).unwrap()), "{bad}");
    }
}

/* ---------- the intersection and the fall-backs ---------- */

#[test]
fn restrict_keeps_mojang_order_and_flags() {
    let manifest: VersionManifest = serde_json::from_str(MANIFEST).unwrap();
    let all = crate::mojang::manifest_to_versions(&manifest, true);
    let got = restrict(
        &all,
        &set(&["1.20.1", "26.3", "26.4-snapshot-8", "26.1.2", "9.9"]),
    );
    assert_eq!(
        ids(&got),
        vec!["26.4-snapshot-8", "26.3", "26.1.2", "1.20.1"]
    );
    assert!(got[0].latest && got[0].version_type == "snapshot");
    assert!(got[1].latest && got[1].version_type == "release");
    assert!(!got[2].latest);
}

#[tokio::test]
async fn purpur_list_drops_versions_without_a_build() {
    let (_tmp, core) = core_with_manifest().await;
    let got = list_versions_with(&core, false, Some(ContainerLoader::Purpur), |_| async {
        Ok(parse(ContainerLoader::Purpur, PURPUR).unwrap())
    })
    .await
    .unwrap();
    assert_eq!(
        ids(&got),
        vec!["26.3", "26.2", "26.1.2", "1.21.11", "1.21.1", "1.21", "1.20.4", "1.20.2", "1.20.1"]
    );
    // Mojang's latest release is still marked, so the UI can offer "Latest".
    assert!(got[0].latest);
}

#[tokio::test]
async fn a_type_trailing_mojang_has_no_latest_entry() {
    let (_tmp, core) = core_with_manifest().await;
    let got = list_versions_with(&core, false, Some(ContainerLoader::Neoforge), |_| async {
        Ok(set(&["26.2", "1.21.1"]))
    })
    .await
    .unwrap();
    assert_eq!(ids(&got), vec!["26.2", "1.21.1"]);
    assert!(got.iter().all(|v| !v.latest));
}

#[tokio::test]
async fn snapshots_follow_include_snapshots() {
    let (_tmp, core) = core_with_manifest().await;
    let fabric = || async { Ok(parse(ContainerLoader::Fabric, FABRIC).unwrap()) };
    let with = list_versions_with(&core, true, Some(ContainerLoader::Fabric), |_| fabric())
        .await
        .unwrap();
    assert_eq!(&ids(&with)[..3], &["26.4-snapshot-8", "26.3", "26.3-rc-3"]);
    let without = list_versions_with(&core, false, Some(ContainerLoader::Fabric), |_| async {
        panic!("the cached Fabric list must be used")
    })
    .await
    .unwrap();
    assert!(without.iter().all(|v| v.version_type == "release"));
    assert_eq!(ids(&without)[0], "26.3");
}

#[tokio::test]
async fn vanilla_and_absent_are_unchanged() {
    let (_tmp, core) = core_with_manifest().await;
    let all = crate::mojang::list_versions(&core, false).await.unwrap();
    for loader in [None, Some(ContainerLoader::Vanilla)] {
        let got = list_versions_with(&core, false, loader, |_| async {
            panic!("vanilla has no list to fetch")
        })
        .await
        .unwrap();
        assert_eq!(ids(&got), ids(&all));
    }
    // The public entry point with no serverType makes no request either.
    let got = list_versions(&core, false, None).await.unwrap();
    assert_eq!(ids(&got), ids(&all));
    assert!(matches!(
        list_versions(&core, false, Some("bukkit")).await,
        Err(Error::InvalidInput(_))
    ));
}

#[tokio::test]
async fn a_failed_list_falls_back_to_every_version() {
    let (_tmp, core) = core_with_manifest().await;
    let all = crate::mojang::list_versions(&core, false).await.unwrap();
    let got = list_versions_with(&core, false, Some(ContainerLoader::Purpur), |_| async {
        Err(Error::DownloadFailed("offline".into()))
    })
    .await
    .unwrap();
    assert_eq!(ids(&got), ids(&all));
    // Nothing was cached by the failure.
    assert!(core.loader_versions_cache.lock().await.is_empty());
}

#[tokio::test]
async fn a_list_sharing_nothing_falls_back_to_every_version() {
    let (_tmp, core) = core_with_manifest().await;
    let all = crate::mojang::list_versions(&core, false).await.unwrap();
    let got = list_versions_with(&core, false, Some(ContainerLoader::Paper), |_| async {
        Ok(set(&["99.1"]))
    })
    .await
    .unwrap();
    assert_eq!(ids(&got), ids(&all));
}

#[tokio::test]
async fn a_stale_cache_beats_an_error() {
    let (_tmp, core) = core_with_manifest().await;
    core.loader_versions_cache.lock().await.insert(
        ContainerLoader::Purpur,
        TypeCache {
            fetched_at: Instant::now() - CACHE_TTL - Duration::from_secs(1),
            versions: set(&["26.2", "1.21.1"]),
        },
    );
    let got = list_versions_with(&core, false, Some(ContainerLoader::Purpur), |_| async {
        Err(Error::DownloadFailed("offline".into()))
    })
    .await
    .unwrap();
    assert_eq!(ids(&got), vec!["26.2", "1.21.1"]);

    // A successful refresh replaces it.
    let got = list_versions_with(&core, false, Some(ContainerLoader::Purpur), |_| async {
        Ok(set(&["26.3"]))
    })
    .await
    .unwrap();
    assert_eq!(ids(&got), vec!["26.3"]);
}

/* ---------- the body cap ---------- */

/// Answers every request with `body`, announcing its length or not.
async fn body_server(body: Vec<u8>, announce_length: bool) -> std::net::SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 2048];
            let _ = sock.read(&mut buf).await;
            let head = if announce_length {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            } else {
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string()
            };
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(&body).await;
            let _ = sock.flush().await;
        }
    });
    addr
}

#[tokio::test]
async fn bodies_over_the_cap_are_refused() {
    let client = reqwest::Client::new();
    for announce in [true, false] {
        let addr = body_server(vec![b'x'; 2048], announce).await;
        let response = client.get(format!("http://{addr}/")).send().await.unwrap();
        assert!(
            matches!(
                read_capped(response, 1024).await,
                Err(Error::DownloadFailed(_))
            ),
            "announce={announce}"
        );
    }
    let addr = body_server(PURPUR.as_bytes().to_vec(), false).await;
    let response = client.get(format!("http://{addr}/")).send().await.unwrap();
    assert_eq!(read_capped(response, MAX_BODY_BYTES).await.unwrap(), PURPUR);
}
