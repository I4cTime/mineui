//! `get_server_status` composition (contract §3.2): server-utils enrichment
//! (advanced only) with SLP fallback. Offline is a value, never a rejection.

use crate::error::Result;
use crate::model::{SampleName, ServerStatus, StatusPlayers};
use crate::settings::Mode;

/// v1 parity: `/status` + `/metrics` + `/mods` from server-utils; max-players
/// from properties; version from the `minecraft` mod entry.
async fn from_server_utils(core: &crate::Core, base_url: &str) -> Result<ServerStatus> {
    let status = crate::serverutils::status(core, base_url).await?;
    let metrics = crate::serverutils::metrics(core, base_url).await.ok();
    let mods = crate::serverutils::mods(core, base_url).await.ok();

    let mut online_players = status.players.len() as u32;
    let mut max_players: Option<u32> = status
        .properties
        .get("max-players")
        .or_else(|| status.properties.get("max_players"))
        .and_then(|v| v.trim().parse::<u32>().ok());

    if let Some(metrics) = metrics.as_ref().filter(|m| m.ok) {
        if let Some(players) = &metrics.players {
            if let Some(online) = players.online {
                online_players = online;
            }
            if players.max.is_some() {
                max_players = players.max;
            }
        }
    }

    let version = mods.as_ref().filter(|m| m.ok).and_then(|m| {
        m.mods
            .iter()
            .find(|entry| entry.id == "minecraft" || entry.name == "Minecraft")
            .map(|entry| entry.version.clone())
    });

    Ok(ServerStatus {
        online: status.ok,
        version,
        motd: status.properties.get("motd").cloned(),
        players: StatusPlayers {
            online: online_players,
            max: max_players.unwrap_or(0),
            sample: status
                .players
                .iter()
                .map(|name| SampleName { name: name.clone() })
                .collect(),
        },
        ping_ms: None,
        source: "server-utils".into(),
        error: if status.ok {
            None
        } else {
            status.errors.first().cloned()
        },
    })
}

/// `get_server_status` (§3.2). Failure resolves an offline status — it does
/// not reject (offline is a normal state, v1 UX).
pub async fn get(core: &crate::Core) -> Result<ServerStatus> {
    let settings = core.settings().await;

    if settings.active_mode == Mode::Advanced {
        if let Some(base_url) = settings.advanced.server_utils_url.as_deref() {
            if let Ok(status) = from_server_utils(core, base_url).await {
                return Ok(status);
            }
        }
    }

    let (host, port) = match settings.active_mode {
        Mode::Advanced => (
            settings.advanced.query_host.clone(),
            settings.advanced.query_port,
        ),
        Mode::Simple => ("127.0.0.1".to_string(), settings.simple.server_port),
    };
    match crate::query::ping(&host, port).await {
        Ok(status) => Ok(status),
        Err(e) => Ok(ServerStatus::offline(e.to_string())),
    }
}
