//! Live port-change and join-info tests (contract §3.13 `update_container_ports`,
//! §3.16). **Opt-in** - `#[ignore]`; CI never runs them. Need network (the
//! image downloads the server jar), podman on PATH and the
//! `docker.io/itzg/minecraft-server` image (pulled when missing); they create
//! and remove their own `mineui-live-*` containers and volumes.
//!
//! ```sh
//! cargo test -p mineui-core --test live_ports -- --ignored --test-threads=1
//! ```

use std::time::Duration;

use mineui_core::model::{
    ContainerLoader, CreateContainerArgs, ExtraPort, PortProtocol, PortReach, ReachablePort,
    ServerPhase,
};
use mineui_core::settings::Mode;
use mineui_core::Hub;

fn podman(args: &[&str]) -> String {
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
    podman(&["rm", "-f", name]);
    podman(&["rm", "-f", &format!("{name}-mineui-old")]);
    podman(&["volume", "rm", &format!("{name}-data")]);
}

fn exists(name: &str) -> bool {
    !podman(&["ps", "-a", "-q", "--filter", &format!("name=^{name}$")])
        .trim()
        .is_empty()
}

fn bindings(name: &str) -> Vec<String> {
    let mut lines: Vec<String> = podman(&[
        "inspect",
        "-f",
        "{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}}{{println}}{{end}}{{end}}",
        name,
    ])
    .lines()
    .map(str::trim)
    .filter(|l| !l.is_empty())
    .map(String::from)
    .collect();
    lines.sort();
    lines
}

fn env_value(name: &str, key: &str) -> Option<String> {
    podman(&[
        "inspect",
        "-f",
        "{{range .Config.Env}}{{println .}}{{end}}",
        name,
    ])
    .lines()
    .find_map(|l| l.strip_prefix(&format!("{key}=")).map(String::from))
}

fn status(name: &str) -> String {
    podman(&["inspect", "-f", "{{.State.Status}}", name])
        .trim()
        .to_string()
}

async fn advanced_core(hub: &Hub) -> std::sync::Arc<mineui_core::Core> {
    let id = hub
        .add("Ports", Some(Mode::Advanced))
        .await
        .unwrap()
        .servers
        .last()
        .unwrap()
        .id
        .clone();
    hub.core(Some(&id)).await.unwrap()
}

/// Create a local-only server, then open it to the network with Simple
/// Voice Chat's port: the world, env and image survive and it boots.
#[tokio::test]
#[ignore]
async fn live_update_container_ports_keeps_everything_else() {
    const NAME: &str = "mineui-live-ports";
    const GAME: u16 = 25630;
    const RCON: u16 = 25631;
    const VOICE: u16 = 24454;
    cleanup(NAME);
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let core = advanced_core(&hub).await;

    let create = CreateContainerArgs {
        loader: ContainerLoader::Vanilla,
        mc_version: "1.21.1".into(),
        container_name: NAME.into(),
        memory_mb: 1024,
        game_port: GAME,
        rcon_port: RCON,
        expose_to_network: false,
        accept_eula: true,
        modpack: None,
        extra_ports: vec![],
    };
    let state = mineui_core::provision::create(&core, &create)
        .await
        .unwrap();
    assert_eq!(state.phase, ServerPhase::Running);
    assert_eq!(
        podman(&[
            "inspect",
            "-f",
            "{{index .Config.Labels \"studio.i4c.mineui.managed\"}}",
            NAME
        ])
        .trim(),
        "1",
        "2.11.0 containers carry the managed label"
    );
    let info = mineui_core::joininfo::join_info(&core).await.unwrap();
    assert_eq!(info.port, GAME);
    assert_eq!(info.reach, PortReach::ThisComputer);
    assert!(info.extra_ports.is_empty());
    assert!(info.can_change_ports, "{:?}", info.why_not);

    // Refused while running.
    let err = mineui_core::provision::update_ports(&core, true, &[], true)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "SERVER_RUNNING");

    podman(&["stop", "-t", "20", NAME]);
    let marker = tmp.path().join("marker.txt");
    std::fs::write(&marker, "still here\n").unwrap();
    podman(&[
        "cp",
        marker.to_str().unwrap(),
        &format!("{NAME}:/data/mineui-marker.txt"),
    ]);
    let secret_before = env_value(NAME, "RCON_PASSWORD").expect("rcon secret in env");
    let image_before = podman(&["inspect", "-f", "{{.Config.Image}}", NAME]);

    // A stale "-mineui-old" container is never deleted: refused, named.
    podman(&[
        "create",
        "--name",
        &format!("{NAME}-mineui-old"),
        "docker.io/library/alpine:latest",
    ]);
    let err = mineui_core::provision::update_ports(&core, true, &[], true)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert!(
        err.to_string().contains("mineui-live-ports-mineui-old"),
        "{err}"
    );
    assert!(exists(&format!("{NAME}-mineui-old")));
    podman(&["rm", "-f", &format!("{NAME}-mineui-old")]);

    // A port already bound on the host: refused before anything changes.
    let held = std::net::UdpSocket::bind(("0.0.0.0", 0)).unwrap();
    let held_port = held.local_addr().unwrap().port();
    let err = mineui_core::provision::update_ports(
        &core,
        true,
        &[ExtraPort {
            port: held_port,
            protocol: PortProtocol::Udp,
        }],
        true,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert!(err.to_string().contains("already in use"), "{err}");
    drop(held);
    assert_eq!(
        bindings(NAME),
        [
            format!("127.0.0.1:{GAME}->25565/tcp"),
            format!("127.0.0.1:{RCON}->25575/tcp"),
        ]
    );

    // The change itself.
    let voice = ExtraPort {
        port: VOICE,
        protocol: PortProtocol::Udp,
    };
    let state = mineui_core::provision::update_ports(&core, true, &[voice], true)
        .await
        .unwrap();
    assert_eq!(state.phase, ServerPhase::Stopped);
    assert!(exists(NAME));
    assert!(!exists(&format!("{NAME}-mineui-old")));
    assert_eq!(status(NAME), "created", "recreated, not started");
    assert_eq!(
        bindings(NAME),
        [
            // sorted as text
            format!("0.0.0.0:{VOICE}->{VOICE}/udp"),
            format!("0.0.0.0:{GAME}->25565/tcp"),
            format!("127.0.0.1:{RCON}->25575/tcp"),
        ]
    );
    assert!(
        env_value(NAME, "RCON_PASSWORD").as_deref() == Some(secret_before.as_str()),
        "the RCON secret survives"
    );
    assert_eq!(env_value(NAME, "TYPE").as_deref(), Some("VANILLA"));
    assert_eq!(env_value(NAME, "VERSION").as_deref(), Some("1.21.1"));
    assert_eq!(env_value(NAME, "EULA").as_deref(), Some("TRUE"));
    assert_eq!(env_value(NAME, "MEMORY").as_deref(), Some("1024M"));
    assert_eq!(
        podman(&["inspect", "-f", "{{.Config.Image}}", NAME]),
        image_before
    );
    let marker_back = podman(&[
        "run",
        "--rm",
        "-v",
        &format!("{NAME}-data:/data:ro"),
        "docker.io/library/alpine:latest",
        "cat",
        "/data/mineui-marker.txt",
    ]);
    assert_eq!(marker_back.trim(), "still here");

    let info = mineui_core::joininfo::join_info(&core).await.unwrap();
    assert_eq!(info.reach, PortReach::Network);
    assert_eq!(
        info.extra_ports,
        [ReachablePort {
            port: VOICE,
            protocol: PortProtocol::Udp,
            reach: PortReach::Network,
        }]
    );
    assert!(info.can_change_ports);
    let log = mineui_core::audit::recent(&core, None).await.unwrap();
    assert!(log.entries.iter().any(|e| e.action == "container.ports"
        && e.ok
        && e.detail.as_deref() == Some("network; +24454/udp")));

    // The rebuilt container boots and answers RCON with the same secret.
    mineui_core::lifecycle::start(&core).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        if let Ok(out) = mineui_core::rcon::run_allowlisted(&core, "list").await {
            assert!(out.contains("players online"), "{out}");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "rebuilt server did not become RCON-ready:\n{}",
            podman(&["logs", "--tail", "30", NAME])
        );
        tokio::time::sleep(Duration::from_secs(4)).await;
    }

    cleanup(NAME);
}

/// `canChangePorts` for containers MineUI did not label: the pre-2.11.0
/// shape is accepted, anything else is not. Nothing is started.
#[tokio::test]
#[ignore]
async fn live_join_info_shape_check() {
    const NAME: &str = "mineui-live-shape";
    cleanup(NAME);
    let tmp = tempfile::tempdir().unwrap();
    let hub = Hub::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let core = advanced_core(&hub).await;
    let mut s = core.settings().await;
    s.advanced.container_name = NAME.into();
    s.advanced.query_port = 25640;
    s.advanced.rcon_port = 25641;
    core.update_settings(s).await.unwrap();

    let info = mineui_core::joininfo::join_info(&core).await.unwrap();
    assert_eq!(info.reach, PortReach::Unknown);
    assert!(!info.can_change_ports);
    assert_eq!(info.why_not.as_deref(), Some("There is no container yet."));

    // What 2.6.0-2.10.x created: itzg image, one named volume, no label.
    podman(&[
        "create",
        "--name",
        NAME,
        "-p",
        "0.0.0.0:25640:25565",
        "-p",
        "127.0.0.1:25641:25575",
        "-v",
        &format!("{NAME}-data:/data"),
        "docker.io/itzg/minecraft-server:java21",
    ]);
    let info = mineui_core::joininfo::join_info(&core).await.unwrap();
    assert_eq!(info.reach, PortReach::Network);
    assert!(info.extra_ports.is_empty(), "RCON is not an extra port");
    assert!(info.can_change_ports, "{:?}", info.why_not);
    assert!(info.why_not.is_none());
    podman(&["rm", "-f", NAME]);

    // Somebody else's container: an extra bind mount.
    let extra = tmp.path().join("mods");
    std::fs::create_dir_all(&extra).unwrap();
    podman(&[
        "create",
        "--name",
        NAME,
        "-p",
        "127.0.0.1:25640:25565",
        "-v",
        &format!("{NAME}-data:/data"),
        "-v",
        &format!("{}:/mods", extra.display()),
        "docker.io/itzg/minecraft-server:java21",
    ]);
    let info = mineui_core::joininfo::join_info(&core).await.unwrap();
    assert_eq!(info.reach, PortReach::ThisComputer);
    assert!(!info.can_change_ports);
    assert!(info
        .why_not
        .as_deref()
        .unwrap()
        .contains("not created by MineUI"));
    let err = mineui_core::provision::update_ports(&core, true, &[], true)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert!(err.to_string().contains("not created by MineUI"), "{err}");

    cleanup(NAME);
}
