//! MineUI-managed Java: `install_java` (contract §3.1, §6.3a, 2.13.0).
//!
//! Downloads the Eclipse Temurin JRE of one major from Adoptium into
//! `<appDataDir>/java/temurin-<major>-jre/`, shared by every server profile.
//! Fixed hosts only, sha256-verified, extracted into a temp dir beside the
//! target with traversal-safe rules, probed, then renamed into place.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{AuditSource, DownloadKind, JavaCheck};

/// §6.3a rule 1.
pub const MIN_MAJOR: i64 = 8;
pub const MAX_MAJOR: i64 = 30;
/// §6.3a rule 5: archive cap.
pub const MAX_ARCHIVE_BYTES: u64 = 300 * 1024 * 1024;
/// §6.3a rule 6: extraction limits.
const MAX_ENTRIES: usize = 20_000;
const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;
/// §6.3a rule 7: how deep below the extraction dir the binary may sit.
const MAX_LOCATE_DEPTH: usize = 3;
/// §6.3a rule 4: the only hosts a Java download may touch, redirects
/// included. Observed chain (2026-11-09): api.adoptium.net answers itself;
/// the archive link is on github.com, which 302s once to
/// release-assets.githubusercontent.com.
pub const ALLOWED_HOSTS: &[&str] = &[
    "api.adoptium.net",
    "github.com",
    "release-assets.githubusercontent.com",
];
const MAX_REDIRECTS: usize = 5;
const API_BASE: &str = "https://api.adoptium.net/v3/assets/latest";

/// `<appDataDir>/java`: the managed Java folder, app-wide.
pub fn managed_root(core: &crate::Core) -> PathBuf {
    core.app_data_dir().join("java")
}

/// The folder one major is installed in.
pub fn install_dir_name(major: u32) -> String {
    format!("temurin-{major}-jre")
}

/// §6.3a rule 2: Adoptium's `os` / `architecture` names for a Rust
/// `std::env::consts::{OS, ARCH}` pair.
pub fn adoptium_platform(os: &str, arch: &str) -> Option<(&'static str, &'static str)> {
    let os = match os {
        "linux" => "linux",
        "macos" => "mac",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    Some((os, arch))
}

/// This build's platform, or None where Temurin has no build we fetch.
pub fn this_platform() -> Option<(&'static str, &'static str)> {
    adoptium_platform(std::env::consts::OS, std::env::consts::ARCH)
}

/// §6.3a rule 3: the Adoptium API v3 query for one major.
pub fn api_url(major: u32, os: &str, arch: &str) -> String {
    format!("{API_BASE}/{major}/hotspot?architecture={arch}&image_type=jre&os={os}&vendor=eclipse")
}

/// §6.3a rule 4: https, no credentials, default port, allowlisted host.
pub fn url_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|h| ALLOWED_HOSTS.iter().any(|a| a.eq_ignore_ascii_case(h)))
}

/// The client every Java request goes through: each redirect hop must stay
/// https on an allowlisted host.
fn build_client() -> reqwest::Client {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        if !url_allowed(attempt.url()) {
            let host = attempt.url().host_str().unwrap_or("?").to_string();
            return attempt.error(format!("redirect to a host MineUI does not trust ({host})"));
        }
        attempt.follow()
    });
    reqwest::Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("MineUI/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client construction cannot fail with static config")
}

/* ---------- Adoptium response ---------- */

#[derive(Debug, Deserialize)]
struct Asset {
    binary: Binary,
    version: AssetVersion,
}

#[derive(Debug, Deserialize)]
struct Binary {
    os: String,
    architecture: String,
    image_type: String,
    package: Package,
}

#[derive(Debug, Deserialize)]
struct Package {
    link: String,
    checksum: String,
    size: u64,
    name: String,
}

#[derive(Debug, Deserialize)]
struct AssetVersion {
    major: u32,
    #[serde(default)]
    openjdk_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    TarGz,
    Zip,
}

/// What `select_asset` takes from the API response.
#[derive(Debug, Clone)]
pub struct SelectedAsset {
    pub link: reqwest::Url,
    pub sha256: String,
    pub size: u64,
    pub name: String,
    /// e.g. `21.0.13+9` (from `openjdk_version`, `-LTS` dropped).
    pub version: String,
    pub kind: ArchiveKind,
}

/// §6.3a rules 3-5: pick the asset from an API response body and check
/// everything the download relies on.
pub fn select_asset(body: &str, major: u32, os: &str, arch: &str) -> Result<SelectedAsset> {
    let assets: Vec<Asset> = serde_json::from_str(body).map_err(|e| {
        Error::DownloadFailed(format!("Adoptium sent an answer MineUI cannot read: {e}"))
    })?;
    let asset = assets
        .into_iter()
        .find(|a| {
            a.binary.image_type == "jre"
                && a.binary.os == os
                && a.binary.architecture == arch
                && a.version.major == major
        })
        .ok_or_else(|| {
            Error::DownloadFailed(format!(
                "Adoptium has no Java {major} runtime for this computer ({os} {arch})"
            ))
        })?;
    let package = asset.binary.package;
    let link = reqwest::Url::parse(&package.link).map_err(|_| {
        Error::DownloadFailed("Adoptium sent a download link MineUI cannot read".into())
    })?;
    if !url_allowed(&link) {
        return Err(Error::DownloadFailed(format!(
            "the Java download link points to a host MineUI does not trust ({})",
            link.host_str().unwrap_or("?")
        )));
    }
    let checksum = package.checksum.to_ascii_lowercase();
    if checksum.len() != 64 || !checksum.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::DownloadFailed(
            "Adoptium sent no usable sha256 checksum for the Java download".into(),
        ));
    }
    if package.size > MAX_ARCHIVE_BYTES {
        return Err(Error::FileTooLarge(format!(
            "the Java download is {} bytes; the limit is {MAX_ARCHIVE_BYTES}",
            package.size
        )));
    }
    let lower = package.name.to_ascii_lowercase();
    let kind = if lower.ends_with(".tar.gz") {
        ArchiveKind::TarGz
    } else if lower.ends_with(".zip") {
        ArchiveKind::Zip
    } else {
        return Err(Error::DownloadFailed(format!(
            "the Java download is not a .tar.gz or .zip ({})",
            package.name
        )));
    };
    let version = asset
        .version
        .openjdk_version
        .trim_end_matches("-LTS")
        .to_string();
    Ok(SelectedAsset {
        link,
        sha256: checksum,
        size: package.size,
        name: package.name,
        version: if version.is_empty() {
            major.to_string()
        } else {
            version
        },
        kind,
    })
}

/* ---------- extraction (blocking; run off the async runtime) ---------- */

fn unsafe_archive(why: impl std::fmt::Display) -> Error {
    Error::DownloadFailed(format!("the Java download was refused: {why}"))
}

/// An entry path made only of normal components (`.` ignored). Absolute
/// paths, drive/root prefixes and `..` are refused.
fn safe_relative(path: &Path) -> Result<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(unsafe_archive(format!(
                    "an entry climbs out of its folder ({})",
                    path.display()
                )))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(unsafe_archive(format!(
                    "an entry has an absolute path ({})",
                    path.display()
                )))
            }
        }
    }
    Ok(out)
}

/// A symlink at `entry` (relative to the extraction dir) pointing at
/// `target` must be relative and resolve inside the extraction dir.
fn check_symlink_target(entry: &Path, target: &Path) -> Result<()> {
    let refuse = || {
        unsafe_archive(format!(
            "a link points outside the Java folder ({} -> {})",
            entry.display(),
            target.display()
        ))
    };
    let mut depth: i64 = entry
        .parent()
        .map(|p| {
            p.components()
                .filter(|c| matches!(c, Component::Normal(_)))
                .count() as i64
        })
        .unwrap_or(0);
    for component in target.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(refuse());
                }
            }
            Component::RootDir | Component::Prefix(_) => return Err(refuse()),
        }
    }
    Ok(())
}

/// Extract a `.tar.gz` stream into `dest` (which must exist).
pub fn extract_tar_gz<R: Read>(reader: R, dest: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(reader));
    // Keep the rwx bits (`bin/java` must stay executable); never setuid etc.
    archive.set_preserve_permissions(false);
    archive.set_overwrite(false);
    let entries = archive
        .entries()
        .map_err(|e| unsafe_archive(format!("unreadable archive: {e}")))?;
    let mut count = 0usize;
    let mut written = 0u64;
    for entry in entries {
        let mut entry = entry.map_err(|e| unsafe_archive(format!("unreadable archive: {e}")))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(unsafe_archive("too many entries"));
        }
        let raw = entry
            .path()
            .map_err(|e| unsafe_archive(format!("unreadable entry name: {e}")))?
            .into_owned();
        let rel = safe_relative(&raw)?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            // Created by unpack_in below.
        } else if kind.is_file() || kind == tar::EntryType::Continuous {
            written = written.saturating_add(entry.size());
            if written > MAX_EXTRACTED_BYTES {
                return Err(unsafe_archive("it unpacks to more than 1 GiB"));
            }
        } else if kind.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|e| unsafe_archive(format!("unreadable link: {e}")))?
                .ok_or_else(|| unsafe_archive("a link without a target"))?
                .into_owned();
            check_symlink_target(&rel, &target)?;
        } else if kind.is_hard_link() {
            let target = entry
                .link_name()
                .map_err(|e| unsafe_archive(format!("unreadable link: {e}")))?
                .ok_or_else(|| unsafe_archive("a link without a target"))?
                .into_owned();
            safe_relative(&target)?;
        } else {
            // Devices, fifos, pax/GNU metadata the iterator did not fold in.
            continue;
        }
        let unpacked = entry
            .unpack_in(dest)
            .map_err(|e| unsafe_archive(format!("could not unpack {}: {e}", rel.display())))?;
        if !unpacked {
            return Err(unsafe_archive(format!(
                "an entry climbs out of its folder ({})",
                raw.display()
            )));
        }
    }
    Ok(())
}

/// The raw zip entry name, `\\` read as `/`: no leading root, no drive
/// letter, no `..` segment (stricter than `enclosed_name`, which strips a
/// leading `/` and allows `a/../b`).
fn check_zip_name(name: &str) -> Result<()> {
    let name = name.replace('\\', "/");
    let bytes = name.as_bytes();
    if name.starts_with('/') || (bytes.len() >= 2 && bytes[1] == b':') {
        return Err(unsafe_archive(format!(
            "an entry has an absolute path ({name})"
        )));
    }
    if name.split('/').any(|segment| segment == "..") {
        return Err(unsafe_archive(format!(
            "an entry climbs out of its folder ({name})"
        )));
    }
    Ok(())
}

/// Extract a `.zip` file into `dest` (which must exist). Links inside the
/// folder are skipped (Windows JRE zips have none); links leaving it refuse
/// the archive.
pub fn extract_zip(file: std::fs::File, dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| unsafe_archive(format!("unreadable archive: {e}")))?;
    if zip.len() > MAX_ENTRIES {
        return Err(unsafe_archive("too many entries"));
    }
    let mut written = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| unsafe_archive(format!("unreadable archive: {e}")))?;
        // zip 9 decodes names lazily: one that does not decode refuses the archive.
        let name = entry
            .name()
            .map_err(|e| unsafe_archive(format!("an entry has an unreadable name: {e}")))?
            .into_owned();
        check_zip_name(&name)?;
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| unsafe_archive(format!("an entry has an unsafe path ({name})")))?;
        let rel = safe_relative(&rel)?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        if entry.is_symlink() {
            let mut target = String::new();
            entry
                .by_ref()
                .take(4096)
                .read_to_string(&mut target)
                .map_err(|e| unsafe_archive(format!("unreadable link: {e}")))?;
            check_symlink_target(&rel, Path::new(&target))?;
            continue;
        }
        let out = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)
                .map_err(|e| Error::Io(format!("could not create {}: {e}", out.display())))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Io(format!("could not create {}: {e}", parent.display())))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&out)
            .map_err(|e| unsafe_archive(format!("could not write {}: {e}", rel.display())))?;
        let remaining = MAX_EXTRACTED_BYTES - written;
        let copied = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut file)
            .map_err(|e| unsafe_archive(format!("could not unpack {}: {e}", rel.display())))?;
        written += copied;
        if written > MAX_EXTRACTED_BYTES {
            return Err(unsafe_archive("it unpacks to more than 1 GiB"));
        }
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(mode & 0o777));
        }
    }
    Ok(())
}

/* ---------- locating the binary ---------- */

/// §6.3a rule 7: `bin/<exe>` or `Contents/Home/bin/<exe>` in `dir` or a
/// folder at most three levels below it. Symlinked folders are not
/// followed. Breadth-first, names sorted, so the shallowest hit wins.
pub fn locate_java_with(dir: &Path, exe: &str) -> Option<PathBuf> {
    let mut level = vec![dir.to_path_buf()];
    for depth in 0..=MAX_LOCATE_DEPTH {
        let mut next = Vec::new();
        for folder in &level {
            for candidate in [
                folder.join("bin").join(exe),
                folder.join("Contents").join("Home").join("bin").join(exe),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            if depth == MAX_LOCATE_DEPTH {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(folder) else {
                continue;
            };
            let mut children: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                .collect();
            children.sort();
            next.extend(children);
        }
        level = next;
    }
    None
}

/// `locate_java_with` for this OS's executable name.
pub fn locate_java(dir: &Path) -> Option<PathBuf> {
    locate_java_with(dir, crate::java::java_exe_name())
}

/* ---------- install ---------- */

/// One install per target folder at a time (§3.1): a second request waits
/// on the same lock and then finds the first one's result on disk.
static INSTALL_LOCKS: LazyLock<std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn install_lock(target: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = INSTALL_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    map.entry(target.to_path_buf()).or_default().clone()
}

/// `Some(binary)` when `target` holds a java that reports `major`.
async fn working_install(target: &Path, major: u32) -> Option<PathBuf> {
    let binary = locate_java(target)?;
    match crate::java::probe(&binary).await {
        Some((_, probed)) if probed == major => Some(binary),
        _ => None,
    }
}

pub fn validate_major(major: i64) -> Result<u32> {
    if !(MIN_MAJOR..=MAX_MAJOR).contains(&major) {
        return Err(Error::InvalidInput(format!(
            "Java version must be between {MIN_MAJOR} and {MAX_MAJOR}, not {major}"
        )));
    }
    Ok(major as u32)
}

/// `install_java` (§3.1): make sure Temurin JRE `major` is in the managed
/// folder, then return this server's Java check.
pub async fn install(core: &crate::Core, major: i64) -> Result<JavaCheck> {
    let major = validate_major(major)?;
    ensure_installed(core, &managed_root(core), major).await?;
    let instance = crate::instance::probe(core).await?;
    let required = instance.required_java_major.or(Some(major));
    crate::java::check_for(core, required).await
}

/// Install `major` under `root` unless a working copy is there. Returns the
/// java binary.
pub async fn ensure_installed(core: &crate::Core, root: &Path, major: u32) -> Result<PathBuf> {
    let dir_name = install_dir_name(major);
    let target = root.join(&dir_name);
    let lock = install_lock(&target);
    let _guard = lock.lock().await;
    if let Some(binary) = working_install(&target, major).await {
        return Ok(binary);
    }
    let mut version: Option<String> = None;
    let result = download_and_install(core, root, &target, major, &mut version).await;
    let detail = version.map(|v| format!("Temurin JRE {v}"));
    crate::audit::record(
        core,
        AuditSource::User,
        "java.install",
        Some(&dir_name),
        detail.as_deref(),
        result.as_ref().err(),
    )
    .await;
    result
}

async fn download_and_install(
    core: &crate::Core,
    root: &Path,
    target: &Path,
    major: u32,
    version_out: &mut Option<String>,
) -> Result<PathBuf> {
    let (os, arch) = this_platform().ok_or_else(|| {
        Error::DownloadFailed("there is no Temurin Java build for this computer".into())
    })?;
    let client = build_client();

    // 1. Ask Adoptium which archive to fetch.
    let api = reqwest::Url::parse(&api_url(major, os, arch))
        .map_err(|e| Error::Internal(format!("bad Adoptium URL: {e}")))?;
    let response = client.get(api).send().await.map_err(|e| {
        Error::DownloadFailed(format!("could not reach Adoptium to download Java: {e}"))
    })?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "Adoptium answered HTTP {} when asked for Java {major}",
            response.status().as_u16()
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not read Adoptium's answer: {e}")))?;
    let asset = select_asset(&body, major, os, arch)?;
    *version_out = Some(asset.version.clone());

    // 2. Download it (progress events, cap, sha256).
    let req = crate::download::DownloadRequest {
        url: asset.link.clone(),
        kind: DownloadKind::Java,
        filename: asset.name.clone(),
        download_id: uuid::Uuid::new_v4().to_string(),
        max_bytes: Some(MAX_ARCHIVE_BYTES),
        expected_sha1: None,
        expected_sha256: Some(asset.sha256.clone()),
        expected_sha512: None,
        allow_private_hosts: false,
        client: Some(client),
    };
    let downloaded = crate::download::to_temp_file(core, &req).await?;
    let archive = downloaded.temp_path;

    // 3. Extract beside the target, probe, rename into place.
    let result = unpack_and_place(root, target, major, &archive, asset.kind).await;
    let _ = tokio::fs::remove_file(&archive).await;
    result
}

async fn unpack_and_place(
    root: &Path,
    target: &Path,
    major: u32,
    archive: &Path,
    kind: ArchiveKind,
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| Error::Io(format!("could not create {}: {e}", root.display())))?;
    let dir_name = install_dir_name(major);
    let tmp = root.join(format!(".tmp-{dir_name}-{}", uuid::Uuid::new_v4()));
    let placed = async {
        tokio::fs::create_dir(&tmp)
            .await
            .map_err(|e| Error::Io(format!("could not create {}: {e}", tmp.display())))?;
        let (archive_path, tmp_dir) = (archive.to_path_buf(), tmp.clone());
        let binary = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
            let file = std::fs::File::open(&archive_path)
                .map_err(|e| Error::Io(format!("could not open the Java download: {e}")))?;
            match kind {
                ArchiveKind::TarGz => extract_tar_gz(std::io::BufReader::new(file), &tmp_dir)?,
                ArchiveKind::Zip => extract_zip(file, &tmp_dir)?,
            }
            locate_java(&tmp_dir).ok_or_else(|| {
                Error::DownloadFailed("the Java download has no java program in it".into())
            })
        })
        .await
        .map_err(|e| Error::Internal(format!("Java extraction task failed: {e}")))??;

        match crate::java::probe(&binary).await {
            Some((_, probed)) if probed == major => {}
            Some((version, _)) => {
                return Err(Error::DownloadFailed(format!(
                    "the downloaded Java reports version {version}, not {major}"
                )))
            }
            None => {
                return Err(Error::DownloadFailed(
                    "the downloaded Java does not run on this computer".into(),
                ))
            }
        }
        let relative = binary
            .strip_prefix(&tmp)
            .map_err(|_| Error::Internal("located java outside the temp dir".into()))?
            .to_path_buf();
        place(root, &tmp, target, &dir_name).await?;
        Ok(target.join(relative))
    }
    .await;
    if placed.is_err() {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }
    placed
}

/// §6.3a rule 8: rename `tmp` to `target`, moving a previous (broken)
/// folder aside first and removing it after.
async fn place(root: &Path, tmp: &Path, target: &Path, dir_name: &str) -> Result<()> {
    let aside = root.join(format!(".old-{dir_name}-{}", uuid::Uuid::new_v4()));
    let had_old = tokio::fs::symlink_metadata(target).await.is_ok();
    if had_old {
        tokio::fs::rename(target, &aside).await.map_err(|e| {
            Error::Io(format!(
                "could not move the old Java folder aside ({}): {e}",
                target.display()
            ))
        })?;
    }
    if let Err(e) = tokio::fs::rename(tmp, target).await {
        if had_old {
            let _ = tokio::fs::rename(&aside, target).await;
        }
        return Err(Error::Io(format!(
            "could not move Java into place ({}): {e}",
            target.display()
        )));
    }
    if had_old {
        let _ = tokio::fs::remove_dir_all(&aside).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/adoptium-jre-21-linux-x64.json");

    #[test]
    fn maps_platforms() {
        assert_eq!(adoptium_platform("linux", "x86_64"), Some(("linux", "x64")));
        assert_eq!(
            adoptium_platform("macos", "aarch64"),
            Some(("mac", "aarch64"))
        );
        assert_eq!(
            adoptium_platform("windows", "x86_64"),
            Some(("windows", "x64"))
        );
        assert_eq!(adoptium_platform("linux", "riscv64"), None);
        assert_eq!(adoptium_platform("freebsd", "x86_64"), None);
    }

    #[test]
    fn api_url_per_platform() {
        assert_eq!(
            api_url(21, "linux", "x64"),
            "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=linux&vendor=eclipse"
        );
        assert_eq!(
            api_url(17, "mac", "aarch64"),
            "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=aarch64&image_type=jre&os=mac&vendor=eclipse"
        );
        assert_eq!(
            api_url(8, "windows", "x64"),
            "https://api.adoptium.net/v3/assets/latest/8/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse"
        );
        let url = reqwest::Url::parse(&api_url(21, "linux", "x64")).unwrap();
        assert!(url_allowed(&url));
    }

    #[test]
    fn major_range() {
        assert!(validate_major(7).is_err());
        assert_eq!(validate_major(7).unwrap_err().code(), "INVALID_INPUT");
        assert_eq!(validate_major(31).unwrap_err().code(), "INVALID_INPUT");
        assert_eq!(validate_major(-21).unwrap_err().code(), "INVALID_INPUT");
        assert_eq!(validate_major(8).unwrap(), 8);
        assert_eq!(validate_major(30).unwrap(), 30);
    }

    #[test]
    fn host_allowlist() {
        let ok = |u: &str| url_allowed(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://github.com/adoptium/x.tar.gz"));
        assert!(ok("https://release-assets.githubusercontent.com/a?b=c"));
        assert!(!ok("http://github.com/adoptium/x.tar.gz"));
        assert!(!ok("https://objects.githubusercontent.com/x"));
        assert!(!ok("https://github.com.evil.example/x"));
        assert!(!ok("https://user:pw@github.com/x"));
        assert!(!ok("https://github.com:8443/x"));
    }

    #[test]
    fn parses_real_response() {
        let asset = select_asset(FIXTURE, 21, "linux", "x64").unwrap();
        assert_eq!(asset.kind, ArchiveKind::TarGz);
        assert_eq!(asset.version, "21.0.13+9");
        assert_eq!(
            asset.name,
            "OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz"
        );
        assert_eq!(
            asset.sha256,
            "a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd"
        );
        assert_eq!(asset.link.host_str(), Some("github.com"));
        assert_eq!(asset.size, 52_181_297);
    }

    #[test]
    fn refuses_mismatched_or_unsafe_assets() {
        // Wrong major / platform: nothing matches.
        assert_eq!(
            select_asset(FIXTURE, 17, "linux", "x64")
                .unwrap_err()
                .code(),
            "DOWNLOAD_FAILED"
        );
        assert_eq!(
            select_asset(FIXTURE, 21, "mac", "x64").unwrap_err().code(),
            "DOWNLOAD_FAILED"
        );
        assert_eq!(
            select_asset("[]", 21, "linux", "x64").unwrap_err().code(),
            "DOWNLOAD_FAILED"
        );
        // A link off the allowlist.
        let evil = FIXTURE.replace("https://github.com/", "https://evil.example/");
        assert_eq!(
            select_asset(&evil, 21, "linux", "x64").unwrap_err().code(),
            "DOWNLOAD_FAILED"
        );
        // Plain http.
        let http = FIXTURE.replace("\"link\": \"https://", "\"link\": \"http://");
        assert_eq!(
            select_asset(&http, 21, "linux", "x64").unwrap_err().code(),
            "DOWNLOAD_FAILED"
        );
        // No usable checksum.
        let nosum = FIXTURE.replace(
            "a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd",
            "nope",
        );
        assert_eq!(
            select_asset(&nosum, 21, "linux", "x64").unwrap_err().code(),
            "DOWNLOAD_FAILED"
        );
        // Over the size cap.
        let big = FIXTURE.replace("\"size\": 52181297", "\"size\": 999999999");
        assert_eq!(
            select_asset(&big, 21, "linux", "x64").unwrap_err().code(),
            "FILE_TOO_LARGE"
        );
    }

    /* ----- archive builders ----- */

    fn tar_gz(build: impl FnOnce(&mut tar::Builder<flate2::write::GzEncoder<Vec<u8>>>)) -> Vec<u8> {
        let enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(enc);
        build(&mut builder);
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn add_file(b: &mut tar::Builder<flate2::write::GzEncoder<Vec<u8>>>, path: &str, mode: u32) {
        let data = b"#!/bin/sh\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_entry_type(tar::EntryType::Regular);
        b.append_data(&mut header, path, &data[..]).unwrap();
    }

    /// Writes a raw name into the header, bypassing tar-rs's own path
    /// checks (an attacker's archive is not built with tar-rs).
    fn add_raw(
        b: &mut tar::Builder<flate2::write::GzEncoder<Vec<u8>>>,
        name: &str,
        kind: tar::EntryType,
        link: Option<&str>,
    ) {
        let mut header = tar::Header::new_old();
        {
            let raw = header.as_old_mut();
            raw.name[..name.len()].copy_from_slice(name.as_bytes());
            if let Some(link) = link {
                raw.linkname[..link.len()].copy_from_slice(link.as_bytes());
            }
        }
        header.set_entry_type(kind);
        header.set_mode(0o644);
        header.set_size(0);
        header.set_cksum();
        b.append(&header, std::io::empty()).unwrap();
    }

    fn untar(bytes: &[u8]) -> (tempfile::TempDir, Result<()>) {
        let dir = tempfile::tempdir().unwrap();
        let res = extract_tar_gz(bytes, dir.path());
        (dir, res)
    }

    #[test]
    fn tar_extracts_and_keeps_exec_bit() {
        let bytes = tar_gz(|b| {
            add_file(b, "jdk-21.0.13+9-jre/bin/java", 0o755);
            add_file(b, "jdk-21.0.13+9-jre/lib/modules", 0o644);
            add_raw(
                b,
                "jdk-21.0.13+9-jre/legal/java.sql/LICENSE",
                tar::EntryType::Symlink,
                Some("../java.base/LICENSE"),
            );
        });
        let (dir, res) = untar(&bytes);
        res.unwrap();
        let java = dir.path().join("jdk-21.0.13+9-jre/bin/java");
        assert!(java.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&java).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "bin/java must stay executable");
        }
        assert_eq!(locate_java_with(dir.path(), "java"), Some(java));
    }

    #[test]
    fn tar_refuses_parent_dir_entry() {
        let bytes = tar_gz(|b| add_raw(b, "../x", tar::EntryType::Regular, None));
        let (dir, res) = untar(&bytes);
        assert_eq!(res.unwrap_err().code(), "DOWNLOAD_FAILED");
        assert!(!dir.path().parent().unwrap().join("x").exists());
    }

    #[test]
    fn tar_refuses_absolute_entry() {
        let bytes = tar_gz(|b| add_raw(b, "/abs", tar::EntryType::Regular, None));
        let (_dir, res) = untar(&bytes);
        assert_eq!(res.unwrap_err().code(), "DOWNLOAD_FAILED");
    }

    #[test]
    fn tar_refuses_outside_symlinks() {
        for target in ["../../outside", "/etc/passwd", "a/../../.."] {
            let bytes = tar_gz(|b| add_raw(b, "jre/link", tar::EntryType::Symlink, Some(target)));
            let (dir, res) = untar(&bytes);
            assert_eq!(res.unwrap_err().code(), "DOWNLOAD_FAILED", "{target}");
            assert!(std::fs::symlink_metadata(dir.path().join("jre/link")).is_err());
        }
        // A hard link naming a path outside.
        let bytes = tar_gz(|b| add_raw(b, "jre/hard", tar::EntryType::Link, Some("../x")));
        assert_eq!(untar(&bytes).1.unwrap_err().code(), "DOWNLOAD_FAILED");
    }

    #[test]
    fn symlink_target_rules() {
        let p = Path::new;
        assert!(check_symlink_target(p("a/b/link"), p("../c")).is_ok());
        assert!(check_symlink_target(p("a/b/link"), p("../../c")).is_ok());
        assert!(check_symlink_target(p("a/b/link"), p("../../../c")).is_err());
        assert!(check_symlink_target(p("link"), p("..")).is_err());
        assert!(check_symlink_target(p("a/link"), p("/abs")).is_err());
    }

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut out);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, data) in entries {
                w.start_file(*name, opts).unwrap();
                std::io::Write::write_all(&mut w, data).unwrap();
            }
            w.finish().unwrap();
        }
        out.into_inner()
    }

    fn unzip(bytes: &[u8]) -> (tempfile::TempDir, Result<()>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.zip");
        std::fs::write(&path, bytes).unwrap();
        let dest = dir.path().join("out");
        std::fs::create_dir(&dest).unwrap();
        let res = extract_zip(std::fs::File::open(&path).unwrap(), &dest);
        (dir, res)
    }

    #[test]
    fn zip_extracts_windows_layout() {
        let bytes = zip_bytes(&[
            ("jdk-21.0.13+9-jre/bin/java.exe", b"MZ"),
            ("jdk-21.0.13+9-jre/release", b"JAVA_VERSION=21"),
        ]);
        let (dir, res) = unzip(&bytes);
        res.unwrap();
        let out = dir.path().join("out");
        assert_eq!(
            locate_java_with(&out, "java.exe"),
            Some(out.join("jdk-21.0.13+9-jre/bin/java.exe"))
        );
    }

    #[test]
    fn zip_refuses_traversal_and_absolute() {
        for name in ["../x", "/abs", "a/../../x", "a/../b", "C:/x", "..\\x"] {
            let bytes = zip_bytes(&[(name, b"x")]);
            let (dir, res) = unzip(&bytes);
            assert_eq!(res.unwrap_err().code(), "DOWNLOAD_FAILED", "{name}");
            assert!(!dir.path().join("x").exists());
        }
    }

    #[test]
    fn locates_java_in_each_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let mk = |rel: &str| {
            let p = tmp.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"").unwrap();
            p
        };
        let linux = mk("linux/jdk-21.0.13+9-jre/bin/java");
        let mac = mk("mac/jdk-21.0.13+9-jre/Contents/Home/bin/java");
        let win = mk("win/jdk-21.0.13+9-jre/bin/java.exe");
        assert_eq!(
            locate_java_with(&tmp.path().join("linux"), "java"),
            Some(linux)
        );
        assert_eq!(locate_java_with(&tmp.path().join("mac"), "java"), Some(mac));
        assert_eq!(
            locate_java_with(&tmp.path().join("win"), "java.exe"),
            Some(win)
        );
        // Too deep: four folders below.
        mk("deep/a/b/c/d/bin/java");
        assert_eq!(locate_java_with(&tmp.path().join("deep"), "java"), None);
        assert_eq!(locate_java_with(&tmp.path().join("missing"), "java"), None);
    }

    #[tokio::test]
    async fn sha256_mismatch_is_refused() {
        // Serve a body from a local socket and verify through the real
        // download path with a wrong expected sha256.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let body = b"not really a jre";
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            sock.write_all(head.as_bytes()).await.unwrap();
            sock.write_all(body).await.unwrap();
            sock.flush().await.unwrap();
        });
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let mut events = core.subscribe_events();
        let req = crate::download::DownloadRequest {
            url: reqwest::Url::parse(&format!("http://{addr}/jre.tar.gz")).unwrap(),
            kind: DownloadKind::Java,
            filename: "jre.tar.gz".into(),
            download_id: "t".into(),
            max_bytes: Some(MAX_ARCHIVE_BYTES),
            expected_sha1: None,
            expected_sha256: Some("0".repeat(64)),
            expected_sha512: None,
            allow_private_hosts: true,
            client: Some(reqwest::Client::new()),
        };
        let Err(err) = crate::download::to_temp_file(&core, &req).await else {
            panic!("a sha256 mismatch must fail the download");
        };
        assert_eq!(err.code(), "CHECKSUM_MISMATCH");
        // The terminal event carries the same code, kind "java".
        let mut last = None;
        while let Ok(ev) = events.try_recv() {
            if let crate::model::CoreEvent::DownloadProgress(p) = ev {
                last = Some(p);
            }
        }
        let last = last.expect("a terminal progress event");
        assert_eq!(last.kind, DownloadKind::Java);
        assert_eq!(last.error.unwrap().code, "CHECKSUM_MISMATCH");
        // Nothing left behind in the temp dir.
        let leftovers = std::fs::read_dir(tmp.path().join("data/tmp"))
            .unwrap()
            .count();
        assert_eq!(leftovers, 0);
    }
}
