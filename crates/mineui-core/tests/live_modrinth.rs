//! Live test for Find mods (contract §3.5a, §6.3b, 2.13.0). **Opt-in** -
//! `#[ignore]`; CI never runs it. Needs the network: it searches Modrinth for
//! Chunky on a Fabric 1.21.1 server, resolves its one required dependency
//! (Fabric API) and downloads both files (under 3 MB) through the
//! host-allowlisted client into a temp data dir, checking each sha512.
//!
//! ```sh
//! cargo test -p mineui-core --test live_modrinth -- --ignored --nocapture
//! ```

use std::collections::HashMap;

use mineui_core::model::{CoreEvent, DownloadKind, ModTarget};
use mineui_core::modrinth::{self, InstalledIndex, LiveSource};
use mineui_core::Core;

#[tokio::test]
#[ignore = "needs the network (api.modrinth.com, cdn.modrinth.com)"]
async fn live_search_resolve_and_download_chunky_on_fabric() {
    let server = modrinth::server_mods(&modrinth::support_for(
        false,
        Some("FABRIC"),
        Some("1.21.1"),
    ))
    .unwrap();
    let client = modrinth::build_client();

    // Search: Chunky is there, every hit is server-capable.
    let page = modrinth::search_page(&client, &server, "chunky", 0, 10)
        .await
        .unwrap();
    println!(
        "search: {} hits of {}: {:?}",
        page.hits.len(),
        page.total_hits,
        page.hits.iter().map(|h| &h.slug).collect::<Vec<_>>()
    );
    assert!(page.hits.iter().any(|h| h.slug == "chunky"));
    // An empty query lists the most downloaded mods for this server.
    let popular = modrinth::search_page(&client, &server, "", 0, 5)
        .await
        .unwrap();
    assert!(
        popular.total_hits > 1000,
        "facets still match: {}",
        popular.total_hits
    );

    // Resolve: Chunky plus Fabric API as a dependency.
    let source = LiveSource {
        client: client.clone(),
    };
    let plan = modrinth::plan_install(&source, &server, "chunky", &InstalledIndex::default())
        .await
        .unwrap();
    for f in &plan.files {
        println!(
            "plan: {} {} ({} bytes) dependency={} url={}",
            f.project_id,
            f.filename,
            f.size,
            f.dependency(),
            f.url
        );
    }
    assert_eq!(plan.files.len(), 2);
    assert!(!plan.files[0].dependency());
    assert_eq!(plan.files[1].project_id, "P7dR8mSH", "Fabric API");
    assert!(plan.files[1].dependency());

    // Download both with the hash checks, into a temp data dir.
    let tmp = tempfile::tempdir().unwrap();
    let core = Core::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let mut events = core.subscribe_events();
    let temps = modrinth::download_plan(&core, &client, &plan.files, &HashMap::new())
        .await
        .unwrap();
    for ((path, id), f) in temps.iter().zip(&plan.files) {
        use sha2::Digest;
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(bytes.len() as u64, f.size);
        assert_eq!(hex::encode(sha2::Sha512::digest(&bytes)), f.sha512);
        println!(
            "downloaded {} ({} bytes, download id {id})",
            f.filename,
            bytes.len()
        );
    }
    let mut done = 0;
    while let Ok(ev) = events.try_recv() {
        if let CoreEvent::DownloadProgress(p) = ev {
            assert_eq!(p.kind, DownloadKind::Mod);
            assert!(p.error.is_none());
            done += usize::from(p.done);
        }
    }
    assert_eq!(done, 2, "one terminal event per file");

    // Staged and placed for a server on this computer (host folder), then
    // the temp dir is empty again.
    modrinth::stage_and_place(&core, ModTarget::Mods, &plan.files, &temps)
        .await
        .unwrap();
    let mods = core.settings().await.simple.instance_dir.join("mods");
    for f in &plan.files {
        assert!(mods.join(&f.filename).is_file(), "{}", f.filename);
    }
    let leftovers = std::fs::read_dir(tmp.path().join("data/tmp"))
        .unwrap()
        .count();
    assert_eq!(leftovers, 0);

    // The installed-projects lookup (real POST /v2/version_files) knows both
    // files now, so a second install of Chunky is refused and Fabric API
    // would count as already there.
    let installed = modrinth::installed_index(&core, &client, ModTarget::Mods)
        .await
        .unwrap();
    println!("installed projects: {:?}", installed.projects);
    assert!(installed.projects.contains_key("fALzjamp"));
    assert!(installed.projects.contains_key("P7dR8mSH"));
    let again = modrinth::plan_install(&source, &server, "chunky", &installed)
        .await
        .unwrap_err();
    println!("second install: {again}");
    assert_eq!(again.code(), "INVALID_INPUT");
}

/* ---------- the whole path on a throwaway container ---------- */

const NAME: &str = "mineui-live-modrinth";
const IMAGE: &str = "docker.io/itzg/minecraft-server:java21";

fn podman(args: &[&str]) -> std::process::Output {
    std::process::Command::new("podman")
        .args(args)
        .output()
        .expect("podman on PATH")
}

/// Removes the container and its volume however the test ends.
struct Cleanup;
impl Drop for Cleanup {
    fn drop(&mut self) {
        podman(&["rm", "-f", "-t", "0", NAME]);
        podman(&["volume", "rm", "-f", &format!("{NAME}-data")]);
    }
}

fn names(list: &[mineui_core::model::ModEntry]) -> Vec<String> {
    list.iter().map(|m| m.filename.clone()).collect()
}

/// Needs the network and podman with the itzg java21 image. Creates its own
/// `mineui-live-modrinth` container (TYPE=FABRIC, VERSION=1.21.1, entrypoint
/// `sleep`, so no Minecraft server runs) and removes it and its volume
/// afterwards.
///
/// ```sh
/// cargo test -p mineui-core --test live_modrinth live_install_on_a_container -- --ignored --nocapture
/// ```
#[tokio::test]
#[ignore = "needs the network and podman"]
async fn live_install_on_a_container() {
    use mineui_core::settings::{Mode, Settings};
    let _cleanup = Cleanup;
    podman(&["rm", "-f", "-t", "0", NAME]);
    let volume = format!("{NAME}-data:/data");
    let made = podman(&[
        "run",
        "-d",
        "--name",
        NAME,
        "-v",
        &volume,
        "-e",
        "TYPE=FABRIC",
        "-e",
        "VERSION=1.21.1",
        "--entrypoint",
        "sleep",
        IMAGE,
        "infinity",
    ]);
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );

    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default_with_data_dir(&tmp.path().join("data"));
    settings.active_mode = Mode::Advanced;
    settings.advanced.container_name = NAME.into();
    let core =
        Core::init_with_settings(tmp.path().join("config"), tmp.path().join("data"), settings)
            .await;

    let support = modrinth::support(&core).await.unwrap();
    println!("support: {support:?}");
    assert!(support.supported);
    assert_eq!(support.target, Some(ModTarget::Mods));
    assert_eq!(support.loaders, ["fabric"]);

    // Install Chunky: Chunky + Fabric API land in /data/mods.
    let result = modrinth::install(&core, "chunky").await.unwrap();
    println!("install: {result:?}");
    assert_eq!(result.installed.len(), 2);
    assert_eq!(result.installed[0].slug, "chunky");
    assert!(!result.installed[0].dependency);
    assert_eq!(result.installed[1].slug, "fabric-api");
    assert!(result.installed[1].dependency);
    let listed = mineui_core::mods::list(&core).await.unwrap();
    println!("mods: {:?}", names(&listed.mods));
    for f in &result.installed {
        assert!(names(&listed.mods).contains(&f.filename), "{}", f.filename);
    }

    // Search marks it installed (hashes read in the container).
    let page = modrinth::search(&core, "chunky", None, Some(5))
        .await
        .unwrap();
    let hit = page.hits.iter().find(|h| h.slug == "chunky").unwrap();
    assert!(hit.installed);
    // A second install is refused; nothing changes.
    let again = modrinth::install(&core, "chunky").await.unwrap_err();
    println!("again: {again}");
    assert_eq!(again.code(), "INVALID_INPUT");

    // Disable / enable through the container script, running ...
    let chunky = result.installed[0].filename.clone();
    let off = mineui_core::mods::set_enabled(&core, &chunky, ModTarget::Mods, false)
        .await
        .unwrap();
    assert_eq!(off.filename, format!("{chunky}.disabled"));
    let listed = mineui_core::mods::list(&core).await.unwrap();
    assert!(names(&listed.mods).contains(&off.filename));
    assert!(!names(&listed.mods).contains(&chunky));
    // ... and stopped (the volumes-from helper).
    podman(&["stop", "-t", "0", NAME]);
    let on = mineui_core::mods::set_enabled(&core, &off.filename, ModTarget::Mods, true)
        .await
        .unwrap();
    assert_eq!(on.filename, chunky);
    // Refuses to overwrite: with Chunky off and a new file under its .jar
    // name, turning the old one on fails and both files stay.
    let off = mineui_core::mods::set_enabled(&core, &chunky, ModTarget::Mods, false)
        .await
        .unwrap();
    let stand_in = tmp.path().join("stand-in.jar");
    std::fs::write(&stand_in, b"not chunky").unwrap();
    let dest = format!("{NAME}:/data/mods/{chunky}");
    let copied = podman(&["cp", stand_in.to_str().unwrap(), &dest]);
    assert!(
        copied.status.success(),
        "{}",
        String::from_utf8_lossy(&copied.stderr)
    );
    let taken = mineui_core::mods::set_enabled(&core, &off.filename, ModTarget::Mods, true)
        .await
        .unwrap_err();
    println!("taken: {taken}");
    assert_eq!(taken.code(), "INVALID_INPUT");
    let listed = mineui_core::mods::list(&core).await.unwrap();
    assert!(names(&listed.mods).contains(&off.filename));
    let size = listed
        .mods
        .iter()
        .find(|m| m.filename == chunky)
        .unwrap()
        .size_bytes;
    assert_eq!(size, 10, "the stand-in was not replaced");
    let missing = mineui_core::mods::set_enabled(&core, "nope.jar", ModTarget::Mods, false)
        .await
        .unwrap_err();
    assert!(missing.to_string().contains("does not exist"), "{missing}");
    let listed = mineui_core::mods::list(&core).await.unwrap();
    println!("mods after: {:?}", names(&listed.mods));

    let log = mineui_core::audit::recent(&core, Some(20)).await.unwrap();
    let actions: Vec<_> = log
        .entries
        .iter()
        .map(|e| {
            format!(
                "{} {} {}",
                e.action,
                e.target.clone().unwrap_or_default(),
                e.detail.clone().unwrap_or_default()
            )
        })
        .collect();
    println!("audit: {actions:#?}");
    assert_eq!(
        log.entries
            .iter()
            .filter(|e| e.action == "mod.install" && e.ok)
            .count(),
        2
    );
}
