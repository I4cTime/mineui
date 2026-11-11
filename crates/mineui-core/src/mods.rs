//! Mods & plugins management (contract §3.5, §6.2–6.3).
//!
//! Advanced-mode listing uses compile-time-constant `sh -c` scripts with
//! zero interpolation (explicitly permitted by §6.1 rule 6); every other exec
//! is a plain argv array. Downloads happen host-side in Rust (reqwest) and
//! are streamed into the container via `cp` - never `curl` in the container.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::model::{
    DownloadKind, DownloadedMod, ModEntry, ModTarget, ModsList, RenamedMod, UploadedMod,
};
use crate::settings::Mode;

/// §3.5: 256 MB download cap.
pub(crate) const MOD_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// §3.5: upload source cap - 512 MiB comfortably covers real modpack jars
/// while stopping accidental (or malicious) multi-GB copies into the
/// container/instance dir. Checked via metadata length (fast, works for
/// sparse files too).
const UPLOAD_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Constant listing script - zero interpolation (§6.1 rule 6). Both roots in
/// one run (2.9.0): on a stopped container each run is a helper container,
/// so one is cheaper than two. Lines are told apart by their path prefix.
const LIST_SCRIPT: &str = r#"for f in /data/mods/* /data/plugins/*; do [ -f "$f" ] || continue; stat -c '%n|%s|%Y' "$f"; done"#;

pub(crate) fn container_root(target: ModTarget) -> &'static str {
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
        // v1 sent unix seconds - normalized to epoch ms (§3.5).
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

/// Split the combined listing into (mods, plugins) by path prefix.
fn parse_combined_listing(stdout: &str) -> ModsList {
    let mut mods = String::new();
    let mut plugins = String::new();
    for line in stdout.lines() {
        if line.starts_with("/data/mods/") {
            mods.push_str(line);
            mods.push('\n');
        } else if line.starts_with("/data/plugins/") {
            plugins.push_str(line);
            plugins.push('\n');
        }
    }
    ModsList {
        mods: parse_stat_lines(&mods),
        plugins: parse_stat_lines(&plugins),
    }
}

/// A listing run's outcome → lists; a failed run is an error, never empty
/// lists (§3.5, 2.9.0 - empty means the folders hold no files).
fn listing_result(out: crate::runtime::ExecOutput) -> Result<ModsList> {
    if out.success() {
        Ok(parse_combined_listing(&out.stdout))
    } else {
        Err(Error::Io(format!(
            "could not list /data/mods and /data/plugins: {}",
            if out.stderr.is_empty() {
                format!("exit code {:?}", out.exit_code)
            } else {
                out.stderr
            }
        )))
    }
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
/// a vanilla jar loads none - the frontend shows an informational note).
pub async fn list(core: &crate::Core) -> Result<ModsList> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            // Missing dir → glob doesn't match → empty output. `exec` while
            // running, the volumes-from helper while stopped (2.9.0).
            let out = crate::runtime::run_in_container(
                runtime.as_ref(),
                &settings.advanced.container_name,
                &["sh", "-c", LIST_SCRIPT],
            )
            .await?;
            listing_result(out)
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
/// target is itself a regular `.jar`/`.zip` file - the copy reads the
/// target's bytes anyway, so this is exactly the content that gets placed.
pub(crate) async fn validate_upload_source(source: &Path) -> Result<PathBuf> {
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
async fn upload_inner(
    core: &crate::Core,
    source_path: &str,
    target: ModTarget,
) -> Result<UploadedMod> {
    let source = PathBuf::from(source_path);
    let canonical = validate_upload_source(&source).await?;
    // The stored filename comes from the path the user picked (then §6.2
    // sanitization), not the canonical target - renaming via symlink is fine.
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
async fn download_inner(
    core: &crate::Core,
    url: &str,
    filename: Option<&str>,
    target: ModTarget,
) -> Result<DownloadedMod> {
    let allow_private = core.settings().await.allow_private_download_hosts;
    let parsed_url = crate::validate::download_url(url)?;
    // §6.3 rule 5: SSRF hardening - user-supplied URLs must point at a
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
        expected_sha256: None,
        expected_sha512: None,
        client: None,
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

/// §6.2 rules 1, 3 and 3a for `delete_mod`: a bare clean `.jar`/`.zip`
/// name, or (2.13.0) a disabled mod `<name>.jar.disabled`.
pub(crate) fn delete_filename(filename: &str) -> Result<String> {
    if !filename.to_ascii_lowercase().ends_with(".jar.disabled") {
        return crate::validate::mod_filename(filename, false);
    }
    if filename.len() > 255 {
        return Err(Error::InvalidInput("filename exceeds 255 bytes".into()));
    }
    // The suffix is ASCII, so this cut is on a char boundary; the base
    // check covers the bare name, the charset and the leading character,
    // and the base ends in `.jar` by construction.
    let base = &filename[..filename.len() - DISABLED_SUFFIX.len()];
    crate::validate::mod_filename(base, false)?;
    Ok(filename.to_string())
}

/// Container side of `delete_mod`: `rm -f --` through `run_in_container`.
async fn delete_in_container(
    runtime: &dyn crate::runtime::Runtime,
    name: &str,
    target: ModTarget,
    filename: &str,
) -> Result<()> {
    let path = format!("{}/{}", container_root(target), filename);
    let out = crate::runtime::run_in_container(runtime, name, &["rm", "-f", "--", &path]).await?;
    if !out.success() {
        return Err(Error::Io(format!(
            "failed to delete {filename}: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// `delete_mod` (§3.5): filename must already be a bare clean name (§6.2).
async fn delete_inner(core: &crate::Core, filename: &str, target: ModTarget) -> Result<()> {
    let filename = delete_filename(filename)?;
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            delete_in_container(
                runtime.as_ref(),
                &settings.advanced.container_name,
                target,
                &filename,
            )
            .await
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

/// `set_mod_enabled` (§3.5, 2.13.0): constant script, zero interpolation -
/// the two paths arrive as positional arguments, never inside the text.
/// Exit 3 = no such file, 4 = the new name is taken.
const RENAME_SCRIPT: &str =
    r#"[ -f "$1" ] || exit 3; if [ -e "$2" ] || [ -L "$2" ]; then exit 4; fi; mv -- "$1" "$2""#;

const DISABLED_SUFFIX: &str = ".disabled";

/// `(from, to)` for `set_mod_enabled`: `<name>.jar` ⇄ `<name>.jar.disabled`,
/// both bare names under §6.2 rules 1 and 3.
pub(crate) fn enable_rename(filename: &str, enabled: bool) -> Result<(String, String)> {
    let lower = filename.to_ascii_lowercase();
    if enabled {
        if !lower.ends_with(".jar.disabled") {
            return Err(Error::InvalidInput(format!(
                "{filename} is not turned off (its name does not end in .jar.disabled)"
            )));
        }
        // The suffix is ASCII, so this cut is on a char boundary.
        let base = &filename[..filename.len() - DISABLED_SUFFIX.len()];
        let base = crate::validate::mod_filename(base, false)?;
        // `filename` is `base` plus an ASCII-letter suffix, so it is as safe.
        Ok((filename.to_string(), base))
    } else {
        if !lower.ends_with(".jar") {
            return Err(Error::InvalidInput(format!(
                "only a .jar file can be turned off, not {filename}"
            )));
        }
        let base = crate::validate::mod_filename(filename, false)?;
        Ok((base.clone(), format!("{base}{DISABLED_SUFFIX}")))
    }
}

/// The rename script's outcome as the contract's errors.
fn rename_outcome(out: &crate::runtime::ExecOutput, from: &str, to: &str) -> Result<()> {
    if out.success() {
        return Ok(());
    }
    match out.exit_code {
        Some(3) => Err(Error::InvalidInput(format!("{from} does not exist"))),
        Some(4) => Err(Error::InvalidInput(format!(
            "there is already a file named {to}"
        ))),
        code => Err(Error::Io(format!(
            "failed to rename {from}: {}",
            if out.stderr.trim().is_empty() {
                format!("exit code {code:?}")
            } else {
                out.stderr.trim().to_string()
            }
        ))),
    }
}

/// Host-side rename with the same checks as the script.
async fn rename_on_host(dir: &Path, from: &str, to: &str) -> Result<()> {
    let src = dir.join(from);
    let dst = dir.join(to);
    match tokio::fs::metadata(&src).await {
        Ok(meta) if meta.is_file() => {}
        _ => return Err(Error::InvalidInput(format!("{from} does not exist"))),
    }
    if tokio::fs::symlink_metadata(&dst).await.is_ok() {
        return Err(Error::InvalidInput(format!(
            "there is already a file named {to}"
        )));
    }
    tokio::fs::rename(&src, &dst)
        .await
        .map_err(|e| Error::Io(format!("failed to rename {from}: {e}")))
}

async fn set_enabled_inner(
    core: &crate::Core,
    filename: &str,
    target: ModTarget,
    enabled: bool,
) -> Result<RenamedMod> {
    let (from, to) = enable_rename(filename, enabled)?;
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let root = container_root(target);
            let (src, dst) = (format!("{root}/{from}"), format!("{root}/{to}"));
            let out = crate::runtime::run_in_container(
                runtime.as_ref(),
                &settings.advanced.container_name,
                &["sh", "-c", RENAME_SCRIPT, "sh", &src, &dst],
            )
            .await?;
            rename_outcome(&out, &from, &to)?;
        }
        Mode::Simple => {
            let dir = settings.simple.instance_dir.join(target.dir_name());
            rename_on_host(&dir, &from, &to).await?;
        }
    }
    Ok(RenamedMod { filename: to })
}

/* ---------- audited entry points (§3.11) ---------- */

pub(crate) fn target_label(target: ModTarget) -> &'static str {
    match target {
        ModTarget::Mods => "mods",
        ModTarget::Plugins => "plugins",
    }
}

/// `upload_mod` (§3.5), audited as `mod.upload`.
pub async fn upload(
    core: &crate::Core,
    source_path: &str,
    target: ModTarget,
) -> Result<UploadedMod> {
    let r = upload_inner(core, source_path, target).await;
    let name = r
        .as_ref()
        .map(|u| u.filename.clone())
        .unwrap_or_else(|_| source_path.to_string());
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        "mod.upload",
        Some(&name),
        Some(target_label(target)),
        r.as_ref().err(),
    )
    .await;
    r
}

/// `download_mod` (§3.5), audited as `mod.download` (target = URL).
pub async fn download(
    core: &crate::Core,
    url: &str,
    filename: Option<&str>,
    target: ModTarget,
) -> Result<DownloadedMod> {
    let r = download_inner(core, url, filename, target).await;
    let detail = match &r {
        Ok(d) => format!("{} → {}", target_label(target), d.filename),
        Err(_) => target_label(target).to_string(),
    };
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        "mod.download",
        Some(url),
        Some(&detail),
        r.as_ref().err(),
    )
    .await;
    r
}

/// `delete_mod` (§3.5), audited as `mod.delete`.
pub async fn delete(core: &crate::Core, filename: &str, target: ModTarget) -> Result<()> {
    let r = delete_inner(core, filename, target).await;
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        "mod.delete",
        Some(filename),
        Some(target_label(target)),
        r.as_ref().err(),
    )
    .await;
    r
}

/// `set_mod_enabled` (§3.5, 2.13.0), audited as `mod.enable` / `mod.disable`.
pub async fn set_enabled(
    core: &crate::Core,
    filename: &str,
    target: ModTarget,
    enabled: bool,
) -> Result<RenamedMod> {
    let r = set_enabled_inner(core, filename, target, enabled).await;
    let detail = match &r {
        Ok(renamed) => format!("{} → {}", target_label(target), renamed.filename),
        Err(_) => target_label(target).to_string(),
    };
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        if enabled { "mod.enable" } else { "mod.disable" },
        Some(filename),
        Some(&detail),
        r.as_ref().err(),
    )
    .await;
    r
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
    fn combined_listing_splits_by_root() {
        let stdout = "/data/mods/sodium-fabric.jar|10|1790000000\n\
/data/plugins/EssentialsX.jar|20|1790000001\n\
/data/mods/fabric-api.jar|30|1790000002\n\
/data/other/stray.jar|1|1\n";
        let list = parse_combined_listing(stdout);
        let mods: Vec<&str> = list.mods.iter().map(|m| m.filename.as_str()).collect();
        assert_eq!(mods, ["fabric-api.jar", "sodium-fabric.jar"]);
        assert_eq!(list.plugins.len(), 1);
        assert_eq!(list.plugins[0].filename, "EssentialsX.jar");
        assert_eq!(list.plugins[0].size_bytes, 20);
    }

    #[test]
    fn a_failed_listing_is_an_error_not_empty_lists() {
        let out = |code: i32, stderr: &str| crate::runtime::ExecOutput {
            stdout: String::new(),
            stderr: stderr.into(),
            exit_code: Some(code),
        };
        let empty = listing_result(out(0, "")).unwrap();
        assert!(empty.mods.is_empty() && empty.plugins.is_empty());
        let err = listing_result(out(125, "Error: container state improper")).unwrap_err();
        assert_eq!(err.code(), "IO");
        assert!(err.to_string().contains("state improper"));
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
        // writing 512 MiB - the check reads metadata.len(), so this is fast.
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

    /* ---------- delete_mod of a disabled mod (§6.2 rule 3a, 2.13.0) ---------- */

    #[test]
    fn delete_accepts_a_disabled_jar_and_nothing_else_new() {
        for ok in [
            "lithium.jar",
            "pack.zip",
            "lithium-0.14.jar.disabled",
            "Chunky-1.4.23.JAR.Disabled",
        ] {
            assert_eq!(delete_filename(ok).unwrap(), ok);
        }
        for bad in [
            "x.disabled",
            "x.jar.disabled.disabled",
            "x.txt.disabled",
            "x.zip.disabled",
            ".jar.disabled",
            "-x.jar.disabled",
            "../x.jar.disabled",
            "mods/x.jar.disabled",
            "..\\x.jar.disabled",
            "/data/mods/x.jar.disabled",
            "bad name.jar.disabled",
            "x.jar.disabled ",
            "x.txt",
        ] {
            assert_eq!(
                delete_filename(bad).unwrap_err().code(),
                "INVALID_INPUT",
                "{bad:?}"
            );
        }
        let long = format!("{}.jar.disabled", "a".repeat(250));
        assert_eq!(delete_filename(&long).unwrap_err().code(), "INVALID_INPUT");
    }

    #[tokio::test]
    async fn delete_a_disabled_mod_on_this_computer() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let mods = core.settings().await.simple.instance_dir.join("mods");
        std::fs::create_dir_all(&mods).unwrap();
        std::fs::write(mods.join("sodium.jar.disabled"), b"jar").unwrap();
        std::fs::write(mods.join("keep.jar"), b"jar").unwrap();
        delete(&core, "sodium.jar.disabled", ModTarget::Mods)
            .await
            .unwrap();
        assert!(!mods.join("sodium.jar.disabled").exists());
        assert!(mods.join("keep.jar").exists());
        assert_eq!(
            delete(&core, "x.txt.disabled", ModTarget::Mods)
                .await
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );
    }

    #[tokio::test]
    async fn delete_a_disabled_mod_in_a_container() {
        use crate::fake_runtime::FakeRuntime;
        let name = delete_filename("sodium.jar.disabled").unwrap();
        // Stopped: the volumes-from helper.
        let rt = FakeRuntime::default();
        delete_in_container(&rt, "mc", ModTarget::Mods, &name)
            .await
            .unwrap();
        assert_eq!(
            rt.calls(),
            ["ps mc", "helper mc rm -f -- /data/mods/sodium.jar.disabled"]
        );
        // Running: exec.
        let rt = FakeRuntime {
            ps: Ok(Some("running".into())),
            ..Default::default()
        };
        delete_in_container(&rt, "mc", ModTarget::Plugins, &name)
            .await
            .unwrap();
        assert_eq!(
            rt.calls(),
            [
                "ps mc",
                "exec mc rm -f -- /data/plugins/sodium.jar.disabled"
            ]
        );
    }

    /* ---------- set_mod_enabled (§3.5, 2.13.0) ---------- */

    #[test]
    fn enable_rename_names() {
        assert_eq!(
            enable_rename("sodium-0.6.jar", false).unwrap(),
            ("sodium-0.6.jar".into(), "sodium-0.6.jar.disabled".into())
        );
        assert_eq!(
            enable_rename("Chunky-1.4.23.JAR.Disabled", true).unwrap(),
            (
                "Chunky-1.4.23.JAR.Disabled".into(),
                "Chunky-1.4.23.JAR".into()
            )
        );
        for (name, enabled) in [
            ("mod.jar.disabled", false), // already off
            ("mod.jar", true),           // already on
            ("pack.zip", false),         // zips cannot be switched
            ("../evil.jar", false),
            ("dir/mod.jar.disabled", true),
            (".jar.disabled", true),
            ("-x.jar", false),
            ("bad name.jar", false),
        ] {
            assert_eq!(
                enable_rename(name, enabled).unwrap_err().code(),
                "INVALID_INPUT",
                "{name} enabled={enabled}"
            );
        }
    }

    #[test]
    fn rename_script_exit_codes_map_to_errors() {
        let out = |code: i32, stderr: &str| crate::runtime::ExecOutput {
            stdout: String::new(),
            stderr: stderr.into(),
            exit_code: Some(code),
        };
        assert!(rename_outcome(&out(0, ""), "a.jar", "a.jar.disabled").is_ok());
        let missing = rename_outcome(&out(3, ""), "a.jar", "a.jar.disabled").unwrap_err();
        assert_eq!(missing.code(), "INVALID_INPUT");
        assert!(missing.to_string().contains("a.jar does not exist"));
        let taken = rename_outcome(&out(4, ""), "a.jar", "a.jar.disabled").unwrap_err();
        assert_eq!(taken.code(), "INVALID_INPUT");
        assert!(taken
            .to_string()
            .contains("already a file named a.jar.disabled"));
        let other = rename_outcome(&out(1, "mv: Permission denied"), "a.jar", "b").unwrap_err();
        assert_eq!(other.code(), "IO");
        assert!(other.to_string().contains("Permission denied"));
    }

    /// The container script itself, run by this machine's `sh`: it renames,
    /// refuses a taken name and a missing source, and treats `$1`/`$2` as
    /// data (a name with shell syntax stays a name).
    #[cfg(unix)]
    #[test]
    fn rename_script_behaves_under_sh() {
        let tmp = tempfile::tempdir().unwrap();
        let run = |from: &str, to: &str| {
            std::process::Command::new("sh")
                .args(["-c", RENAME_SCRIPT, "sh"])
                .arg(tmp.path().join(from))
                .arg(tmp.path().join(to))
                .status()
                .unwrap()
                .code()
        };
        std::fs::write(tmp.path().join("a.jar"), b"a").unwrap();
        assert_eq!(run("a.jar", "a.jar.disabled"), Some(0));
        assert!(tmp.path().join("a.jar.disabled").exists());
        assert!(!tmp.path().join("a.jar").exists());
        assert_eq!(run("a.jar", "a.jar.disabled"), Some(3), "source gone");
        std::fs::write(tmp.path().join("a.jar"), b"new").unwrap();
        assert_eq!(run("a.jar", "a.jar.disabled"), Some(4), "target taken");
        assert_eq!(
            std::fs::read(tmp.path().join("a.jar.disabled")).unwrap(),
            b"a"
        );
        std::fs::write(tmp.path().join("$(touch pwned).jar"), b"x").unwrap();
        assert_eq!(run("$(touch pwned).jar", "x.jar"), Some(0));
        assert!(!tmp.path().join("pwned").exists());
        assert!(!std::path::Path::new("pwned").exists());
    }

    #[tokio::test]
    async fn set_enabled_on_this_computer_renames_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let mods = core.settings().await.simple.instance_dir.join("mods");
        std::fs::create_dir_all(&mods).unwrap();
        std::fs::write(mods.join("lithium.jar"), b"jar").unwrap();

        let off = set_enabled(&core, "lithium.jar", ModTarget::Mods, false)
            .await
            .unwrap();
        assert_eq!(off.filename, "lithium.jar.disabled");
        assert!(mods.join("lithium.jar.disabled").is_file());
        assert!(!mods.join("lithium.jar").exists());

        // A new lithium.jar appears; turning the old one back on must not
        // replace it.
        std::fs::write(mods.join("lithium.jar"), b"newer").unwrap();
        let err = set_enabled(&core, "lithium.jar.disabled", ModTarget::Mods, true)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert_eq!(std::fs::read(mods.join("lithium.jar")).unwrap(), b"newer");
        assert!(mods.join("lithium.jar.disabled").is_file());

        std::fs::remove_file(mods.join("lithium.jar")).unwrap();
        let on = set_enabled(&core, "lithium.jar.disabled", ModTarget::Mods, true)
            .await
            .unwrap();
        assert_eq!(on.filename, "lithium.jar");
        assert_eq!(std::fs::read(mods.join("lithium.jar")).unwrap(), b"jar");

        let missing = set_enabled(&core, "nope.jar", ModTarget::Mods, false)
            .await
            .unwrap_err();
        assert!(missing.to_string().contains("does not exist"));

        let log = crate::audit::recent(&core, Some(10)).await.unwrap();
        let actions: Vec<_> = log.entries.iter().map(|e| e.action.as_str()).collect();
        assert!(actions.contains(&"mod.disable") && actions.contains(&"mod.enable"));
    }
}
