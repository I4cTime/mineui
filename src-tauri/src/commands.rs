//! One `#[tauri::command]` per contract §3 row — thin delegation only.
//! No business logic, no validation, no subprocess calls here (contract §8).
//!
//! Note: Tauri v2 maps JS camelCase invoke args to these snake_case
//! parameters automatically (e.g. `sourcePath` → `source_path`).

use std::sync::Arc;

use mineui_core::model::{
    BackupEntry, ConfigFileContent, ConfigFileList, CreateInstanceArgs, DownloadedMod,
    InstanceStatus, JavaCheck, LogsTail, McVersion, Metrics, ModTarget, ModsList, PlayerHistory,
    PlayersResult, RconOutput, RuntimeProbe, ServerState, ServerStatus, UploadedMod,
};
use mineui_core::{Core, Error, Settings};

type CmdResult<T> = Result<T, Error>;
type CoreState<'a> = tauri::State<'a, Arc<Core>>;

/* ---------- §3.1 settings & environment ---------- */

#[tauri::command]
pub async fn get_settings(core: CoreState<'_>) -> CmdResult<Settings> {
    Ok(core.settings().await)
}

#[tauri::command]
pub async fn set_settings(core: CoreState<'_>, settings: Settings) -> CmdResult<Settings> {
    core.update_settings(settings).await
}

#[tauri::command]
pub async fn detect_runtimes(core: CoreState<'_>) -> CmdResult<RuntimeProbe> {
    let settings = core.settings().await;
    Ok(mineui_core::runtime::detect(&settings.advanced).await)
}

#[tauri::command]
pub async fn java_check(core: CoreState<'_>) -> CmdResult<JavaCheck> {
    let settings = core.settings().await;
    // Ungated probe: java_check is available in both modes and reads the
    // instance metadata only when present (§3.1).
    let instance = mineui_core::instance::probe(&core).await?;
    mineui_core::java::check(
        settings.simple.java_path.as_deref(),
        instance.required_java_major,
    )
    .await
}

/* ---------- §3.2 server state / lifecycle / status ---------- */

#[tauri::command]
pub async fn get_server_state(core: CoreState<'_>) -> CmdResult<ServerState> {
    mineui_core::lifecycle::state(&core).await
}

#[tauri::command]
pub async fn start_server(core: CoreState<'_>) -> CmdResult<()> {
    mineui_core::lifecycle::start(&core).await
}

#[tauri::command]
pub async fn stop_server(core: CoreState<'_>) -> CmdResult<()> {
    mineui_core::lifecycle::stop(&core).await
}

#[tauri::command]
pub async fn restart_server(core: CoreState<'_>) -> CmdResult<()> {
    mineui_core::lifecycle::restart(&core).await
}

#[tauri::command]
pub async fn get_server_status(core: CoreState<'_>) -> CmdResult<ServerStatus> {
    mineui_core::status::get(&core).await
}

/* ---------- §3.3 logs ---------- */

#[tauri::command]
pub async fn get_logs(core: CoreState<'_>, tail: Option<u32>) -> CmdResult<LogsTail> {
    mineui_core::logs::tail(&core, tail).await
}

#[tauri::command]
pub async fn start_log_stream(core: CoreState<'_>) -> CmdResult<()> {
    mineui_core::logs::stream_start(&core).await
}

#[tauri::command]
pub async fn stop_log_stream(core: CoreState<'_>) -> CmdResult<()> {
    mineui_core::logs::stream_stop(&core).await
}

/* ---------- §3.4 players & rcon ---------- */

#[tauri::command]
pub async fn get_players(core: CoreState<'_>) -> CmdResult<PlayersResult> {
    mineui_core::players::online(&core).await
}

#[tauri::command]
pub async fn get_player_history(core: CoreState<'_>) -> CmdResult<PlayerHistory> {
    mineui_core::players::history(&core).await
}

#[tauri::command]
pub async fn run_rcon_command(core: CoreState<'_>, command: String) -> CmdResult<RconOutput> {
    let output = mineui_core::rcon::run_allowlisted(&core, &command).await?;
    Ok(RconOutput { output })
}

/* ---------- §3.5 mods & plugins ---------- */

#[tauri::command]
pub async fn list_mods(core: CoreState<'_>) -> CmdResult<ModsList> {
    mineui_core::mods::list(&core).await
}

#[tauri::command]
pub async fn upload_mod(
    core: CoreState<'_>,
    source_path: String,
    target: ModTarget,
) -> CmdResult<UploadedMod> {
    mineui_core::mods::upload(&core, &source_path, target).await
}

#[tauri::command]
pub async fn download_mod(
    core: CoreState<'_>,
    url: String,
    filename: Option<String>,
    target: ModTarget,
) -> CmdResult<DownloadedMod> {
    mineui_core::mods::download(&core, &url, filename.as_deref(), target).await
}

#[tauri::command]
pub async fn delete_mod(core: CoreState<'_>, filename: String, target: ModTarget) -> CmdResult<()> {
    mineui_core::mods::delete(&core, &filename, target).await
}

/* ---------- §3.6 instance (simple mode only; WRONG_MODE enforced in core) ---------- */

#[tauri::command]
pub async fn list_mc_versions(
    core: CoreState<'_>,
    include_snapshots: Option<bool>,
) -> CmdResult<Vec<McVersion>> {
    mineui_core::mojang::list_versions(&core, include_snapshots.unwrap_or(false)).await
}

#[tauri::command]
pub async fn create_instance(
    core: CoreState<'_>,
    args: CreateInstanceArgs,
) -> CmdResult<InstanceStatus> {
    mineui_core::instance::create(&core, &args).await
}

#[tauri::command]
pub async fn delete_instance(core: CoreState<'_>, confirm: bool) -> CmdResult<()> {
    mineui_core::instance::delete(&core, confirm).await
}

#[tauri::command]
pub async fn instance_status(core: CoreState<'_>) -> CmdResult<InstanceStatus> {
    mineui_core::instance::status(&core).await
}

/* ---------- §3.7 config files ---------- */

#[tauri::command]
pub async fn list_config_files(core: CoreState<'_>) -> CmdResult<ConfigFileList> {
    mineui_core::config_files::list(&core).await
}

#[tauri::command]
pub async fn read_config_file(core: CoreState<'_>, path: String) -> CmdResult<ConfigFileContent> {
    mineui_core::config_files::read(&core, &path).await
}

#[tauri::command]
pub async fn write_config_file(
    core: CoreState<'_>,
    path: String,
    content: String,
) -> CmdResult<()> {
    mineui_core::config_files::write(&core, &path, &content).await
}

/* ---------- §3.8 backups ---------- */

#[tauri::command]
pub async fn create_backup(core: CoreState<'_>) -> CmdResult<BackupEntry> {
    mineui_core::backups::create(&core).await
}

#[tauri::command]
pub async fn list_backups(core: CoreState<'_>) -> CmdResult<Vec<BackupEntry>> {
    mineui_core::backups::list(&core).await
}

#[tauri::command]
pub async fn restore_backup(core: CoreState<'_>, filename: String) -> CmdResult<()> {
    mineui_core::backups::restore(&core, &filename).await
}

#[tauri::command]
pub async fn delete_backup(core: CoreState<'_>, filename: String) -> CmdResult<()> {
    mineui_core::backups::delete(&core, &filename).await
}

/* ---------- §3.9 metrics ---------- */

#[tauri::command]
pub async fn get_metrics(core: CoreState<'_>) -> CmdResult<Metrics> {
    mineui_core::metrics::get(&core).await
}
