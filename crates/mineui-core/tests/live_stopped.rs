//! Live test for listings on a **stopped** container (contract §3.4, §3.5,
//! §3.8, 2.9.0). **Opt-in** — `#[ignore]`; CI never runs it. Needs podman on
//! PATH and the `itzg/minecraft-server:java21` image (pulled if missing). It
//! creates its own `mineui-live-stopped` container + volume (no Minecraft
//! server runs: the entrypoint is `sleep`) and removes both afterwards.
//!
//! ```sh
//! cargo test -p mineui-core --test live_stopped -- --ignored
//! ```

use mineui_core::settings::{Mode, Settings};
use mineui_core::Core;

const NAME: &str = "mineui-live-stopped";
const IMAGE: &str = "docker.io/itzg/minecraft-server:java21";
const BACKUP: &str = "world-20261003-120000.tar.gz";
const OLDER: &str = "world-20261002-120000.tar.gz";

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

async fn core_for(tmp: &std::path::Path, container: &str) -> std::sync::Arc<Core> {
    let mut settings = Settings::default_with_data_dir(&tmp.join("data"));
    settings.active_mode = Mode::Advanced;
    settings.advanced.container_name = container.into();
    settings.advanced.rcon_host = "127.0.0.1".into();
    // Nothing listens here: RCON is unreachable, as on a stopped server.
    settings.advanced.rcon_port = 9;
    Core::init_with_settings(tmp.join("config"), tmp.join("data"), settings).await
}

#[tokio::test]
#[ignore]
async fn live_listings_work_while_the_container_is_stopped() {
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
    // Test fixture only: a constant script, nothing interpolated.
    let seed = podman(&[
        "exec",
        NAME,
        "sh",
        "-c",
        "mkdir -p /data/backups /data/mods /data/plugins /data/logs \
         && echo world | gzip > /data/backups/world-20261003-120000.tar.gz \
         && echo older | gzip > /data/backups/world-20261002-120000.tar.gz \
         && echo jar > /data/mods/fabric-api.jar \
         && echo jar > /data/plugins/EssentialsX.jar \
         && echo '[10:00:00] [Server thread/INFO]: Alice joined the game' > /data/logs/latest.log",
    ]);
    assert!(
        seed.status.success(),
        "{}",
        String::from_utf8_lossy(&seed.stderr)
    );

    let tmp = tempfile::tempdir().unwrap();
    let core = core_for(tmp.path(), NAME).await;

    // Running: the exec path.
    let running = mineui_core::backups::list(&core)
        .await
        .expect("list running");
    assert_eq!(running.len(), 2, "{running:?}");

    podman(&["stop", "-t", "0", NAME]);
    let state = mineui_core::lifecycle::state(&core).await.unwrap();
    assert_eq!(state.phase, mineui_core::model::ServerPhase::Stopped);

    // Stopped: the volumes-from helper. Before 2.9.0 this was [].
    let stopped = mineui_core::backups::list(&core)
        .await
        .expect("list stopped");
    let names: Vec<&str> = stopped.iter().map(|b| b.filename.as_str()).collect();
    assert_eq!(names, [BACKUP, OLDER]);
    assert!(stopped[0].size_bytes > 0);

    mineui_core::backups::delete(&core, OLDER)
        .await
        .expect("delete while stopped");
    let after = mineui_core::backups::list(&core).await.unwrap();
    let names: Vec<&str> = after.iter().map(|b| b.filename.as_str()).collect();
    assert_eq!(names, [BACKUP]);

    let mods = mineui_core::mods::list(&core).await.expect("mods stopped");
    assert_eq!(mods.mods.len(), 1, "{mods:?}");
    assert_eq!(mods.mods[0].filename, "fabric-api.jar");
    assert_eq!(mods.plugins.len(), 1);

    mineui_core::notes::set(&core, "Zed", "griefed spawn")
        .await
        .unwrap();
    let history = mineui_core::players::history(&core)
        .await
        .expect("history without RCON");
    assert!(!history.rcon_available);
    let users: Vec<&str> = history.users.iter().map(|u| u.username.as_str()).collect();
    assert!(users.contains(&"Alice"), "log-derived row: {users:?}");
    assert!(users.contains(&"Zed"), "noted player: {users:?}");
    assert!(history.users.iter().all(|u| !u.is_online));

    // The container is still there afterwards (helpers are --rm, never it).
    assert!(podman(&["container", "exists", NAME]).status.success());

    // Missing container: CONTAINER_NOT_FOUND, not an empty list.
    let missing = core_for(tmp.path(), "mineui-live-does-not-exist").await;
    let err = mineui_core::backups::list(&missing).await.unwrap_err();
    assert_eq!(err.code(), "CONTAINER_NOT_FOUND");
    let err = mineui_core::mods::list(&missing).await.unwrap_err();
    assert_eq!(err.code(), "CONTAINER_NOT_FOUND");
}

/// §3.1 (2.9.0): a working CLI whose engine cannot be reached is
/// RUNTIME_UNAVAILABLE, not RUNTIME_NOT_FOUND. A socket nobody serves stands
/// in for a stopped `podman machine` / Docker Desktop.
#[tokio::test]
#[ignore]
async fn live_dead_socket_is_runtime_unavailable() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default_with_data_dir(&tmp.path().join("data"));
    settings.active_mode = Mode::Advanced;
    settings.advanced.container_name = NAME.into();
    settings.advanced.socket_path = Some(
        tmp.path()
            .join("nobody-serves-this.sock")
            .to_string_lossy()
            .to_string(),
    );
    let core =
        Core::init_with_settings(tmp.path().join("config"), tmp.path().join("data"), settings)
            .await;
    let err = mineui_core::lifecycle::state(&core).await.unwrap_err();
    assert_eq!(err.code(), "RUNTIME_UNAVAILABLE", "{err}");
    let message = err.to_string();
    assert!(
        message.starts_with("podman is installed but not responding"),
        "{message}"
    );
    let err = mineui_core::backups::list(&core).await.unwrap_err();
    assert_eq!(err.code(), "RUNTIME_UNAVAILABLE", "{err}");
}

/// §3.1 (2.9.0): Auto honors `runtimeBinary`, inferring the kind from
/// `--version`.
#[tokio::test]
#[ignore]
async fn live_auto_honors_the_binary_override() {
    let which = std::process::Command::new("which")
        .arg("podman")
        .output()
        .expect("which");
    let path = String::from_utf8_lossy(&which.stdout).trim().to_string();
    assert!(!path.is_empty(), "podman on PATH");
    let mut settings = Settings::default();
    assert_eq!(
        settings.advanced.runtime,
        mineui_core::settings::RuntimeKind::Auto
    );
    settings.advanced.runtime_binary = Some(path.clone().into());
    let probe = mineui_core::runtime::detect(&settings.advanced).await;
    assert_eq!(probe.resolved.as_deref(), Some("podman"));
    assert_eq!(probe.podman.as_ref().unwrap().binary, path);
    let runtime = mineui_core::runtime::resolve(&settings.advanced)
        .await
        .unwrap();
    assert_eq!(runtime.kind(), "podman");

    // An override that does not run falls back to PATH.
    settings.advanced.runtime_binary = Some("/nonexistent/podman".into());
    let probe = mineui_core::runtime::detect(&settings.advanced).await;
    assert_eq!(probe.podman.as_ref().unwrap().binary, "podman");
}
