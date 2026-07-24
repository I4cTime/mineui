//! mineui-core — all MineUI v2 business logic (contract §8).
//!
//! Pure Rust, no Tauri dependency. The Tauri shell (`src-tauri`) injects
//! platform paths, forwards `CoreEvent`s to the webview, and delegates every
//! command here. **No shell-string interpolation anywhere in this crate**:
//! subprocesses use argv arrays; the only `sh -c` scripts are compile-time
//! constants with zero interpolation.

pub mod backups;
pub mod config_files;
pub mod download;
pub mod error;
pub mod instance;
pub mod java;
pub mod lifecycle;
pub mod logs;
pub mod metrics;
pub mod model;
pub mod mods;
pub mod mojang;
pub mod players;
pub mod query;
pub mod rcon;
pub mod runtime;
pub mod serverutils;
pub mod settings;
pub mod status;
pub mod supervisor;
pub mod util;
pub mod validate;

use std::path::PathBuf;
use std::sync::Arc;

pub use error::{Error, Result};
pub use model::CoreEvent;
pub use settings::{Mode, Settings};

/// Platform paths injected by the shell (`app_config_dir`, `app_data_dir`).
#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
}

/// Shared application core. One instance per app, wrapped in `Arc`.
pub struct Core {
    pub paths: Paths,
    pub http: reqwest::Client,
    pub supervisor: supervisor::Supervisor,
    pub logs: logs::Manager,
    pub(crate) events: tokio::sync::broadcast::Sender<CoreEvent>,
    pub(crate) mojang_cache: tokio::sync::Mutex<Option<mojang::ManifestCache>>,
    pub(crate) last_advanced_phase: std::sync::Mutex<Option<model::ServerPhase>>,
    settings: tokio::sync::RwLock<Settings>,
}

impl Core {
    /// Initialize the core: loads (and migrates/creates) settings from
    /// `<config_dir>/settings.json`. Must be called on a Tokio runtime.
    pub async fn init(config_dir: PathBuf, data_dir: PathBuf) -> Result<Arc<Core>> {
        let loaded = settings::load(&config_dir, &data_dir).await?;
        Ok(Self::build(config_dir, data_dir, loaded))
    }

    /// Test/embedding constructor: skips disk I/O for settings.
    pub async fn init_with_settings(
        config_dir: PathBuf,
        data_dir: PathBuf,
        settings: Settings,
    ) -> Arc<Core> {
        Self::build(config_dir, data_dir, settings)
    }

    fn build(config_dir: PathBuf, data_dir: PathBuf, loaded: Settings) -> Arc<Core> {
        let (events, _keepalive) = tokio::sync::broadcast::channel::<CoreEvent>(512);
        let logs = logs::Manager::new(events.clone());
        let supervisor = supervisor::Supervisor::new(events.clone(), logs.sink());
        Arc::new(Core {
            paths: Paths {
                config_dir,
                data_dir,
            },
            http: download::build_client(),
            supervisor,
            logs,
            events,
            mojang_cache: tokio::sync::Mutex::new(None),
            last_advanced_phase: std::sync::Mutex::new(None),
            settings: tokio::sync::RwLock::new(loaded),
        })
    }

    /// Snapshot of the current settings.
    pub async fn settings(&self) -> Settings {
        self.settings.read().await.clone()
    }

    /// `set_settings` (§3.1): validate, persist atomically, swap in memory,
    /// and return the normalized result.
    pub async fn update_settings(&self, new_settings: Settings) -> Result<Settings> {
        let saved = settings::save(&self.paths.config_dir, new_settings).await?;
        *self.settings.write().await = saved.clone();
        Ok(saved)
    }

    /// Subscribe to core events (the Tauri layer forwards these to the
    /// webview as `mineui://*` events).
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<CoreEvent> {
        self.events.subscribe()
    }

    pub(crate) fn emit_event(&self, event: CoreEvent) {
        let _ = self.events.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn core_init_creates_settings_file() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let core = Core::init(config_dir.clone(), data_dir.clone())
            .await
            .unwrap();
        assert!(config_dir.join("settings.json").is_file());
        let s = core.settings().await;
        assert_eq!(s.schema_version, 2);
        assert_eq!(
            s.simple.instance_dir,
            data_dir.join("instances").join("default")
        );
    }

    #[tokio::test]
    async fn update_settings_validates_and_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let core = Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let mut s = core.settings().await;
        s.simple.memory_mb = 128; // < 512 → invalid
        let err = core.update_settings(s).await.unwrap_err();
        assert_eq!(err.code(), "SETTINGS_INVALID");

        let mut s = core.settings().await;
        s.simple.memory_mb = 4096;
        let saved = core.update_settings(s).await.unwrap();
        assert_eq!(saved.simple.memory_mb, 4096);
        assert_eq!(core.settings().await.simple.memory_mb, 4096);
    }

    #[tokio::test]
    async fn events_fan_out_to_subscribers() {
        let tmp = tempfile::tempdir().unwrap();
        let core = Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let mut rx = core.subscribe_events();
        core.emit_event(CoreEvent::ServerState(model::ServerStateEvent {
            mode: Mode::Simple,
            phase: model::ServerPhase::Running,
            previous_phase: model::ServerPhase::Starting,
            epoch_ms: 1,
            exit_code: None,
        }));
        match rx.try_recv().unwrap() {
            CoreEvent::ServerState(ev) => assert_eq!(ev.phase, model::ServerPhase::Running),
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
