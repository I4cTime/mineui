//! Shared wire types (contract §3, §4, §7). All structs serialize camelCase.

use serde::{Deserialize, Serialize};

use crate::settings::Mode;

/* ---------- §3.1 environment ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHit {
    pub binary: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProbe {
    pub podman: Option<RuntimeHit>,
    pub docker: Option<RuntimeHit>,
    /// What "auto" would pick right now: podman if present, else docker, else null.
    pub resolved: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaCheck {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub major_version: Option<u32>,
    pub required_major: Option<u32>,
    pub compatible: Option<bool>,
}

/* ---------- §3.2 server state / status ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServerPhase {
    NotCreated,
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetail {
    pub exists: bool,
    pub id: Option<String>,
    pub status: Option<String>,
    pub created_at: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetail {
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub last_exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerState {
    pub mode: Mode,
    pub phase: ServerPhase,
    pub container: Option<ContainerDetail>,
    pub process: Option<ProcessDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleName {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPlayers {
    pub online: u32,
    pub max: u32,
    pub sample: Vec<SampleName>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub online: bool,
    pub version: Option<String>,
    pub motd: Option<String>,
    pub players: StatusPlayers,
    pub ping_ms: Option<u64>,
    /// "query" | "server-utils" | "none"
    pub source: String,
    pub error: Option<String>,
}

impl ServerStatus {
    pub fn offline(error: String) -> Self {
        ServerStatus {
            online: false,
            version: None,
            motd: None,
            players: StatusPlayers {
                online: 0,
                max: 0,
                sample: Vec::new(),
            },
            ping_ms: None,
            source: "none".into(),
            error: Some(error),
        }
    }
}

/* ---------- §3.4 players ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayersResult {
    pub players: Vec<String>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerHistoryRow {
    pub username: String,
    pub last_seen_epoch_ms: Option<i64>,
    pub ip_address: Option<String>,
    pub is_online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerHistory {
    pub users: Vec<PlayerHistoryRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RconOutput {
    pub output: String,
}

/* ---------- §3.5 mods ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModTarget {
    Mods,
    Plugins,
}

impl ModTarget {
    pub fn dir_name(&self) -> &'static str {
        match self {
            ModTarget::Mods => "mods",
            ModTarget::Plugins => "plugins",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModLoader {
    Forge,
    Neoforge,
    Fabric,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    pub name: String,
    pub filename: String,
    pub size_bytes: u64,
    pub updated_at_epoch_ms: i64,
    pub loader: ModLoader,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModsList {
    pub mods: Vec<ModEntry>,
    pub plugins: Vec<ModEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedMod {
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedMod {
    pub filename: String,
    pub download_id: String,
}

/// Result of `unpack_mod_archive` (§3.5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpackedMods {
    pub installed: Vec<String>,
    pub skipped: usize,
    pub download_id: Option<String>,
}

/* ---------- §3.6 instance ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McVersion {
    pub id: String,
    /// "release" | "snapshot" | "old_beta" | "old_alpha"
    #[serde(rename = "type")]
    pub version_type: String,
    pub release_time: String,
    pub latest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstanceArgs {
    pub mc_version: String,
    pub accept_eula: bool,
    #[serde(default)]
    pub memory_mb: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatus {
    pub exists: bool,
    pub instance_dir: String,
    pub mc_version: Option<String>,
    pub required_java_major: Option<u32>,
    pub jar_sha1: Option<String>,
    pub eula_accepted: bool,
    pub rcon_configured: bool,
    pub world_exists: bool,
    pub created_at: Option<String>,
}

/// On-disk `mineui-instance.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMeta {
    pub mc_version: String,
    pub jar_sha1: String,
    pub required_java_major: Option<u32>,
    pub created_at: String,
}

/* ---------- §3.7 config files ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileList {
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileContent {
    pub content: String,
}

/* ---------- §3.8 backups ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub filename: String,
    pub size_bytes: u64,
    pub created_at_epoch_ms: i64,
}

/* ---------- §3.9 metrics ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IoPair {
    pub input_bytes: Option<u64>,
    pub output_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemStats {
    pub used_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub used_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tps {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mspt {
    pub one: Option<f64>,
    pub five: Option<f64>,
    pub fifteen: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionStats {
    pub chunks: Option<i64>,
    pub entities: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsPlayers {
    pub online: Option<u32>,
    pub max: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    /// "container" (advanced runtime stats) or "process" (simple sysinfo).
    pub base: String,
    pub enriched: bool,
    pub cpu_percent: Option<f64>,
    pub mem: MemStats,
    pub net: Option<IoPair>,
    pub block: Option<IoPair>,
    pub disk: Option<DiskStats>,
    pub started_at: Option<String>,
    pub uptime_seconds: Option<i64>,
    pub tps: Option<Tps>,
    pub mspt: Option<Mspt>,
    pub chunks: Option<i64>,
    pub entities: Option<i64>,
    pub dimensions: Option<std::collections::HashMap<String, DimensionStats>>,
    pub players: Option<MetricsPlayers>,
}

impl Metrics {
    pub fn empty(base: &str) -> Self {
        Metrics {
            base: base.into(),
            enriched: false,
            cpu_percent: None,
            mem: MemStats {
                used_bytes: None,
                total_bytes: None,
                percent: None,
            },
            net: None,
            block: None,
            disk: None,
            started_at: None,
            uptime_seconds: None,
            tps: None,
            mspt: None,
            chunks: None,
            entities: None,
            dimensions: None,
            players: None,
        }
    }
}

/* ---------- §3.3 logs ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsTail {
    pub lines: Vec<String>,
}

/* ---------- §4 events ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    Stdout,
    Stderr,
    Runtime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub text: String,
    pub epoch_ms: i64,
    pub source: LogSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsEvent {
    pub lines: Vec<LogLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStateEvent {
    pub mode: Mode,
    pub phase: ServerPhase,
    pub previous_phase: ServerPhase,
    pub epoch_ms: i64,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadKind {
    ServerJar,
    Mod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadErrorShape {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub download_id: String,
    pub kind: DownloadKind,
    pub filename: String,
    pub url: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub done: bool,
    pub error: Option<DownloadErrorShape>,
}

/* ---------- §3.10 scheduler ---------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobRunResult {
    pub epoch_ms: i64,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJobStatus {
    pub id: String,
    pub next_run_epoch_ms: Option<i64>,
    pub last_run: Option<JobRunResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
    pub enabled: bool,
    pub jobs: Vec<ScheduledJobStatus>,
}

/* ---------- §3.11 player notes & audit log ---------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerNote {
    pub username: String,
    pub note: String,
    pub updated_at_epoch_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerNotes {
    pub notes: Vec<PlayerNote>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditSource {
    User,
    Scheduler,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub epoch_ms: i64,
    pub source: AuditSource,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLog {
    pub entries: Vec<AuditEntry>,
}

/* ---------- §2.5 / §3.12 server profiles ---------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerList {
    pub active_server_id: String,
    pub servers: Vec<ServerProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOverview {
    pub id: String,
    pub name: String,
    pub mode: Mode,
    /// None when the phase probe failed (see `error`).
    pub phase: Option<ServerPhase>,
    pub status: ServerStatus,
    pub error: Option<String>,
    pub container_name: Option<String>,
    pub address: String,
    pub loader: Option<String>,
    pub mc_version: Option<String>,
    pub modpack: Option<String>,
}

/* ---------- §3.13 container creation ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerLoader {
    Vanilla,
    Fabric,
    Forge,
    Neoforge,
    Paper,
    Quilt,
    Purpur,
}

impl ContainerLoader {
    /// The image's `TYPE` value.
    pub fn itzg_type(&self) -> &'static str {
        match self {
            ContainerLoader::Vanilla => "VANILLA",
            ContainerLoader::Fabric => "FABRIC",
            ContainerLoader::Forge => "FORGE",
            ContainerLoader::Neoforge => "NEOFORGE",
            ContainerLoader::Paper => "PAPER",
            ContainerLoader::Quilt => "QUILT",
            ContainerLoader::Purpur => "PURPUR",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateContainerArgs {
    pub loader: ContainerLoader,
    pub mc_version: String,
    pub container_name: String,
    pub memory_mb: u32,
    pub game_port: u16,
    pub rcon_port: u16,
    pub expose_to_network: bool,
    pub accept_eula: bool,
    /// Create from a modpack instead of a bare loader (2.7.0).
    #[serde(default)]
    pub modpack: Option<ModpackRef>,
}

/// Result of `delete_container` (§3.13).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedContainer {
    pub container_name: String,
    /// The named volume deleted with it, if any.
    pub deleted_volume: Option<String>,
    /// Why the data was left in place although deletion was asked for.
    pub data_kept: Option<String>,
}

/* ---------- §3.13 / §3.14 modpacks ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModpackSource {
    Modrinth,
    Curseforge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackRef {
    pub source: ModpackSource,
    pub project: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackHit {
    pub source: ModpackSource,
    pub slug: String,
    pub id: String,
    pub title: String,
    pub description: String,
    pub author: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
}

/// Core-side event bus payload; the Tauri layer forwards each variant to its
/// channel name (`mineui://logs`, `mineui://server-state`, `mineui://download-progress`).
#[derive(Debug, Clone)]
pub enum CoreEvent {
    Logs(LogsEvent),
    ServerState(ServerStateEvent),
    DownloadProgress(DownloadProgressEvent),
}

/// A `CoreEvent` tagged with the server profile it came from (§4): what the
/// hub's event bus carries.
#[derive(Debug, Clone)]
pub struct HubEvent {
    pub server_id: String,
    pub event: CoreEvent,
}

/// Wire shape of every §4 event: the payload's own fields plus `serverId`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerScoped<T: Serialize> {
    pub server_id: String,
    #[serde(flatten)]
    pub payload: T,
}

pub const EVENT_LOGS: &str = "mineui://logs";
pub const EVENT_SERVER_STATE: &str = "mineui://server-state";
pub const EVENT_DOWNLOAD_PROGRESS: &str = "mineui://download-progress";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_phase_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ServerPhase::NotCreated).unwrap(),
            "\"not-created\""
        );
        assert_eq!(
            serde_json::to_string(&ServerPhase::Running).unwrap(),
            "\"running\""
        );
    }

    #[test]
    fn server_scoped_flattens_payload_next_to_server_id() {
        let scoped = ServerScoped {
            server_id: "a1b2c3d4".into(),
            payload: ServerStateEvent {
                mode: Mode::Advanced,
                phase: ServerPhase::Running,
                previous_phase: ServerPhase::Stopped,
                epoch_ms: 7,
                exit_code: None,
            },
        };
        let v = serde_json::to_value(&scoped).unwrap();
        assert_eq!(v["serverId"], "a1b2c3d4");
        assert_eq!(v["phase"], "running");
        assert_eq!(v["previousPhase"], "stopped");
        assert!(v.get("payload").is_none());
    }

    #[test]
    fn download_kind_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&DownloadKind::ServerJar).unwrap(),
            "\"server-jar\""
        );
    }

    #[test]
    fn mod_entry_wire_shape_is_camel_case() {
        let entry = ModEntry {
            name: "Fabric API".into(),
            filename: "fabric-api-1.0.jar".into(),
            size_bytes: 10,
            updated_at_epoch_ms: 1000,
            loader: ModLoader::Fabric,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v.get("sizeBytes").is_some());
        assert!(v.get("updatedAtEpochMs").is_some());
        assert_eq!(v.get("loader").unwrap(), "fabric");
    }
}
