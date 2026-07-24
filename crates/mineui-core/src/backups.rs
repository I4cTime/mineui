//! World backups (contract §3.8).
//!
//! Advanced: argv-array `tar`/`mv`/`rm` execs in the container (constant
//! `sh -c` only for the stat listing, zero interpolation). Restore requires
//! the server stopped, and `exec` cannot run in a stopped container — so
//! restore runs its `test`/`mv`/`tar` steps in a throwaway helper container
//! sharing the target's volumes (`run --rm --volumes-from`, still pure argv;
//! verified live against rootless podman 4.9.3). Simple: host-side tar.gz via
//! the `tar` + `flate2` crates.

use crate::error::{Error, Result};
use crate::model::BackupEntry;
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

/// `create_backup` (§3.8). Allowed while running (crash-consistent snapshot).
pub async fn create(core: &crate::Core) -> Result<BackupEntry> {
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
            let out = runtime
                .exec(
                    &settings.advanced.container_name,
                    &["sh", "-c", LIST_BACKUPS_SCRIPT],
                )
                .await?;
            Ok(if out.success() {
                parse_stat_lines(&out.stdout)
            } else {
                Vec::new()
            })
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
pub async fn restore(core: &crate::Core, filename: &str) -> Result<()> {
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

/// `delete_backup` (§3.8).
pub async fn delete(core: &crate::Core, filename: &str) -> Result<()> {
    crate::validate::backup_filename(filename)?;
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let path = format!("/data/backups/{filename}");
            let out = runtime
                .exec(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_filenames_match_the_strict_pattern() {
        let name = new_backup_filename();
        assert!(crate::validate::backup_filename(&name).is_ok(), "{name}");
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
