//! Live test for `install_java` (contract §3.1, §6.3a, 2.13.0). **Opt-in** -
//! `#[ignore]`; CI never runs it. Needs the network: it downloads the real
//! Temurin JRE 21 for this computer from Adoptium (about 50 MB) into a temp
//! app data dir, which is removed afterwards.
//!
//! ```sh
//! cargo test -p mineui-core --test live_java -- --ignored --nocapture
//! ```

use std::collections::HashSet;
use std::sync::Arc;

use mineui_core::model::{CoreEvent, DownloadKind};
use mineui_core::Core;

/// The download ids of every `kind: "java"` progress event seen so far.
fn java_downloads(rx: &mut tokio::sync::broadcast::Receiver<CoreEvent>) -> HashSet<String> {
    let mut ids = HashSet::new();
    loop {
        match rx.try_recv() {
            Ok(CoreEvent::DownloadProgress(p)) if p.kind == DownloadKind::Java => {
                assert!(p.error.is_none(), "download error: {:?}", p.error);
                ids.insert(p.download_id);
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
            Err(_) => break,
        }
    }
    ids
}

async fn profile(app_data: &std::path::Path, config: &std::path::Path, id: &str) -> Arc<Core> {
    Core::init_in_app(
        config.join("servers").join(id),
        app_data.join("servers").join(id),
        app_data.to_path_buf(),
    )
    .await
    .unwrap()
}

#[tokio::test]
#[ignore]
async fn live_install_temurin_21_once_for_every_profile() {
    let tmp = tempfile::tempdir().unwrap();
    let app_data = tmp.path().join("data");
    let config = tmp.path().join("config");
    let a = profile(&app_data, &config, "a1b2c3d4").await;
    let b = profile(&app_data, &config, "e5f6a7b8").await;
    let mut rx_a = a.subscribe_events();
    let mut rx_b = b.subscribe_events();

    // Two servers ask at once: one download, both get the same Java.
    let started = std::time::Instant::now();
    let (ra, rb) = tokio::join!(
        mineui_core::javainstall::install(&a, 21),
        mineui_core::javainstall::install(&b, 21)
    );
    let (ra, rb) = (ra.unwrap(), rb.unwrap());
    eprintln!("installed in {:?}: {ra:?}", started.elapsed());
    let downloads: HashSet<String> = java_downloads(&mut rx_a)
        .union(&java_downloads(&mut rx_b))
        .cloned()
        .collect();
    assert_eq!(downloads.len(), 1, "exactly one download for two requests");

    for r in [&ra, &rb] {
        assert!(r.found && r.managed, "{r:?}");
        assert_eq!(r.major_version, Some(21));
        assert_eq!(r.required_major, Some(21));
        assert_eq!(r.compatible, Some(true));
    }
    assert_eq!(ra.path, rb.path);
    let java = std::path::PathBuf::from(ra.path.clone().unwrap());
    assert!(
        java.starts_with(app_data.join("java").join("temurin-21-jre")),
        "app-wide folder, not a server folder: {}",
        java.display()
    );

    // The binary really runs and reports 21.
    let out = std::process::Command::new(&java)
        .arg("-version")
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stderr);
    eprintln!("{text}");
    assert!(text.contains("version \"21."), "{text}");
    assert!(text.contains("Temurin"), "{text}");

    // No temp or aside folders left behind.
    let leftovers: Vec<_> = std::fs::read_dir(app_data.join("java"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(leftovers, vec!["temurin-21-jre".to_string()]);

    // A later call reuses it without downloading again.
    let again = mineui_core::javainstall::install(&a, 21).await.unwrap();
    assert_eq!(again.path, ra.path);
    assert!(java_downloads(&mut rx_a).is_empty(), "no second download");

    // java_check on a server finds it too (managed first).
    let check = mineui_core::java::check_for(&b, Some(21)).await.unwrap();
    assert_eq!(check.path, ra.path);
    assert!(check.managed);

    // Exactly one java.install audit entry, on the profile that downloaded.
    let mut audited = 0;
    for core in [&a, &b] {
        let log = mineui_core::audit::recent(core, Some(50)).await.unwrap();
        for entry in log.entries.iter().filter(|e| e.action == "java.install") {
            assert!(entry.ok);
            assert_eq!(entry.target.as_deref(), Some("temurin-21-jre"));
            let detail = entry.detail.as_deref().unwrap_or("");
            assert!(detail.starts_with("Temurin JRE 21."), "{detail}");
            eprintln!("audit: {detail}");
            audited += 1;
        }
    }
    assert_eq!(audited, 1);
}

/// `required_java_major` (§3.6) against the real Mojang manifest.
#[tokio::test]
#[ignore]
async fn live_required_java_major_from_mojang() {
    let tmp = tempfile::tempdir().unwrap();
    let core = Core::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let latest = mineui_core::mojang::list_versions(&core, false)
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.latest)
        .unwrap();
    let for_latest = mineui_core::mojang::required_java_major(&core, "LATEST").await;
    let for_id = mineui_core::mojang::required_java_major(&core, &latest.id).await;
    eprintln!("latest release {} needs Java {for_latest:?}", latest.id);
    assert_eq!(for_latest, for_id);
    assert!(for_latest.is_some_and(|m| m >= 21));
    assert_eq!(
        mineui_core::mojang::required_java_major(&core, "1.20.4").await,
        Some(17)
    );
    assert_eq!(
        mineui_core::mojang::required_java_major(&core, "1.16.5").await,
        Some(8)
    );
    assert_eq!(
        mineui_core::mojang::required_java_major(&core, "no-such-version").await,
        None
    );
}
