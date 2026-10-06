//! Server state + lifecycle across both modes (contract §3.2).

use crate::error::{Error, Result};
use crate::model::AuditSource;
use crate::model::{
    ContainerDetail, CoreEvent, ProcessDetail, ServerPhase, ServerState, ServerStateEvent,
};
use crate::runtime::Runtime;
use crate::settings::Mode;

/// Audit detail of the start fallback's in-place change (2.11.1).
pub const PIDS_LIFTED_DETAIL: &str = "process limit (pids) lifted";

/// The sentence added to the start error when the pids limit could not be
/// lifted (§3.2, 2.11.1).
pub fn pids_unliftable_sentence(runtime_kind: &str, name: &str) -> String {
    format!(
        "The container was made with a process limit this machine cannot apply, and MineUI could not lift it; run `{runtime_kind} update --pids-limit=0 {name}` and start the server again."
    )
}

/// What the pids fallback did, for the audit: `None` = not needed.
pub(crate) type PidsLift = Option<Result<()>>;

/// Start (or restart) `name`; when the runtime refuses because this machine
/// cannot apply the container's pids limit (crun: "controller `pids` is not
/// available" - Podman on WSL without systemd), lift the limit in place with
/// `update --pids-limit=0` and start once more (§3.2, 2.11.1). Only once.
/// Containers created before the 2.7.1 create retry, and any container the
/// user made elsewhere, carry the runtime's default limit and land here.
pub(crate) async fn start_lifting_pids(
    runtime: &dyn Runtime,
    name: &str,
    restart: bool,
) -> (Result<()>, PidsLift) {
    let first = if restart {
        runtime.restart(name).await
    } else {
        runtime.start(name).await
    };
    let original = match first {
        Err(e) if crate::runtime::is_pids_controller_unavailable(&e.to_string()) => e,
        other => return (other, None),
    };
    if let Err(lift_error) = runtime.set_pids_limit_unlimited(name).await {
        let message = format!(
            "{original} {}",
            pids_unliftable_sentence(runtime.kind(), name)
        );
        return (Err(Error::Internal(message)), Some(Err(lift_error)));
    }
    // The failed attempt left the container stopped, so a plain start is
    // the retry for a restart too.
    (runtime.start(name).await, Some(Ok(())))
}

/// Record the fallback's `container.update` entry when it ran (§3.11).
async fn audit_pids_lift(core: &crate::Core, source: AuditSource, name: &str, lift: &PidsLift) {
    if let Some(outcome) = lift {
        crate::audit::record(
            core,
            source,
            "container.update",
            Some(name),
            Some(PIDS_LIFTED_DETAIL),
            outcome.as_ref().err(),
        )
        .await;
    }
}

pub(crate) fn phase_from_container(detail: &ContainerDetail) -> ServerPhase {
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

pub(crate) fn simple_phase(core: &crate::Core, settings: &crate::Settings) -> ServerPhase {
    let instance_exists = settings
        .simple
        .instance_dir
        .join(crate::instance::META_FILE)
        .is_file();
    if core.supervisor.is_active() {
        core.supervisor.phase()
    } else if !instance_exists {
        ServerPhase::NotCreated
    } else {
        core.supervisor.phase() // stopped or crashed
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
            let phase = simple_phase(core, &settings);
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
async fn start_inner(core: &crate::Core) -> Result<()> {
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
            let (result, lift) = start_lifting_pids(runtime.as_ref(), name, false).await;
            audit_pids_lift(core, AuditSource::User, name, &lift).await;
            result?;
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
                    "no instance found - create one first".into(),
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
async fn stop_inner(core: &crate::Core) -> Result<()> {
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
async fn restart_inner(core: &crate::Core, source: AuditSource) -> Result<()> {
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
            let (result, lift) = start_lifting_pids(runtime.as_ref(), name, true).await;
            audit_pids_lift(core, source, name, &lift).await;
            result?;
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

/* ---------- audited entry points (§3.11) ---------- */

/// `start_server` (§3.2), audited as `server.start`.
pub async fn start(core: &crate::Core) -> Result<()> {
    let r = start_inner(core).await;
    crate::audit::record(
        core,
        AuditSource::User,
        "server.start",
        None,
        None,
        r.as_ref().err(),
    )
    .await;
    r
}

/// `stop_server` (§3.2), audited as `server.stop`.
pub async fn stop(core: &crate::Core) -> Result<()> {
    let r = stop_inner(core).await;
    crate::audit::record(
        core,
        AuditSource::User,
        "server.stop",
        None,
        None,
        r.as_ref().err(),
    )
    .await;
    r
}

/// `restart_server` (§3.2), audited as `server.restart` from the user.
pub async fn restart(core: &crate::Core) -> Result<()> {
    restart_from(core, AuditSource::User).await
}

/// Restart on behalf of `source` (the scheduler uses `Scheduler`).
pub async fn restart_from(core: &crate::Core, source: AuditSource) -> Result<()> {
    let r = restart_inner(core, source).await;
    crate::audit::record(core, source, "server.restart", None, None, r.as_ref().err()).await;
    r
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

    const PIDS_ERROR: &str = "podman start failed: Error: unable to start container \"06cd\": crun: controller pids is not available under /sys/fs/cgroup/non-systemd/user.slice/libpod-06cd.scope/container/cgroup.controllers: OCI runtime error";

    #[tokio::test]
    async fn a_pids_refusal_lifts_the_limit_and_starts_again() {
        use crate::fake_runtime::FakeRuntime;
        for restart in [false, true] {
            let rt = FakeRuntime::failing_starts(&[Some(PIDS_ERROR)]);
            let (result, lift) = start_lifting_pids(&rt, "mc", restart).await;
            result.unwrap();
            assert!(matches!(lift, Some(Ok(()))));
            let first = if restart { "restart mc" } else { "start mc" };
            assert_eq!(rt.calls(), [first, "update --pids-limit=0 mc", "start mc"]);
        }
    }

    #[tokio::test]
    async fn other_start_errors_are_left_alone() {
        use crate::fake_runtime::FakeRuntime;
        let rt = FakeRuntime::failing_starts(&[Some(
            "podman start failed: Error: rootlessport listen tcp 127.0.0.1:25566: bind: address already in use",
        )]);
        let (result, lift) = start_lifting_pids(&rt, "mc", false).await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("address already in use"));
        assert!(lift.is_none());
        assert_eq!(rt.calls(), ["start mc"]);

        // A clean start never touches the container.
        let rt = FakeRuntime::default();
        let (result, lift) = start_lifting_pids(&rt, "mc", false).await;
        result.unwrap();
        assert!(lift.is_none());
        assert_eq!(rt.calls(), ["start mc"]);
    }

    #[tokio::test]
    async fn an_unliftable_limit_says_what_to_run() {
        use crate::fake_runtime::FakeRuntime;
        let rt = FakeRuntime {
            update_failure: Some("Error: unknown flag: --pids-limit".into()),
            ..FakeRuntime::failing_starts(&[Some(PIDS_ERROR)])
        };
        let (result, lift) = start_lifting_pids(&rt, "mc", false).await;
        let message = result.unwrap_err().to_string();
        assert!(message.starts_with(PIDS_ERROR), "{message}");
        assert!(
            message.ends_with(&pids_unliftable_sentence("podman", "mc")),
            "{message}"
        );
        assert!(message.contains("`podman update --pids-limit=0 mc`"));
        assert!(lift
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("unknown flag"));
        assert_eq!(rt.calls(), ["start mc", "update --pids-limit=0 mc"]);
    }

    #[tokio::test]
    async fn the_retry_happens_once() {
        use crate::fake_runtime::FakeRuntime;
        let rt = FakeRuntime::failing_starts(&[Some(PIDS_ERROR), Some(PIDS_ERROR)]);
        let (result, lift) = start_lifting_pids(&rt, "mc", false).await;
        assert!(result.is_err());
        assert!(matches!(lift, Some(Ok(()))));
        assert_eq!(
            rt.calls(),
            ["start mc", "update --pids-limit=0 mc", "start mc"]
        );
    }

    #[tokio::test]
    async fn the_lift_is_audited_only_when_it_ran() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        audit_pids_lift(&core, AuditSource::User, "mc", &None).await;
        audit_pids_lift(&core, AuditSource::Scheduler, "mc", &Some(Ok(()))).await;
        audit_pids_lift(
            &core,
            AuditSource::User,
            "mc",
            &Some(Err(Error::Internal("no update verb".into()))),
        )
        .await;
        let log = crate::audit::recent(&core, None).await.unwrap();
        let lifts: Vec<_> = log
            .entries
            .iter()
            .filter(|e| e.action == "container.update")
            .collect();
        assert_eq!(lifts.len(), 2);
        for e in &lifts {
            assert_eq!(e.target.as_deref(), Some("mc"));
            assert_eq!(e.detail.as_deref(), Some(PIDS_LIFTED_DETAIL));
        }
        assert!(lifts
            .iter()
            .any(|e| e.ok && e.source == AuditSource::Scheduler));
        assert!(lifts
            .iter()
            .any(|e| !e.ok && e.error.as_deref() == Some("INTERNAL: no update verb")));
    }
}
