//! Server state + lifecycle across both modes (contract §3.2).

use crate::error::{Error, Result};
use crate::model::{
    ContainerDetail, CoreEvent, ProcessDetail, ServerPhase, ServerState, ServerStateEvent,
};
use crate::settings::Mode;

fn phase_from_container(detail: &ContainerDetail) -> ServerPhase {
    if !detail.exists {
        return ServerPhase::NotCreated;
    }
    match detail.status.as_deref() {
        Some(s) if s.eq_ignore_ascii_case("running") || s.to_lowercase().starts_with("up") => {
            ServerPhase::Running
        }
        _ => ServerPhase::Stopped,
    }
}

/// `get_server_state` (§3.2).
pub async fn state(core: &crate::Core) -> Result<ServerState> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let mut detail = runtime.ps_state(name).await?;
            if detail.exists {
                detail.started_at = runtime.inspect_started_at(name).await.unwrap_or(None);
            }
            let phase = phase_from_container(&detail);
            Ok(ServerState {
                mode: Mode::Advanced,
                phase,
                container: Some(detail),
                process: None,
            })
        }
        Mode::Simple => {
            let instance_exists = settings
                .simple
                .instance_dir
                .join(crate::instance::META_FILE)
                .is_file();
            let phase = if core.supervisor.is_active() {
                core.supervisor.phase()
            } else if !instance_exists {
                ServerPhase::NotCreated
            } else {
                core.supervisor.phase() // stopped or crashed
            };
            Ok(ServerState {
                mode: Mode::Simple,
                phase,
                container: None,
                process: Some(ProcessDetail {
                    pid: core.supervisor.pid(),
                    started_at: if core.supervisor.is_active() {
                        core.supervisor.started_at()
                    } else {
                        None
                    },
                    last_exit_code: core.supervisor.last_exit_code(),
                }),
            })
        }
    }
}

/// `start_server` (§3.2).
pub async fn start(core: &crate::Core) -> Result<()> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let detail = runtime.ps_state(name).await?;
            if !detail.exists {
                return Err(Error::ContainerNotFound(format!(
                    "container '{name}' does not exist"
                )));
            }
            runtime.start(name).await?;
            poll_advanced_state(core).await;
            Ok(())
        }
        Mode::Simple => {
            // Preconditions (§3.2): instance exists, EULA, java, not running.
            if core.supervisor.is_active() {
                return Err(Error::ServerRunning("server is already running".into()));
            }
            let instance = crate::instance::probe(core).await?;
            if !instance.exists {
                return Err(Error::InstanceNotFound(
                    "no instance found — create one first".into(),
                ));
            }
            if !settings.simple.eula_accepted {
                return Err(Error::EulaNotAccepted(
                    "accept the Minecraft EULA in settings before starting".into(),
                ));
            }
            let java = crate::java::check(
                settings.simple.java_path.as_deref(),
                instance.required_java_major,
            )
            .await?;
            if !java.found {
                return Err(Error::JavaNotFound(
                    "no java binary found on PATH or JAVA_HOME".into(),
                ));
            }
            if java.compatible == Some(false) {
                return Err(Error::JavaIncompatible(format!(
                    "this instance requires Java {}+ but {} was found",
                    instance.required_java_major.unwrap_or(0),
                    java.version.as_deref().unwrap_or("unknown")
                )));
            }
            // Re-assert RCON config + eula.txt before spawn (§3.2).
            crate::instance::assert_runtime_files(core).await?;

            let java_path = std::path::PathBuf::from(java.path.expect("found java has a path"));
            let refreshed = core.settings().await;
            core.supervisor
                .start(
                    &java_path,
                    &refreshed.simple.instance_dir,
                    refreshed.simple.memory_mb,
                )
                .await
        }
    }
}

/// `stop_server` (§3.2).
pub async fn stop(core: &crate::Core) -> Result<()> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let detail = runtime.ps_state(name).await?;
            if !detail.exists {
                return Err(Error::ContainerNotFound(format!(
                    "container '{name}' does not exist"
                )));
            }
            runtime.stop(name).await?;
            poll_advanced_state(core).await;
            Ok(())
        }
        Mode::Simple => core.supervisor.stop().await,
    }
}

/// `restart_server` (§3.2): simple mode = stop (await exit) then start.
pub async fn restart(core: &crate::Core) -> Result<()> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let detail = runtime.ps_state(name).await?;
            if !detail.exists {
                return Err(Error::ContainerNotFound(format!(
                    "container '{name}' does not exist"
                )));
            }
            runtime.restart(name).await?;
            poll_advanced_state(core).await;
            Ok(())
        }
        Mode::Simple => {
            if core.supervisor.is_active() {
                core.supervisor.stop().await?;
                core.supervisor
                    .wait_for_exit(std::time::Duration::from_secs(40))
                    .await?;
            }
            start(core).await
        }
    }
}

/// Advanced-mode phase-change detection (§4.2): called by the Tauri layer's
/// 2 s poller and immediately after start/stop/restart. Emits
/// `mineui://server-state` on transitions. Silent on probe errors.
pub async fn poll_advanced_state(core: &crate::Core) {
    let settings = core.settings().await;
    if settings.active_mode != Mode::Advanced {
        // Leaving advanced mode invalidates the cached phase.
        *core.last_advanced_phase.lock().unwrap() = None;
        return;
    }
    let phase = match crate::runtime::resolve(&settings.advanced).await {
        Ok(runtime) => match runtime.ps_state(&settings.advanced.container_name).await {
            Ok(detail) => phase_from_container(&detail),
            Err(_) => return,
        },
        Err(_) => return,
    };
    let previous = {
        let mut last = core.last_advanced_phase.lock().unwrap();
        let previous = *last;
        *last = Some(phase);
        previous
    };
    if let Some(previous) = previous {
        if previous != phase {
            core.emit_event(CoreEvent::ServerState(ServerStateEvent {
                mode: Mode::Advanced,
                phase,
                previous_phase: previous,
                epoch_ms: crate::util::now_epoch_ms(),
                exit_code: None,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(exists: bool, status: Option<&str>) -> ContainerDetail {
        ContainerDetail {
            exists,
            id: None,
            status: status.map(|s| s.to_string()),
            created_at: None,
            started_at: None,
        }
    }

    #[test]
    fn container_phase_mapping() {
        assert_eq!(
            phase_from_container(&detail(false, None)),
            ServerPhase::NotCreated
        );
        assert_eq!(
            phase_from_container(&detail(true, Some("running"))),
            ServerPhase::Running
        );
        assert_eq!(
            phase_from_container(&detail(true, Some("Running"))),
            ServerPhase::Running
        );
        assert_eq!(
            phase_from_container(&detail(true, Some("Up 2 hours"))),
            ServerPhase::Running
        );
        assert_eq!(
            phase_from_container(&detail(true, Some("exited"))),
            ServerPhase::Stopped
        );
        assert_eq!(
            phase_from_container(&detail(true, None)),
            ServerPhase::Stopped
        );
    }
}
