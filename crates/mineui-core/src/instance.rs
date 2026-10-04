//! Simple-mode instance management (contract §3.6).

use std::path::Path;

use rand::RngExt;

use crate::error::{Error, Result};
use crate::model::{ChangedInstanceVersion, CreateInstanceArgs, InstanceMeta, InstanceStatus};

pub const META_FILE: &str = "mineui-instance.json";

/// Generate the RCON password: 24 chars, alphanumeric, CSPRNG (§2.1).
pub fn generate_rcon_password() -> String {
    let mut rng = rand::rng();
    (0..24)
        .map(|_| char::from(rng.sample(rand::distr::Alphanumeric)))
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
async fn create_inner(core: &crate::Core, args: &CreateInstanceArgs) -> Result<InstanceStatus> {
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
async fn delete_inner(core: &crate::Core, confirm: bool) -> Result<()> {
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

/* ---------- change_instance_version (§3.6, 2.10.0) ---------- */

/// Which way a version change goes, by manifest `releaseTime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionDirection {
    Upgrade,
    Downgrade,
    /// A time is missing or unparseable, or both are the same instant.
    /// Treated like a downgrade.
    Unknown,
}

/// §3.6 step 3: compare the two versions' manifest release times.
pub fn version_direction(from_release: Option<&str>, to_release: Option<&str>) -> VersionDirection {
    let parse =
        |s: Option<&str>| s.and_then(|s| chrono::DateTime::parse_from_rfc3339(s.trim()).ok());
    match (parse(from_release), parse(to_release)) {
        (Some(from), Some(to)) if to > from => VersionDirection::Upgrade,
        (Some(from), Some(to)) if to < from => VersionDirection::Downgrade,
        _ => VersionDirection::Unknown,
    }
}

/// §3.6 step 2: refuse a change to the version the instance already runs.
pub fn ensure_different_version(current: &str, target: &str) -> Result<()> {
    if current == target {
        return Err(Error::InvalidInput(format!(
            "this server is already on Minecraft {target}"
        )));
    }
    Ok(())
}

/// §3.6 step 3: anything but a clear upgrade needs `allowDowngrade`.
pub fn ensure_direction_allowed(
    from: &str,
    to: &str,
    direction: VersionDirection,
    allow_downgrade: bool,
) -> Result<()> {
    if direction == VersionDirection::Upgrade || allow_downgrade {
        return Ok(());
    }
    let why = match direction {
        VersionDirection::Downgrade => format!("Minecraft {to} is older than {from}"),
        _ => format!("MineUI cannot tell whether Minecraft {to} is older than {from}"),
    };
    Err(Error::InvalidInput(format!(
        "{why}. A world saved by a newer version usually cannot be opened by an older \
         one; set allowDowngrade to change the version anyway (a backup is made first)"
    )))
}

/// §3.6 step 7: the new `mineui-instance.json`, keeping `createdAt`.
pub fn rewritten_meta(
    old: &InstanceMeta,
    mc_version: &str,
    jar_sha1: &str,
    required_java_major: Option<u32>,
) -> InstanceMeta {
    InstanceMeta {
        mc_version: mc_version.to_string(),
        jar_sha1: jar_sha1.to_string(),
        required_java_major,
        created_at: old.created_at.clone(),
    }
}

async fn change_version_inner(
    core: &crate::Core,
    mc_version: &str,
    allow_downgrade: bool,
) -> Result<ChangedInstanceVersion> {
    // 1. Mode, instance, stopped.
    ensure_simple_mode(core).await?;
    let dir = core.settings().await.simple.instance_dir.clone();
    let meta_path = dir.join(META_FILE);
    if !meta_path.is_file() {
        return Err(Error::InstanceNotFound(format!(
            "no MineUI instance at {}",
            dir.display()
        )));
    }
    let Some(old_meta) = read_meta(&dir).await else {
        return Err(Error::InstanceNotFound(format!(
            "{META_FILE} at {} is unreadable",
            dir.display()
        )));
    };
    if core.supervisor.is_active() {
        return Err(Error::ServerRunning(
            "stop the server before changing its Minecraft version".into(),
        ));
    }

    // 2. Target: different, known, with a server download.
    let target = mc_version.trim();
    if target.is_empty() {
        return Err(Error::InvalidInput("mcVersion must not be empty".into()));
    }
    let from = old_meta.mc_version.clone();
    ensure_different_version(&from, target)?;
    let detail = crate::mojang::version_detail(core, target).await?;
    let server =
        detail.downloads.server.clone().ok_or_else(|| {
            Error::InvalidInput(format!("version {target} has no server download"))
        })?;
    let required_major = detail.java_version.as_ref().map(|j| j.major_version);

    // 3. Direction.
    let direction = version_direction(
        crate::mojang::cached_release_time(core, &from)
            .await
            .as_deref(),
        crate::mojang::cached_release_time(core, target)
            .await
            .as_deref(),
    );
    ensure_direction_allowed(&from, target, direction, allow_downgrade)?;

    // 4. Java.
    let java_path = core.settings().await.simple.java_path.clone();
    let java = crate::java::check(java_path.as_deref(), required_major).await?;
    if !java.found {
        return Err(Error::JavaNotFound(
            "no java binary found on PATH or JAVA_HOME; install a JRE/JDK first".into(),
        ));
    }
    if java.compatible == Some(false) {
        return Err(Error::JavaIncompatible(format!(
            "Minecraft {target} requires Java {}+ but {} was found",
            required_major.unwrap_or(0),
            java.version.as_deref().unwrap_or("unknown")
        )));
    }

    // 5. New jar next to the old one, sha1-verified.
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let temp_jar = dir.join(format!("server.jar.{}.download", &suffix[..12]));
    let jar_sha1 = match crate::mojang::download_server_jar(core, &server, &temp_jar).await {
        Ok(sha1) => sha1,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_jar).await;
            return Err(e);
        }
    };

    // 6. Safety backup when there is a world; a failed backup aborts.
    let (backup, pruned) = if dir.join("world").is_dir() {
        match crate::backups::create(core).await {
            Ok(created) => (Some(created.entry.filename), created.pruned),
            Err(e) => {
                let _ = tokio::fs::remove_file(&temp_jar).await;
                return Err(e);
            }
        }
    } else {
        (None, Vec::new())
    };

    // 7. Swap jar, rewrite meta, persist the version.
    if let Err(e) = tokio::fs::rename(&temp_jar, dir.join("server.jar")).await {
        let _ = tokio::fs::remove_file(&temp_jar).await;
        return Err(Error::Io(format!("failed to replace server.jar: {e}")));
    }
    let meta = rewritten_meta(&old_meta, target, &jar_sha1, required_major);
    let json = serde_json::to_string_pretty(&meta)
        .map_err(|e| Error::Internal(format!("failed to serialize instance meta: {e}")))?;
    crate::util::write_atomic_bytes(&meta_path, json.as_bytes()).await?;
    let mut settings = core.settings().await;
    settings.simple.mc_version = target.to_string();
    core.update_settings(settings).await?;

    Ok(ChangedInstanceVersion {
        status: probe(core).await?,
        from_version: from,
        to_version: target.to_string(),
        backup,
        pruned,
    })
}

/* ---------- audited entry points (§3.11) ---------- */

/// `change_instance_version` (§3.6), audited as `instance.change-version`
/// (target = "<from> → <to>", detail = the safety backup filename).
pub async fn change_version(
    core: &crate::Core,
    mc_version: &str,
    allow_downgrade: bool,
) -> Result<ChangedInstanceVersion> {
    let r = change_version_inner(core, mc_version, allow_downgrade).await;
    let from = match &r {
        Ok(changed) => changed.from_version.clone(),
        Err(_) => {
            let dir = core.settings().await.simple.instance_dir.clone();
            read_meta(&dir)
                .await
                .map(|m| m.mc_version)
                .unwrap_or_else(|| "?".into())
        }
    };
    let target = format!("{from} → {}", mc_version.trim());
    let detail = r.as_ref().ok().and_then(|c| c.backup.clone());
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        "instance.change-version",
        Some(&target),
        detail.as_deref(),
        r.as_ref().err(),
    )
    .await;
    r
}

/// `create_instance` (§3.6), audited as `instance.create` (target = version).
pub async fn create(core: &crate::Core, args: &CreateInstanceArgs) -> Result<InstanceStatus> {
    let r = create_inner(core, args).await;
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        "instance.create",
        Some(&args.mc_version),
        None,
        r.as_ref().err(),
    )
    .await;
    r
}

/// `delete_instance` (§3.6), audited as `instance.delete`.
pub async fn delete(core: &crate::Core, confirm: bool) -> Result<()> {
    let r = delete_inner(core, confirm).await;
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        "instance.delete",
        None,
        None,
        r.as_ref().err(),
    )
    .await;
    r
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
    fn direction_by_release_time() {
        let old = Some("2024-10-23T12:28:15+00:00");
        let new = Some("2024-12-03T10:12:57+00:00");
        assert_eq!(version_direction(old, new), VersionDirection::Upgrade);
        assert_eq!(version_direction(new, old), VersionDirection::Downgrade);
        // Different offsets, same ordering.
        assert_eq!(
            version_direction(
                Some("2024-12-03T10:00:00+02:00"),
                Some("2024-12-03T09:30:00+00:00")
            ),
            VersionDirection::Upgrade
        );
    }

    #[test]
    fn direction_unknown_when_a_time_is_missing_bad_or_equal() {
        let t = Some("2024-12-03T10:12:57+00:00");
        assert_eq!(version_direction(None, t), VersionDirection::Unknown);
        assert_eq!(version_direction(t, None), VersionDirection::Unknown);
        assert_eq!(
            version_direction(Some("yesterday"), t),
            VersionDirection::Unknown
        );
        assert_eq!(version_direction(t, t), VersionDirection::Unknown);
    }

    #[test]
    fn same_version_is_refused() {
        let err = ensure_different_version("1.21.4", "1.21.4").unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains("already on Minecraft 1.21.4"));
        assert!(ensure_different_version("1.21.3", "1.21.4").is_ok());
    }

    #[test]
    fn downgrade_and_unknown_need_allow_downgrade() {
        use VersionDirection::*;
        assert!(ensure_direction_allowed("1.21.3", "1.21.4", Upgrade, false).is_ok());
        assert!(ensure_direction_allowed("1.21.4", "1.21.3", Downgrade, true).is_ok());
        assert!(ensure_direction_allowed("1.21.4", "1.21.3", Unknown, true).is_ok());

        let down = ensure_direction_allowed("1.21.4", "1.21.3", Downgrade, false).unwrap_err();
        assert_eq!(down.code(), "INVALID_INPUT");
        let msg = down.to_string();
        assert!(msg.contains("1.21.3 is older than 1.21.4"), "{msg}");
        assert!(msg.contains("cannot be opened by an older"), "{msg}");
        assert!(msg.contains("allowDowngrade"), "{msg}");

        let unknown = ensure_direction_allowed("1.21.4", "1.21.3", Unknown, false).unwrap_err();
        assert_eq!(unknown.code(), "INVALID_INPUT");
        assert!(unknown.to_string().contains("cannot tell"));
        assert!(unknown.to_string().contains("allowDowngrade"));
    }

    #[test]
    fn rewritten_meta_keeps_created_at() {
        let old = InstanceMeta {
            mc_version: "1.21.3".into(),
            jar_sha1: "old".into(),
            required_java_major: Some(17),
            created_at: "2026-01-02T03:04:05Z".into(),
        };
        let new = rewritten_meta(&old, "1.21.4", "new", Some(21));
        assert_eq!(new.mc_version, "1.21.4");
        assert_eq!(new.jar_sha1, "new");
        assert_eq!(new.required_java_major, Some(21));
        assert_eq!(new.created_at, "2026-01-02T03:04:05Z");
    }

    #[tokio::test]
    async fn change_version_refusals_before_any_network() {
        use crate::settings::{Mode, Settings};
        let tmp = tempfile::tempdir().unwrap();
        let mut settings = Settings::default_with_data_dir(&tmp.path().join("data"));
        settings.active_mode = Mode::Advanced;
        let core = crate::Core::init_with_settings(
            tmp.path().join("config"),
            tmp.path().join("data"),
            settings.clone(),
        )
        .await;
        let err = change_version(&core, "1.21.4", false).await.unwrap_err();
        assert_eq!(err.code(), "WRONG_MODE");

        settings.active_mode = Mode::Simple;
        core.update_settings(settings).await.unwrap();
        let err = change_version(&core, "1.21.4", false).await.unwrap_err();
        assert_eq!(err.code(), "INSTANCE_NOT_FOUND");

        let dir = core.settings().await.simple.instance_dir.clone();
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let meta = InstanceMeta {
            mc_version: "1.21.4".into(),
            jar_sha1: "abc".into(),
            required_java_major: Some(21),
            created_at: "2026-01-02T03:04:05Z".into(),
        };
        tokio::fs::write(dir.join(META_FILE), serde_json::to_vec(&meta).unwrap())
            .await
            .unwrap();
        let err = change_version(&core, " 1.21.4 ", false).await.unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains("already on"));

        let log = crate::audit::recent(&core, Some(10)).await.unwrap();
        let entry = log
            .entries
            .iter()
            .find(|e| e.action == "instance.change-version")
            .expect("audited");
        assert!(!entry.ok);
        assert_eq!(entry.target.as_deref(), Some("1.21.4 → 1.21.4"));
    }

    #[test]
    fn changed_instance_version_wire_shape() {
        let v = serde_json::to_value(ChangedInstanceVersion {
            status: InstanceStatus {
                exists: true,
                instance_dir: "/x".into(),
                mc_version: Some("1.21.4".into()),
                required_java_major: Some(21),
                jar_sha1: Some("abc".into()),
                eula_accepted: true,
                rcon_configured: true,
                world_exists: true,
                created_at: None,
            },
            from_version: "1.21.3".into(),
            to_version: "1.21.4".into(),
            backup: None,
            pruned: vec![],
        })
        .unwrap();
        assert_eq!(v["fromVersion"], "1.21.3");
        assert_eq!(v["toVersion"], "1.21.4");
        assert!(v["backup"].is_null());
        assert_eq!(v["status"]["mcVersion"], "1.21.4");
        assert!(v["pruned"].as_array().unwrap().is_empty());
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
