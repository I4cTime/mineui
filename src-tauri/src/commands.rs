//! One `#[tauri::command]` per contract §3 row — thin delegation only.
//! No business logic, no validation, no subprocess calls here (contract §8).
//!
//! Every §3.1–§3.11 command takes `server_id` (§3.0) and runs against that
//! server profile's core; §3.12 commands act on the profile list itself.
//!
//! Note: Tauri v2 maps JS camelCase invoke args to these snake_case
//! parameters automatically (e.g. `sourcePath` → `source_path`).

use std::sync::Arc;

use mineui_core::model::{
    AuditLog, BackupEntry, ConfigFileContent, ConfigFileList, CreateContainerArgs,
    CreateInstanceArgs, DeletedContainer, DownloadedMod, InstanceStatus, JavaCheck, JobRunResult,
    LogsTail, McVersion, Metrics, ModTarget, ModpackHit, ModpackZipInfo, ModsList, PlayerHistory,
    PlayerNote, PlayerNotes, PlayersResult, RconOutput, RuntimeProbe, SchedulerStatus, ServerList,
    ServerOverview, ServerState, ServerStatus, UnpackedMods, UploadedMod,
};
use mineui_core::settings::Mode;
use mineui_core::{Core, Error, Hub, Settings};

type CmdResult<T> = Result<T, Error>;
type HubState<'a> = tauri::State<'a, Arc<Hub>>;

/// §3.0 server targeting: the named profile's core, or the active one.
async fn core_for(hub: &HubState<'_>, server_id: Option<String>) -> CmdResult<Arc<Core>> {
    hub.core(server_id.as_deref()).await
}

/* ---------- §3.1 settings & environment ---------- */

#[tauri::command]
pub async fn get_settings(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<Settings> {
    let core = core_for(&hub, server_id).await?;
    Ok(core.settings().await)
}

#[tauri::command]
pub async fn set_settings(
    hub: HubState<'_>,
    server_id: Option<String>,
    settings: Settings,
) -> CmdResult<Settings> {
    let core = core_for(&hub, server_id).await?;
    core.update_settings(settings).await
}

#[tauri::command]
pub async fn detect_runtimes(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<RuntimeProbe> {
    let core = core_for(&hub, server_id).await?;
    let settings = core.settings().await;
    Ok(mineui_core::runtime::detect(&settings.advanced).await)
}

#[tauri::command]
pub async fn java_check(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<JavaCheck> {
    let core = core_for(&hub, server_id).await?;
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
pub async fn get_server_state(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<ServerState> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::lifecycle::state(&core).await
}

#[tauri::command]
pub async fn start_server(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::lifecycle::start(&core).await
}

#[tauri::command]
pub async fn stop_server(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::lifecycle::stop(&core).await
}

#[tauri::command]
pub async fn restart_server(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::lifecycle::restart(&core).await
}

#[tauri::command]
pub async fn get_server_status(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<ServerStatus> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::status::get(&core).await
}

/* ---------- §3.3 logs ---------- */

#[tauri::command]
pub async fn get_logs(
    hub: HubState<'_>,
    server_id: Option<String>,
    tail: Option<u32>,
) -> CmdResult<LogsTail> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::logs::tail(&core, tail).await
}

#[tauri::command]
pub async fn start_log_stream(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::logs::stream_start(&core).await
}

#[tauri::command]
pub async fn stop_log_stream(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::logs::stream_stop(&core).await
}

/* ---------- §3.4 players & rcon ---------- */

#[tauri::command]
pub async fn get_players(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<PlayersResult> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::players::online(&core).await
}

#[tauri::command]
pub async fn get_player_history(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<PlayerHistory> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::players::history(&core).await
}

#[tauri::command]
pub async fn run_rcon_command(
    hub: HubState<'_>,
    server_id: Option<String>,
    command: String,
) -> CmdResult<RconOutput> {
    let core = core_for(&hub, server_id).await?;
    let output = mineui_core::rcon::run_allowlisted(&core, &command).await?;
    Ok(RconOutput { output })
}

/* ---------- §3.5 mods & plugins ---------- */

#[tauri::command]
pub async fn list_mods(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<ModsList> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::mods::list(&core).await
}

#[tauri::command]
pub async fn upload_mod(
    hub: HubState<'_>,
    server_id: Option<String>,
    source_path: String,
    target: ModTarget,
) -> CmdResult<UploadedMod> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::mods::upload(&core, &source_path, target).await
}

#[tauri::command]
pub async fn download_mod(
    hub: HubState<'_>,
    server_id: Option<String>,
    url: String,
    filename: Option<String>,
    target: ModTarget,
) -> CmdResult<DownloadedMod> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::mods::download(&core, &url, filename.as_deref(), target).await
}

#[tauri::command]
pub async fn delete_mod(
    hub: HubState<'_>,
    server_id: Option<String>,
    filename: String,
    target: ModTarget,
) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::mods::delete(&core, &filename, target).await
}

#[tauri::command]
pub async fn unpack_mod_archive(
    hub: HubState<'_>,
    server_id: Option<String>,
    source_path: Option<String>,
    url: Option<String>,
    filename: Option<String>,
    target: ModTarget,
) -> CmdResult<UnpackedMods> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::mod_archive::unpack(
        &core,
        source_path.as_deref(),
        url.as_deref(),
        filename.as_deref(),
        target,
    )
    .await
}

/* ---------- §3.6 instance (simple mode only; WRONG_MODE enforced in core) ---------- */

#[tauri::command]
pub async fn list_mc_versions(
    hub: HubState<'_>,
    server_id: Option<String>,
    include_snapshots: Option<bool>,
) -> CmdResult<Vec<McVersion>> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::mojang::list_versions(&core, include_snapshots.unwrap_or(false)).await
}

#[tauri::command]
pub async fn create_instance(
    hub: HubState<'_>,
    server_id: Option<String>,
    args: CreateInstanceArgs,
) -> CmdResult<InstanceStatus> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::instance::create(&core, &args).await
}

#[tauri::command]
pub async fn delete_instance(
    hub: HubState<'_>,
    server_id: Option<String>,
    confirm: bool,
) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::instance::delete(&core, confirm).await
}

#[tauri::command]
pub async fn instance_status(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<InstanceStatus> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::instance::status(&core).await
}

/* ---------- §3.7 config files ---------- */

#[tauri::command]
pub async fn list_config_files(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<ConfigFileList> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::config_files::list(&core).await
}

#[tauri::command]
pub async fn read_config_file(
    hub: HubState<'_>,
    server_id: Option<String>,
    path: String,
) -> CmdResult<ConfigFileContent> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::config_files::read(&core, &path).await
}

#[tauri::command]
pub async fn write_config_file(
    hub: HubState<'_>,
    server_id: Option<String>,
    path: String,
    content: String,
) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::config_files::write(&core, &path, &content).await
}

/* ---------- §3.8 backups ---------- */

#[tauri::command]
pub async fn create_backup(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<BackupEntry> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::backups::create(&core).await
}

#[tauri::command]
pub async fn list_backups(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<Vec<BackupEntry>> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::backups::list(&core).await
}

#[tauri::command]
pub async fn restore_backup(
    hub: HubState<'_>,
    server_id: Option<String>,
    filename: String,
) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::backups::restore(&core, &filename).await
}

#[tauri::command]
pub async fn delete_backup(
    hub: HubState<'_>,
    server_id: Option<String>,
    filename: String,
) -> CmdResult<()> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::backups::delete(&core, &filename).await
}

/* ---------- §3.9 metrics ---------- */

#[tauri::command]
pub async fn get_metrics(hub: HubState<'_>, server_id: Option<String>) -> CmdResult<Metrics> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::metrics::get(&core).await
}

/* ---------- §3.10 scheduler ---------- */

#[tauri::command]
pub async fn get_scheduler_status(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<SchedulerStatus> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::scheduler::status(&core).await
}

#[tauri::command]
pub async fn run_scheduled_job_now(
    hub: HubState<'_>,
    server_id: Option<String>,
    id: String,
) -> CmdResult<JobRunResult> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::scheduler::run_now(&core, &id).await
}

/* ---------- §3.11 player notes & audit log ---------- */

#[tauri::command]
pub async fn get_player_notes(
    hub: HubState<'_>,
    server_id: Option<String>,
) -> CmdResult<PlayerNotes> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::notes::list(&core).await
}

#[tauri::command]
pub async fn set_player_note(
    hub: HubState<'_>,
    server_id: Option<String>,
    username: String,
    note: String,
) -> CmdResult<Option<PlayerNote>> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::notes::set(&core, &username, &note).await
}

#[tauri::command]
pub async fn get_audit_log(
    hub: HubState<'_>,
    server_id: Option<String>,
    limit: Option<u32>,
) -> CmdResult<AuditLog> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::audit::recent(&core, limit).await
}

/* ---------- §3.13 container creation ---------- */

#[tauri::command]
pub async fn create_container(
    hub: HubState<'_>,
    server_id: Option<String>,
    args: CreateContainerArgs,
) -> CmdResult<ServerState> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::provision::create(&core, &args).await
}

#[tauri::command]
pub async fn delete_container(
    hub: HubState<'_>,
    server_id: Option<String>,
    confirm: bool,
    delete_data: bool,
) -> CmdResult<DeletedContainer> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::provision::delete(&core, confirm, delete_data).await
}

/* ---------- §3.14 modpack search ---------- */

#[tauri::command]
pub async fn search_modpacks(
    hub: HubState<'_>,
    server_id: Option<String>,
    query: String,
    limit: Option<u32>,
) -> CmdResult<Vec<ModpackHit>> {
    let core = core_for(&hub, server_id).await?;
    mineui_core::modpacks::search(&core, &query, limit).await
}

#[tauri::command]
pub async fn inspect_modpack_zip(
    hub: HubState<'_>,
    server_id: Option<String>,
    source_path: String,
) -> CmdResult<ModpackZipInfo> {
    // Read-only and host-side; the profile only has to exist.
    let _ = core_for(&hub, server_id).await?;
    mineui_core::cfpack::inspect(&source_path).await
}

/* ---------- §3.12 server profiles ---------- */

#[tauri::command]
pub async fn list_servers(hub: HubState<'_>) -> CmdResult<ServerList> {
    Ok(hub.list().await)
}

#[tauri::command]
pub async fn add_server(
    hub: HubState<'_>,
    name: String,
    mode: Option<Mode>,
) -> CmdResult<ServerList> {
    hub.add(&name, mode).await
}

#[tauri::command]
pub async fn rename_server(hub: HubState<'_>, id: String, name: String) -> CmdResult<ServerList> {
    hub.rename(&id, &name).await
}

#[tauri::command]
pub async fn remove_server(hub: HubState<'_>, id: String, confirm: bool) -> CmdResult<ServerList> {
    hub.remove(&id, confirm).await
}

#[tauri::command]
pub async fn set_active_server(hub: HubState<'_>, id: String) -> CmdResult<ServerList> {
    hub.set_active(&id).await
}

#[tauri::command]
pub async fn get_servers_overview(hub: HubState<'_>) -> CmdResult<Vec<ServerOverview>> {
    Ok(hub.overview().await)
}
