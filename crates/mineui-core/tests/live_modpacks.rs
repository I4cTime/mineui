//! Live modpack tests (contract §3.13, §3.14). **Opt-in** — `#[ignore]`; CI
//! never runs them. Need network, and podman or docker on PATH; they create
//! and remove their own containers and volumes.
//!
//! ```sh
//! cargo test -p mineui-core --test live_modpacks -- --ignored --test-threads=1
//! ```

use std::time::Duration;

use mineui_core::model::{
    ContainerLoader, CreateContainerArgs, ModpackRef, ModpackSource, ServerPhase,
};
use mineui_core::settings::Mode;
use mineui_core::Hub;

fn runtime(args: &[&str]) -> String {
    let out = std::process::Command::new("podman")
        .args(args)
        .output()
        .expect("podman on PATH");
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn cleanup(name: &str) {
    runtime(&["rm", "-f", name]);
    runtime(&["volume", "rm", &format!("{name}-data")]);
}

fn args(name: &str, port: u16, source: ModpackSource, project: &str) -> CreateContainerArgs {
    CreateContainerArgs {
        loader: ContainerLoader::Vanilla, // ignored: the pack decides
        mc_version: "1.21.1".into(),
        container_name: name.into(),
        memory_mb: 2048,
        game_port: port,
        rcon_port: port + 1,
        expose_to_network: false,
        accept_eula: true,
        modpack: Some(ModpackRef {
            source,
            project: project.into(),
        }),
    }
}

#[tokio::test]
#[ignore]
async fn live_search_finds_server_capable_modpacks() {
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let core = hub.core(None).await.unwrap();

    let hits = mineui_core::modpacks::search(&core, "cobblemon", Some(5))
        .await
        .unwrap();
    assert!(!hits.is_empty() && hits.len() <= 5);
    let official = hits
        .iter()
        .find(|h| h.slug == "cobblemon-fabric")
        .expect("the official Cobblemon pack is a top hit");
    assert!(official.game_versions.iter().any(|v| v == "1.21.1"));
    assert!(official.loaders.iter().any(|l| l == "fabric"));
    assert!(official.downloads > 1_000_000);

    // Empty query = most downloaded; a client-only pack is never offered.
    let popular = mineui_core::modpacks::search(&core, "", None)
        .await
        .unwrap();
    assert_eq!(popular.len(), 12);
    assert!(popular.windows(2).all(|w| w[0].downloads >= w[1].downloads));
    let client_only = mineui_core::modpacks::search(&core, "fabulously optimized", None)
        .await
        .unwrap();
    assert!(client_only.iter().all(|h| h.slug != "fabulously-optimized"));
}

/// A Modrinth modpack end to end: MineUI creates the container, the image
/// installs the pack, the server comes up and answers RCON.
#[tokio::test]
#[ignore]
async fn live_modrinth_modpack_server_boots() {
    const NAME: &str = "mineui-live-modrinth";
    cleanup(NAME);
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let id = hub
        .add("Pack", Some(Mode::Advanced))
        .await
        .unwrap()
        .servers
        .last()
        .unwrap()
        .id
        .clone();
    let core = hub.core(Some(&id)).await.unwrap();

    // Given as a page URL on purpose: core reduces it to the slug.
    let create = args(
        NAME,
        25592,
        ModpackSource::Modrinth,
        "https://modrinth.com/modpack/adrenaserver",
    );
    let state = mineui_core::provision::create(&core, &create)
        .await
        .unwrap();
    assert_eq!(state.phase, ServerPhase::Running);

    let entry = hub
        .overview()
        .await
        .into_iter()
        .find(|o| o.id == id)
        .unwrap();
    assert_eq!(entry.loader.as_deref(), Some("modrinth"));
    assert_eq!(entry.modpack.as_deref(), Some("adrenaserver"));
    assert_eq!(entry.mc_version.as_deref(), Some("1.21.1"));

    let deadline = tokio::time::Instant::now() + Duration::from_secs(420);
    loop {
        if let Ok(out) = mineui_core::rcon::run_allowlisted(&core, "list").await {
            assert!(out.contains("players online"), "{out}");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "modpack server did not become RCON-ready:\n{}",
            runtime(&["logs", "--tail", "30", NAME])
        );
        tokio::time::sleep(Duration::from_secs(4)).await;
    }
    // The pack's mods really are there.
    let mods = mineui_core::mods::list(&core).await.unwrap();
    assert!(
        mods.mods.len() >= 5,
        "only {} mods installed",
        mods.mods.len()
    );
    let status = mineui_core::status::get(&core).await.unwrap();
    assert_eq!(status.version.as_deref(), Some("1.21.1"));

    cleanup(NAME);
}

/// CurseForge: the env MineUI writes is what the image needs to resolve and
/// start installing a pack without any API key from the user. Stops as soon
/// as the image is downloading the pack's mods (a full install is gigabytes).
#[tokio::test]
#[ignore]
async fn live_curseforge_modpack_starts_installing() {
    const NAME: &str = "mineui-live-curseforge";
    cleanup(NAME);
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let id = hub
        .add("CF pack", Some(Mode::Advanced))
        .await
        .unwrap()
        .servers
        .last()
        .unwrap()
        .id
        .clone();
    let core = hub.core(Some(&id)).await.unwrap();

    let create = args(
        NAME,
        25594,
        ModpackSource::Curseforge,
        "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10",
    );
    mineui_core::provision::create(&core, &create)
        .await
        .unwrap();

    let env = runtime(&[
        "inspect",
        "-f",
        "{{range .Config.Env}}{{println .}}{{end}}",
        NAME,
    ]);
    assert!(env.contains("TYPE=AUTO_CURSEFORGE"), "{env}");
    assert!(env.contains("CF_SLUG=all-the-mods-10"), "{env}");
    assert!(
        !env.lines().any(|l| l.starts_with("VERSION=1.21.1")),
        "{env}"
    );

    let entry = hub
        .overview()
        .await
        .into_iter()
        .find(|o| o.id == id)
        .unwrap();
    assert_eq!(entry.loader.as_deref(), Some("auto_curseforge"));
    assert_eq!(entry.modpack.as_deref(), Some("all-the-mods-10"));

    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let logs = runtime(&["logs", "--tail", "200", NAME]);
        if logs.contains("Downloaded mod file") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the image never started installing the pack:\n{logs}"
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    cleanup(NAME);
}

/// `unpack_mod_archive` into a real container: the jars of a zip land in
/// /data/mods through one runtime `cp`, and the listing sees them.
#[tokio::test]
#[ignore]
async fn live_unpack_mod_archive_into_container() {
    use std::io::Write;
    const NAME: &str = "mineui-live-unpack";
    cleanup(NAME);
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let id = hub
        .add("Unpack", Some(Mode::Advanced))
        .await
        .unwrap()
        .servers
        .last()
        .unwrap()
        .id
        .clone();
    let core = hub.core(Some(&id)).await.unwrap();
    let mut create = args(NAME, 25596, ModpackSource::Modrinth, "unused");
    create.modpack = None; // a plain vanilla container is enough to hold files
    mineui_core::provision::create(&core, &create)
        .await
        .unwrap();

    // A "server pack" shaped zip: wrapper folder, mods/, and things to skip.
    let archive = tmp.path().join("server pack.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in [
        ("Pack/mods/create-1.21.1.jar", &b"create"[..]),
        ("Pack/mods/jei-1.21.1.jar", &b"jei-bytes"[..]),
        ("Pack/server.jar", &b"server"[..]),
        ("Pack/config/create.toml", &b"x=1"[..]),
    ] {
        writer.start_file(name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();

    let done = mineui_core::mod_archive::unpack(
        &core,
        Some(archive.to_str().unwrap()),
        None,
        None,
        mineui_core::model::ModTarget::Mods,
    )
    .await
    .unwrap();
    assert_eq!(done.installed, ["create-1.21.1.jar", "jei-1.21.1.jar"]);
    assert_eq!(done.skipped, 2);

    let listed = mineui_core::mods::list(&core).await.unwrap();
    let names: Vec<_> = listed.mods.iter().map(|m| m.filename.as_str()).collect();
    assert!(
        names.contains(&"create-1.21.1.jar") && names.contains(&"jei-1.21.1.jar"),
        "{names:?}"
    );
    let jei = listed
        .mods
        .iter()
        .find(|m| m.filename == "jei-1.21.1.jar")
        .unwrap();
    assert_eq!(jei.size_bytes, 9, "content arrived intact");
    // Nothing else from the archive reached the container.
    let ls = runtime(&["exec", NAME, "ls", "/data/mods"]);
    assert!(
        !ls.contains("server.jar") && !ls.contains("create.toml"),
        "{ls}"
    );

    cleanup(NAME);
}

/// `delete_container` against real containers: keeping the world, deleting
/// it, and never deleting a world that lives in a host folder.
#[tokio::test]
#[ignore]
async fn live_delete_container_and_its_data() {
    const NAME: &str = "mineui-live-delete";
    const VOLUME: &str = "mineui-live-delete-data";
    cleanup(NAME);
    let volume_exists = || {
        runtime(&["volume", "ls", "--format", "{{.Name}}"])
            .lines()
            .any(|v| v == VOLUME)
    };
    let container_exists = || {
        runtime(&["ps", "-a", "--format", "{{.Names}}"])
            .lines()
            .any(|n| n == NAME)
    };

    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let id = hub
        .add("Disposable", Some(Mode::Advanced))
        .await
        .unwrap()
        .servers
        .last()
        .unwrap()
        .id
        .clone();
    let core = hub.core(Some(&id)).await.unwrap();
    let mut create = args(NAME, 25598, ModpackSource::Modrinth, "unused");
    create.modpack = None;

    // Nothing to delete yet.
    let mut pointed = core.settings().await;
    pointed.advanced.container_name = NAME.into();
    core.update_settings(pointed).await.unwrap();
    let err = mineui_core::provision::delete(&core, true, true)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "CONTAINER_NOT_FOUND");

    // 1. Delete the container, keep the world.
    mineui_core::provision::create(&core, &create)
        .await
        .unwrap();
    assert!(container_exists() && volume_exists());
    assert_eq!(
        mineui_core::provision::delete(&core, false, false)
            .await
            .unwrap_err()
            .code(),
        "INVALID_INPUT",
        "unconfirmed"
    );
    assert!(container_exists(), "an unconfirmed call removes nothing");
    let done = mineui_core::provision::delete(&core, true, false)
        .await
        .unwrap();
    assert_eq!(done.container_name, NAME);
    assert_eq!((done.deleted_volume, done.data_kept), (None, None));
    assert!(!container_exists());
    assert!(volume_exists(), "the world's volume is kept");
    let state = mineui_core::lifecycle::state(&core).await.unwrap();
    assert_eq!(state.phase, ServerPhase::NotCreated);
    // The profile still knows its container name and ports: create again.
    assert_eq!(core.settings().await.advanced.container_name, NAME);

    // 2. Create again (reusing the volume), then delete everything.
    mineui_core::provision::create(&core, &create)
        .await
        .unwrap();
    let done = mineui_core::provision::delete(&core, true, true)
        .await
        .unwrap();
    assert_eq!(done.deleted_volume.as_deref(), Some(VOLUME));
    assert_eq!(done.data_kept, None);
    assert!(!container_exists() && !volume_exists());

    // 3. A world in a host folder is never deleted, even when asked.
    let world = tmp.path().join("my-world");
    std::fs::create_dir_all(&world).unwrap();
    std::fs::write(world.join("level.dat"), b"precious").unwrap();
    let bind = format!("{}:/data", world.display());
    let out = runtime(&[
        "create",
        "--name",
        NAME,
        "-v",
        &bind,
        "docker.io/itzg/minecraft-server:java21",
    ]);
    assert!(container_exists(), "{out}");
    let done = mineui_core::provision::delete(&core, true, true)
        .await
        .unwrap();
    assert_eq!(done.deleted_volume, None);
    let why = done.data_kept.expect("says why the data stayed");
    assert!(why.contains("my-world"), "{why}");
    assert!(!container_exists());
    assert_eq!(std::fs::read(world.join("level.dat")).unwrap(), b"precious");

    // Every attempt is in the activity log.
    let log = mineui_core::audit::recent(&core, None).await.unwrap();
    let details: Vec<_> = log
        .entries
        .iter()
        .filter(|e| e.action == "container.delete" && e.ok)
        .filter_map(|e| e.detail.as_deref())
        .collect();
    assert_eq!(
        details,
        [
            "data kept",
            "data deleted: mineui-live-delete-data",
            "data kept"
        ]
    );
    cleanup(NAME);
}
