//! Simple-mode instance management (contract §3.6).

use std::path::Path;

use rand::Rng;

use crate::error::{Error, Result};
use crate::model::{CreateInstanceArgs, InstanceMeta, InstanceStatus};

pub const META_FILE: &str = "mineui-instance.json";

/// Generate the RCON password: 24 chars, alphanumeric, CSPRNG (§2.1).
pub fn generate_rcon_password() -> String {
    let mut rng = rand::thread_rng();
    (0..24)
        .map(|_| char::from(rng.sample(rand::distributions::Alphanumeric)))
        .collect()
}

/// Upsert `key=value` pairs into server.properties content, preserving every
/// other line (comments, user keys, ordering) (§3.6 step 6).
pub fn upsert_properties(content: &str, entries: &[(&str, String)]) -> String {
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let mut seen = vec![false; entries.len()];
    for line in lines.iter_mut() {
        let replacement = {
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') {
                None
            } else if let Some(eq) = trimmed.find('=') {
                let key = trimmed[..eq].trim();
                entries
                    .iter()
                    .enumerate()
                    .find_map(|(i, (entry_key, value))| {
                        if key == *entry_key {
                            Some((i, format!("{entry_key}={value}")))
                        } else {
                            None
                        }
                    })
            } else {
                None
            }
        };
        if let Some((i, new_line)) = replacement {
            *line = new_line;
            seen[i] = true;
        }
    }
    for (i, (key, value)) in entries.iter().enumerate() {
        if !seen[i] {
            lines.push(format!("{key}={value}"));
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Read a value out of server.properties content.
pub fn read_property<'a>(content: &'a str, key: &str) -> Option<&'a str> {
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            if trimmed[..eq].trim() == key {
                return Some(trimmed[eq + 1..].trim());
            }
        }
    }
    None
}

async fn read_meta(instance_dir: &Path) -> Option<InstanceMeta> {
    let raw = tokio::fs::read_to_string(instance_dir.join(META_FILE))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

async fn eula_accepted_on_disk(instance_dir: &Path) -> bool {
    match tokio::fs::read_to_string(instance_dir.join("eula.txt")).await {
        Ok(content) => content
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case("eula=true")),
        Err(_) => false,
    }
}

/// §3.6: instance commands reject with WRONG_MODE outside simple mode.
pub(crate) async fn ensure_simple_mode(core: &crate::Core) -> Result<()> {
    if core.settings().await.active_mode != crate::settings::Mode::Simple {
        return Err(Error::WrongMode(
            "this command is only available in simple mode".into(),
        ));
    }
    Ok(())
}

/// `instance_status` (§3.6). WRONG_MODE outside simple mode.
pub async fn status(core: &crate::Core) -> Result<InstanceStatus> {
    ensure_simple_mode(core).await?;
    probe(core).await
}

/// Ungated instance probe for internal callers (`java_check` is available in
/// both modes and reads instance metadata when present).
pub async fn probe(core: &crate::Core) -> Result<InstanceStatus> {
    let settings = core.settings().await;
    let dir = settings.simple.instance_dir.clone();
    let meta = read_meta(&dir).await;
    let exists = meta.is_some();

    let rcon_configured = match tokio::fs::read_to_string(dir.join("server.properties")).await {
        Ok(props) => {
            read_property(&props, "enable-rcon") == Some("true")
                && read_property(&props, "rcon.port").is_some()
                && read_property(&props, "rcon.password").map(|p| !p.is_empty()) == Some(true)
        }
        Err(_) => false,
    };

    Ok(InstanceStatus {
        exists,
        instance_dir: dir.to_string_lossy().to_string(),
        mc_version: meta.as_ref().map(|m| m.mc_version.clone()),
        required_java_major: meta.as_ref().and_then(|m| m.required_java_major),
        jar_sha1: meta.as_ref().map(|m| m.jar_sha1.clone()),
        eula_accepted: eula_accepted_on_disk(&dir).await,
        rcon_configured,
        world_exists: dir.join("world").is_dir(),
        created_at: meta.as_ref().map(|m| m.created_at.clone()),
    })
}

/// Re-assert the managed server.properties keys and eula.txt before every
/// simple-mode start, preserving user-edited keys (§3.6 step 6, §3.2).
pub async fn assert_runtime_files(core: &crate::Core) -> Result<()> {
    let mut settings = core.settings().await;
    let dir = settings.simple.instance_dir.clone();

    // eula.txt
    tokio::fs::write(dir.join("eula.txt"), b"# accepted via MineUI\neula=true\n")
        .await
        .map_err(|e| Error::Io(format!("failed to write eula.txt: {e}")))?;

    // Ensure an RCON password exists.
    if settings.simple.rcon_password.is_empty() {
        settings.simple.rcon_password = generate_rcon_password();
        settings = core.update_settings(settings).await?;
    }

    let props_path = dir.join("server.properties");
    let existing = tokio::fs::read_to_string(&props_path)
        .await
        .unwrap_or_default();
    let updated = upsert_properties(
        &existing,
        &[
            ("enable-rcon", "true".to_string()),
            ("rcon.port", settings.simple.rcon_port.to_string()),
            ("rcon.password", settings.simple.rcon_password.clone()),
            ("broadcast-rcon-to-ops", "false".to_string()),
            ("server-port", settings.simple.server_port.to_string()),
            ("enable-status", "true".to_string()),
        ],
    );
    tokio::fs::write(&props_path, updated.as_bytes())
        .await
        .map_err(|e| Error::Io(format!("failed to write server.properties: {e}")))?;
    Ok(())
}

/// `create_instance` (§3.6). Sequence and error codes per contract.
pub async fn create(core: &crate::Core, args: &CreateInstanceArgs) -> Result<InstanceStatus> {
    ensure_simple_mode(core).await?;
    // 1. EULA gate.
    if !args.accept_eula {
        return Err(Error::EulaNotAccepted(
            "you must accept the Minecraft EULA to create a server".into(),
        ));
    }
    let settings = core.settings().await;
    let dir = settings.simple.instance_dir.clone();

    // 2. Already initialized?
    if dir.join(META_FILE).is_file() {
        return Err(Error::InstanceExists(format!(
            "an instance already exists at {}",
            dir.display()
        )));
    }

    // 3. Resolve version + detail.
    let detail = crate::mojang::version_detail(core, &args.mc_version).await?;
    let server = detail.downloads.server.clone().ok_or_else(|| {
        Error::InvalidInput(format!(
            "version {} has no server download",
            args.mc_version
        ))
    })?;
    let required_major = detail.java_version.as_ref().map(|j| j.major_version);

    // 4. Java check against the required major (report, don't bundle).
    let java = crate::java::check(settings.simple.java_path.as_deref(), required_major).await?;
    if !java.found {
        return Err(Error::JavaNotFound(
            "no java binary found on PATH or JAVA_HOME; install a JRE/JDK first".into(),
        ));
    }
    if java.compatible == Some(false) {
        return Err(Error::JavaIncompatible(format!(
            "Minecraft {} requires Java {}+ but {} was found",
            args.mc_version,
            required_major.unwrap_or(0),
            java.version.as_deref().unwrap_or("unknown")
        )));
    }

    let dir_existed = dir.is_dir();
    let created = async {
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| Error::Io(format!("failed to create instance dir: {e}")))?;

        // 5. Download + sha1-verify the server jar.
        let jar_sha1 =
            crate::mojang::download_server_jar(core, &server, &dir.join("server.jar")).await?;

        // 6. eula.txt + server.properties (+ generated rcon password).
        //    Persist eulaAccepted/mcVersion/memoryMb first so
        //    assert_runtime_files sees the final settings.
        let mut updated = core.settings().await;
        updated.simple.eula_accepted = true;
        updated.simple.mc_version = args.mc_version.clone();
        if let Some(memory) = args.memory_mb {
            updated.simple.memory_mb = memory;
        }
        if updated.simple.rcon_password.is_empty() {
            updated.simple.rcon_password = generate_rcon_password();
        }
        core.update_settings(updated).await?;
        assert_runtime_files(core).await?;

        // Managed subdirectories (§3.6 layout).
        for sub in ["mods", "plugins", "backups", "logs"] {
            let _ = tokio::fs::create_dir_all(dir.join(sub)).await;
        }

        // 7. mineui-instance.json.
        let meta = InstanceMeta {
            mc_version: args.mc_version.clone(),
            jar_sha1,
            required_java_major: required_major,
            created_at: crate::util::now_iso8601(),
        };
        let json = serde_json::to_string_pretty(&meta)
            .map_err(|e| Error::Internal(format!("failed to serialize instance meta: {e}")))?;
        tokio::fs::write(dir.join(META_FILE), json.as_bytes())
            .await
            .map_err(|e| Error::Io(format!("failed to write {META_FILE}: {e}")))?;
        Ok::<(), Error>(())
    }
    .await;

    if let Err(err) = created {
        // Best-effort cleanup of a partial instance (§3.6): only if we created
        // the dir ourselves and it never got its meta file.
        if !dir_existed && !dir.join(META_FILE).is_file() {
            let _ = tokio::fs::remove_dir_all(&dir).await;
        }
        return Err(err);
    }
    probe(core).await
}

/// `delete_instance` (§3.6): safety latch on mineui-instance.json.
pub async fn delete(core: &crate::Core, confirm: bool) -> Result<()> {
    ensure_simple_mode(core).await?;
    if !confirm {
        return Err(Error::InvalidInput(
            "delete_instance requires confirm: true".into(),
        ));
    }
    if core.supervisor.is_active() {
        return Err(Error::ServerRunning(
            "stop the server before deleting the instance".into(),
        ));
    }
    let settings = core.settings().await;
    let dir = settings.simple.instance_dir.clone();
    if !dir.join(META_FILE).is_file() {
        return Err(Error::InstanceNotFound(format!(
            "no MineUI instance at {}",
            dir.display()
        )));
    }
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| Error::Io(format!("failed to delete instance: {e}")))?;

    let mut updated = core.settings().await;
    updated.simple.mc_version = String::new();
    core.update_settings(updated).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rcon_password_is_24_alphanumeric() {
        let p1 = generate_rcon_password();
        let p2 = generate_rcon_password();
        assert_eq!(p1.len(), 24);
        assert!(p1.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(p1, p2);
    }

    #[test]
    fn upsert_preserves_user_keys_and_comments() {
        let existing = "#Minecraft server properties\n#Wed Jul 23\nmotd=My Server\nenable-rcon=false\ndifficulty=hard\n";
        let updated = upsert_properties(
            existing,
            &[
                ("enable-rcon", "true".into()),
                ("rcon.port", "25575".into()),
            ],
        );
        assert!(updated.contains("#Minecraft server properties"));
        assert!(updated.contains("motd=My Server"));
        assert!(updated.contains("difficulty=hard"));
        assert!(updated.contains("enable-rcon=true"));
        assert!(!updated.contains("enable-rcon=false"));
        assert!(updated.contains("rcon.port=25575"));
    }

    #[test]
    fn upsert_appends_missing_keys() {
        let updated = upsert_properties("", &[("server-port", "25565".into())]);
        assert_eq!(updated, "server-port=25565\n");
    }

    #[test]
    fn read_property_parses() {
        let props = "# comment\nenable-rcon=true\nrcon.password= secret \n";
        assert_eq!(read_property(props, "enable-rcon"), Some("true"));
        assert_eq!(read_property(props, "rcon.password"), Some("secret"));
        assert_eq!(read_property(props, "missing"), None);
    }

    #[test]
    fn instance_meta_wire_shape() {
        let meta = InstanceMeta {
            mc_version: "1.21.6".into(),
            jar_sha1: "abc".into(),
            required_java_major: Some(21),
            created_at: "2026-07-23T00:00:00Z".into(),
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(v["mcVersion"], "1.21.6");
        assert_eq!(v["jarSha1"], "abc");
        assert_eq!(v["requiredJavaMajor"], 21);
    }
}
