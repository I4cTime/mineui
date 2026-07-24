//! Live integration tests for Advanced mode against a real rootless podman
//! container. **Opt-in** — every test is `#[ignore]`; CI never runs them.
//!
//! Prerequisite (matches the shapes these tests assert against, validated on
//! podman 4.9.3 + itzg/minecraft-server, Minecraft 26.2):
//!
//! ```sh
//! podman run -d --name minecraft-server -e EULA=TRUE -e TYPE=VANILLA \
//!   -e MEMORY=2G -e RCON_PASSWORD=mineui-adv-test \
//!   -p 25565:25565 -p 25575:25575 docker.io/itzg/minecraft-server
//! # wait for readiness ("]: Done (" in `podman logs minecraft-server`)
//! cargo test -p mineui-core -- --ignored
//! ```
//!
//! Tests share one container, so they serialize on a process-wide mutex.
//! The restore test stops/starts the container but always brings it back up
//! (and waits for RCON readiness) before releasing the lock.

use std::sync::Arc;
use std::time::Duration;

use mineui_core::model::ServerPhase;
use mineui_core::settings::{Mode, Settings};
use mineui_core::Core;

const CONTAINER: &str = "minecraft-server";
const HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 25565;
const RCON_PORT: u16 = 25575;
const RCON_PASSWORD: &str = "mineui-adv-test";

// Async-aware so the guard may be held across await points (each test runs
// on its own #[tokio::test] runtime; tokio's Mutex is runtime-agnostic).
static LIVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn live_lock() -> tokio::sync::MutexGuard<'static, ()> {
    LIVE_LOCK.lock().await
}

fn advanced_settings(data_dir: &std::path::Path) -> Settings {
    let mut settings = Settings::default_with_data_dir(data_dir);
    settings.active_mode = Mode::Advanced;
    settings.advanced.container_name = CONTAINER.into();
    settings.advanced.query_host = HOST.into();
    settings.advanced.query_port = SERVER_PORT;
    settings.advanced.rcon_host = HOST.into();
    settings.advanced.rcon_port = RCON_PORT;
    settings.advanced.rcon_password = RCON_PASSWORD.into();
    settings
}

async fn live_core() -> (tempfile::TempDir, Arc<Core>) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let settings = advanced_settings(&tmp.path().join("data"));
    let core =
        Core::init_with_settings(tmp.path().join("config"), tmp.path().join("data"), settings)
            .await;
    (tmp, core)
}

async fn resolve_runtime() -> Box<dyn mineui_core::runtime::Runtime> {
    let settings = advanced_settings(std::path::Path::new("/tmp"));
    mineui_core::runtime::resolve(&settings.advanced)
        .await
        .expect("podman or docker CLI on PATH")
}

/// Poll until the server answers RCON `list` (used after restarts).
async fn wait_for_rcon_ready(timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Ok(mut client) =
            mineui_core::rcon::RconClient::connect(HOST, RCON_PORT, RCON_PASSWORD).await
        {
            if client.exec("list").await.is_ok() {
                return;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "server did not become RCON-ready within {timeout:?}"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/* ---------- runtime adapter ---------- */

#[tokio::test]
#[ignore]
async fn live_ps_state_running() {
    let _g = live_lock().await;
    let runtime = resolve_runtime().await;
    let detail = runtime.ps_state(CONTAINER).await.expect("ps_state");
    assert!(detail.exists, "container '{CONTAINER}' must exist");
    assert!(detail.id.is_some(), "ps JSON must carry an id");
    let status = detail.status.expect("ps JSON must carry a state/status");
    assert!(
        status.eq_ignore_ascii_case("running") || status.to_lowercase().starts_with("up"),
        "expected a running status, got {status:?}"
    );
    assert!(detail.created_at.is_some(), "createdAt should be reported");
}

#[tokio::test]
#[ignore]
async fn live_missing_container_maps_to_not_exists() {
    let _g = live_lock().await;
    let runtime = resolve_runtime().await;
    let detail = runtime
        .ps_state("mineui-live-test-does-not-exist")
        .await
        .expect("ps_state on missing name still succeeds");
    assert!(!detail.exists);
}

#[tokio::test]
#[ignore]
async fn live_inspect_started_at_is_rfc3339() {
    let _g = live_lock().await;
    let runtime = resolve_runtime().await;
    let started_at = runtime
        .inspect_started_at(CONTAINER)
        .await
        .expect("inspect")
        .expect("running container must have a StartedAt (local-zone podman output must parse)");
    chrono::DateTime::parse_from_rfc3339(&started_at)
        .unwrap_or_else(|e| panic!("startedAt {started_at:?} is not RFC 3339: {e}"));
}

#[tokio::test]
#[ignore]
async fn live_stats_parse_real_keys() {
    let _g = live_lock().await;
    let runtime = resolve_runtime().await;
    let stats = runtime.stats(CONTAINER).await.expect("stats");
    assert!(stats.cpu_percent.is_some(), "cpu_percent must parse");
    assert!(
        stats.mem_used_bytes.unwrap_or(0) > 0,
        "mem usage of a running JVM must be > 0, got {:?}",
        stats.mem_used_bytes
    );
    assert!(stats.mem_total_bytes.unwrap_or(0) > 0);
    assert!(stats.mem_percent.is_some());
    assert!(stats.net_input_bytes.is_some());
    assert!(stats.net_output_bytes.is_some());
    assert!(stats.block_input_bytes.is_some());
    assert!(stats.block_output_bytes.is_some());
}

#[tokio::test]
#[ignore]
async fn live_logs_tail() {
    let _g = live_lock().await;
    let runtime = resolve_runtime().await;
    let lines = runtime.logs_tail(CONTAINER, 50).await.expect("logs_tail");
    assert!(!lines.is_empty(), "a booted server must have log lines");
    assert!(
        lines.iter().any(|l| l.contains('[')),
        "expected vanilla [HH:MM:SS] log lines, got {:?}",
        lines.first()
    );
}

/* ---------- lifecycle / state mapping ---------- */

#[tokio::test]
#[ignore]
async fn live_lifecycle_state_running_phase() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    let state = mineui_core::lifecycle::state(&core).await.expect("state");
    assert_eq!(state.mode, Mode::Advanced);
    assert_eq!(state.phase, ServerPhase::Running);
    let container = state.container.expect("advanced state carries container");
    assert!(container.exists);
    assert!(
        container.started_at.is_some(),
        "startedAt must be filled from inspect"
    );
}

/* ---------- config files ---------- */

#[tokio::test]
#[ignore]
async fn live_config_list_and_read() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    let listing = mineui_core::config_files::list(&core).await.expect("list");
    assert!(
        listing.files.contains(&"server.properties".to_string()),
        "itzg /data always has server.properties, got {:?}",
        listing.files
    );
    let content = mineui_core::config_files::read(&core, "server.properties")
        .await
        .expect("read server.properties");
    assert!(
        content.content.contains("rcon.port"),
        "server.properties should contain rcon settings"
    );
}

#[tokio::test]
#[ignore]
async fn live_config_write_roundtrip_creates_missing_subdir() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    // Vanilla itzg has no /data/config — the write must create it
    // (regression: bare `podman cp` fails when the parent dir is missing).
    let rel = "config/mineui-live-test.toml";
    let body = "mineui = \"live-test\"\n";
    mineui_core::config_files::write(&core, rel, body)
        .await
        .expect("write into missing /data/config");
    let read_back = mineui_core::config_files::read(&core, rel)
        .await
        .expect("read back");
    assert_eq!(read_back.content, body);
    let listing = mineui_core::config_files::list(&core).await.expect("list");
    assert!(listing.files.contains(&rel.to_string()));

    // Cleanup so reruns start from the vanilla layout.
    let runtime = resolve_runtime().await;
    let rm = runtime
        .exec(
            CONTAINER,
            &["rm", "-f", "--", "/data/config/mineui-live-test.toml"],
        )
        .await
        .expect("cleanup rm");
    assert!(rm.success());
    let _ = runtime
        .exec(
            CONTAINER,
            &["rmdir", "--ignore-fail-on-non-empty", "/data/config"],
        )
        .await;
}

/* ---------- mods ---------- */

#[tokio::test]
#[ignore]
async fn live_mods_list_vanilla_is_empty_not_error() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    // Vanilla server: no /data/mods, no /data/plugins — must be an empty
    // result, not an error.
    let mods = mineui_core::mods::list(&core).await.expect("mods list");
    assert!(mods.mods.is_empty(), "vanilla has no mods dir");
    assert!(mods.plugins.is_empty(), "vanilla has no plugins dir");
}

/* ---------- backups ---------- */

#[tokio::test]
#[ignore]
async fn live_backup_create_list_delete() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    let created = mineui_core::backups::create(&core).await.expect("create");
    assert!(
        created.size_bytes > 0,
        "tar.gz of a world must be non-empty"
    );
    assert!(created.created_at_epoch_ms > 0);

    let listed = mineui_core::backups::list(&core).await.expect("list");
    assert!(
        listed.iter().any(|b| b.filename == created.filename),
        "created backup must appear in list, got {listed:?}"
    );

    mineui_core::backups::delete(&core, &created.filename)
        .await
        .expect("delete");
    let listed = mineui_core::backups::list(&core).await.expect("list again");
    assert!(!listed.iter().any(|b| b.filename == created.filename));
}

#[tokio::test]
#[ignore]
async fn live_backup_restore_cycle_stops_and_restarts() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;

    // Create a backup while running (crash-consistent, allowed).
    let backup = mineui_core::backups::create(&core).await.expect("create");

    // Restore while running must be rejected.
    let err = mineui_core::backups::restore(&core, &backup.filename)
        .await
        .expect_err("restore while running must fail");
    assert_eq!(err.code(), "SERVER_RUNNING");

    // Stop, restore (runs in a --volumes-from helper container since exec is
    // impossible on a stopped container), then bring the server back up.
    mineui_core::lifecycle::stop(&core).await.expect("stop");
    let state = mineui_core::lifecycle::state(&core).await.expect("state");
    assert_eq!(state.phase, ServerPhase::Stopped);

    let restore_result = mineui_core::backups::restore(&core, &backup.filename).await;

    // Verify + clean up the preserved world dir regardless of outcome.
    let runtime = resolve_runtime().await;
    let preserved = runtime
        .run_with_volumes_from(
            CONTAINER,
            &[
                "find",
                "/data",
                "-maxdepth",
                "1",
                "-name",
                "world.pre-restore-*",
            ],
        )
        .await
        .expect("find preserved worlds");
    let preserved_dirs: Vec<String> = preserved
        .stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    for dir in &preserved_dirs {
        let _ = runtime
            .run_with_volumes_from(CONTAINER, &["rm", "-rf", "--", dir])
            .await;
    }
    let _ = mineui_core::backups::delete(&core, &backup.filename).await;

    // Bring the server back before asserting, so a failure never leaves the
    // container stopped.
    mineui_core::lifecycle::start(&core).await.expect("start");
    wait_for_rcon_ready(Duration::from_secs(300)).await;

    restore_result.expect("restore on a stopped container");
    assert!(
        !preserved_dirs.is_empty(),
        "restore must preserve the old world as world.pre-restore-*"
    );
}

/* ---------- RCON + players ---------- */

#[tokio::test]
#[ignore]
async fn live_rcon_auth_and_list() {
    let _g = live_lock().await;
    let mut client = mineui_core::rcon::RconClient::connect(HOST, RCON_PORT, RCON_PASSWORD)
        .await
        .expect("RCON connect+auth");
    let raw = client.exec("list").await.expect("rcon list");
    assert!(
        raw.contains("players online"),
        "unexpected list output: {raw:?}"
    );
    // No one is connected to the test server; the trailing ": " must parse
    // to an empty player list (not [""]).
    assert!(mineui_core::players::parse_list_output(&raw).is_empty());
}

#[tokio::test]
#[ignore]
async fn live_rcon_bad_password_is_auth_failure() {
    let _g = live_lock().await;
    let err = mineui_core::rcon::RconClient::connect(HOST, RCON_PORT, "wrong-password")
        .await
        .err()
        .expect("bad password must fail");
    assert_eq!(err.code(), "RCON_UNAVAILABLE");
}

#[tokio::test]
#[ignore]
async fn live_players_online_empty() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    let players = mineui_core::players::online(&core).await.expect("players");
    assert!(players.players.is_empty());
    assert!(players.raw.contains("players online"));
}

/* ---------- SLP / status ---------- */

#[tokio::test]
#[ignore]
async fn live_slp_ping() {
    let _g = live_lock().await;
    let status = mineui_core::query::ping(HOST, SERVER_PORT)
        .await
        .expect("server list ping");
    assert!(status.online);
    assert!(status.version.is_some(), "version.name must parse");
    assert_eq!(status.motd.as_deref(), Some("A Minecraft Server"));
    assert!(status.players.max > 0, "players.max must parse");
    assert_eq!(status.source, "query");
}

#[tokio::test]
#[ignore]
async fn live_status_get_composes_slp() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    let status = mineui_core::status::get(&core).await.expect("status");
    assert!(status.online, "status must be online: {:?}", status.error);
    assert_eq!(status.source, "query");
}

/* ---------- metrics composition ---------- */

#[tokio::test]
#[ignore]
async fn live_metrics_composition_end_to_end() {
    let _g = live_lock().await;
    let (_tmp, core) = live_core().await;
    let metrics = mineui_core::metrics::get(&core).await.expect("metrics");
    assert_eq!(metrics.base, "container");
    assert!(!metrics.enriched, "no serverUtilsUrl configured");
    assert!(metrics.cpu_percent.is_some());
    assert!(metrics.mem.used_bytes.unwrap_or(0) > 0);
    assert!(metrics.mem.total_bytes.unwrap_or(0) > 0);
    assert!(metrics.net.is_some());
    assert!(metrics.block.is_some());
    let disk = metrics.disk.expect("df -k /data must parse");
    assert!(disk.total_bytes.unwrap_or(0) > 0);
    assert!(disk.percent.is_some());
    let started_at = metrics.started_at.expect("startedAt from inspect");
    chrono::DateTime::parse_from_rfc3339(&started_at).expect("startedAt is RFC 3339");
    assert!(metrics.uptime_seconds.unwrap_or(-1) >= 0);
    // Vanilla has no `tps` command — must degrade to None, not error.
    assert!(metrics.tps.is_none());
}
