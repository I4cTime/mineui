//! World backups (contract §3.8).
//!
//! Advanced: argv-array `tar`/`mv`/`rm` execs in the container (constant
//! `sh -c` only for the stat listing, zero interpolation). Restore requires
//! the server stopped, and `exec` cannot run in a stopped container — so
//! restore runs its `test`/`mv`/`tar` steps in a throwaway helper container
//! sharing the target's volumes (`run --rm --volumes-from`, still pure argv;
//! verified live against rootless podman 4.9.3). Listing and delete (2.9.0)
//! go through `runtime::run_in_container`: `exec` while the container runs,
//! the same helper otherwise. Simple: host-side tar.gz via the `tar` +
//! `flate2` crates.

use crate::error::{Error, Result};
use crate::model::{AuditSource, BackupEntry, CreatedBackup};
use crate::settings::Mode;

const LIST_BACKUPS_SCRIPT: &str =
    r#"for f in /data/backups/*.tar.gz; do [ -f "$f" ] || continue; stat -c '%n|%s|%Y' "$f"; done"#;

fn new_backup_filename() -> String {
    chrono::Local::now()
        .format("world-%Y%m%d-%H%M%S.tar.gz")
        .to_string()
}

fn parse_stat_lines(stdout: &str) -> Vec<BackupEntry> {
    let mut entries: Vec<BackupEntry> = stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.rsplitn(3, '|');
            let mtime: i64 = parts.next()?.trim().parse().ok()?;
            let size: u64 = parts.next()?.trim().parse().ok()?;
            let full_path = parts.next()?;
            let filename = full_path.rsplit('/').next()?.trim().to_string();
            crate::validate::backup_filename(&filename).ok()?;
            Some(BackupEntry {
                filename,
                size_bytes: size,
                created_at_epoch_ms: mtime * 1000,
            })
        })
        .collect();
    entries.sort_by(|a, b| b.filename.cmp(&a.filename)); // newest first
    entries
}

/// A listing run's outcome → entries; a failed run is an error, never `[]`
/// (§3.8, 2.9.0 — an empty list means there are no backups).
fn listing_result(out: crate::runtime::ExecOutput) -> Result<Vec<BackupEntry>> {
    if out.success() {
        Ok(parse_stat_lines(&out.stdout))
    } else {
        Err(Error::Io(format!(
            "could not list /data/backups: {}",
            if out.stderr.is_empty() {
                format!("exit code {:?}", out.exit_code)
            } else {
                out.stderr
            }
        )))
    }
}

async fn require_stopped(core: &crate::Core) -> Result<()> {
    let state = crate::lifecycle::state(core).await?;
    if state.phase == crate::model::ServerPhase::Running
        || state.phase == crate::model::ServerPhase::Starting
        || state.phase == crate::model::ServerPhase::Stopping
    {
        return Err(Error::ServerRunning(
            "stop the server before restoring a backup".into(),
        ));
    }
    Ok(())
}

/// Snapshot the world (§3.8). Allowed while running (crash-consistent).
async fn create_inner(core: &crate::Core) -> Result<BackupEntry> {
    let settings = core.settings().await;
    let filename = new_backup_filename();
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let world_dir = settings.advanced.world_dir.clone();

            let mkdir = runtime
                .exec(name, &["mkdir", "-p", "/data/backups"])
                .await?;
            if !mkdir.success() {
                return Err(Error::Io(format!(
                    "failed to create /data/backups: {}",
                    mkdir.stderr
                )));
            }
            let archive = format!("/data/backups/{filename}");
            let tar = runtime
                .exec(name, &["tar", "-czf", &archive, "-C", "/data", &world_dir])
                .await?;
            if !tar.success() {
                return Err(Error::Io(format!("backup failed: {}", tar.stderr)));
            }
            let stat = runtime
                .exec(name, &["stat", "-c", "%s|%Y", &archive])
                .await?;
            let (size, mtime) = if stat.success() {
                let mut parts = stat.stdout.trim().splitn(2, '|');
                (
                    parts
                        .next()
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .unwrap_or(0),
                    parts
                        .next()
                        .and_then(|s| s.trim().parse::<i64>().ok())
                        .unwrap_or(0),
                )
            } else {
                (0, 0)
            };
            Ok(BackupEntry {
                filename,
                size_bytes: size,
                created_at_epoch_ms: if mtime > 0 {
                    mtime * 1000
                } else {
                    crate::util::now_epoch_ms()
                },
            })
        }
        Mode::Simple => {
            let instance_dir = settings.simple.instance_dir.clone();
            let world = instance_dir.join("world");
            if !world.is_dir() {
                return Err(Error::Io(format!(
                    "world directory does not exist at {}",
                    world.display()
                )));
            }
            let backups_dir = instance_dir.join("backups");
            tokio::fs::create_dir_all(&backups_dir)
                .await
                .map_err(|e| Error::Io(format!("failed to create backups dir: {e}")))?;
            let archive = backups_dir.join(&filename);

            let archive_for_task = archive.clone();
            tokio::task::spawn_blocking(move || -> std::result::Result<(), std::io::Error> {
                let file = std::fs::File::create(&archive_for_task)?;
                let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
                let mut builder = tar::Builder::new(encoder);
                builder.append_dir_all("world", &world)?;
                builder.into_inner()?.finish()?;
                Ok(())
            })
            .await
            .map_err(|e| Error::Internal(format!("backup task panicked: {e}")))?
            .map_err(|e| Error::Io(format!("backup failed: {e}")))?;

            let metadata = tokio::fs::metadata(&archive)
                .await
                .map_err(|e| Error::Io(format!("backup metadata unavailable: {e}")))?;
            Ok(BackupEntry {
                filename,
                size_bytes: metadata.len(),
                created_at_epoch_ms: crate::util::now_epoch_ms(),
            })
        }
    }
}

/// `list_backups` (§3.8).
pub async fn list(core: &crate::Core) -> Result<Vec<BackupEntry>> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let out = crate::runtime::run_in_container(
                runtime.as_ref(),
                &settings.advanced.container_name,
                &["sh", "-c", LIST_BACKUPS_SCRIPT],
            )
            .await?;
            listing_result(out)
        }
        Mode::Simple => {
            let dir = settings.simple.instance_dir.join("backups");
            let mut entries: Vec<BackupEntry> = Vec::new();
            let Ok(mut reader) = tokio::fs::read_dir(&dir).await else {
                return Ok(entries);
            };
            while let Ok(Some(item)) = reader.next_entry().await {
                let filename = item.file_name().to_string_lossy().to_string();
                if crate::validate::backup_filename(&filename).is_err() {
                    continue;
                }
                let Ok(metadata) = item.metadata().await else {
                    continue;
                };
                let mtime = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                entries.push(BackupEntry {
                    filename,
                    size_bytes: metadata.len(),
                    created_at_epoch_ms: mtime,
                });
            }
            entries.sort_by(|a, b| b.filename.cmp(&a.filename));
            Ok(entries)
        }
    }
}

/// `restore_backup` (§3.8): requires server stopped. Current world is renamed
/// to `<worldDir>.pre-restore-<timestamp>` (kept), then the archive is
/// extracted into the data root.
async fn restore_inner(core: &crate::Core, filename: &str) -> Result<()> {
    crate::validate::backup_filename(filename)?;
    require_stopped(core).await?;
    let settings = core.settings().await;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();

    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let world_dir = settings.advanced.world_dir.clone();
            let archive = format!("/data/backups/{filename}");

            // The container is stopped here (require_stopped above), so every
            // step runs in a helper container over the same volumes — `exec`
            // would fail with "can only … on running containers".
            let exists = runtime
                .run_with_volumes_from(name, &["test", "-f", &archive])
                .await?;
            if !exists.success() {
                return Err(Error::InvalidInput(format!("backup not found: {filename}")));
            }
            let world_abs = format!("/data/{world_dir}");
            let world_present = runtime
                .run_with_volumes_from(name, &["test", "-d", &world_abs])
                .await?;
            if world_present.success() {
                let preserved = format!("/data/{world_dir}.pre-restore-{stamp}");
                let mv = runtime
                    .run_with_volumes_from(name, &["mv", &world_abs, &preserved])
                    .await?;
                if !mv.success() {
                    return Err(Error::Io(format!(
                        "failed to preserve current world: {}",
                        mv.stderr
                    )));
                }
            }
            let tar = runtime
                .run_with_volumes_from(name, &["tar", "-xzf", &archive, "-C", "/data"])
                .await?;
            if !tar.success() {
                return Err(Error::Io(format!("restore failed: {}", tar.stderr)));
            }
            Ok(())
        }
        Mode::Simple => {
            let instance_dir = settings.simple.instance_dir.clone();
            let archive = instance_dir.join("backups").join(filename);
            if !archive.is_file() {
                return Err(Error::InvalidInput(format!("backup not found: {filename}")));
            }
            let world = instance_dir.join("world");
            if world.is_dir() {
                let preserved = instance_dir.join(format!("world.pre-restore-{stamp}"));
                tokio::fs::rename(&world, &preserved)
                    .await
                    .map_err(|e| Error::Io(format!("failed to preserve current world: {e}")))?;
            }
            let root = instance_dir.clone();
            tokio::task::spawn_blocking(move || -> std::result::Result<(), std::io::Error> {
                let file = std::fs::File::open(&archive)?;
                let decoder = flate2::read::GzDecoder::new(file);
                let mut archive = tar::Archive::new(decoder);
                archive.unpack(&root)?;
                Ok(())
            })
            .await
            .map_err(|e| Error::Internal(format!("restore task panicked: {e}")))?
            .map_err(|e| Error::Io(format!("restore failed: {e}")))?;
            Ok(())
        }
    }
}

/// Remove one archive (§3.8), no audit — see `delete` / `prune`.
async fn delete_inner(core: &crate::Core, filename: &str) -> Result<()> {
    crate::validate::backup_filename(filename)?;
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let path = format!("/data/backups/{filename}");
            let out = crate::runtime::run_in_container(
                runtime.as_ref(),
                &settings.advanced.container_name,
                &["rm", "-f", "--", &path],
            )
            .await?;
            if !out.success() {
                return Err(Error::Io(format!(
                    "failed to delete backup: {}",
                    out.stderr
                )));
            }
            Ok(())
        }
        Mode::Simple => {
            let path = settings.simple.instance_dir.join("backups").join(filename);
            match tokio::fs::remove_file(&path).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    Err(Error::InvalidInput(format!("backup not found: {filename}")))
                }
                Err(e) => Err(Error::Io(format!("failed to delete backup: {e}"))),
            }
        }
    }
}

/* ---------- audited entry points, retention and off-box copy (§3.8, §3.11) ---------- */

/// `create_backup` (§3.8) from the user: snapshot, then retention + copy.
pub async fn create(core: &crate::Core) -> Result<CreatedBackup> {
    create_from(core, AuditSource::User).await
}

/// Create on behalf of `source` (the scheduler passes `Scheduler`). Retention
/// pruning and the off-box copy run after a successful snapshot and never
/// change its outcome; the files retention removed come back in `pruned`.
pub async fn create_from(core: &crate::Core, source: AuditSource) -> Result<CreatedBackup> {
    let r = create_inner(core).await;
    let target = r.as_ref().ok().map(|e| e.filename.clone());
    let detail = r.as_ref().ok().map(|e| format!("{} bytes", e.size_bytes));
    crate::audit::record(
        core,
        source,
        "backup.create",
        target.as_deref(),
        detail.as_deref(),
        r.as_ref().err(),
    )
    .await;
    let entry = r?;
    let pruned = prune(core, source, &entry.filename).await;
    copy_off_box(core, source, &entry.filename).await;
    Ok(CreatedBackup { entry, pruned })
}

/// `restore_backup` (§3.8), audited as `backup.restore`.
pub async fn restore(core: &crate::Core, filename: &str) -> Result<()> {
    let r = restore_inner(core, filename).await;
    crate::audit::record(
        core,
        AuditSource::User,
        "backup.restore",
        Some(filename),
        None,
        r.as_ref().err(),
    )
    .await;
    r
}

/// `delete_backup` (§3.8), audited as `backup.delete`.
pub async fn delete(core: &crate::Core, filename: &str) -> Result<()> {
    let r = delete_inner(core, filename).await;
    crate::audit::record(
        core,
        AuditSource::User,
        "backup.delete",
        Some(filename),
        None,
        r.as_ref().err(),
    )
    .await;
    r
}

/// Which archives fall outside `keep_last` (newest first input), never `just_written`.
pub fn prune_candidates<'a>(
    entries: &'a [BackupEntry],
    keep_last: u32,
    just_written: &str,
) -> Vec<&'a BackupEntry> {
    if keep_last == 0 {
        return Vec::new();
    }
    entries
        .iter()
        .skip(keep_last as usize)
        .filter(|e| e.filename != just_written)
        .collect()
}

/// Retention (§3.8): delete the oldest archives beyond `settings.backups.keepLast`.
/// Returns the filenames actually deleted (newest first, oldest last).
async fn prune(core: &crate::Core, source: AuditSource, just_written: &str) -> Vec<String> {
    let mut pruned: Vec<String> = Vec::new();
    let keep_last = core.settings().await.backups.keep_last;
    if keep_last == 0 {
        return pruned;
    }
    let entries = match list(core).await {
        Ok(entries) => entries,
        Err(e) => {
            crate::audit::record(
                core,
                source,
                "backup.prune",
                None,
                Some("listing failed"),
                Some(&e),
            )
            .await;
            return pruned;
        }
    };
    for stale in prune_candidates(&entries, keep_last, just_written) {
        let r = delete_inner(core, &stale.filename).await;
        let detail = format!("keepLast={keep_last}");
        crate::audit::record(
            core,
            source,
            "backup.prune",
            Some(&stale.filename),
            Some(&detail),
            r.as_ref().err(),
        )
        .await;
        if r.is_ok() {
            pruned.push(stale.filename.clone());
        }
    }
    pruned
}

/// Off-box copy (§3.8): `<copyDir>/<filename>` via a `.tmp` sibling + rename.
async fn copy_off_box(core: &crate::Core, source: AuditSource, filename: &str) {
    let settings = core.settings().await;
    let Some(copy_dir) = settings.backups.copy_dir.clone() else {
        return;
    };
    let dest = copy_dir.join(filename);
    let tmp = copy_dir.join(format!(".{filename}.tmp"));
    let result: Result<()> = async {
        tokio::fs::create_dir_all(&copy_dir)
            .await
            .map_err(|e| Error::Io(format!("failed to create {}: {e}", copy_dir.display())))?;
        match settings.active_mode {
            Mode::Simple => {
                let src = settings.simple.instance_dir.join("backups").join(filename);
                tokio::fs::copy(&src, &tmp)
                    .await
                    .map_err(|e| Error::Io(format!("copy failed: {e}")))?;
            }
            Mode::Advanced => {
                let runtime = crate::runtime::resolve(&settings.advanced).await?;
                let archive = format!("/data/backups/{filename}");
                runtime
                    .cp_from(&settings.advanced.container_name, &archive, &tmp)
                    .await?;
            }
        }
        tokio::fs::rename(&tmp, &dest)
            .await
            .map_err(|e| Error::Io(format!("failed to move copy into place: {e}")))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    let detail = dest.display().to_string();
    crate::audit::record(
        core,
        source,
        "backup.copy",
        Some(filename),
        Some(&detail),
        result.as_ref().err(),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_filenames_match_the_strict_pattern() {
        let name = new_backup_filename();
        assert!(crate::validate::backup_filename(&name).is_ok(), "{name}");
    }

    fn entry(name: &str) -> BackupEntry {
        BackupEntry {
            filename: name.into(),
            size_bytes: 1,
            created_at_epoch_ms: 0,
        }
    }

    #[test]
    fn prune_keeps_newest_and_never_the_fresh_archive() {
        let entries = vec![
            entry("world-20260926-040000.tar.gz"),
            entry("world-20260925-040000.tar.gz"),
            entry("world-20260924-040000.tar.gz"),
            entry("world-20260923-040000.tar.gz"),
        ];
        let stale: Vec<&str> = prune_candidates(&entries, 2, "world-20260926-040000.tar.gz")
            .into_iter()
            .map(|e| e.filename.as_str())
            .collect();
        assert_eq!(
            stale,
            vec![
                "world-20260924-040000.tar.gz",
                "world-20260923-040000.tar.gz"
            ]
        );
        assert!(
            prune_candidates(&entries, 0, "x").is_empty(),
            "0 = unlimited"
        );
        assert!(prune_candidates(&entries, 10, "x").is_empty());
        // A stale-looking listing that contains the fresh file keeps it.
        let stale = prune_candidates(&entries, 1, "world-20260923-040000.tar.gz");
        assert_eq!(stale.len(), 2);
    }

    #[test]
    fn created_backup_serializes_flat_with_pruned() {
        let created = CreatedBackup {
            entry: BackupEntry {
                filename: "world-20261003-120000.tar.gz".into(),
                size_bytes: 42,
                created_at_epoch_ms: 1_790_000_000_000,
            },
            pruned: vec!["world-20260901-040000.tar.gz".into()],
        };
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            serde_json::json!({
                "filename": "world-20261003-120000.tar.gz",
                "sizeBytes": 42,
                "createdAtEpochMs": 1_790_000_000_000i64,
                "pruned": ["world-20260901-040000.tar.gz"],
            })
        );
        let none = CreatedBackup {
            pruned: vec![],
            ..created
        };
        assert_eq!(
            serde_json::to_value(&none).unwrap()["pruned"],
            serde_json::json!([])
        );
    }

    fn exec_out(code: i32, stdout: &str, stderr: &str) -> crate::runtime::ExecOutput {
        crate::runtime::ExecOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code: Some(code),
        }
    }

    #[test]
    fn a_failed_listing_is_an_error_not_an_empty_list() {
        // Empty dir / no matches: success with no output → genuinely none.
        assert!(listing_result(exec_out(0, "", "")).unwrap().is_empty());
        let ok = listing_result(exec_out(
            0,
            "/data/backups/world-20261003-120000.tar.gz|10|1790000000\n",
            "",
        ))
        .unwrap();
        assert_eq!(ok.len(), 1);
        // The pre-2.9.0 bug: a failing exec on a stopped container came back as [].
        let err = listing_result(exec_out(
            125,
            "",
            "Error: can only create exec sessions on running containers: container state improper",
        ))
        .unwrap_err();
        assert_eq!(err.code(), "IO");
        assert!(err.to_string().contains("running containers"));
        assert_eq!(
            listing_result(exec_out(1, "", "")).unwrap_err().code(),
            "IO"
        );
    }

    #[test]
    fn stat_listing_filters_non_backup_files() {
        let stdout = "/data/backups/world-20260723-101530.tar.gz|1000|1753200000\n/data/backups/evil.tar.gz|5|1\n/data/backups/world-20260722-090000.tar.gz|2000|1753100000";
        let entries = parse_stat_lines(stdout);
        assert_eq!(entries.len(), 2);
        // newest first
        assert_eq!(entries[0].filename, "world-20260723-101530.tar.gz");
        assert_eq!(entries[0].created_at_epoch_ms, 1753200000000);
    }
}
