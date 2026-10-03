//! MineUI Tauri v2 shell: command registration, core-event forwarding to the
//! webview, and the 2 s advanced-mode state poller (contract §4, §8).
//! Business logic lives entirely in `mineui-core`.

mod commands;

use std::sync::Arc;
use std::time::Duration;

use mineui_core::model::{
    CoreEvent, HubEvent, ServerScoped, EVENT_DOWNLOAD_PROGRESS, EVENT_LOGS, EVENT_SERVER_STATE,
};
use mineui_core::Hub;
use tauri::{Emitter, Manager};

/// Forward one hub event to its `mineui://*` channel, tagged with the server
/// profile it came from (§4).
fn forward_event(app: &tauri::AppHandle, HubEvent { server_id, event }: HubEvent) {
    let result = match event {
        CoreEvent::Logs(payload) => app.emit(EVENT_LOGS, ServerScoped { server_id, payload }),
        CoreEvent::ServerState(payload) => {
            app.emit(EVENT_SERVER_STATE, ServerScoped { server_id, payload })
        }
        CoreEvent::DownloadProgress(payload) => {
            app.emit(EVENT_DOWNLOAD_PROGRESS, ServerScoped { server_id, payload })
        }
    };
    if let Err(e) = result {
        eprintln!("mineui: failed to emit event: {e}");
    }
}

/// WebKitGTK's DMA-BUF renderer crashes the webview on NVIDIA + Wayland
/// ("Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display")
/// before a single frame is drawn. Opt out of it on Linux when the NVIDIA
/// kernel module is loaded, unless the user has already made their own
/// choice via the environment. Must run before the webview is created.
#[cfg(target_os = "linux")]
fn apply_webkit_nvidia_workaround() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_some() {
        return;
    }
    if std::path::Path::new("/proc/driver/nvidia/version").exists() {
        // Safety: called from `run()` on the main thread before any other
        // thread is spawned, so no concurrent environment access exists.
        unsafe { std::env::set_var(VAR, "1") };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_webkit_nvidia_workaround();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Path-resolver wiring: platform dirs are injected into core at
            // startup (§8); core never touches Tauri path APIs itself.
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;

            // One core per server profile (§2.5), all live at once.
            let hub: Arc<Hub> = tauri::async_runtime::block_on(Hub::init(config_dir, data_dir))
                .map_err(|e| format!("failed to initialize MineUI core: {e}"))?;

            // Core events → webview events.
            let handle = app.handle().clone();
            let mut rx = hub.subscribe_events();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(event) => forward_event(&handle, event),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // 2 s advanced-mode phase poller (§4.2). The timer lives here;
            // change detection + event emission live in core.
            let poll_hub = hub.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    poll_hub.poll_all().await;
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            });

            // 30 s scheduler tick (§3.10). The timer lives here; due-time
            // math, job execution and run state live in core.
            let tick_hub = hub.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    tick_hub.tick_all().await;
                }
            });

            app.manage(hub);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // §3.1 settings & environment
            commands::get_settings,
            commands::set_settings,
            commands::detect_runtimes,
            commands::java_check,
            // §3.2 server state / lifecycle / status
            commands::get_server_state,
            commands::start_server,
            commands::stop_server,
            commands::restart_server,
            commands::get_server_status,
            // §3.3 logs
            commands::get_logs,
            commands::start_log_stream,
            commands::stop_log_stream,
            // §3.4 players & rcon
            commands::get_players,
            commands::get_player_history,
            commands::run_rcon_command,
            // §3.5 mods & plugins
            commands::list_mods,
            commands::upload_mod,
            commands::download_mod,
            commands::delete_mod,
            commands::unpack_mod_archive,
            // §3.6 instance
            commands::list_mc_versions,
            commands::create_instance,
            commands::delete_instance,
            commands::instance_status,
            // §3.7 config files
            commands::list_config_files,
            commands::read_config_file,
            commands::write_config_file,
            // §3.8 backups
            commands::create_backup,
            commands::list_backups,
            commands::restore_backup,
            commands::delete_backup,
            // §3.9 metrics
            commands::get_metrics,
            // §3.10 scheduler
            commands::get_scheduler_status,
            commands::run_scheduled_job_now,
            // §3.11 player notes & audit log
            commands::get_player_notes,
            commands::set_player_note,
            commands::get_audit_log,
            // §3.13 container creation
            commands::create_container,
            commands::delete_container,
            // §3.14 modpack search
            commands::search_modpacks,
            commands::inspect_modpack_zip,
            // §3.12 server profiles
            commands::list_servers,
            commands::add_server,
            commands::rename_server,
            commands::remove_server,
            commands::set_active_server,
            commands::get_servers_overview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MineUI");
}
