//! Mojang version manifest + server jar acquisition (contract §3.6).

use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{DownloadKind, McVersion};

pub const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestLatest {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
    #[serde(rename = "releaseTime")]
    pub release_time: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VersionManifest {
    pub latest: ManifestLatest,
    pub versions: Vec<ManifestVersion>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerDownload {
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct VersionDownloads {
    pub server: Option<ServerDownload>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JavaVersionInfo {
    #[serde(rename = "majorVersion")]
    pub major_version: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VersionDetail {
    pub id: String,
    #[serde(default)]
    pub downloads: VersionDownloads,
    #[serde(rename = "javaVersion")]
    pub java_version: Option<JavaVersionInfo>,
}

/// In-memory manifest cache stored on `Core`.
pub struct ManifestCache {
    pub fetched_at: Instant,
    pub manifest: VersionManifest,
}

pub fn manifest_to_versions(manifest: &VersionManifest, include_snapshots: bool) -> Vec<McVersion> {
    manifest
        .versions
        .iter()
        .filter(|v| include_snapshots || v.version_type == "release")
        .map(|v| McVersion {
            id: v.id.clone(),
            version_type: v.version_type.clone(),
            release_time: v.release_time.clone(),
            latest: v.id == manifest.latest.release || v.id == manifest.latest.snapshot,
        })
        .collect()
}

async fn fetch_manifest(core: &crate::Core) -> Result<VersionManifest> {
    let response = core
        .http
        .get(MANIFEST_URL)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| Error::DownloadFailed(format!("failed to fetch version manifest: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "version manifest returned HTTP {}",
            response.status().as_u16()
        )));
    }
    response
        .json::<VersionManifest>()
        .await
        .map_err(|e| Error::DownloadFailed(format!("invalid version manifest: {e}")))
}

/// `list_mc_versions` (§3.6): WRONG_MODE outside simple mode; 15-minute
/// in-memory cache; network failure with a warm cache serves the cache,
/// otherwise DOWNLOAD_FAILED.
pub async fn list_versions(core: &crate::Core, include_snapshots: bool) -> Result<Vec<McVersion>> {
    crate::instance::ensure_simple_mode(core).await?;
    list_versions_unchecked(core, include_snapshots).await
}

pub(crate) async fn list_versions_unchecked(
    core: &crate::Core,
    include_snapshots: bool,
) -> Result<Vec<McVersion>> {
    let mut cache = core.mojang_cache.lock().await;
    if let Some(cached) = cache.as_ref() {
        if cached.fetched_at.elapsed() < CACHE_TTL {
            return Ok(manifest_to_versions(&cached.manifest, include_snapshots));
        }
    }
    match fetch_manifest(core).await {
        Ok(manifest) => {
            let versions = manifest_to_versions(&manifest, include_snapshots);
            *cache = Some(ManifestCache {
                fetched_at: Instant::now(),
                manifest,
            });
            Ok(versions)
        }
        Err(e) => {
            if let Some(stale) = cache.as_ref() {
                Ok(manifest_to_versions(&stale.manifest, include_snapshots))
            } else {
                Err(e)
            }
        }
    }
}

/// Resolve one version id in the manifest and fetch its detail JSON.
/// Unknown version → INVALID_INPUT.
pub async fn version_detail(core: &crate::Core, version_id: &str) -> Result<VersionDetail> {
    // Ensure a manifest (cached or fresh).
    {
        let cache = core.mojang_cache.lock().await;
        if cache.is_none() || cache.as_ref().unwrap().fetched_at.elapsed() >= CACHE_TTL {
            drop(cache);
            let _ = list_versions_unchecked(core, true).await?;
        }
    }
    let url = {
        let cache = core.mojang_cache.lock().await;
        let manifest = &cache
            .as_ref()
            .ok_or_else(|| Error::DownloadFailed("version manifest unavailable".into()))?
            .manifest;
        manifest
            .versions
            .iter()
            .find(|v| v.id == version_id)
            .map(|v| v.url.clone())
            .ok_or_else(|| {
                Error::InvalidInput(format!("unknown Minecraft version: {version_id}"))
            })?
    };
    let response = core
        .http
        .get(&url)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| Error::DownloadFailed(format!("failed to fetch version detail: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "version detail returned HTTP {}",
            response.status().as_u16()
        )));
    }
    response
        .json::<VersionDetail>()
        .await
        .map_err(|e| Error::DownloadFailed(format!("invalid version detail JSON: {e}")))
}

/// Download the server jar to `dest` with sha1 verification and
/// `kind: "server-jar"` progress events (§3.6 step 5).
pub async fn download_server_jar(
    core: &crate::Core,
    download: &ServerDownload,
    dest: &std::path::Path,
) -> Result<String> {
    let url = crate::validate::download_url(&download.url)?;
    let req = crate::download::DownloadRequest {
        url,
        kind: DownloadKind::ServerJar,
        filename: "server.jar".into(),
        download_id: uuid::Uuid::new_v4().to_string(),
        max_bytes: None,
        expected_sha1: Some(download.sha1.clone()),
        // Server-jar URLs come from Mojang's HTTPS manifest and the content
        // is SHA-1 pinned; still use the strict client — piston-data has no
        // business redirecting to private hosts.
        allow_private_hosts: false,
    };
    let result = crate::download::to_temp_file(core, &req).await?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| Error::Io(format!("failed to create instance dir: {e}")))?;
    }
    move_file(&result.temp_path, dest).await?;
    Ok(result.sha1_hex)
}

/// Rename, falling back to copy+remove across filesystems.
pub async fn move_file(src: &std::path::Path, dest: &std::path::Path) -> Result<()> {
    match tokio::fs::rename(src, dest).await {
        Ok(()) => Ok(()),
        Err(_) => {
            tokio::fs::copy(src, dest)
                .await
                .map_err(|e| Error::Io(format!("failed to move file into place: {e}")))?;
            let _ = tokio::fs::remove_file(src).await;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST_FIXTURE: &str = r#"{
      "latest": { "release": "1.21.6", "snapshot": "25w30a" },
      "versions": [
        { "id": "25w30a", "type": "snapshot", "url": "https://piston-meta.mojang.com/v1/packages/aaa/25w30a.json", "time": "2026-07-20T10:00:00+00:00", "releaseTime": "2026-07-20T10:00:00+00:00", "sha1": "aaa", "complianceLevel": 1 },
        { "id": "1.21.6", "type": "release", "url": "https://piston-meta.mojang.com/v1/packages/bbb/1.21.6.json", "time": "2026-06-17T10:00:00+00:00", "releaseTime": "2026-06-17T10:00:00+00:00", "sha1": "bbb", "complianceLevel": 1 },
        { "id": "1.21.5", "type": "release", "url": "https://piston-meta.mojang.com/v1/packages/ccc/1.21.5.json", "time": "2026-03-25T10:00:00+00:00", "releaseTime": "2026-03-25T10:00:00+00:00", "sha1": "ccc", "complianceLevel": 1 },
        { "id": "b1.8.1", "type": "old_beta", "url": "https://piston-meta.mojang.com/v1/packages/ddd/b1.8.1.json", "time": "2011-09-19T10:00:00+00:00", "releaseTime": "2011-09-19T10:00:00+00:00", "sha1": "ddd", "complianceLevel": 0 }
      ]
    }"#;

    const DETAIL_FIXTURE: &str = r#"{
      "id": "1.21.6",
      "downloads": {
        "client": { "sha1": "x", "size": 1, "url": "https://example.com/client.jar" },
        "server": { "sha1": "8c757bb9b6fbd8b19bb1f6dfd2be1cf0e9c69777", "size": 51830140, "url": "https://piston-data.mojang.com/v1/objects/8c7/server.jar" }
      },
      "javaVersion": { "component": "java-runtime-delta", "majorVersion": 21 }
    }"#;

    #[test]
    fn manifest_deserializes_and_filters() {
        let manifest: VersionManifest = serde_json::from_str(MANIFEST_FIXTURE).unwrap();
        assert_eq!(manifest.latest.release, "1.21.6");

        let releases = manifest_to_versions(&manifest, false);
        assert_eq!(releases.len(), 2);
        assert!(releases.iter().all(|v| v.version_type == "release"));
        assert!(releases.iter().find(|v| v.id == "1.21.6").unwrap().latest);
        assert!(!releases.iter().find(|v| v.id == "1.21.5").unwrap().latest);

        let all = manifest_to_versions(&manifest, true);
        assert_eq!(all.len(), 4);
        assert!(all.iter().find(|v| v.id == "25w30a").unwrap().latest);
    }

    #[test]
    fn version_detail_deserializes() {
        let detail: VersionDetail = serde_json::from_str(DETAIL_FIXTURE).unwrap();
        let server = detail.downloads.server.unwrap();
        assert_eq!(server.size, 51830140);
        assert_eq!(server.sha1, "8c757bb9b6fbd8b19bb1f6dfd2be1cf0e9c69777");
        assert_eq!(detail.java_version.unwrap().major_version, 21);
    }

    #[test]
    fn mc_version_wire_shape() {
        let v = McVersion {
            id: "1.21.6".into(),
            version_type: "release".into(),
            release_time: "2026-06-17T10:00:00+00:00".into(),
            latest: true,
        };
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["type"], "release");
        assert_eq!(json["releaseTime"], "2026-06-17T10:00:00+00:00");
    }
}
