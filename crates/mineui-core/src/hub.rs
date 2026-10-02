//! Server profiles (contract §2.5, §3.12): MineUI manages several independent
//! servers at once. A [`Core`] *is* one profile; the [`Hub`] owns the profile
//! list (`servers.json`), one live `Core` per profile, and a single event bus
//! that tags every core event with the profile it came from (§4).
//!
//! The `default` profile keeps the pre-2.6.0 paths (`<config>/settings.json`,
//! `<data>/`), so an existing install upgrades without moving a file. Every
//! other profile lives under `servers/<id>/` in both dirs.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::error::{Error, Result};
use crate::model::{
    AuditSource, HubEvent, ServerList, ServerOverview, ServerProfile, ServerStatus,
};
use crate::settings::Mode;
use crate::{Core, Paths};

pub const DEFAULT_SERVER_ID: &str = "default";
pub const DEFAULT_SERVER_NAME: &str = "Default";
pub const INDEX_SCHEMA_VERSION: u32 = 1;
pub const MAX_SERVERS: usize = 16;
pub const MAX_NAME_CHARS: usize = 40;

const INDEX_FILE: &str = "servers.json";
const SERVERS_DIR: &str = "servers";
const BASE_GAME_PORT: u16 = 25565;
const BASE_RCON_PORT: u16 = 25575;

/// On-disk `servers.json` (§2.5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ServerIndex {
    schema_version: u32,
    active_server_id: String,
    servers: Vec<ServerProfile>,
}

impl Default for ServerIndex {
    fn default() -> Self {
        ServerIndex {
            schema_version: INDEX_SCHEMA_VERSION,
            active_server_id: DEFAULT_SERVER_ID.into(),
            servers: vec![default_profile()],
        }
    }
}

impl ServerIndex {
    fn list(&self) -> ServerList {
        ServerList {
            active_server_id: self.active_server_id.clone(),
            servers: self.servers.clone(),
        }
    }

    fn name_of(&self, id: &str) -> Option<&str> {
        self.servers
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.as_str())
    }
}

fn default_profile() -> ServerProfile {
    ServerProfile {
        id: DEFAULT_SERVER_ID.into(),
        name: DEFAULT_SERVER_NAME.into(),
    }
}

/// Profile id grammar (§2.5): `^[a-z0-9][a-z0-9-]{0,31}$`. Ids become path
/// segments, so this is the traversal defense for `servers/<id>/`.
pub fn is_valid_server_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    id.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Display-name rules (§2.5): trimmed, 1–40 chars, no control characters.
fn normalize_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::InvalidInput("server name must not be empty".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::InvalidInput(format!(
            "server name must be at most {MAX_NAME_CHARS} characters"
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(Error::InvalidInput(
            "server name must not contain control characters".into(),
        ));
    }
    Ok(name.to_string())
}

fn ensure_unique_name(
    servers: &[ServerProfile],
    name: &str,
    except_id: Option<&str>,
) -> Result<()> {
    let wanted = name.to_lowercase();
    let taken = servers
        .iter()
        .filter(|p| Some(p.id.as_str()) != except_id)
        .any(|p| p.name.to_lowercase() == wanted);
    if taken {
        return Err(Error::InvalidInput(format!(
            "a server named '{name}' already exists"
        )));
    }
    Ok(())
}

/// §2.5 storage layout: `default` keeps the root dirs, everything else lives
/// under `servers/<id>/`.
fn profile_paths(root: &Paths, id: &str) -> Paths {
    if id == DEFAULT_SERVER_ID {
        return root.clone();
    }
    Paths {
        config_dir: root.config_dir.join(SERVERS_DIR).join(id),
        data_dir: root.data_dir.join(SERVERS_DIR).join(id),
    }
}

fn index_file(config_dir: &Path) -> PathBuf {
    config_dir.join(INDEX_FILE)
}

/// Validate a parsed index (§2.5): strict on ids (they are path segments),
/// self-healing on the two things a hand edit plausibly breaks — a missing
/// `default` profile and a dangling `activeServerId`.
fn normalize_index(mut index: ServerIndex) -> Result<ServerIndex> {
    let inv = |msg: String| Err(Error::SettingsInvalid(msg));
    let mut seen = HashSet::new();
    for profile in &mut index.servers {
        if !is_valid_server_id(&profile.id) {
            return inv(format!(
                "servers.json: invalid server id '{}' (expected ^[a-z0-9][a-z0-9-]{{0,31}}$)",
                profile.id
            ));
        }
        if !seen.insert(profile.id.clone()) {
            return inv(format!(
                "servers.json: duplicate server id '{}'",
                profile.id
            ));
        }
        profile.name = profile.name.trim().to_string();
        if profile.name.is_empty() {
            profile.name = profile.id.clone();
        }
    }
    if !seen.contains(DEFAULT_SERVER_ID) {
        index.servers.insert(0, default_profile());
    }
    if index.servers.len() > MAX_SERVERS {
        return inv(format!(
            "servers.json: at most {MAX_SERVERS} servers are supported"
        ));
    }
    if index.name_of(&index.active_server_id).is_none() {
        index.active_server_id = DEFAULT_SERVER_ID.into();
    }
    index.schema_version = INDEX_SCHEMA_VERSION;
    Ok(index)
}

async fn load_index(config_dir: &Path) -> Result<ServerIndex> {
    let raw = match tokio::fs::read_to_string(index_file(config_dir)).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ServerIndex::default()),
        Err(e) => return Err(Error::Io(format!("failed to read servers.json: {e}"))),
    };
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| Error::SettingsInvalid(format!("servers.json is not valid JSON: {e}")))?;
    let version = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    if version > INDEX_SCHEMA_VERSION {
        return Err(Error::SettingsInvalid(format!(
            "servers.json has unknown future schemaVersion {version}"
        )));
    }
    let parsed: ServerIndex = serde_json::from_value(value)
        .map_err(|e| Error::SettingsInvalid(format!("servers.json invalid: {e}")))?;
    normalize_index(parsed)
}

async fn write_index(config_dir: &Path, index: &ServerIndex) -> Result<()> {
    let json = serde_json::to_string_pretty(index)
        .map_err(|e| Error::Internal(format!("failed to serialize servers.json: {e}")))?;
    crate::util::write_atomic_bytes(&index_file(config_dir), json.as_bytes()).await
}

/// `add_server` port suggestion (§3.12): the first `25565+n` / `25575+n`
/// pair no existing profile uses.
pub fn suggest_ports(used: &HashSet<u16>) -> (u16, u16) {
    (0..1000u16)
        .map(|n| (BASE_GAME_PORT + n, BASE_RCON_PORT + n))
        .find(|(game, rcon)| !used.contains(game) && !used.contains(rcon))
        .unwrap_or((BASE_GAME_PORT, BASE_RCON_PORT))
}

fn mint_id(servers: &[ServerProfile]) -> String {
    loop {
        let id: String = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        if servers.iter().all(|p| p.id != id) {
            return id;
        }
    }
}

/// Tag every event of one core with its profile id and fan it into the hub
/// bus. Ends by itself once the core (and with it the sender) is dropped.
fn spawn_forwarder(server_id: String, core: &Core, hub_events: broadcast::Sender<HubEvent>) {
    let mut rx = core.subscribe_events();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let _ = hub_events.send(HubEvent {
                        server_id: server_id.clone(),
                        event,
                    });
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

struct Inner {
    index: ServerIndex,
    cores: HashMap<String, Arc<Core>>,
}

/// All server profiles of one app. One instance per app, wrapped in `Arc`.
pub struct Hub {
    root: Paths,
    inner: tokio::sync::RwLock<Inner>,
    /// Serializes list mutations (add/rename/remove/set_active), so `inner`
    /// is only ever write-locked for the in-memory swap.
    mutate: tokio::sync::Mutex<()>,
    events: broadcast::Sender<HubEvent>,
}

impl Hub {
    /// Load `servers.json` (absent = just `default`) and bring up one `Core`
    /// per profile. Must be called on a Tokio runtime.
    pub async fn init(config_dir: PathBuf, data_dir: PathBuf) -> Result<Arc<Hub>> {
        let root = Paths {
            config_dir,
            data_dir,
        };
        let index = load_index(&root.config_dir).await?;
        let (events, _keepalive) = broadcast::channel::<HubEvent>(1024);
        let mut cores = HashMap::new();
        for profile in &index.servers {
            let paths = profile_paths(&root, &profile.id);
            let core = Core::init(paths.config_dir, paths.data_dir).await?;
            spawn_forwarder(profile.id.clone(), &core, events.clone());
            cores.insert(profile.id.clone(), core);
        }
        write_index(&root.config_dir, &index).await?;
        Ok(Arc::new(Hub {
            root,
            inner: tokio::sync::RwLock::new(Inner { index, cores }),
            mutate: tokio::sync::Mutex::new(()),
            events,
        }))
    }

    /// Subscribe to every profile's events, tagged with the profile id (§4).
    pub fn subscribe_events(&self) -> broadcast::Receiver<HubEvent> {
        self.events.subscribe()
    }

    /// §3.0 targeting: the named profile's core, or the active one for `None`.
    pub async fn core(&self, server_id: Option<&str>) -> Result<Arc<Core>> {
        let inner = self.inner.read().await;
        let id = server_id.unwrap_or(&inner.index.active_server_id);
        inner
            .cores
            .get(id)
            .cloned()
            .ok_or_else(|| Error::ServerNotFound(format!("no server with id '{id}'")))
    }

    /// `list_servers` (§3.12).
    pub async fn list(&self) -> ServerList {
        self.inner.read().await.index.list()
    }

    /// Every profile with its core, in display order.
    async fn snapshot(&self) -> Vec<(ServerProfile, Arc<Core>)> {
        let inner = self.inner.read().await;
        inner
            .index
            .servers
            .iter()
            .filter_map(|p| inner.cores.get(&p.id).map(|c| (p.clone(), c.clone())))
            .collect()
    }

    async fn default_core(&self) -> Option<Arc<Core>> {
        self.inner
            .read()
            .await
            .cores
            .get(DEFAULT_SERVER_ID)
            .cloned()
    }

    /// Persist `index`, then swap it in.
    async fn commit_index(&self, index: ServerIndex) -> Result<ServerList> {
        write_index(&self.root.config_dir, &index).await?;
        let list = index.list();
        self.inner.write().await.index = index;
        Ok(list)
    }

    /// `add_server` (§3.12), audited as `server.add` (target = name).
    pub async fn add(&self, name: &str, mode: Option<Mode>) -> Result<ServerList> {
        let _guard = self.mutate.lock().await;
        let result = self.add_inner(name, mode).await;
        let target = Some(name.trim());
        match &result {
            Ok((_, core)) => {
                crate::audit::record(core, AuditSource::User, "server.add", target, None, None)
                    .await;
            }
            Err(e) => {
                if let Some(core) = self.default_core().await {
                    let err = Some(e);
                    crate::audit::record(&core, AuditSource::User, "server.add", target, None, err)
                        .await;
                }
            }
        }
        result.map(|(list, _)| list)
    }

    async fn add_inner(&self, name: &str, mode: Option<Mode>) -> Result<(ServerList, Arc<Core>)> {
        let name = normalize_name(name)?;
        let mut index = self.inner.read().await.index.clone();
        if index.servers.len() >= MAX_SERVERS {
            return Err(Error::InvalidInput(format!(
                "at most {MAX_SERVERS} servers are supported"
            )));
        }
        ensure_unique_name(&index.servers, &name, None)?;

        let mut used_ports = HashSet::new();
        for (_, core) in self.snapshot().await {
            let s = core.settings().await;
            used_ports.extend([
                s.simple.server_port,
                s.simple.rcon_port,
                s.advanced.query_port,
                s.advanced.rcon_port,
            ]);
        }
        let (game_port, rcon_port) = suggest_ports(&used_ports);

        let id = mint_id(&index.servers);
        let paths = profile_paths(&self.root, &id);
        let created = async {
            // Write the profile's settings first, so `Core::init` loads this
            // file instead of running first-run logic (the v1 import) for it.
            let mut settings = crate::Settings::default_with_data_dir(&paths.data_dir);
            settings.active_mode = mode.unwrap_or(Mode::Advanced);
            settings.simple.server_port = game_port;
            settings.simple.rcon_port = rcon_port;
            settings.advanced.query_port = game_port;
            settings.advanced.rcon_port = rcon_port;
            crate::settings::save(&paths.config_dir, settings).await?;
            let core = Core::init(paths.config_dir.clone(), paths.data_dir.clone()).await?;

            index.servers.push(ServerProfile {
                id: id.clone(),
                name,
            });
            write_index(&self.root.config_dir, &index).await?;
            Ok::<Arc<Core>, Error>(core)
        }
        .await;
        let core = match created {
            Ok(core) => core,
            Err(e) => {
                // Nothing references the half-made profile yet: drop its settings.
                let _ = tokio::fs::remove_dir_all(&paths.config_dir).await;
                return Err(e);
            }
        };

        spawn_forwarder(id.clone(), &core, self.events.clone());
        let list = index.list();
        let mut inner = self.inner.write().await;
        inner.cores.insert(id, core.clone());
        inner.index = index;
        Ok((list, core))
    }

    /// `rename_server` (§3.12), audited as `server.rename` (target = new name).
    pub async fn rename(&self, id: &str, name: &str) -> Result<ServerList> {
        let _guard = self.mutate.lock().await;
        let result = self.rename_inner(id, name).await;
        let core = match self.core(Some(id)).await {
            Ok(core) => Some(core),
            Err(_) => self.default_core().await,
        };
        if let Some(core) = core {
            crate::audit::record(
                &core,
                AuditSource::User,
                "server.rename",
                Some(name.trim()),
                None,
                result.as_ref().err(),
            )
            .await;
        }
        result
    }

    async fn rename_inner(&self, id: &str, name: &str) -> Result<ServerList> {
        let mut index = self.inner.read().await.index.clone();
        if index.name_of(id).is_none() {
            return Err(Error::ServerNotFound(format!("no server with id '{id}'")));
        }
        let name = normalize_name(name)?;
        ensure_unique_name(&index.servers, &name, Some(id))?;
        for profile in index.servers.iter_mut().filter(|p| p.id == id) {
            profile.name = name.clone();
        }
        self.commit_index(index).await
    }

    /// `remove_server` (§3.12), audited as `server.remove` in `default`'s
    /// log (target = the removed profile's name).
    pub async fn remove(&self, id: &str, confirm: bool) -> Result<ServerList> {
        let _guard = self.mutate.lock().await;
        let name = self.inner.read().await.index.name_of(id).map(String::from);
        let result = self.remove_inner(id, confirm).await;
        if let Some(core) = self.default_core().await {
            crate::audit::record(
                &core,
                AuditSource::User,
                "server.remove",
                Some(name.as_deref().unwrap_or(id)),
                None,
                result.as_ref().err(),
            )
            .await;
        }
        result
    }

    async fn remove_inner(&self, id: &str, confirm: bool) -> Result<ServerList> {
        if !confirm {
            return Err(Error::InvalidInput(
                "remove_server requires confirm: true".into(),
            ));
        }
        if id == DEFAULT_SERVER_ID {
            return Err(Error::InvalidInput(
                "the default server cannot be removed".into(),
            ));
        }
        let core = self.core(Some(id)).await?;
        if core.supervisor.is_active() {
            return Err(Error::ServerRunning(
                "stop the server before removing it".into(),
            ));
        }
        core.logs.shutdown().await;

        let mut index = self.inner.read().await.index.clone();
        index.servers.retain(|p| p.id != id);
        if index.active_server_id == id {
            index.active_server_id = DEFAULT_SERVER_ID.into();
        }
        write_index(&self.root.config_dir, &index).await?;
        let list = index.list();
        {
            let mut inner = self.inner.write().await;
            inner.cores.remove(id);
            inner.index = index;
        }
        // Settings only. The state dir (a simple-mode world lives there by
        // default) is deliberately left on disk (§3.12).
        let config_dir = profile_paths(&self.root, id).config_dir;
        if let Err(e) = tokio::fs::remove_dir_all(&config_dir).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("mineui: failed to delete {}: {e}", config_dir.display());
            }
        }
        Ok(list)
    }

    /// `set_active_server` (§3.12).
    pub async fn set_active(&self, id: &str) -> Result<ServerList> {
        let _guard = self.mutate.lock().await;
        let mut index = self.inner.read().await.index.clone();
        if index.name_of(id).is_none() {
            return Err(Error::ServerNotFound(format!("no server with id '{id}'")));
        }
        index.active_server_id = id.to_string();
        self.commit_index(index).await
    }

    /// `get_servers_overview` (§3.12): every profile probed concurrently. A
    /// per-profile fault lands in that entry's `error`, never in a rejection.
    pub async fn overview(&self) -> Vec<ServerOverview> {
        let probes: Vec<_> = self
            .snapshot()
            .await
            .into_iter()
            .map(|(profile, core)| {
                let task = tokio::spawn(async move {
                    let mode = core.settings().await.active_mode;
                    let ((phase, identity), status) =
                        tokio::join!(crate::identity::probe(&core), crate::status::get(&core));
                    (mode, phase, identity, status)
                });
                (profile, task)
            })
            .collect();

        let mut out = Vec::with_capacity(probes.len());
        for (profile, task) in probes {
            let Ok((mode, phase, identity, status)) = task.await else {
                continue; // probe task panicked; nothing truthful to report
            };
            let (phase, error) = match phase {
                Ok(phase) => (Some(phase), None),
                Err(e) => (None, Some(crate::audit::error_string(&e))),
            };
            out.push(ServerOverview {
                id: profile.id,
                name: profile.name,
                mode,
                phase,
                status: status.unwrap_or_else(|e| ServerStatus::offline(e.to_string())),
                error,
                container_name: identity.container_name,
                address: identity.address,
                loader: identity.loader,
                mc_version: identity.mc_version,
            });
        }
        out
    }

    /// §4.2 poll: advanced-mode phase-change detection for every profile.
    pub async fn poll_all(&self) {
        let tasks: Vec<_> = self
            .snapshot()
            .await
            .into_iter()
            .map(|(_, core)| {
                tokio::spawn(async move { crate::lifecycle::poll_advanced_state(&core).await })
            })
            .collect();
        for task in tasks {
            let _ = task.await;
        }
    }

    /// §3.10 tick: fire due scheduled jobs of every profile.
    pub async fn tick_all(&self) {
        for (_, core) in self.snapshot().await {
            crate::scheduler::tick(&core).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CoreEvent, ServerPhase, ServerStateEvent};

    async fn hub_in(tmp: &tempfile::TempDir) -> Arc<Hub> {
        Hub::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap()
    }

    #[test]
    fn server_id_grammar() {
        assert!(is_valid_server_id("default"));
        assert!(is_valid_server_id("a1b2c3d4"));
        assert!(is_valid_server_id("my-server-2"));
        assert!(!is_valid_server_id(""));
        assert!(!is_valid_server_id("-leading"));
        assert!(!is_valid_server_id("Upper"));
        assert!(!is_valid_server_id("../escape"));
        assert!(!is_valid_server_id("a/b"));
        assert!(!is_valid_server_id("dot.dot"));
        assert!(!is_valid_server_id(&"a".repeat(33)));
    }

    #[test]
    fn port_suggestion_skips_used_pairs() {
        let none = HashSet::new();
        assert_eq!(suggest_ports(&none), (25565, 25575));
        let one: HashSet<u16> = [25565, 25575].into();
        assert_eq!(suggest_ports(&one), (25566, 25576));
        // A game port that collides with someone's rcon port is skipped too.
        let crowded: HashSet<u16> = (25565..=25584).collect();
        assert_eq!(suggest_ports(&crowded), (25585, 25595));
    }

    #[tokio::test]
    async fn fresh_install_has_one_default_profile_on_the_root_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        let list = hub.list().await;
        assert_eq!(list.active_server_id, "default");
        assert_eq!(list.servers, vec![default_profile()]);

        // Pre-2.6.0 layout untouched: settings.json at the config root.
        assert!(tmp.path().join("config/settings.json").is_file());
        assert!(tmp.path().join("config/servers.json").is_file());
        assert!(!tmp.path().join("config/servers").exists());
        let core = hub.core(None).await.unwrap();
        assert_eq!(core.paths.data_dir, tmp.path().join("data"));
    }

    #[tokio::test]
    async fn existing_single_server_settings_become_the_default_profile() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{ "schemaVersion": 2, "activeMode": "advanced",
                 "advanced": { "containerName": "old-mc", "rconPort": 25999 } }"#,
        )
        .unwrap();
        let hub = hub_in(&tmp).await;
        let s = hub.core(Some("default")).await.unwrap().settings().await;
        assert_eq!(s.active_mode, Mode::Advanced);
        assert_eq!(s.advanced.container_name, "old-mc");
        assert_eq!(s.advanced.rcon_port, 25999);
    }

    #[tokio::test]
    async fn add_creates_an_isolated_profile_with_fresh_ports() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        let list = hub.add("  Forge  ", None).await.unwrap();
        assert_eq!(list.servers.len(), 2);
        assert_eq!(list.active_server_id, "default", "add must not switch");
        let forge = list.servers.last().unwrap().clone();
        assert_eq!(forge.name, "Forge");
        assert!(is_valid_server_id(&forge.id));
        assert_eq!(forge.id.len(), 8);

        let settings_file = tmp
            .path()
            .join("config/servers")
            .join(&forge.id)
            .join("settings.json");
        assert!(settings_file.is_file());

        let core = hub.core(Some(&forge.id)).await.unwrap();
        assert_eq!(
            core.paths.data_dir,
            tmp.path().join("data/servers").join(&forge.id)
        );
        let s = core.settings().await;
        assert_eq!(s.active_mode, Mode::Advanced);
        assert_eq!(
            (s.advanced.query_port, s.advanced.rcon_port),
            (25566, 25576)
        );
        assert_eq!((s.simple.server_port, s.simple.rcon_port), (25566, 25576));
        assert_eq!(
            s.simple.instance_dir,
            core.paths.data_dir.join("instances").join("default")
        );

        let list = hub.add("Fabric", Some(Mode::Simple)).await.unwrap();
        let fabric = list.servers.last().unwrap().clone();
        let s = hub.core(Some(&fabric.id)).await.unwrap().settings().await;
        assert_eq!(s.active_mode, Mode::Simple);
        assert_eq!((s.simple.server_port, s.simple.rcon_port), (25567, 25577));

        // Isolation: editing one profile leaves the others alone.
        let mut edited = core.settings().await;
        edited.advanced.container_name = "mc-forge".into();
        core.update_settings(edited).await.unwrap();
        let default = hub.core(Some("default")).await.unwrap().settings().await;
        assert_eq!(default.advanced.container_name, "minecraft-server");
        assert_eq!(s.advanced.container_name, "minecraft-server");
    }

    #[tokio::test]
    async fn names_are_validated_and_unique() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        let too_long = "x".repeat(MAX_NAME_CHARS + 1);
        for bad in ["", "   ", too_long.as_str(), "tab\there"] {
            let err = hub.add(bad, None).await.unwrap_err();
            assert_eq!(err.code(), "INVALID_INPUT", "name {bad:?}");
        }
        let err = hub.add("default", None).await.unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT", "case-insensitive duplicate");

        let list = hub.add("Forge", None).await.unwrap();
        let id = list.servers.last().unwrap().id.clone();
        assert_eq!(
            hub.rename(&id, "DEFAULT").await.unwrap_err().code(),
            "INVALID_INPUT"
        );
        // Renaming to its own name (any case) is not a collision.
        let list = hub.rename(&id, "forge").await.unwrap();
        assert_eq!(list.servers.last().unwrap().name, "forge");
        let list = hub.rename("default", "Vanilla").await.unwrap();
        assert_eq!(list.servers[0].name, "Vanilla");
        assert_eq!(
            hub.rename("nope", "x").await.unwrap_err().code(),
            "SERVER_NOT_FOUND"
        );
        // Rejected adds created nothing: one profile dir, for Forge.
        assert_eq!(hub.list().await.servers.len(), 2);
        let dirs = std::fs::read_dir(tmp.path().join("config/servers")).unwrap();
        assert_eq!(dirs.count(), 1);
    }

    #[tokio::test]
    async fn unknown_server_id_is_server_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        let err = hub.core(Some("missing")).await.err().unwrap();
        assert_eq!(err.code(), "SERVER_NOT_FOUND");
        assert_eq!(
            hub.set_active("missing").await.unwrap_err().code(),
            "SERVER_NOT_FOUND"
        );
    }

    #[tokio::test]
    async fn active_server_is_persisted_and_targets_untagged_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        let id = hub.add("Forge", None).await.unwrap().servers[1].id.clone();
        hub.set_active(&id).await.unwrap();
        assert_eq!(
            hub.core(None).await.unwrap().paths.data_dir,
            tmp.path().join("data/servers").join(&id)
        );
        drop(hub);

        let reloaded = hub_in(&tmp).await;
        let list = reloaded.list().await;
        assert_eq!(list.active_server_id, id);
        assert_eq!(list.servers.len(), 2);
        assert_eq!(list.servers[1].name, "Forge");
        let s = reloaded.core(Some(&id)).await.unwrap().settings().await;
        assert_eq!(s.advanced.query_port, 25566);
    }

    #[tokio::test]
    async fn remove_drops_settings_but_keeps_the_state_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        let id = hub.add("Forge", None).await.unwrap().servers[1].id.clone();
        hub.set_active(&id).await.unwrap();
        let data_dir = tmp.path().join("data/servers").join(&id);
        assert!(
            data_dir.join("audit-log.jsonl").is_file(),
            "server.add audited"
        );

        assert_eq!(
            hub.remove(&id, false).await.unwrap_err().code(),
            "INVALID_INPUT"
        );
        assert_eq!(
            hub.remove("default", true).await.unwrap_err().code(),
            "INVALID_INPUT"
        );
        assert_eq!(
            hub.remove("missing", true).await.unwrap_err().code(),
            "SERVER_NOT_FOUND"
        );

        let list = hub.remove(&id, true).await.unwrap();
        assert_eq!(list.servers, vec![default_profile()]);
        assert_eq!(list.active_server_id, "default", "active falls back");
        assert!(!tmp.path().join("config/servers").join(&id).exists());
        assert!(data_dir.is_dir(), "state dir (worlds) is never deleted");
        assert_eq!(
            hub.core(Some(&id)).await.err().unwrap().code(),
            "SERVER_NOT_FOUND"
        );

        let log = crate::audit::recent(&hub.core(Some("default")).await.unwrap(), None)
            .await
            .unwrap();
        let removal = log
            .entries
            .iter()
            .find(|e| e.action == "server.remove" && e.ok);
        assert_eq!(removal.unwrap().target.as_deref(), Some("Forge"));
    }

    #[tokio::test]
    async fn server_limit_is_enforced() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        for n in 1..MAX_SERVERS {
            hub.add(&format!("server {n}"), None).await.unwrap();
        }
        assert_eq!(hub.list().await.servers.len(), MAX_SERVERS);
        let err = hub.add("one too many", None).await.unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
    }

    #[tokio::test]
    async fn index_file_is_validated_and_self_heals() {
        let write = |tmp: &tempfile::TempDir, json: &str| {
            let config = tmp.path().join("config");
            std::fs::create_dir_all(&config).unwrap();
            std::fs::write(config.join("servers.json"), json).unwrap();
        };
        let init =
            |tmp: &tempfile::TempDir| Hub::init(tmp.path().join("config"), tmp.path().join("data"));

        for bad in [
            r#"{ "schemaVersion": 2 }"#,
            r#"not json"#,
            r#"{ "servers": [{ "id": "../../etc", "name": "x" }] }"#,
            r#"{ "servers": [{ "id": "a", "name": "x" }, { "id": "a", "name": "y" }] }"#,
        ] {
            let tmp = tempfile::tempdir().unwrap();
            write(&tmp, bad);
            let err = init(&tmp).await.err().expect(bad);
            assert_eq!(err.code(), "SETTINGS_INVALID", "{bad}");
        }

        // Missing default profile + dangling active id are repaired.
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp,
            r#"{ "schemaVersion": 1, "activeServerId": "gone",
                 "servers": [{ "id": "forge", "name": "  " }] }"#,
        );
        let hub = init(&tmp).await.unwrap();
        let list = hub.list().await;
        assert_eq!(list.active_server_id, "default");
        assert_eq!(list.servers[0], default_profile());
        assert_eq!(list.servers[1].id, "forge");
        assert_eq!(list.servers[1].name, "forge", "blank name falls back to id");
    }

    #[tokio::test]
    async fn events_carry_the_profile_they_came_from() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        let id = hub.add("Forge", None).await.unwrap().servers[1].id.clone();
        let mut rx = hub.subscribe_events();

        let event = |phase| {
            CoreEvent::ServerState(ServerStateEvent {
                mode: Mode::Advanced,
                phase,
                previous_phase: ServerPhase::Stopped,
                epoch_ms: 1,
                exit_code: None,
            })
        };
        hub.core(Some(&id))
            .await
            .unwrap()
            .emit_event(event(ServerPhase::Running));
        hub.core(Some("default"))
            .await
            .unwrap()
            .emit_event(event(ServerPhase::Crashed));

        let mut seen = HashMap::new();
        for _ in 0..2 {
            let ev = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .expect("event forwarded")
                .unwrap();
            let CoreEvent::ServerState(state) = ev.event else {
                panic!("unexpected event");
            };
            seen.insert(ev.server_id, state.phase);
        }
        assert_eq!(seen[&id], ServerPhase::Running);
        assert_eq!(seen["default"], ServerPhase::Crashed);
    }

    #[tokio::test]
    async fn overview_lists_every_profile_without_rejecting() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = hub_in(&tmp).await;
        hub.add("Second", Some(Mode::Simple)).await.unwrap();
        let overview = hub.overview().await;
        assert_eq!(overview.len(), 2);
        assert_eq!(overview[0].id, "default");
        assert_eq!(overview[1].name, "Second");
        // Simple mode, nothing created: a normal state, not an error.
        for entry in &overview {
            assert_eq!(entry.mode, Mode::Simple);
            assert_eq!(entry.phase, Some(ServerPhase::NotCreated));
            assert!(entry.error.is_none());
        }
    }
}
