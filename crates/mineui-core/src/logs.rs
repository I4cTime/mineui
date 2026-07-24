//! Log tail + refcounted live stream (contract §3.3, §4.1).
//!
//! `mineui://logs` events are emitted only while at least one stream is
//! active; the batcher flushes at most every 100 ms or 50 lines.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::model::{CoreEvent, LogLine, LogSource, LogsEvent, LogsTail};
use crate::settings::Mode;

const BATCH_MAX_LINES: usize = 50;
const BATCH_MAX_DELAY: Duration = Duration::from_millis(100);
const CHANNEL_CAPACITY: usize = 4096;

/// Cheap clonable handle producers (supervisor, runtime follower) use to
/// submit lines. Lines are dropped when no stream is active.
#[derive(Clone)]
pub struct LogSink {
    active: Arc<AtomicBool>,
    tx: mpsc::Sender<LogLine>,
}

impl LogSink {
    pub fn submit(&self, line: LogLine) {
        if self.active.load(Ordering::Relaxed) {
            let _ = self.tx.try_send(line);
        }
    }
}

pub struct Manager {
    active: Arc<AtomicBool>,
    tx: mpsc::Sender<LogLine>,
    refcount: std::sync::Mutex<usize>,
    follow_child: tokio::sync::Mutex<Option<tokio::process::Child>>,
}

impl Manager {
    /// Creates the manager and spawns the batcher task on the current runtime.
    pub fn new(events: tokio::sync::broadcast::Sender<CoreEvent>) -> Self {
        let (tx, rx) = mpsc::channel::<LogLine>(CHANNEL_CAPACITY);
        tokio::spawn(batcher(rx, events));
        Manager {
            active: Arc::new(AtomicBool::new(false)),
            tx,
            refcount: std::sync::Mutex::new(0),
            follow_child: tokio::sync::Mutex::new(None),
        }
    }

    pub fn sink(&self) -> LogSink {
        LogSink {
            active: self.active.clone(),
            tx: self.tx.clone(),
        }
    }

    /// §3.3 `start_log_stream`: refcounted; the advanced-mode follow
    /// subprocess is spawned on the 0→1 transition.
    pub async fn stream_start(&self, core: &crate::Core) -> Result<()> {
        let is_first = {
            let mut count = self.refcount.lock().unwrap();
            *count += 1;
            *count == 1
        };
        if !is_first {
            return Ok(());
        }
        self.active.store(true, Ordering::Relaxed);

        let settings = core.settings().await;
        if settings.active_mode == Mode::Advanced {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let mut child = runtime
                .spawn_follow_logs(&settings.advanced.container_name)
                .await?;
            let sink = self.sink();
            if let Some(stdout) = child.stdout.take() {
                spawn_follow_reader(stdout, sink.clone());
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_follow_reader(stderr, sink);
            }
            *self.follow_child.lock().await = Some(child);
        }
        Ok(())
    }

    /// §3.3 `stop_log_stream`: kills the follower on the 1→0 transition.
    /// Extra stops are a no-op, not an error.
    pub async fn stream_stop(&self) -> Result<()> {
        let is_last = {
            let mut count = self.refcount.lock().unwrap();
            if *count == 0 {
                return Ok(());
            }
            *count -= 1;
            *count == 0
        };
        if !is_last {
            return Ok(());
        }
        self.active.store(false, Ordering::Relaxed);
        if let Some(mut child) = self.follow_child.lock().await.take() {
            let _ = child.start_kill();
        }
        Ok(())
    }
}

fn spawn_follow_reader(stream: impl tokio::io::AsyncRead + Unpin + Send + 'static, sink: LogSink) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            sink.submit(LogLine {
                text,
                epoch_ms: crate::util::now_epoch_ms(),
                source: LogSource::Runtime,
            });
        }
    });
}

/// Flushes at most every 100 ms or 50 lines, whichever first (§4.1).
async fn batcher(
    mut rx: mpsc::Receiver<LogLine>,
    events: tokio::sync::broadcast::Sender<CoreEvent>,
) {
    let mut buffer: Vec<LogLine> = Vec::with_capacity(BATCH_MAX_LINES);
    loop {
        if buffer.is_empty() {
            match rx.recv().await {
                Some(line) => buffer.push(line),
                None => return,
            }
            continue;
        }
        let deadline = tokio::time::Instant::now() + BATCH_MAX_DELAY;
        loop {
            tokio::select! {
                maybe = rx.recv() => match maybe {
                    Some(line) => {
                        buffer.push(line);
                        if buffer.len() >= BATCH_MAX_LINES {
                            break;
                        }
                    }
                    None => break,
                },
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }
        let lines = std::mem::take(&mut buffer);
        let _ = events.send(CoreEvent::Logs(LogsEvent { lines }));
        if rx.is_closed() && rx.is_empty() {
            return;
        }
    }
}

/// §3.3 `get_logs`: tail default 200, clamped [10, 1000].
pub async fn tail(core: &crate::Core, tail: Option<u32>) -> Result<LogsTail> {
    let n = crate::util::clamp_tail(tail);
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let lines = runtime
                .logs_tail(&settings.advanced.container_name, n)
                .await?;
            Ok(LogsTail { lines })
        }
        Mode::Simple => Ok(LogsTail {
            lines: core.supervisor.ring_tail(n as usize),
        }),
    }
}

/// Convenience wrappers matching the contract's core-fn names.
pub async fn stream_start(core: &crate::Core) -> Result<()> {
    core.logs.stream_start(core).await
}

pub async fn stream_stop(core: &crate::Core) -> Result<()> {
    core.logs.stream_stop().await.map_err(|e: Error| e)
}
