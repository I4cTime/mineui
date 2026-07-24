//! Mods & plugins management (contract §3.5, §6.2–6.3).
//!
//! Advanced-mode listing uses compile-time-constant `sh -c` scripts with
//! zero interpolation (explicitly permitted by §6.1 rule 6); every other exec
//! is a plain argv array. Downloads happen host-side in Rust (reqwest) and
//! are streamed into the container via `cp` — never `curl` in the container.

use std::path::PathBuf;

use crate::error::{Error, Result};
use crate::model::{DownloadKind, DownloadedMod, ModEntry, ModTarget, ModsList, UploadedMod};
use crate::settings::Mode;

/// §3.5: 256 MB download cap.
const MOD_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Constant listing scripts — zero interpolation (§6.1 rule 6).
const LIST_MODS_SCRIPT: &str =
    r#"for f in /data/mods/*; do [ -f "$f" ] || continue; stat -c '%n|%s|%Y' "$f"; done"#;
const LIST_PLUGINS_SCRIPT: &str =
    r#"for f in /data/plugins/*; do [ -f "$f" ] || continue; stat -c '%n|%s|%Y' "$f"; done"#;

fn container_root(target: ModTarget) -> &'static str {
    match target {
        ModTarget::Mods => "/data/mods",
        ModTarget::Plugins => "/data/plugins",
    }
}

fn entry_from_parts(filename: &str, size: u64, mtime_secs: i64) -> ModEntry {
    ModEntry {
        name: crate::util::mod_display_name(filename),
        filename: filename.to_string(),
        size_bytes: size,
        // v1 sent unix seconds — normalized to epoch ms (§3.5).
        updated_at_epoch_ms: mtime_secs * 1000,
        loader: crate::util::detect_loader(filename),
    }
}

/// Parse `stat -c '%n|%s|%Y'` lines.
fn parse_stat_lines(stdout: &str) -> Vec<ModEntry> {
    let mut entries: Vec<ModEntry> = stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.rsplitn(3, '|');
            let mtime: i64 = parts.next()?.trim().parse().ok()?;
            let size: u64 = parts.next()?.trim().parse().ok()?;
            let full_path = parts.next()?;
            let filename = full_path.rsplit('/').next()?.trim();
            if filename.is_empty() {
                return None;
            }
            Some(entry_from_parts(filename, size, mtime))
        })
        .collect();
    entries.sort_by_key(|a| a.filename.to_lowercase());
    entries
}

async fn list_host_dir(dir: &std::path::Path) -> Vec<ModEntry> {
    let mut entries: Vec<ModEntry> = Vec::new();
    let Ok(mut reader) = tokio::fs::read_dir(dir).await else {
        return entries;
    };
    while let Ok(Some(item)) = reader.next_entry().await {
        let Ok(metadata) = item.metadata().await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let filename = item.file_name().to_string_lossy().to_string();
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(entry_from_parts(&filename, metadata.len(), mtime));
    }
    entries.sort_by_key(|a| a.filename.to_lowercase());
    entries
}

/// `list_mods` (§3.5). Works in both modes (simple manages files even though
/// a vanilla jar loads none — the frontend shows an informational note).
pub async fn list(core: &crate::Core) -> Result<ModsList> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let mut lists: Vec<Vec<ModEntry>> = Vec::with_capacity(2);
            for script in [LIST_MODS_SCRIPT, LIST_PLUGINS_SCRIPT] {
                let out = runtime.exec(name, &["sh", "-c", script]).await?;
                // Missing dir → glob doesn't match → empty output; non-zero
                // exit means the container is unavailable.
                lists.push(if out.success() {
                    parse_stat_lines(&out.stdout)
                } else {
                    Vec::new()
                });
            }
            let plugins = lists.pop().unwrap_or_default();
            let mods = lists.pop().unwrap_or_default();
            Ok(ModsList { mods, plugins })
        }
        Mode::Simple => {
            let dir = settings.simple.instance_dir.clone();
            Ok(ModsList {
                mods: list_host_dir(&dir.join("mods")).await,
                plugins: list_host_dir(&dir.join("plugins")).await,
            })
        }
    }
}

/// Place a host file into the target root (advanced: `cp`; simple: fs copy).
async fn place_file(
    core: &crate::Core,
    host_src: &std::path::Path,
    target: ModTarget,
    filename: &str,
) -> Result<()> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            // Ensure the target dir exists (argv array).
            let root = container_root(target);
            let _ = runtime.exec(name, &["mkdir", "-p", root]).await;
            runtime
                .cp_to(name, host_src, &format!("{root}/{filename}"))
                .await
        }
        Mode::Simple => {
            let dir = settings.simple.instance_dir.join(target.dir_name());
            tokio::fs::create_dir_all(&dir).await.map_err(|e| {
                Error::Io(format!("failed to create {} dir: {e}", target.dir_name()))
            })?;
            tokio::fs::copy(host_src, dir.join(filename))
                .await
                .map_err(|e| Error::Io(format!("failed to copy file: {e}")))?;
            Ok(())
        }
    }
}

/// `upload_mod` (§3.5): `source_path` is a host path from the Tauri dialog.
pub async fn upload(
    core: &crate::Core,
    source_path: &str,
    target: ModTarget,
) -> Result<UploadedMod> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(Error::InvalidInput(format!(
            "source file does not exist: {source_path}"
        )));
    }
    let basename = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let filename = crate::validate::mod_filename(&basename, true)?;
    place_file(core, &source, target, &filename).await?;
    Ok(UploadedMod { filename })
}

/// `download_mod` (§3.5, §6.3): host-side reqwest download with progress
/// events, then placed like an upload.
pub async fn download(
    core: &crate::Core,
    url: &str,
    filename: Option<&str>,
    target: ModTarget,
) -> Result<DownloadedMod> {
    let parsed_url = crate::validate::download_url(url)?;
    let filename = crate::validate::download_filename(&parsed_url, filename)?;
    let download_id = uuid::Uuid::new_v4().to_string();

    let request = crate::download::DownloadRequest {
        url: parsed_url,
        kind: DownloadKind::Mod,
        filename: filename.clone(),
        download_id: download_id.clone(),
        max_bytes: Some(MOD_MAX_BYTES),
        expected_sha1: None,
    };
    let result = crate::download::to_temp_file(core, &request).await?;
    let placed = place_file(core, &result.temp_path, target, &filename).await;
    let _ = tokio::fs::remove_file(&result.temp_path).await;
    placed?;
    Ok(DownloadedMod {
        filename,
        download_id,
    })
}

/// `delete_mod` (§3.5): filename must already be a bare clean name (§6.2).
pub async fn delete(core: &crate::Core, filename: &str, target: ModTarget) -> Result<()> {
    let filename = crate::validate::mod_filename(filename, false)?;
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let path = format!("{}/{}", container_root(target), filename);
            let out = runtime.exec(name, &["rm", "-f", "--", &path]).await?;
            if !out.success() {
                return Err(Error::Io(format!(
                    "failed to delete {filename}: {}",
                    out.stderr
                )));
            }
            Ok(())
        }
        Mode::Simple => {
            let path = settings
                .simple
                .instance_dir
                .join(target.dir_name())
                .join(&filename);
            match tokio::fs::remove_file(&path).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    Err(Error::InvalidInput(format!("{filename} does not exist")))
                }
                Err(e) => Err(Error::Io(format!("failed to delete {filename}: {e}"))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stat_lines_into_entries() {
        let stdout = "/data/mods/fabric-api-0.92.jar|1048576|1753200000\n/data/mods/sodium_fabric.jar|2048|1753100000";
        let entries = parse_stat_lines(stdout);
        assert_eq!(entries.len(), 2);
        let fabric = &entries[0];
        assert_eq!(fabric.filename, "fabric-api-0.92.jar");
        assert_eq!(fabric.size_bytes, 1048576);
        assert_eq!(fabric.updated_at_epoch_ms, 1753200000000);
        assert_eq!(fabric.loader, crate::model::ModLoader::Fabric);
        assert_eq!(entries[1].name, "sodium fabric");
    }

    #[test]
    fn parse_stat_lines_skips_garbage() {
        let entries = parse_stat_lines("garbage\n|1|\n/data/mods/x.jar|not-a-number|5");
        assert!(entries.is_empty());
    }

    #[test]
    fn filenames_with_pipes_survive_rsplitn() {
        // rsplitn(3) keeps pipes inside the filename intact.
        let entries = parse_stat_lines("/data/mods/weird|name.jar|10|20");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].filename, "weird|name.jar");
        assert_eq!(entries[0].size_bytes, 10);
    }
}
