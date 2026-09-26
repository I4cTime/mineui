//! Settings schema v2: load/save/validate/migrate (contract §2).
//! Atomic write (tmp + rename) with unix permissions 0600.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::validate;

pub const SCHEMA_VERSION: u32 = 2;

pub const DEFAULT_RCON_ALLOWLIST: [&str; 12] = [
    "list",
    "whitelist",
    "op",
    "deop",
    "ban",
    "pardon",
    "banlist",
    "kick",
    "say",
    "save-all",
    "stop",
    "tps",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Simple,
    Advanced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Auto,
    Podman,
    Docker,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimpleModeSettings {
    pub instance_dir: PathBuf,
    pub mc_version: String,
    pub memory_mb: u32,
    pub java_path: Option<PathBuf>,
    pub eula_accepted: bool,
    pub server_port: u16,
    pub rcon_port: u16,
    pub rcon_password: String,
}

impl Default for SimpleModeSettings {
    fn default() -> Self {
        SimpleModeSettings {
            instance_dir: PathBuf::new(), // filled from data_dir at load
            mc_version: String::new(),
            memory_mb: 2048,
            java_path: None,
            eula_accepted: false,
            server_port: 25565,
            rcon_port: 25575,
            rcon_password: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AdvancedModeSettings {
    pub runtime: RuntimeKind,
    pub socket_path: Option<String>,
    pub runtime_binary: Option<PathBuf>,
    pub container_name: String,
    pub query_host: String,
    pub query_port: u16,
    pub rcon_host: String,
    pub rcon_port: u16,
    pub rcon_password: String,
    pub world_dir: String,
    pub server_utils_url: Option<String>,
}

impl Default for AdvancedModeSettings {
    fn default() -> Self {
        AdvancedModeSettings {
            runtime: RuntimeKind::Auto,
            socket_path: None,
            runtime_binary: None,
            container_name: "minecraft-server".into(),
            query_host: "127.0.0.1".into(),
            query_port: 25565,
            rcon_host: "127.0.0.1".into(),
            rcon_port: 25575,
            rcon_password: String::new(),
            world_dir: "world".into(),
            server_utils_url: None,
        }
    }
}

/* ---------- 2.5.0: scheduler + backup policy (contract §2.1) ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Weekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

impl From<Weekday> for chrono::Weekday {
    fn from(w: Weekday) -> Self {
        match w {
            Weekday::Monday => chrono::Weekday::Mon,
            Weekday::Tuesday => chrono::Weekday::Tue,
            Weekday::Wednesday => chrono::Weekday::Wed,
            Weekday::Thursday => chrono::Weekday::Thu,
            Weekday::Friday => chrono::Weekday::Fri,
            Weekday::Saturday => chrono::Weekday::Sat,
            Weekday::Sunday => chrono::Weekday::Sun,
        }
    }
}

/// When a job fires. Times are local wall-clock `"HH:MM"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Schedule {
    #[serde(rename_all = "camelCase")]
    Interval {
        every_hours: u32,
    },
    Daily {
        time: String,
    },
    Weekly {
        weekday: Weekday,
        time: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledJobKind {
    Restart,
    Backup,
    Broadcast,
}

impl ScheduledJobKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScheduledJobKind::Restart => "restart",
            ScheduledJobKind::Backup => "backup",
            ScheduledJobKind::Broadcast => "broadcast",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    pub id: String,
    pub kind: ScheduledJobKind,
    pub enabled: bool,
    pub schedule: Schedule,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SchedulerSettings {
    pub enabled: bool,
    pub jobs: Vec<ScheduledJob>,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        SchedulerSettings {
            enabled: true,
            jobs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSettings {
    /// Newest snapshots kept after each backup; 0 = unlimited.
    pub keep_last: u32,
    /// Absolute host directory receiving a copy of every new snapshot.
    pub copy_dir: Option<PathBuf>,
}

impl Default for BackupSettings {
    fn default() -> Self {
        BackupSettings {
            keep_last: 10,
            copy_dir: None,
        }
    }
}

pub const MAX_SCHEDULED_JOBS: usize = 32;
pub const MAX_JOB_MESSAGE_CHARS: usize = 200;
pub const MAX_KEEP_LAST: u32 = 1000;

/// `"HH:MM"` (24 h) → (hour, minute).
pub fn parse_hhmm(time: &str) -> Option<(u32, u32)> {
    let (h, m) = time.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    (h < 24 && m < 60).then_some((h, m))
}

fn is_valid_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_valid_message(msg: &str) -> bool {
    !msg.is_empty()
        && msg.chars().count() <= MAX_JOB_MESSAGE_CHARS
        && !msg.chars().any(char::is_control)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub active_mode: Mode,
    pub rcon_allowlist: Vec<String>,
    /// §6.3 rule 5 escape hatch: when true, `download_mod` may fetch from
    /// loopback/private/LAN hosts (homelab use). Default false = SSRF
    /// hardening on. Serde `default` on the struct means pre-existing v2
    /// files without the field load as false and are rewritten with it.
    pub allow_private_download_hosts: bool,
    pub simple: SimpleModeSettings,
    pub advanced: AdvancedModeSettings,
    /// 2.5.0 (contract §2.1, §3.10). Serde default: older files load with
    /// an empty, enabled scheduler and are rewritten with the field.
    pub scheduler: SchedulerSettings,
    /// 2.5.0 (contract §2.1, §3.8): retention + off-box copy policy.
    pub backups: BackupSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema_version: SCHEMA_VERSION,
            active_mode: Mode::Simple,
            rcon_allowlist: DEFAULT_RCON_ALLOWLIST
                .iter()
                .map(|s| s.to_string())
                .collect(),
            allow_private_download_hosts: false,
            simple: SimpleModeSettings::default(),
            advanced: AdvancedModeSettings::default(),
            scheduler: SchedulerSettings::default(),
            backups: BackupSettings::default(),
        }
    }
}

impl Settings {
    pub fn default_with_data_dir(data_dir: &Path) -> Self {
        let mut s = Settings::default();
        s.simple.instance_dir = data_dir.join("instances").join("default");
        s
    }
}

fn settings_file(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// Load settings from `<config_dir>/settings.json`, migrating/importing as needed.
/// Missing file: attempts a best-effort v1 import from `./.cursor/mineui-settings.json`
/// (process cwd), else defaults. The result is persisted back to disk.
pub async fn load(config_dir: &Path, data_dir: &Path) -> Result<Settings> {
    let file = settings_file(config_dir);
    let settings = match tokio::fs::read_to_string(&file).await {
        Ok(raw) => {
            let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
                Error::SettingsInvalid(format!("settings.json is not valid JSON: {e}"))
            })?;
            let version = value
                .get("schemaVersion")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            if version > SCHEMA_VERSION {
                return Err(Error::SettingsInvalid(format!(
                    "settings.json has unknown future schemaVersion {version}"
                )));
            }
            // version == 2: parse directly; version < 2 / missing: fill defaults
            // for missing fields, stamp schemaVersion 2 and rewrite (migration).
            let mut parsed: Settings = serde_json::from_value(value)
                .map_err(|e| Error::SettingsInvalid(format!("settings.json invalid: {e}")))?;
            parsed.schema_version = SCHEMA_VERSION;
            parsed
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match import_v1(data_dir).await {
            Some(imported) => imported,
            None => Settings::default_with_data_dir(data_dir),
        },
        Err(e) => return Err(Error::Io(format!("failed to read settings.json: {e}"))),
    };

    let mut settings = settings;
    if settings.simple.instance_dir.as_os_str().is_empty() {
        settings.simple.instance_dir = data_dir.join("instances").join("default");
    }
    normalize(&mut settings);
    // Persist (creates the file on first run, rewrites after migration).
    write_atomic(config_dir, &settings).await?;
    Ok(settings)
}

/// Validate + normalize + persist atomically. Returns the normalized settings.
pub async fn save(config_dir: &Path, mut settings: Settings) -> Result<Settings> {
    settings.schema_version = SCHEMA_VERSION;
    normalize(&mut settings);
    validate_settings(&settings)?;
    write_atomic(config_dir, &settings).await?;
    Ok(settings)
}

fn normalize(settings: &mut Settings) {
    for job in &mut settings.scheduler.jobs {
        job.id = job.id.trim().to_string();
        job.message = job
            .message
            .as_ref()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        if job.kind == ScheduledJobKind::Backup {
            job.message = None;
        }
    }
    settings.backups.copy_dir = settings
        .backups
        .copy_dir
        .as_ref()
        .filter(|p| !p.as_os_str().is_empty())
        .cloned();
    settings.rcon_allowlist = settings
        .rcon_allowlist
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(url) = &settings.advanced.server_utils_url {
        let trimmed = url.trim().trim_end_matches('/').to_string();
        settings.advanced.server_utils_url = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
}

/// Contract §2.3 validation. Error code SETTINGS_INVALID.
pub fn validate_settings(s: &Settings) -> Result<()> {
    let inv = |msg: &str| Err(Error::SettingsInvalid(msg.to_string()));

    if s.simple.server_port == 0 || s.simple.rcon_port == 0 {
        return inv("simple ports must be in 1-65535");
    }
    if s.simple.server_port == s.simple.rcon_port {
        return inv("simple.serverPort must differ from simple.rconPort");
    }
    if s.advanced.query_port == 0 || s.advanced.rcon_port == 0 {
        return inv("advanced ports must be in 1-65535");
    }
    if s.simple.memory_mb < 512 {
        return inv("simple.memoryMb must be >= 512");
    }
    if !validate::is_valid_container_name(&s.advanced.container_name) {
        return inv("advanced.containerName must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$");
    }
    if !validate::is_single_path_segment(&s.advanced.world_dir) {
        return inv("advanced.worldDir must be a single path segment");
    }
    if let Some(url) = &s.advanced.server_utils_url {
        let parsed = reqwest::Url::parse(url).map_err(|_| {
            Error::SettingsInvalid("advanced.serverUtilsUrl is not a valid URL".into())
        })?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return inv("advanced.serverUtilsUrl scheme must be http or https");
        }
    }
    if !s.simple.instance_dir.is_absolute() {
        return inv("simple.instanceDir must be an absolute path");
    }
    for entry in &s.rcon_allowlist {
        if entry.is_empty() || entry.chars().any(|c| c.is_whitespace()) {
            return inv("rconAllowlist entries must be non-empty and contain no whitespace");
        }
    }
    validate_scheduler(&s.scheduler)?;
    if s.backups.keep_last > MAX_KEEP_LAST {
        return inv("backups.keepLast must be in 0-1000");
    }
    if let Some(dir) = &s.backups.copy_dir {
        if !dir.is_absolute() {
            return inv("backups.copyDir must be an absolute path");
        }
    }
    Ok(())
}

/// Contract §2.3 scheduler rules (2.5.0).
fn validate_scheduler(sched: &SchedulerSettings) -> Result<()> {
    let inv = |msg: String| Err(Error::SettingsInvalid(msg));
    if sched.jobs.len() > MAX_SCHEDULED_JOBS {
        return inv(format!(
            "scheduler.jobs may hold at most {MAX_SCHEDULED_JOBS} jobs"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for job in &sched.jobs {
        if !is_valid_job_id(&job.id) {
            return inv(format!(
                "scheduler job id '{}' must match ^[A-Za-z0-9-]{{1,64}}$",
                job.id
            ));
        }
        if !seen.insert(job.id.as_str()) {
            return inv(format!("scheduler job id '{}' is not unique", job.id));
        }
        match &job.schedule {
            Schedule::Interval { every_hours } => {
                if !(1..=168).contains(every_hours) {
                    return inv(format!("job '{}': everyHours must be in 1-168", job.id));
                }
            }
            Schedule::Daily { time } | Schedule::Weekly { time, .. } => {
                if parse_hhmm(time).is_none() {
                    return inv(format!("job '{}': time must be HH:MM (24 h)", job.id));
                }
            }
        }
        if let Some(msg) = &job.message {
            if !is_valid_message(msg) {
                return inv(format!(
                    "job '{}': message must be 1-{MAX_JOB_MESSAGE_CHARS} characters with no control characters",
                    job.id
                ));
            }
        }
        if job.kind == ScheduledJobKind::Broadcast && job.message.is_none() {
            return inv(format!("job '{}': broadcast jobs need a message", job.id));
        }
    }
    Ok(())
}

/// Atomic write: temp file in the same dir + rename, chmod 0600 on unix.
async fn write_atomic(config_dir: &Path, settings: &Settings) -> Result<()> {
    tokio::fs::create_dir_all(config_dir)
        .await
        .map_err(|e| Error::Io(format!("failed to create config dir: {e}")))?;
    let file = settings_file(config_dir);
    let tmp = config_dir.join(format!(
        ".settings.json.tmp-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| Error::Internal(format!("failed to serialize settings: {e}")))?;
    tokio::fs::write(&tmp, json.as_bytes())
        .await
        .map_err(|e| Error::Io(format!("failed to write settings temp file: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| Error::Io(format!("failed to chmod settings file: {e}")))?;
    }
    tokio::fs::rename(&tmp, &file)
        .await
        .map_err(|e| Error::Io(format!("failed to move settings file into place: {e}")))?;
    // Re-chmod the final path defensively (rename preserves perms, but be explicit).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}

/* ---------- v1 import (§2.4) ---------- */

#[derive(Debug, Deserialize)]
struct V1File {
    #[serde(rename = "MINECRAFT_CONTAINER_NAME")]
    container_name: Option<String>,
    #[serde(rename = "MINECRAFT_QUERY_HOST")]
    query_host: Option<String>,
    #[serde(rename = "MINECRAFT_QUERY_PORT")]
    query_port: Option<serde_json::Value>,
    #[serde(rename = "PODMAN_SOCKET")]
    podman_socket: Option<String>,
    #[serde(rename = "PODMAN_BINARY")]
    podman_binary: Option<String>,
    #[serde(rename = "MINECRAFT_WORLD_DIR")]
    world_dir: Option<String>,
    #[serde(rename = "MINECRAFT_RCON_HOST")]
    rcon_host: Option<String>,
    #[serde(rename = "MINECRAFT_RCON_PORT")]
    rcon_port: Option<serde_json::Value>,
    #[serde(rename = "MINECRAFT_RCON_PASSWORD")]
    rcon_password: Option<String>,
    #[serde(rename = "MINECRAFT_RCON_ALLOWLIST")]
    rcon_allowlist: Option<String>,
    #[serde(rename = "MINEUI_SERVER_UTILS_URL")]
    server_utils_url: Option<String>,
}

fn v1_port(value: &Option<serde_json::Value>) -> Option<u16> {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_u64().and_then(|v| u16::try_from(v).ok()),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u16>().ok(),
        _ => None,
    }
}

/// Best-effort one-time import of `./.cursor/mineui-settings.json` from the
/// process cwd. Unparseable/absent → None. The v1 file is never deleted.
async fn import_v1(data_dir: &Path) -> Option<Settings> {
    let cwd = std::env::current_dir().ok()?;
    let raw = tokio::fs::read_to_string(cwd.join(".cursor").join("mineui-settings.json"))
        .await
        .ok()?;
    let v1: V1File = serde_json::from_str(&raw).ok()?;

    let mut s = Settings::default_with_data_dir(data_dir);
    s.active_mode = Mode::Advanced;
    let adv = &mut s.advanced;
    if let Some(v) = v1.container_name {
        adv.container_name = v;
    }
    if let Some(v) = v1.query_host {
        adv.query_host = v;
    }
    if let Some(p) = v1_port(&v1.query_port) {
        adv.query_port = p;
    }
    if let Some(v) = v1.podman_socket {
        adv.socket_path = Some(v);
    }
    if let Some(v) = v1.podman_binary {
        adv.runtime_binary = Some(PathBuf::from(v));
        adv.runtime = RuntimeKind::Podman;
    }
    if let Some(v) = v1.world_dir {
        adv.world_dir = v;
    }
    if let Some(v) = v1.rcon_host {
        adv.rcon_host = v;
    }
    if let Some(p) = v1_port(&v1.rcon_port) {
        adv.rcon_port = p;
    }
    if let Some(v) = v1.rcon_password {
        adv.rcon_password = v;
    }
    if let Some(v) = v1.server_utils_url {
        let trimmed = v.trim().to_string();
        adv.server_utils_url = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    if let Some(v) = v1.rcon_allowlist {
        let list: Vec<String> = v
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        if !list.is_empty() {
            s.rcon_allowlist = list;
        }
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_settings(dir: &Path) -> Settings {
        Settings::default_with_data_dir(dir)
    }

    #[tokio::test]
    async fn roundtrip_save_load() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");

        let mut s = valid_settings(&data_dir);
        s.advanced.container_name = "mc-1".into();
        s.advanced.rcon_password = "hunter2hunter2".into();
        s.rcon_allowlist = vec!["LIST".into(), " say ".into(), "".into()];
        s.allow_private_download_hosts = true;

        let saved = save(&config_dir, s).await.unwrap();
        assert_eq!(saved.rcon_allowlist, vec!["list", "say"]);

        let loaded = load(&config_dir, &data_dir).await.unwrap();
        assert_eq!(loaded.schema_version, 2);
        assert_eq!(loaded.advanced.container_name, "mc-1");
        assert_eq!(loaded.advanced.rcon_password, "hunter2hunter2");
        assert_eq!(loaded.rcon_allowlist, vec!["list", "say"]);
        assert!(loaded.allow_private_download_hosts);
    }

    #[tokio::test]
    async fn wire_shape_is_camel_case_with_nulls() {
        let tmp = tempfile::tempdir().unwrap();
        let s = valid_settings(tmp.path());
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["schemaVersion"], 2);
        assert_eq!(v["activeMode"], "simple");
        assert_eq!(v["allowPrivateDownloadHosts"], false);
        assert!(v["simple"]["javaPath"].is_null());
        assert!(v["advanced"]["serverUtilsUrl"].is_null());
        assert!(v["advanced"]["socketPath"].is_null());
        assert_eq!(v["advanced"]["containerName"], "minecraft-server");
    }

    #[tokio::test]
    async fn migrates_versionless_file_to_v2() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("settings.json"),
            r#"{ "activeMode": "advanced", "advanced": { "containerName": "old-mc" } }"#,
        )
        .unwrap();
        let loaded = load(&config_dir, tmp.path()).await.unwrap();
        assert_eq!(loaded.schema_version, 2);
        assert_eq!(loaded.active_mode, Mode::Advanced);
        assert_eq!(loaded.advanced.container_name, "old-mc");
        // Field added post-v2-launch: absent in old files → default false.
        assert!(!loaded.allow_private_download_hosts);
        // rewritten to disk with schemaVersion 2
        let raw = std::fs::read_to_string(config_dir.join("settings.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["schemaVersion"], 2);
    }

    #[tokio::test]
    async fn future_schema_version_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("settings.json"),
            r#"{ "schemaVersion": 3 }"#,
        )
        .unwrap();
        let err = load(&config_dir, tmp.path()).await.unwrap_err();
        assert_eq!(err.code(), "SETTINGS_INVALID");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn settings_file_has_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        save(&config_dir, valid_settings(tmp.path())).await.unwrap();
        let mode = std::fs::metadata(config_dir.join("settings.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn validation_rejects_bad_values() {
        let tmp = tempfile::tempdir().unwrap();
        let base = valid_settings(tmp.path());

        let mut s = base.clone();
        s.simple.server_port = 25575;
        s.simple.rcon_port = 25575;
        assert_eq!(
            validate_settings(&s).unwrap_err().code(),
            "SETTINGS_INVALID"
        );

        let mut s = base.clone();
        s.simple.memory_mb = 256;
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.advanced.container_name = "-bad;name".into();
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.advanced.world_dir = "../etc".into();
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.advanced.world_dir = "a/b".into();
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.advanced.server_utils_url = Some("ftp://example.com".into());
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.simple.instance_dir = PathBuf::from("relative/dir");
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.rcon_allowlist = vec!["two words".into()];
        assert!(validate_settings(&s).is_err());

        assert!(validate_settings(&base).is_ok());
    }

    fn job(
        id: &str,
        kind: ScheduledJobKind,
        schedule: Schedule,
        message: Option<&str>,
    ) -> ScheduledJob {
        ScheduledJob {
            id: id.into(),
            kind,
            enabled: true,
            schedule,
            message: message.map(String::from),
        }
    }

    #[tokio::test]
    async fn scheduler_and_backup_fields_default_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("settings.json"),
            r#"{ "schemaVersion": 2, "activeMode": "simple" }"#,
        )
        .unwrap();
        let loaded = load(&config_dir, tmp.path()).await.unwrap();
        assert!(loaded.scheduler.enabled);
        assert!(loaded.scheduler.jobs.is_empty());
        assert_eq!(loaded.backups.keep_last, 10);
        assert!(loaded.backups.copy_dir.is_none());
        let v = serde_json::to_value(&loaded).unwrap();
        assert_eq!(v["scheduler"]["enabled"], true);
        assert_eq!(v["backups"]["keepLast"], 10);
        assert!(v["backups"]["copyDir"].is_null());
    }

    #[test]
    fn schedule_wire_shape_is_tagged_by_kind() {
        let daily = Schedule::Daily {
            time: "04:30".into(),
        };
        assert_eq!(
            serde_json::to_value(&daily).unwrap(),
            serde_json::json!({ "kind": "daily", "time": "04:30" })
        );
        let weekly = Schedule::Weekly {
            weekday: Weekday::Sunday,
            time: "03:00".into(),
        };
        assert_eq!(
            serde_json::to_value(&weekly).unwrap(),
            serde_json::json!({ "kind": "weekly", "weekday": "sunday", "time": "03:00" })
        );
        let interval: Schedule =
            serde_json::from_value(serde_json::json!({ "kind": "interval", "everyHours": 6 }))
                .unwrap();
        assert_eq!(interval, Schedule::Interval { every_hours: 6 });
    }

    #[test]
    fn scheduler_validation_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let base = valid_settings(tmp.path());
        let daily = || Schedule::Daily {
            time: "04:00".into(),
        };

        let mut s = base.clone();
        s.scheduler.jobs = vec![job("a", ScheduledJobKind::Backup, daily(), None)];
        assert!(validate_settings(&s).is_ok());

        let mut s = base.clone();
        s.scheduler.jobs = vec![job("bad id!", ScheduledJobKind::Backup, daily(), None)];
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.scheduler.jobs = vec![
            job("dup", ScheduledJobKind::Backup, daily(), None),
            job("dup", ScheduledJobKind::Restart, daily(), None),
        ];
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.scheduler.jobs = vec![job(
            "i",
            ScheduledJobKind::Restart,
            Schedule::Interval { every_hours: 0 },
            None,
        )];
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.scheduler.jobs = vec![job(
            "t",
            ScheduledJobKind::Restart,
            Schedule::Daily {
                time: "24:00".into(),
            },
            None,
        )];
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.scheduler.jobs = vec![job("b", ScheduledJobKind::Broadcast, daily(), None)];
        assert!(validate_settings(&s).is_err(), "broadcast needs a message");

        let mut s = base.clone();
        s.scheduler.jobs = vec![job(
            "b",
            ScheduledJobKind::Broadcast,
            daily(),
            Some("line1\nline2"),
        )];
        assert!(validate_settings(&s).is_err(), "control chars rejected");

        let mut s = base.clone();
        s.backups.keep_last = 5000;
        assert!(validate_settings(&s).is_err());

        let mut s = base.clone();
        s.backups.copy_dir = Some(PathBuf::from("relative/copies"));
        assert!(validate_settings(&s).is_err());
    }

    #[tokio::test]
    async fn normalize_trims_messages_and_clears_backup_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let mut s = valid_settings(tmp.path());
        s.scheduler.jobs = vec![
            job(
                " j1 ",
                ScheduledJobKind::Backup,
                Schedule::Daily {
                    time: "01:00".into(),
                },
                Some("ignored"),
            ),
            job(
                "j2",
                ScheduledJobKind::Restart,
                Schedule::Daily {
                    time: "01:00".into(),
                },
                Some("  "),
            ),
        ];
        s.backups.copy_dir = Some(PathBuf::new());
        let saved = save(&tmp.path().join("config"), s).await.unwrap();
        assert_eq!(saved.scheduler.jobs[0].id, "j1");
        assert!(saved.scheduler.jobs[0].message.is_none());
        assert!(saved.scheduler.jobs[1].message.is_none());
        assert!(saved.backups.copy_dir.is_none());
    }

    #[test]
    fn hhmm_parsing() {
        assert_eq!(parse_hhmm("00:00"), Some((0, 0)));
        assert_eq!(parse_hhmm("23:59"), Some((23, 59)));
        assert_eq!(parse_hhmm("7:30"), None);
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("noon"), None);
    }

    #[test]
    fn v1_port_parses_strings_and_numbers() {
        assert_eq!(v1_port(&Some(serde_json::json!(25565))), Some(25565));
        assert_eq!(v1_port(&Some(serde_json::json!("25566"))), Some(25566));
        assert_eq!(v1_port(&Some(serde_json::json!("nope"))), None);
        assert_eq!(v1_port(&None), None);
    }
}
