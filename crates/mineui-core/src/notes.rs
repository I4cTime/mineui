//! Per-player operator notes (contract §3.11).
//!
//! `<data_dir>/player-notes.json`: `{ [usernameLower]: PlayerNote }`, written
//! atomically with 0600 permissions like settings.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::error::{Error, Result};
use crate::model::{AuditSource, PlayerNote, PlayerNotes};

const FILE: &str = "player-notes.json";
pub const MAX_NOTE_CHARS: usize = 2000;

fn file(core: &crate::Core) -> PathBuf {
    core.paths.data_dir.join(FILE)
}

fn validate_username(username: &str) -> Result<()> {
    let ok = (1..=16).contains(&username.len())
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidInput(format!(
            "invalid username: {username} (expected ^[A-Za-z0-9_]{{1,16}}$)"
        )))
    }
}

async fn read_map(core: &crate::Core) -> Result<BTreeMap<String, PlayerNote>> {
    match tokio::fs::read_to_string(file(core)).await {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|e| Error::Io(format!("player-notes.json is not valid: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(Error::Io(format!("failed to read player notes: {e}"))),
    }
}

async fn write_map(core: &crate::Core, map: &BTreeMap<String, PlayerNote>) -> Result<()> {
    let json = serde_json::to_string_pretty(map)
        .map_err(|e| Error::Internal(format!("failed to serialize player notes: {e}")))?;
    crate::util::write_atomic_bytes(&file(core), json.as_bytes()).await
}

/// `get_player_notes` (§3.11): every note, sorted by lowercase username.
pub async fn list(core: &crate::Core) -> Result<PlayerNotes> {
    let map = read_map(core).await?;
    Ok(PlayerNotes {
        notes: map.into_values().collect(),
    })
}

/// `set_player_note` (§3.11): trimmed note; empty deletes and returns `None`.
pub async fn set(core: &crate::Core, username: &str, note: &str) -> Result<Option<PlayerNote>> {
    let username = username.trim();
    validate_username(username)?;
    let note = note.trim();
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(Error::InvalidInput(format!(
            "note exceeds {MAX_NOTE_CHARS} characters"
        )));
    }
    let key = username.to_lowercase();
    let result = {
        let _guard = core.notes_lock.lock().await;
        let mut map = read_map(core).await?;
        let stored = if note.is_empty() {
            map.remove(&key);
            None
        } else {
            let entry = PlayerNote {
                username: username.to_string(),
                note: note.to_string(),
                updated_at_epoch_ms: crate::util::now_epoch_ms(),
            };
            map.insert(key, entry.clone());
            Some(entry)
        };
        write_map(core, &map).await.map(|_| stored)
    };
    let action = if note.is_empty() {
        "note.clear"
    } else {
        "note.set"
    };
    crate::audit::record(
        core,
        AuditSource::User,
        action,
        Some(username),
        None,
        result.as_ref().err(),
    )
    .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn core() -> std::sync::Arc<crate::Core> {
        let dir = tempfile::tempdir().unwrap().keep();
        crate::Core::init_with_settings(
            dir.join("config"),
            dir.join("data"),
            crate::Settings::default_with_data_dir(&dir.join("data")),
        )
        .await
    }

    #[tokio::test]
    async fn set_list_and_clear_roundtrip() {
        let core = core().await;
        let saved = set(&core, "Steve", "  griefed spawn twice ")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.username, "Steve");
        assert_eq!(saved.note, "griefed spawn twice");
        set(&core, "alex", "builder").await.unwrap();
        let all = list(&core).await.unwrap();
        assert_eq!(all.notes.len(), 2);
        assert_eq!(all.notes[0].username, "alex"); // sorted by lowercase key
                                                   // Same player, different case → overwrite, not duplicate.
        set(&core, "STEVE", "reformed").await.unwrap();
        let all = list(&core).await.unwrap();
        assert_eq!(all.notes.len(), 2);
        assert_eq!(all.notes[1].note, "reformed");
        assert!(set(&core, "steve", "").await.unwrap().is_none());
        assert_eq!(list(&core).await.unwrap().notes.len(), 1);
        let log = crate::audit::recent(&core, None).await.unwrap();
        assert_eq!(log.entries[0].action, "note.clear");
    }

    #[tokio::test]
    async fn rejects_bad_usernames_and_long_notes() {
        let core = core().await;
        assert_eq!(
            set(&core, "bad name", "x").await.unwrap_err().code(),
            "INVALID_INPUT"
        );
        assert_eq!(
            set(&core, "", "x").await.unwrap_err().code(),
            "INVALID_INPUT"
        );
        assert_eq!(
            set(&core, "a".repeat(17).as_str(), "x")
                .await
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );
        let long = "n".repeat(MAX_NOTE_CHARS + 1);
        assert_eq!(
            set(&core, "ok_name", &long).await.unwrap_err().code(),
            "INVALID_INPUT"
        );
    }
}
