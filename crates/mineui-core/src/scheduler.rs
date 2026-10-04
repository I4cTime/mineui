//! Scheduled jobs (contract §3.10): automatic restarts, backups and chat
//! broadcasts. Definitions live in `Settings::scheduler`; run state lives in
//! `<data_dir>/scheduler-state.json`. The shell drives `tick` every 30 s.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::{AuditSource, JobRunResult, ScheduledJobStatus, SchedulerStatus, ServerPhase};
use crate::settings::{parse_hhmm, Schedule, ScheduledJob, ScheduledJobKind};

const STATE_FILE: &str = "scheduler-state.json";
/// Warning lead time before a restart that carries a message.
pub const RESTART_WARNING_SECS: u64 = 60;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobState {
    last_run: Option<JobRunResult>,
}

/// Per-core engine state, owned by `Core`.
pub struct Engine {
    state: tokio::sync::Mutex<Option<HashMap<String, JobState>>>,
    run_lock: tokio::sync::Mutex<()>,
    started_at_epoch_ms: i64,
}

impl Engine {
    pub(crate) fn new() -> Self {
        Engine {
            state: tokio::sync::Mutex::new(None),
            run_lock: tokio::sync::Mutex::new(()),
            started_at_epoch_ms: crate::util::now_epoch_ms(),
        }
    }
}

fn state_file(core: &crate::Core) -> PathBuf {
    core.paths.data_dir.join(STATE_FILE)
}

async fn load_state(core: &crate::Core) -> HashMap<String, JobState> {
    match tokio::fs::read_to_string(state_file(core)).await {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Run `f` against the (lazily loaded) state map and persist it afterwards.
async fn with_state<T>(
    core: &crate::Core,
    f: impl FnOnce(&mut HashMap<String, JobState>) -> T,
) -> T {
    let mut guard = core.scheduler.state.lock().await;
    if guard.is_none() {
        *guard = Some(load_state(core).await);
    }
    let map = guard.as_mut().expect("state loaded above");
    let out = f(map);
    match serde_json::to_string_pretty(map) {
        Ok(json) => {
            if let Err(e) =
                crate::util::write_atomic_bytes(&state_file(core), json.as_bytes()).await
            {
                eprintln!("mineui: scheduler state write failed: {e}");
            }
        }
        Err(e) => eprintln!("mineui: scheduler state serialize failed: {e}"),
    }
    out
}

fn epoch_ms(t: DateTime<Local>) -> i64 {
    t.timestamp_millis()
}

fn local_at(date: chrono::NaiveDate, hour: u32, minute: u32) -> Option<DateTime<Local>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => Some(t),
        chrono::LocalResult::Ambiguous(a, _) => Some(a),
        chrono::LocalResult::None => {
            // DST gap: slide forward an hour.
            let shifted = naive + chrono::Duration::hours(1);
            Local.from_local_datetime(&shifted).earliest()
        }
    }
}

/// The first time strictly after `after` at which `schedule` fires.
pub fn next_due(schedule: &Schedule, after: DateTime<Local>) -> Option<DateTime<Local>> {
    match schedule {
        Schedule::Interval { every_hours } => {
            Some(after + chrono::Duration::hours(i64::from(*every_hours)))
        }
        Schedule::Daily { time } => {
            let (h, m) = parse_hhmm(time)?;
            let today = local_at(after.date_naive(), h, m)?;
            if today > after {
                return Some(today);
            }
            local_at(after.date_naive().succ_opt()?, h, m)
        }
        Schedule::Weekly { weekday, time } => {
            let (h, m) = parse_hhmm(time)?;
            let target: chrono::Weekday = (*weekday).into();
            let mut date = after.date_naive();
            for _ in 0..8 {
                if date.weekday() == target {
                    if let Some(candidate) = local_at(date, h, m) {
                        if candidate > after {
                            return Some(candidate);
                        }
                    }
                }
                date = date.succ_opt()?;
            }
            None
        }
    }
}

/// Anchor for a job's next due time: its last run, or app start - whichever
/// is later. A slot missed while the app was closed never fires late.
fn anchor_ms(core: &crate::Core, last_run: Option<&JobRunResult>) -> i64 {
    let started = core.scheduler.started_at_epoch_ms;
    last_run.map(|r| r.epoch_ms.max(started)).unwrap_or(started)
}

fn next_run_ms(
    core: &crate::Core,
    job: &ScheduledJob,
    last_run: Option<&JobRunResult>,
) -> Option<i64> {
    let anchor = Local
        .timestamp_millis_opt(anchor_ms(core, last_run))
        .single()?;
    next_due(&job.schedule, anchor).map(epoch_ms)
}

/// `get_scheduler_status` (§3.10).
pub async fn status(core: &crate::Core) -> Result<SchedulerStatus> {
    let settings = core.settings().await;
    let state = with_state(core, |map| {
        // Drop state for jobs that no longer exist.
        map.retain(|id, _| settings.scheduler.jobs.iter().any(|j| &j.id == id));
        map.clone()
    })
    .await;
    let jobs = settings
        .scheduler
        .jobs
        .iter()
        .map(|job| {
            let last_run = state.get(&job.id).and_then(|s| s.last_run.clone());
            let next_run_epoch_ms = if settings.scheduler.enabled && job.enabled {
                next_run_ms(core, job, last_run.as_ref())
            } else {
                None
            };
            ScheduledJobStatus {
                id: job.id.clone(),
                next_run_epoch_ms,
                last_run,
            }
        })
        .collect();
    Ok(SchedulerStatus {
        enabled: settings.scheduler.enabled,
        jobs,
    })
}

async fn phase(core: &crate::Core) -> ServerPhase {
    crate::lifecycle::state(core)
        .await
        .map(|s| s.phase)
        .unwrap_or(ServerPhase::Stopped)
}

fn skipped(message: &str) -> JobRunResult {
    JobRunResult {
        epoch_ms: crate::util::now_epoch_ms(),
        ok: false,
        message: Some(message.to_string()),
    }
}

/// Execute one job now and return its result (audit entry included).
async fn execute(core: &crate::Core, job: &ScheduledJob, source: AuditSource) -> JobRunResult {
    let action = format!("scheduler.{}", job.kind.as_str());
    let outcome: std::result::Result<Option<String>, Error> = match job.kind {
        ScheduledJobKind::Restart => {
            if phase(core).await != ServerPhase::Running {
                let r = skipped("server not running");
                crate::audit::record(
                    core,
                    source,
                    &action,
                    Some(&job.id),
                    r.message.as_deref(),
                    None,
                )
                .await;
                return r;
            }
            let warn = job.message.clone();
            async {
                if let Some(msg) = &warn {
                    crate::rcon::run(core, &format!("say {msg}")).await?;
                    tokio::time::sleep(std::time::Duration::from_secs(RESTART_WARNING_SECS)).await;
                }
                crate::lifecycle::restart_from(core, source).await?;
                Ok(warn.map(|m| format!("warned: {m}")))
            }
            .await
        }
        ScheduledJobKind::Backup => {
            let settings = core.settings().await;
            if settings.active_mode == crate::settings::Mode::Advanced
                && phase(core).await != ServerPhase::Running
            {
                let r = skipped("server not running");
                crate::audit::record(
                    core,
                    source,
                    &action,
                    Some(&job.id),
                    r.message.as_deref(),
                    None,
                )
                .await;
                return r;
            }
            crate::backups::create_from(core, source)
                .await
                .map(|created| Some(created.entry.filename))
        }
        ScheduledJobKind::Broadcast => {
            if phase(core).await != ServerPhase::Running {
                let r = skipped("server not running");
                crate::audit::record(
                    core,
                    source,
                    &action,
                    Some(&job.id),
                    r.message.as_deref(),
                    None,
                )
                .await;
                return r;
            }
            let msg = job.message.clone().unwrap_or_default();
            crate::rcon::run(core, &format!("say {msg}"))
                .await
                .map(|_| Some(msg))
        }
    };
    let result = match &outcome {
        Ok(detail) => JobRunResult {
            epoch_ms: crate::util::now_epoch_ms(),
            ok: true,
            message: detail.clone(),
        },
        Err(e) => JobRunResult {
            epoch_ms: crate::util::now_epoch_ms(),
            ok: false,
            message: Some(crate::audit::error_string(e)),
        },
    };
    crate::audit::record(
        core,
        source,
        &action,
        Some(&job.id),
        result.message.as_deref(),
        outcome.as_ref().err(),
    )
    .await;
    result
}

/// Run one job under the engine's run lock and persist the outcome.
async fn run_locked(core: &crate::Core, job: &ScheduledJob, source: AuditSource) -> JobRunResult {
    let _guard = core.scheduler.run_lock.lock().await;
    // Stamp the slot first so a slow job is not re-fired by the next tick.
    let started = JobRunResult {
        epoch_ms: crate::util::now_epoch_ms(),
        ok: false,
        message: Some("running".into()),
    };
    let id = job.id.clone();
    with_state(core, |map| {
        map.entry(id.clone()).or_default().last_run = Some(started);
    })
    .await;
    let result = execute(core, job, source).await;
    let stored = result.clone();
    with_state(core, |map| {
        map.entry(id).or_default().last_run = Some(stored);
    })
    .await;
    result
}

/// `run_scheduled_job_now` (§3.10): ignores `enabled` flags and the schedule.
pub async fn run_now(core: &crate::Core, id: &str) -> Result<JobRunResult> {
    let settings = core.settings().await;
    let job = settings
        .scheduler
        .jobs
        .iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or_else(|| Error::InvalidInput(format!("unknown scheduled job: {id}")))?;
    Ok(run_locked(core, &job, AuditSource::User).await)
}

/// One scheduler tick (§3.10): fire every enabled job whose due time has
/// passed. Due jobs run on their own task so the tick never blocks; the run
/// lock serializes them and a job whose slot arrives while another run is in
/// progress simply waits its turn.
pub async fn tick(core: &Arc<crate::Core>) {
    let settings = core.settings().await;
    if !settings.scheduler.enabled {
        return;
    }
    let now = crate::util::now_epoch_ms();
    let state = with_state(core, |map| map.clone()).await;
    for job in settings.scheduler.jobs.iter().filter(|j| j.enabled) {
        let last_run = state.get(&job.id).and_then(|s| s.last_run.as_ref());
        if last_run.is_some_and(|r| r.message.as_deref() == Some("running")) {
            continue;
        }
        let Some(due) = next_run_ms(core, job, last_run) else {
            continue;
        };
        if now >= due {
            let core = core.clone();
            let job = job.clone();
            tokio::spawn(async move {
                run_locked(&core, &job, AuditSource::Scheduler).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Weekday;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().unwrap()
    }

    #[test]
    fn interval_adds_hours() {
        let after = at(2026, 9, 26, 10, 0);
        let due = next_due(&Schedule::Interval { every_hours: 6 }, after).unwrap();
        assert_eq!(due, at(2026, 9, 26, 16, 0));
    }

    #[test]
    fn daily_picks_today_or_tomorrow() {
        let sched = Schedule::Daily {
            time: "04:30".into(),
        };
        assert_eq!(
            next_due(&sched, at(2026, 9, 26, 3, 0)).unwrap(),
            at(2026, 9, 26, 4, 30)
        );
        assert_eq!(
            next_due(&sched, at(2026, 9, 26, 4, 30)).unwrap(),
            at(2026, 9, 27, 4, 30)
        );
        assert_eq!(
            next_due(&sched, at(2026, 9, 26, 23, 59)).unwrap(),
            at(2026, 9, 27, 4, 30)
        );
    }

    #[test]
    fn weekly_finds_the_next_matching_weekday() {
        // 2026-09-26 is a Saturday.
        let sched = Schedule::Weekly {
            weekday: Weekday::Sunday,
            time: "03:00".into(),
        };
        assert_eq!(
            next_due(&sched, at(2026, 9, 26, 12, 0)).unwrap(),
            at(2026, 9, 27, 3, 0)
        );
        let same_day = Schedule::Weekly {
            weekday: Weekday::Saturday,
            time: "03:00".into(),
        };
        assert_eq!(
            next_due(&same_day, at(2026, 9, 26, 12, 0)).unwrap(),
            at(2026, 10, 3, 3, 0)
        );
        assert_eq!(
            next_due(&same_day, at(2026, 9, 26, 2, 0)).unwrap(),
            at(2026, 9, 26, 3, 0)
        );
    }

    #[test]
    fn invalid_time_yields_none() {
        assert!(next_due(
            &Schedule::Daily {
                time: "25:00".into()
            },
            at(2026, 1, 1, 0, 0)
        )
        .is_none());
    }

    async fn core_with_jobs(jobs: Vec<ScheduledJob>) -> Arc<crate::Core> {
        let dir = tempfile::tempdir().unwrap().keep();
        let mut settings = crate::Settings::default_with_data_dir(&dir.join("data"));
        settings.scheduler.jobs = jobs;
        crate::Core::init_with_settings(dir.join("config"), dir.join("data"), settings).await
    }

    fn job(id: &str, kind: ScheduledJobKind, schedule: Schedule) -> ScheduledJob {
        ScheduledJob {
            id: id.into(),
            kind,
            enabled: true,
            schedule,
            message: Some("hello".into()),
        }
    }

    #[tokio::test]
    async fn status_reports_next_run_after_app_start_and_drops_stale_state() {
        let core = core_with_jobs(vec![job(
            "j1",
            ScheduledJobKind::Broadcast,
            Schedule::Interval { every_hours: 2 },
        )])
        .await;
        // Stale state for a job that no longer exists.
        with_state(&core, |map| {
            map.insert("gone".into(), JobState::default());
        })
        .await;
        let st = status(&core).await.unwrap();
        assert!(st.enabled);
        assert_eq!(st.jobs.len(), 1);
        let next = st.jobs[0].next_run_epoch_ms.unwrap();
        assert_eq!(next, core.scheduler.started_at_epoch_ms + 2 * 3600 * 1000);
        assert!(st.jobs[0].last_run.is_none());
        let raw = tokio::fs::read_to_string(state_file(&core)).await.unwrap();
        assert!(!raw.contains("gone"));
    }

    #[tokio::test]
    async fn run_now_records_a_skipped_result_when_server_is_down() {
        let core = core_with_jobs(vec![job(
            "b1",
            ScheduledJobKind::Broadcast,
            Schedule::Daily {
                time: "01:00".into(),
            },
        )])
        .await;
        let r = run_now(&core, "b1").await.unwrap();
        assert!(!r.ok);
        assert_eq!(r.message.as_deref(), Some("server not running"));
        let st = status(&core).await.unwrap();
        assert_eq!(
            st.jobs[0].last_run.as_ref().unwrap().message.as_deref(),
            Some("server not running")
        );
        let log = crate::audit::recent(&core, None).await.unwrap();
        assert_eq!(log.entries[0].action, "scheduler.broadcast");
        assert_eq!(log.entries[0].target.as_deref(), Some("b1"));
        assert_eq!(
            run_now(&core, "nope").await.unwrap_err().code(),
            "INVALID_INPUT"
        );
    }

    #[tokio::test]
    async fn disabled_jobs_have_no_next_run() {
        let mut j = job(
            "d",
            ScheduledJobKind::Backup,
            Schedule::Daily {
                time: "01:00".into(),
            },
        );
        j.enabled = false;
        let core = core_with_jobs(vec![j]).await;
        assert!(status(&core).await.unwrap().jobs[0]
            .next_run_epoch_ms
            .is_none());
    }
}
