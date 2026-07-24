//! Simple-mode process supervisor (contract §3.2, module map §8):
//! spawn java, stream stdout/stderr, phase machine
//! (starting → running via "]: Done (", stopping via stdin `stop` with a 30 s
//! kill timeout, crashed on unexpected nonzero exit), 2000-line ring buffer.

use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Notify;

use crate::error::{Error, Result};
use crate::model::{CoreEvent, LogLine, LogSource, ServerPhase, ServerStateEvent};
use crate::settings::Mode;

pub const RING_CAPACITY: usize = 2000;
const STOP_KILL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
struct PhaseInfo {
    phase: ServerPhase,
    pid: Option<u32>,
    started_at: Option<String>,
    last_exit_code: Option<i32>,
    stop_requested: bool,
    generation: u64,
}

struct Shared {
    info: Mutex<PhaseInfo>,
    ring: Mutex<VecDeque<LogLine>>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    kill_notify: Notify,
    events: tokio::sync::broadcast::Sender<CoreEvent>,
    log_sink: crate::logs::LogSink,
}

pub struct Supervisor {
    shared: Arc<Shared>,
}

impl Supervisor {
    pub fn new(
        events: tokio::sync::broadcast::Sender<CoreEvent>,
        log_sink: crate::logs::LogSink,
    ) -> Self {
        Supervisor {
            shared: Arc::new(Shared {
                info: Mutex::new(PhaseInfo {
                    phase: ServerPhase::Stopped,
                    pid: None,
                    started_at: None,
                    last_exit_code: None,
                    stop_requested: false,
                    generation: 0,
                }),
                ring: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
                stdin: tokio::sync::Mutex::new(None),
                kill_notify: Notify::new(),
                events,
                log_sink,
            }),
        }
    }

    pub fn phase(&self) -> ServerPhase {
        self.shared.info.lock().unwrap().phase
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self.phase(),
            ServerPhase::Starting | ServerPhase::Running | ServerPhase::Stopping
        )
    }

    pub fn pid(&self) -> Option<u32> {
        self.shared.info.lock().unwrap().pid
    }

    pub fn started_at(&self) -> Option<String> {
        self.shared.info.lock().unwrap().started_at.clone()
    }

    pub fn last_exit_code(&self) -> Option<i32> {
        self.shared.info.lock().unwrap().last_exit_code
    }

    /// Last `n` buffered log lines (text only).
    pub fn ring_tail(&self, n: usize) -> Vec<String> {
        let ring = self.shared.ring.lock().unwrap();
        ring.iter()
            .skip(ring.len().saturating_sub(n))
            .map(|line| line.text.clone())
            .collect()
    }

    /// Spawn `<java> -Xms<mem>M -Xmx<mem>M -jar server.jar nogui` with
    /// cwd = instance_dir (§3.2). Phase: starting.
    pub async fn start(&self, java: &Path, instance_dir: &Path, memory_mb: u32) -> Result<()> {
        if self.is_active() {
            return Err(Error::ServerRunning("server is already running".into()));
        }

        let mut child = tokio::process::Command::new(java)
            .arg(format!("-Xms{memory_mb}M"))
            .arg(format!("-Xmx{memory_mb}M"))
            .arg("-jar")
            .arg("server.jar")
            .arg("nogui")
            .current_dir(instance_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::JavaNotFound(format!("failed to spawn java: {e}")))?;

        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();

        let generation = {
            let mut info = self.shared.info.lock().unwrap();
            info.generation += 1;
            info.pid = pid;
            info.started_at = Some(crate::util::now_iso8601());
            info.last_exit_code = None;
            info.stop_requested = false;
            info.generation
        };
        *self.shared.stdin.lock().await = stdin;
        self.set_phase(ServerPhase::Starting, None);

        if let Some(stdout) = stdout {
            spawn_line_reader(self.shared.clone(), stdout, LogSource::Stdout, generation);
        }
        if let Some(stderr) = stderr {
            spawn_line_reader(self.shared.clone(), stderr, LogSource::Stderr, generation);
        }
        spawn_waiter(self.shared.clone(), child, generation);
        Ok(())
    }

    /// Write `stop\n` to stdin; phase stopping; SIGKILL after 30 s (§3.2).
    pub async fn stop(&self) -> Result<()> {
        if !self.is_active() {
            return Err(Error::ServerNotRunning("server is not running".into()));
        }
        {
            let mut info = self.shared.info.lock().unwrap();
            info.stop_requested = true;
        }
        self.set_phase(ServerPhase::Stopping, None);

        let mut stdin_slot = self.shared.stdin.lock().await;
        let wrote = if let Some(stdin) = stdin_slot.as_mut() {
            stdin.write_all(b"stop\n").await.is_ok() && stdin.flush().await.is_ok()
        } else {
            false
        };
        drop(stdin_slot);
        if !wrote {
            // stdin unavailable — go straight to kill.
            self.shared.kill_notify.notify_one();
            return Ok(());
        }

        let shared = self.shared.clone();
        let generation = shared.info.lock().unwrap().generation;
        tokio::spawn(async move {
            tokio::time::sleep(STOP_KILL_TIMEOUT).await;
            let still_stopping = {
                let info = shared.info.lock().unwrap();
                info.generation == generation && info.phase == ServerPhase::Stopping
            };
            if still_stopping {
                shared.kill_notify.notify_one();
            }
        });
        Ok(())
    }

    /// Await process exit after a stop (used by restart). Polls the phase.
    pub async fn wait_for_exit(&self, timeout: Duration) -> Result<()> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if !self.is_active() {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::Internal(
                    "timed out waiting for the server process to exit".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    fn set_phase(&self, phase: ServerPhase, exit_code: Option<i32>) {
        set_phase_on(&self.shared, phase, exit_code);
    }
}

fn set_phase_on(shared: &Shared, phase: ServerPhase, exit_code: Option<i32>) {
    let previous = {
        let mut info = shared.info.lock().unwrap();
        let previous = info.phase;
        if previous == phase {
            return;
        }
        info.phase = phase;
        if exit_code.is_some() {
            info.last_exit_code = exit_code;
        }
        if matches!(phase, ServerPhase::Stopped | ServerPhase::Crashed) {
            info.pid = None;
        }
        previous
    };
    let _ = shared.events.send(CoreEvent::ServerState(ServerStateEvent {
        mode: Mode::Simple,
        phase,
        previous_phase: previous,
        epoch_ms: crate::util::now_epoch_ms(),
        exit_code,
    }));
}

fn spawn_line_reader(
    shared: Arc<Shared>,
    stream: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    source: LogSource,
    generation: u64,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            let line = LogLine {
                text,
                epoch_ms: crate::util::now_epoch_ms(),
                source,
            };
            {
                let mut ring = shared.ring.lock().unwrap();
                if ring.len() >= RING_CAPACITY {
                    ring.pop_front();
                }
                ring.push_back(line.clone());
            }
            // "Done (" detection: starting → running.
            let should_promote = {
                let info = shared.info.lock().unwrap();
                info.generation == generation
                    && info.phase == ServerPhase::Starting
                    && crate::util::is_done_line(&line.text)
            };
            if should_promote {
                set_phase_on(&shared, ServerPhase::Running, None);
            }
            shared.log_sink.submit(line);
        }
    });
}

fn spawn_waiter(shared: Arc<Shared>, mut child: Child, generation: u64) {
    tokio::spawn(async move {
        let status = loop {
            tokio::select! {
                status = child.wait() => break status,
                _ = shared.kill_notify.notified() => {
                    let _ = child.start_kill();
                }
            }
        };
        let exit_code = status.ok().and_then(|s| s.code());
        let (stale, stop_requested) = {
            let info = shared.info.lock().unwrap();
            (info.generation != generation, info.stop_requested)
        };
        if stale {
            return;
        }
        *shared.stdin.lock().await = None;
        // Exit while not stopping → crashed (§3.2); treat exit code 0 as a
        // clean stop even if externally initiated.
        let phase = if stop_requested || exit_code == Some(0) {
            ServerPhase::Stopped
        } else {
            ServerPhase::Crashed
        };
        set_phase_on(&shared, phase, Some(exit_code.unwrap_or(-1)));
    });
}
