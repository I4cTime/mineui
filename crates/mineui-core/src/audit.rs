//! Append-only admin audit log (contract §3.11).
//!
//! `<data_dir>/audit-log.jsonl`, one `AuditEntry` per line. When the file
//! passes 5 MB it is rotated to `audit-log.jsonl.1` (one generation kept).
//! Recording never fails the action it describes: every error here is
//! swallowed after an `eprintln!`.

use std::path::PathBuf;

use crate::error::{Error, Result};
use crate::model::{AuditEntry, AuditLog, AuditSource};

const FILE: &str = "audit-log.jsonl";
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
pub const DEFAULT_LIMIT: u32 = 200;
pub const MAX_LIMIT: u32 = 1000;

fn primary(core: &crate::Core) -> PathBuf {
    core.paths.data_dir.join(FILE)
}

fn rotated(core: &crate::Core) -> PathBuf {
    core.paths.data_dir.join(format!("{FILE}.1"))
}

/// `"CODE: message"` - the `error` field of a failed entry.
pub fn error_string(e: &Error) -> String {
    format!("{}: {e}", e.code())
}

/// Record one action. `err` is the failure of the action, if any.
pub async fn record(
    core: &crate::Core,
    source: AuditSource,
    action: &str,
    target: Option<&str>,
    detail: Option<&str>,
    err: Option<&Error>,
) {
    let entry = AuditEntry {
        id: uuid::Uuid::new_v4().to_string(),
        epoch_ms: crate::util::now_epoch_ms(),
        source,
        action: action.to_string(),
        target: target.map(str::to_string),
        detail: detail.map(str::to_string),
        ok: err.is_none(),
        error: err.map(error_string),
    };
    if let Err(e) = append(core, &entry).await {
        eprintln!("mineui: audit log write failed: {e}");
    }
}

async fn append(core: &crate::Core, entry: &AuditEntry) -> Result<()> {
    let _guard = core.audit_lock.lock().await;
    let path = primary(core);
    tokio::fs::create_dir_all(&core.paths.data_dir)
        .await
        .map_err(|e| Error::Io(format!("failed to create data dir: {e}")))?;
    if let Ok(meta) = tokio::fs::metadata(&path).await {
        if meta.len() > ROTATE_BYTES {
            tokio::fs::rename(&path, rotated(core))
                .await
                .map_err(|e| Error::Io(format!("audit log rotation failed: {e}")))?;
        }
    }
    let mut line = serde_json::to_string(entry)
        .map_err(|e| Error::Internal(format!("failed to serialize audit entry: {e}")))?;
    line.push('\n');
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| Error::Io(format!("failed to open audit log: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await;
    }
    file.write_all(line.as_bytes())
        .await
        .map_err(|e| Error::Io(format!("failed to append audit entry: {e}")))?;
    // tokio's File hands the write to a blocking thread; without this the
    // entry can still be in flight when we return, and a `recent()` right
    // after (the Activity log refreshing on an action) would miss it.
    file.flush()
        .await
        .map_err(|e| Error::Io(format!("failed to flush audit entry: {e}")))?;
    Ok(())
}

fn parse_lines(raw: &str) -> Vec<AuditEntry> {
    raw.lines()
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .collect()
}

/// `get_audit_log` (§3.11): newest `limit` entries, newest first.
pub async fn recent(core: &crate::Core, limit: Option<u32>) -> Result<AuditLog> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    let mut entries = match tokio::fs::read_to_string(primary(core)).await {
        Ok(raw) => parse_lines(&raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(Error::Io(format!("failed to read audit log: {e}"))),
    };
    if entries.len() < limit {
        if let Ok(raw) = tokio::fs::read_to_string(rotated(core)).await {
            let mut older = parse_lines(&raw);
            older.append(&mut entries);
            entries = older;
        }
    }
    let skip = entries.len().saturating_sub(limit);
    let mut newest: Vec<AuditEntry> = entries.into_iter().skip(skip).collect();
    newest.reverse();
    Ok(AuditLog { entries: newest })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn core() -> std::sync::Arc<crate::Core> {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.keep();
        crate::Core::init_with_settings(
            dir.join("config"),
            dir.join("data"),
            crate::Settings::default_with_data_dir(&dir.join("data")),
        )
        .await
    }

    #[tokio::test]
    async fn records_and_reads_newest_first() {
        let core = core().await;
        record(&core, AuditSource::User, "server.start", None, None, None).await;
        let err = Error::InvalidInput("nope".into());
        record(
            &core,
            AuditSource::Scheduler,
            "scheduler.backup",
            Some("job-1"),
            Some("d"),
            Some(&err),
        )
        .await;
        let log = recent(&core, None).await.unwrap();
        assert_eq!(log.entries.len(), 2);
        assert_eq!(log.entries[0].action, "scheduler.backup");
        assert!(!log.entries[0].ok);
        assert_eq!(log.entries[0].error.as_deref(), Some("INVALID_INPUT: nope"));
        assert_eq!(log.entries[0].source, AuditSource::Scheduler);
        assert_eq!(log.entries[1].action, "server.start");
        assert!(log.entries[1].ok);
        let limited = recent(&core, Some(1)).await.unwrap();
        assert_eq!(limited.entries.len(), 1);
        assert_eq!(limited.entries[0].action, "scheduler.backup");
    }

    #[tokio::test]
    async fn empty_log_is_ok_and_entry_shape_is_camel_case() {
        let core = core().await;
        assert!(recent(&core, None).await.unwrap().entries.is_empty());
        record(
            &core,
            AuditSource::User,
            "note.set",
            Some("Steve"),
            None,
            None,
        )
        .await;
        let raw = tokio::fs::read_to_string(primary(&core)).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(v["source"], "user");
        assert!(v.get("epochMs").is_some());
        assert_eq!(v["target"], "Steve");
        assert!(v["detail"].is_null());
    }

    #[tokio::test]
    async fn reads_rotated_generation_when_primary_is_short() {
        let core = core().await;
        record(&core, AuditSource::User, "old", None, None, None).await;
        tokio::fs::rename(primary(&core), rotated(&core))
            .await
            .unwrap();
        record(&core, AuditSource::User, "new", None, None, None).await;
        let log = recent(&core, Some(10)).await.unwrap();
        assert_eq!(
            log.entries
                .iter()
                .map(|e| e.action.as_str())
                .collect::<Vec<_>>(),
            vec!["new", "old"]
        );
    }
}
