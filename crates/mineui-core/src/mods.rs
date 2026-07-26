//! Mods & plugins management (contract §3.5, §6.2–6.3).
//!
//! Advanced-mode listing uses compile-time-constant `sh -c` scripts with
//! zero interpolation (explicitly permitted by §6.1 rule 6); every other exec
//! is a plain argv array. Downloads happen host-side in Rust (reqwest) and
//! are streamed into the container via `cp` — never `curl` in the container.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::model::{DownloadKind, DownloadedMod, ModEntry, ModTarget, ModsList, UploadedMod};
use crate::settings::Mode;

/// §3.5: 256 MB download cap.
const MOD_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// §3.5: upload source cap — 512 MiB comfortably covers real modpack jars
/// while stopping accidental (or malicious) multi-GB copies into the
/// container/instance dir. Checked via metadata length (fast, works for
/// sparse files too).
const UPLOAD_MAX_BYTES: u64 = 512 * 1024 * 1024;

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

/// §3.5 upload-source hardening: `source_path` comes from the webview, so a
/// compromised webview could point it at any readable host file (e.g.
/// `~/.ssh/id_rsa` named via a symlink called `mod.jar`) and exfiltrate it
/// into the mods dir/container. Canonicalize (resolving symlinks) and
/// require the *resolved* path to be a regular `.jar`/`.zip` file under the
/// size cap. Consequence for symlinks: a symlink is accepted only when its
/// target is itself a regular `.jar`/`.zip` file — the copy reads the
/// target's bytes anyway, so this is exactly the content that gets placed.
async fn validate_upload_source(source: &Path) -> Result<PathBuf> {
    let canonical = tokio::fs::canonicalize(source).await.map_err(|_| {
        Error::InvalidInput(format!(
            "source file does not exist or cannot be resolved: {}",
            source.display()
        ))
    })?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| Error::InvalidInput(format!("cannot read source file metadata: {e}")))?;
    if !metadata.is_file() {
        return Err(Error::InvalidInput(
            "source path is not a regular file".into(),
        ));
    }
    let ext_ok = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let ext = e.to_lowercase();
            ext == "jar" || ext == "zip"
        })
        .unwrap_or(false);
    if !ext_ok {
        return Err(Error::InvalidInput(
            "source file must be a .jar or .zip".into(),
        ));
    }
    if metadata.len() > UPLOAD_MAX_BYTES {
        return Err(Error::FileTooLarge(format!(
            "source file is {} bytes; the upload limit is {UPLOAD_MAX_BYTES}",
            metadata.len()
        )));
    }
    Ok(canonical)
}

/// `upload_mod` (§3.5): `source_path` is a host path from the Tauri dialog.
pub async fn upload(
    core: &crate::Core,
    source_path: &str,
    target: ModTarget,
) -> Result<UploadedMod> {
    let source = PathBuf::from(source_path);
    let canonical = validate_upload_source(&source).await?;
    // The stored filename comes from the path the user picked (then §6.2
    // sanitization), not the canonical target — renaming via symlink is fine.
    let basename = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let filename = crate::validate::mod_filename(&basename, true)?;
    place_file(core, &canonical, target, &filename).await?;
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
    let allow_private = core.settings().await.allow_private_download_hosts;
    let parsed_url = crate::validate::download_url(url)?;
    // §6.3 rule 5: SSRF hardening — user-supplied URLs must point at a
    // public host unless the user opted in (homelab escape hatch).
    crate::validate::ensure_public_download_host(&parsed_url, allow_private)?;
    let filename = crate::validate::download_filename(&parsed_url, filename)?;
    let download_id = uuid::Uuid::new_v4().to_string();

    let request = crate::download::DownloadRequest {
        url: parsed_url,
        kind: DownloadKind::Mod,
        filename: filename.clone(),
        download_id: download_id.clone(),
        max_bytes: Some(MOD_MAX_BYTES),
        expected_sha1: None,
        allow_private_hosts: allow_private,
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

    /* ---------- upload source validation (§3.5 hardening) ---------- */

    #[tokio::test]
    async fn upload_source_accepts_regular_jar() {
        let tmp = tempfile::tempdir().unwrap();
        let jar = tmp.path().join("fabric-api.jar");
        std::fs::write(&jar, b"PK\x03\x04not really a jar").unwrap();
        let canonical = validate_upload_source(&jar).await.unwrap();
        assert!(canonical.ends_with("fabric-api.jar"));
    }

    #[tokio::test]
    async fn upload_source_rejects_wrong_extension() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["id_rsa", "notes.txt", "mod.jar.exe", "archive.tar.gz"] {
            let file = tmp.path().join(name);
            std::fs::write(&file, b"data").unwrap();
            let err = validate_upload_source(&file).await.unwrap_err();
            assert_eq!(err.code(), "INVALID_INPUT", "should reject {name}");
        }
        // Case-insensitive acceptance still holds.
        let upper = tmp.path().join("MOD.JAR");
        std::fs::write(&upper, b"data").unwrap();
        assert!(validate_upload_source(&upper).await.is_ok());
    }

    #[tokio::test]
    async fn upload_source_rejects_missing_and_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope.jar");
        assert_eq!(
            validate_upload_source(&missing).await.unwrap_err().code(),
            "INVALID_INPUT"
        );
        // A directory named like a jar is not a regular file.
        let dir = tmp.path().join("fake.jar");
        std::fs::create_dir(&dir).unwrap();
        assert_eq!(
            validate_upload_source(&dir).await.unwrap_err().code(),
            "INVALID_INPUT"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn upload_source_symlink_behavior() {
        // Documented behavior: symlinks are resolved; the *target* must be a
        // regular .jar/.zip. A jar-named symlink to a sensitive non-jar file
        // is rejected; a jar-named symlink to a real jar elsewhere is fine.
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret_key");
        std::fs::write(&secret, b"PRIVATE KEY").unwrap();
        let evil_link = tmp.path().join("innocent.jar");
        std::os::unix::fs::symlink(&secret, &evil_link).unwrap();
        assert_eq!(
            validate_upload_source(&evil_link).await.unwrap_err().code(),
            "INVALID_INPUT"
        );

        let elsewhere = tempfile::tempdir().unwrap();
        let real_jar = elsewhere.path().join("real-mod.jar");
        std::fs::write(&real_jar, b"jar bytes").unwrap();
        let ok_link = tmp.path().join("renamed-mod.jar");
        std::os::unix::fs::symlink(&real_jar, &ok_link).unwrap();
        let canonical = validate_upload_source(&ok_link).await.unwrap();
        assert!(canonical.ends_with("real-mod.jar"));
    }

    #[tokio::test]
    async fn upload_source_rejects_oversize() {
        let tmp = tempfile::tempdir().unwrap();
        let big = tmp.path().join("huge-pack.jar");
        // Sparse file: set_len makes metadata report the size without
        // writing 512 MiB — the check reads metadata.len(), so this is fast.
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(UPLOAD_MAX_BYTES + 1).unwrap();
        drop(file);
        let err = validate_upload_source(&big).await.unwrap_err();
        assert_eq!(err.code(), "FILE_TOO_LARGE");

        // Exactly at the cap is allowed.
        let ok = tmp.path().join("at-cap.zip");
        let file = std::fs::File::create(&ok).unwrap();
        file.set_len(UPLOAD_MAX_BYTES).unwrap();
        drop(file);
        assert!(validate_upload_source(&ok).await.is_ok());
    }
}
