//! Live multi-server test (contract §2.5, §3.12): one `Hub` managing a Forge
//! and a Fabric container **at the same time**. **Opt-in** — `#[ignore]`; CI
//! never runs it.
//!
//! Prerequisite: two itzg/minecraft-server containers on rootless podman (or
//! docker), loopback ports as below, both past `]: Done (`:
//!
//! ```sh
//! podman run -d --name mc-forge  -e EULA=TRUE -e TYPE=FORGE  -e VERSION=1.21.1 \
//!   -e MOTD="Forge server"  -e RCON_PASSWORD="$FORGE_PW" \
//!   -p 127.0.0.1:25566:25565 -p 127.0.0.1:25576:25575 \
//!   docker.io/itzg/minecraft-server:java21
//! podman run -d --name mc-fabric -e EULA=TRUE -e TYPE=FABRIC -e VERSION=1.21.1 \
//!   -e MOTD="Fabric server" -e RCON_PASSWORD="$FABRIC_PW" \
//!   -p 127.0.0.1:25567:25565 -p 127.0.0.1:25577:25575 \
//!   docker.io/itzg/minecraft-server:java21
//!
//! MINEUI_LIVE_FORGE_RCON_PASSWORD="$FORGE_PW" \
//! MINEUI_LIVE_FABRIC_RCON_PASSWORD="$FABRIC_PW" \
//!   cargo test -p mineui-core --test live_two_servers -- --ignored
//! ```

use std::sync::Arc;
use std::time::Duration;

use mineui_core::model::{CoreEvent, ServerPhase};
use mineui_core::settings::Mode;
use mineui_core::{Core, Hub};

struct Target {
    name: &'static str,
    container: &'static str,
    game_port: u16,
    rcon_port: u16,
    env_var: &'static str,
    motd: &'static str,
    /// Substring of the brand the loader logs at startup.
    log_marker: &'static str,
}

const FORGE: Target = Target {
    name: "Forge",
    container: "mc-forge",
    game_port: 25566,
    rcon_port: 25576,
    env_var: "MINEUI_LIVE_FORGE_RCON_PASSWORD",
    motd: "Forge server",
    log_marker: "forge",
};

const FABRIC: Target = Target {
    name: "Fabric",
    container: "mc-fabric",
    game_port: 25567,
    rcon_port: 25577,
    env_var: "MINEUI_LIVE_FABRIC_RCON_PASSWORD",
    motd: "Fabric server",
    log_marker: "fabric",
};

/// Add a profile for `target` and point it at its container.
async fn attach(hub: &Hub, target: &Target) -> (String, Arc<Core>) {
    let Ok(password) = std::env::var(target.env_var) else {
        panic!("a required environment variable is not set — see the file header");
    };
    let list = hub.add(target.name, Some(Mode::Advanced)).await.unwrap();
    let id = list.servers.last().unwrap().id.clone();
    let core = hub.core(Some(&id)).await.unwrap();
    let mut settings = core.settings().await;
    settings.advanced.container_name = target.container.into();
    settings.advanced.query_port = target.game_port;
    settings.advanced.rcon_port = target.rcon_port;
    settings.advanced.rcon_password = password;
    core.update_settings(settings).await.unwrap();
    (id, core)
}

#[tokio::test]
#[ignore]
async fn live_forge_and_fabric_managed_at_once() {
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let (forge_id, forge) = attach(&hub, &FORGE).await;
    let (fabric_id, fabric) = attach(&hub, &FABRIC).await;
    assert_ne!(forge_id, fabric_id);

    // Both containers are seen running, in one probe round.
    let overview = hub.overview().await;
    assert_eq!(overview.len(), 3, "default + forge + fabric");
    for (id, target) in [(&forge_id, &FORGE), (&fabric_id, &FABRIC)] {
        let entry = overview.iter().find(|o| &o.id == id).unwrap();
        assert_eq!(entry.name, target.name);
        assert_eq!(entry.mode, Mode::Advanced);
        assert_eq!(entry.phase, Some(ServerPhase::Running), "{}", target.name);
        assert!(entry.error.is_none(), "{:?}", entry.error);
        assert!(
            entry.status.online,
            "{} SLP: {:?}",
            target.name, entry.status.error
        );
        // The MOTD proves each profile pinged its *own* server.
        assert_eq!(entry.status.motd.as_deref(), Some(target.motd));
        // Identity: what tells the two apart regardless of their names.
        assert_eq!(entry.container_name.as_deref(), Some(target.container));
        assert_eq!(entry.address, format!("127.0.0.1:{}", target.game_port));
        assert_eq!(entry.loader.as_deref(), Some(target.log_marker));
        assert_eq!(entry.mc_version.as_deref(), Some("1.21.1"));
    }

    // RCON to both servers concurrently, each with its own credentials.
    let (forge_list, fabric_list) = tokio::join!(
        mineui_core::rcon::run_allowlisted(&forge, "list"),
        mineui_core::rcon::run_allowlisted(&fabric, "list"),
    );
    assert!(forge_list.unwrap().contains("players online"));
    assert!(fabric_list.unwrap().contains("players online"));

    // Each profile reads its own container's log.
    for (core, target) in [(&forge, &FORGE), (&fabric, &FABRIC)] {
        let tail = mineui_core::logs::tail(core, Some(1000)).await.unwrap();
        let joined = tail.lines.join("\n").to_lowercase();
        assert!(
            joined.contains(target.log_marker),
            "{} log should mention its loader",
            target.name
        );
    }

    // Live log streams run side by side and stay separated: a line said on
    // one server arrives tagged with that server's id and never the other's.
    let mut rx = hub.subscribe_events();
    mineui_core::logs::stream_start(&forge).await.unwrap();
    mineui_core::logs::stream_start(&fabric).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    mineui_core::rcon::run_allowlisted(&forge, "say mineui-live-forge-marker")
        .await
        .unwrap();
    mineui_core::rcon::run_allowlisted(&fabric, "say mineui-live-fabric-marker")
        .await
        .unwrap();

    let (mut forge_seen, mut fabric_seen) = (false, false);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !(forge_seen && fabric_seen) {
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("both markers within 10 s")
            .unwrap();
        let CoreEvent::Logs(logs) = ev.event else {
            continue;
        };
        for line in &logs.lines {
            if line.text.contains("mineui-live-forge-marker") {
                assert_eq!(ev.server_id, forge_id, "forge line under the wrong id");
                forge_seen = true;
            }
            if line.text.contains("mineui-live-fabric-marker") {
                assert_eq!(ev.server_id, fabric_id, "fabric line under the wrong id");
                fabric_seen = true;
            }
        }
    }
    mineui_core::logs::stream_stop(&forge).await.unwrap();
    mineui_core::logs::stream_stop(&fabric).await.unwrap();

    // Per-profile state: the audit trail of one server is not the other's.
    let forge_audit = mineui_core::audit::recent(&forge, None).await.unwrap();
    let said: Vec<_> = forge_audit
        .entries
        .iter()
        .filter_map(|e| e.detail.as_deref())
        .filter(|d| d.contains("marker"))
        .collect();
    assert_eq!(said, vec!["say mineui-live-forge-marker"]);

    // Removing a profile detaches MineUI; the container keeps running.
    hub.remove(&fabric_id, true).await.unwrap();
    let overview = hub.overview().await;
    assert!(overview.iter().all(|o| o.id != fabric_id));
    let forge_entry = overview.iter().find(|o| o.id == forge_id).unwrap();
    assert_eq!(forge_entry.phase, Some(ServerPhase::Running));
    let still_up = mineui_core::query::ping("127.0.0.1", FABRIC.game_port).await;
    assert!(
        still_up.is_ok(),
        "removing a profile must not stop its server"
    );
}

/// Every per-server feature works on both loaders, and each profile only
/// ever touches its own container.
#[tokio::test]
#[ignore]
async fn live_feature_surface_on_both_loaders() {
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let (_, forge) = attach(&hub, &FORGE).await;
    let (_, fabric) = attach(&hub, &FABRIC).await;

    for (core, target) in [(&forge, &FORGE), (&fabric, &FABRIC)] {
        let name = target.name;

        let state = mineui_core::lifecycle::state(core).await.unwrap();
        assert_eq!(state.phase, ServerPhase::Running, "{name}");
        assert!(state.container.unwrap().started_at.is_some(), "{name}");

        let players = mineui_core::players::online(core).await.unwrap();
        assert!(players.players.is_empty(), "{name}: {:?}", players.raw);
        mineui_core::players::history(core).await.unwrap();

        // No output on any loader — and no 5 s stall on Forge.
        let started = std::time::Instant::now();
        let said = mineui_core::rcon::run_allowlisted(core, "say feature-check").await;
        assert_eq!(said.unwrap(), "", "{name}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{name} say stalled"
        );

        mineui_core::mods::list(core).await.unwrap();
        let configs = mineui_core::config_files::list(core).await.unwrap();
        assert!(
            configs.files.iter().any(|f| f == "server.properties"),
            "{name}: {:?}",
            configs.files
        );
        let props = mineui_core::config_files::read(core, "server.properties")
            .await
            .unwrap();
        assert!(
            props.content.contains(&format!("motd={}", target.motd)),
            "{name} read another server's properties"
        );

        let metrics = mineui_core::metrics::get(core).await.unwrap();
        assert_eq!(metrics.base, "container", "{name}");
        assert!(metrics.mem.used_bytes.unwrap_or(0) > 0, "{name}");

        let backup = mineui_core::backups::create(core).await.unwrap().entry;
        assert!(backup.size_bytes > 0, "{name}");
        let listed = mineui_core::backups::list(core).await.unwrap();
        assert!(
            listed.iter().any(|b| b.filename == backup.filename),
            "{name}"
        );
        mineui_core::backups::delete(core, &backup.filename)
            .await
            .unwrap();
    }
}

/// `create_container` (§3.13) end to end: MineUI makes a brand-new itzg
/// container, wires the profile to it, and the server comes up reachable
/// with the generated RCON password. Needs no pre-existing container; pulls
/// `itzg/minecraft-server:java21` if missing. Cleans up after itself.
#[tokio::test]
#[ignore]
async fn live_create_container_end_to_end() {
    use mineui_core::model::{ContainerLoader, CreateContainerArgs};

    const NAME: &str = "mineui-live-create";
    const GAME_PORT: u16 = 25590;
    const RCON_PORT: u16 = 25591;
    let podman = |args: &[&str]| {
        let _ = std::process::Command::new("podman").args(args).output();
    };
    podman(&["rm", "-f", NAME]);

    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let list = hub.add("Created here", Some(Mode::Advanced)).await.unwrap();
    let id = list.servers.last().unwrap().id.clone();
    let core = hub.core(Some(&id)).await.unwrap();

    let args = CreateContainerArgs {
        loader: ContainerLoader::Vanilla,
        mc_version: "1.21.1".into(),
        container_name: NAME.into(),
        memory_mb: 1024,
        game_port: GAME_PORT,
        rcon_port: RCON_PORT,
        expose_to_network: false,
        accept_eula: true,
        modpack: None,
    };
    let state = mineui_core::provision::create(&core, &args).await.unwrap();
    assert_eq!(state.phase, ServerPhase::Running);

    // The profile now points at the container, with a generated password.
    let settings = core.settings().await;
    assert_eq!(settings.advanced.container_name, NAME);
    assert_eq!(settings.advanced.query_port, GAME_PORT);
    assert_eq!(settings.advanced.rcon_port, RCON_PORT);
    assert_eq!(settings.advanced.rcon_password.len(), 24);
    // No env file (it held the password) is left behind.
    let leftovers = std::fs::read_dir(tmp.path().join("data/servers").join(&id).join("tmp"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(leftovers, 0);

    // A second create never touches the existing container.
    let err = mineui_core::provision::create(&core, &args)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "CONTAINER_EXISTS");

    // Identity comes straight from the container MineUI just made.
    let entry = hub
        .overview()
        .await
        .into_iter()
        .find(|o| o.id == id)
        .unwrap();
    assert_eq!(entry.loader.as_deref(), Some("vanilla"));
    assert_eq!(entry.mc_version.as_deref(), Some("1.21.1"));
    assert_eq!(entry.container_name.as_deref(), Some(NAME));

    // The server inside comes up and answers RCON with that password.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    loop {
        if let Ok(out) = mineui_core::rcon::run_allowlisted(&core, "list").await {
            assert!(out.contains("players online"), "{out}");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "created server did not become RCON-ready"
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    let status = mineui_core::status::get(&core).await.unwrap();
    assert!(status.online, "{:?}", status.error);
    assert_eq!(status.version.as_deref(), Some("1.21.1"));

    podman(&["rm", "-f", NAME]);
    podman(&["volume", "rm", &format!("{NAME}-data")]);
}
