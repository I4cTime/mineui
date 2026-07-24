//! Host-side HTTP downloads with progress events (contract §4.3, §6.3).
//! All downloads happen in Rust via reqwest — never `curl` in a container.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use sha1::{Digest, Sha1};
use tokio::io::AsyncWriteExt;

use crate::error::{Error, Result};
use crate::model::{DownloadErrorShape, DownloadKind, DownloadProgressEvent};

/// Progress events are throttled to ≥ 150 ms apart; the terminal event is
/// always emitted (§4.3).
const PROGRESS_THROTTLE: Duration = Duration::from_millis(150);
/// §6.3: 60 s idle timeout.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// §6.3: ≤ 5 redirects, each re-checked for http/https.
const MAX_REDIRECTS: usize = 5;

pub struct DownloadRequest {
    pub url: reqwest::Url,
    pub kind: DownloadKind,
    pub filename: String,
    pub download_id: String,
    /// Byte cap (FILE_TOO_LARGE); None = uncapped (server jars are
    /// sha1-verified instead).
    pub max_bytes: Option<u64>,
    /// Expected SHA-1 (lowercase hex); mismatch → CHECKSUM_MISMATCH.
    pub expected_sha1: Option<String>,
}

pub struct DownloadResult {
    pub temp_path: PathBuf,
    pub bytes: u64,
    pub sha1_hex: String,
}

pub fn build_client() -> reqwest::Client {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        let scheme = attempt.url().scheme();
        if scheme != "http" && scheme != "https" {
            return attempt.error("redirect to non-http(s) URL");
        }
        attempt.follow()
    });
    reqwest::Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(READ_TIMEOUT)
        .user_agent(concat!("MineUI/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client construction cannot fail with static config")
}

/// Stream `req.url` to a temp file under `tmp_dir`, emitting
/// `mineui://download-progress` events on `core.events`. On failure the
/// terminal error event is emitted and the same error is returned.
pub async fn to_temp_file(core: &crate::Core, req: &DownloadRequest) -> Result<DownloadResult> {
    match run(core, req).await {
        Ok(result) => {
            emit(core, req, result.bytes, Some(result.bytes), true, None);
            Ok(result)
        }
        Err(err) => {
            emit(
                core,
                req,
                0,
                None,
                false,
                Some(DownloadErrorShape {
                    code: err.code().to_string(),
                    message: err.to_string(),
                }),
            );
            Err(err)
        }
    }
}

async fn run(core: &crate::Core, req: &DownloadRequest) -> Result<DownloadResult> {
    let tmp_dir = core.paths.data_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(|e| Error::Io(format!("failed to create temp dir: {e}")))?;
    let temp_path = tmp_dir.join(format!("download-{}", req.download_id));

    let response = core
        .http
        .get(req.url.clone())
        .send()
        .await
        .map_err(|e| Error::DownloadFailed(format!("request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "download failed with HTTP {}",
            response.status().as_u16()
        )));
    }
    let total_bytes = response.content_length();
    if let (Some(cap), Some(total)) = (req.max_bytes, total_bytes) {
        if total > cap {
            return Err(Error::FileTooLarge(format!(
                "download is {total} bytes; limit is {cap}"
            )));
        }
    }

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| Error::Io(format!("failed to create temp file: {e}")))?;
    let mut hasher = Sha1::new();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now() - PROGRESS_THROTTLE;

    let mut response = response;
    let result: Result<()> = loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                received += chunk.len() as u64;
                if let Some(cap) = req.max_bytes {
                    if received > cap {
                        break Err(Error::FileTooLarge(format!(
                            "download exceeded the {cap}-byte limit"
                        )));
                    }
                }
                hasher.update(&chunk);
                if let Err(e) = file.write_all(&chunk).await {
                    break Err(Error::Io(format!("failed writing download: {e}")));
                }
                if last_emit.elapsed() >= PROGRESS_THROTTLE {
                    last_emit = Instant::now();
                    emit(core, req, received, total_bytes, false, None);
                }
            }
            Ok(None) => break Ok(()),
            Err(e) => {
                break Err(Error::DownloadFailed(format!(
                    "download stream failed: {e}"
                )))
            }
        }
    };

    if let Err(err) = result {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(err);
    }
    file.flush()
        .await
        .map_err(|e| Error::Io(format!("failed flushing download: {e}")))?;
    drop(file);

    let sha1_hex = hex::encode(hasher.finalize());
    if let Some(expected) = &req.expected_sha1 {
        if !expected.eq_ignore_ascii_case(&sha1_hex) {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(Error::ChecksumMismatch(format!(
                "sha1 mismatch: expected {expected}, got {sha1_hex}"
            )));
        }
    }
    Ok(DownloadResult {
        temp_path,
        bytes: received,
        sha1_hex,
    })
}

fn emit(
    core: &crate::Core,
    req: &DownloadRequest,
    received: u64,
    total: Option<u64>,
    done: bool,
    error: Option<DownloadErrorShape>,
) {
    core.emit_event(crate::model::CoreEvent::DownloadProgress(
        DownloadProgressEvent {
            download_id: req.download_id.clone(),
            kind: req.kind,
            filename: req.filename.clone(),
            url: req.url.to_string(),
            received_bytes: received,
            total_bytes: total,
            done,
            error,
        },
    ));
}
