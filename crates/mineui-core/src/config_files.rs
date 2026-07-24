//! Config file editor (contract §3.7, validation §6.1).
//!
//! Paths in this API are relative, forward-slash. Advanced-mode I/O never
//! touches a shell: list = `find` argv + Rust filtering, read = `cat` argv
//! with a core-constructed absolute path, write = host temp file + `cp`.

use crate::error::{Error, Result};
use crate::model::{ConfigFileContent, ConfigFileList};
use crate::settings::Mode;

/// §3.7: write cap 1,500,000 bytes (v1 parity).
const WRITE_MAX_BYTES: usize = 1_500_000;
const ADVANCED_ROOT: &str = "/data";

fn is_listable(rel: &str) -> bool {
    crate::validate::validate_config_rel_path(rel).is_ok()
}

/// `list_config_files`: server.properties (if present) plus every allowed
/// file under config/, sorted.
pub async fn list(core: &crate::Core) -> Result<ConfigFileList> {
    let settings = core.settings().await;
    let mut files: Vec<String> = Vec::new();
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;

            let props = runtime
                .exec(name, &["test", "-f", "/data/server.properties"])
                .await?;
            if props.success() {
                files.push("server.properties".to_string());
            }

            let found = runtime
                .exec(name, &["find", "/data/config", "-type", "f"])
                .await?;
            if found.success() {
                for line in found.stdout.lines() {
                    let Some(rel) = line.trim().strip_prefix("/data/") else {
                        continue;
                    };
                    if is_listable(rel) {
                        files.push(rel.to_string());
                    }
                }
            }
        }
        Mode::Simple => {
            let root = settings.simple.instance_dir.clone();
            if root.join("server.properties").is_file() {
                files.push("server.properties".to_string());
            }
            let mut stack = vec![root.join("config")];
            while let Some(dir) = stack.pop() {
                let Ok(mut reader) = tokio::fs::read_dir(&dir).await else {
                    continue;
                };
                while let Ok(Some(item)) = reader.next_entry().await {
                    let path = item.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if let Ok(rel) = path.strip_prefix(&root) {
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        if is_listable(&rel) {
                            files.push(rel);
                        }
                    }
                }
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(ConfigFileList { files })
}

/// `read_config_file` (§3.7).
pub async fn read(core: &crate::Core, path: &str) -> Result<ConfigFileContent> {
    crate::validate::validate_config_rel_path(path)?;
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let abs = crate::validate::join_under_root(std::path::Path::new(ADVANCED_ROOT), path)?;
            let abs = abs.to_string_lossy().to_string();
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let out = runtime
                .exec(&settings.advanced.container_name, &["cat", &abs])
                .await?;
            if !out.success() {
                return Err(Error::Io(format!("failed to read {path}: {}", out.stderr)));
            }
            Ok(ConfigFileContent {
                content: out.stdout,
            })
        }
        Mode::Simple => {
            let abs = crate::validate::join_under_root(&settings.simple.instance_dir, path)?;
            let content = tokio::fs::read_to_string(&abs)
                .await
                .map_err(|e| Error::Io(format!("failed to read {path}: {e}")))?;
            Ok(ConfigFileContent { content })
        }
    }
}

/// `write_config_file` (§3.7): 1.5 MB cap; advanced = temp file + `cp`
/// (no base64-through-shell); simple = std fs with symlink-escape re-check.
pub async fn write(core: &crate::Core, path: &str, content: &str) -> Result<()> {
    crate::validate::validate_config_rel_path(path)?;
    if content.len() > WRITE_MAX_BYTES {
        return Err(Error::FileTooLarge(format!(
            "config writes are limited to {WRITE_MAX_BYTES} bytes"
        )));
    }
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let abs = crate::validate::join_under_root(std::path::Path::new(ADVANCED_ROOT), path)?;
            let parent = abs
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ADVANCED_ROOT.to_string());
            let abs = abs.to_string_lossy().to_string();
            let runtime = crate::runtime::resolve(&settings.advanced).await?;

            // `cp` cannot create missing parent directories (verified live:
            // rootless podman 4.9.3 fails with "could not be found on
            // container" when /data/config does not exist yet). Best-effort
            // mkdir, mirroring mods::place_file; a real failure surfaces via
            // the cp below.
            let _ = runtime
                .exec(&settings.advanced.container_name, &["mkdir", "-p", &parent])
                .await;

            let tmp_dir = core.paths.data_dir.join("tmp");
            tokio::fs::create_dir_all(&tmp_dir)
                .await
                .map_err(|e| Error::Io(format!("failed to create temp dir: {e}")))?;
            let tmp = tmp_dir.join(format!("cfg-{}", uuid::Uuid::new_v4().simple()));
            tokio::fs::write(&tmp, content.as_bytes())
                .await
                .map_err(|e| Error::Io(format!("failed to stage config write: {e}")))?;
            let result = runtime
                .cp_to(&settings.advanced.container_name, &tmp, &abs)
                .await;
            let _ = tokio::fs::remove_file(&tmp).await;
            result
        }
        Mode::Simple => {
            let root = settings.simple.instance_dir.clone();
            let abs = crate::validate::join_under_root(&root, path)?;
            let parent = abs
                .parent()
                .ok_or_else(|| Error::PathNotAllowed("path has no parent".into()))?;
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| Error::Io(format!("failed to create config dir: {e}")))?;
            // §6.1 rule 3: canonicalize the parent on write and re-check
            // (symlink escape defense).
            let canonical_parent = tokio::fs::canonicalize(parent)
                .await
                .map_err(|e| Error::Io(format!("failed to resolve config dir: {e}")))?;
            let canonical_root = tokio::fs::canonicalize(&root)
                .await
                .map_err(|e| Error::Io(format!("failed to resolve instance dir: {e}")))?;
            if !canonical_parent.starts_with(&canonical_root) {
                return Err(Error::PathNotAllowed(format!(
                    "path escapes the instance directory: {path}"
                )));
            }
            let file_name = abs
                .file_name()
                .ok_or_else(|| Error::PathNotAllowed("path has no filename".into()))?;
            tokio::fs::write(canonical_parent.join(file_name), content.as_bytes())
                .await
                .map_err(|e| Error::Io(format!("failed to write {path}: {e}")))?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    async fn core_with_instance() -> (tempfile::TempDir, std::sync::Arc<crate::Core>) {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let mut settings = Settings::default_with_data_dir(&data_dir);
        settings.simple.instance_dir = tmp.path().join("instance");
        std::fs::create_dir_all(&settings.simple.instance_dir).unwrap();
        let core = crate::Core::init_with_settings(config_dir, data_dir, settings).await;
        (tmp, core)
    }

    #[tokio::test]
    async fn simple_mode_roundtrip_and_listing() {
        let (_tmp, core) = core_with_instance().await;
        write(&core, "server.properties", "motd=hi\n")
            .await
            .unwrap();
        write(&core, "config/mod/settings.toml", "a = 1\n")
            .await
            .unwrap();

        let content = read(&core, "config/mod/settings.toml").await.unwrap();
        assert_eq!(content.content, "a = 1\n");

        let listing = list(&core).await.unwrap();
        assert_eq!(
            listing.files,
            vec![
                "config/mod/settings.toml".to_string(),
                "server.properties".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn rejects_traversal_and_bad_extensions() {
        let (_tmp, core) = core_with_instance().await;
        let err = write(&core, "../evil.txt", "x").await.unwrap_err();
        assert_eq!(err.code(), "PATH_NOT_ALLOWED");
        let err = write(&core, "config/evil.jar", "x").await.unwrap_err();
        assert_eq!(err.code(), "PATH_NOT_ALLOWED");
        let err = read(&core, "config/../server.jar").await.unwrap_err();
        assert_eq!(err.code(), "PATH_NOT_ALLOWED");
    }

    #[tokio::test]
    async fn enforces_write_cap() {
        let (_tmp, core) = core_with_instance().await;
        let big = "x".repeat(WRITE_MAX_BYTES + 1);
        let err = write(&core, "config/big.txt", &big).await.unwrap_err();
        assert_eq!(err.code(), "FILE_TOO_LARGE");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_config_dir_cannot_escape_root() {
        let (tmp, core) = core_with_instance().await;
        let settings = core.settings().await;
        let instance = settings.simple.instance_dir.clone();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(instance.join("config")).unwrap();
        std::os::unix::fs::symlink(&outside, instance.join("config").join("link")).unwrap();

        let err = write(&core, "config/link/escape.txt", "x")
            .await
            .unwrap_err();
        assert_eq!(err.code(), "PATH_NOT_ALLOWED");
        assert!(!outside.join("escape.txt").exists());
    }
}
