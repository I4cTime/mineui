//! HTTP client for mineui-server-utils `/status`, `/metrics`, `/mods`
//! (module map §8). Short timeouts; callers degrade silently on failure.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};

const TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Deserialize)]
pub struct SuStatus {
    pub ok: bool,
    #[serde(default)]
    pub properties: HashMap<String, String>,
    #[serde(default)]
    pub players: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SuTps {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
    #[serde(default)]
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SuMspt {
    pub one: Option<f64>,
    pub five: Option<f64>,
    pub fifteen: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuMem {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub limit_bytes: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuNet {
    pub input_bytes: Option<u64>,
    pub output_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuDiskIo {
    pub read_bytes: Option<u64>,
    pub write_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuContainer {
    pub cpu_percent: Option<f64>,
    pub mem: Option<SuMem>,
    pub net: Option<SuNet>,
    pub block: Option<SuDiskIo>,
    pub pids: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuSystem {
    pub cpu_percent: Option<f64>,
    pub mem: Option<SuMem>,
    pub net: Option<SuNet>,
    pub disk: Option<SuDiskIo>,
    pub container: Option<SuContainer>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuPlayers {
    pub online: Option<u32>,
    pub max: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SuMetrics {
    pub ok: bool,
    pub tps: Option<SuTps>,
    pub mspt: Option<SuMspt>,
    #[serde(default)]
    pub chunks: Option<i64>,
    #[serde(default)]
    pub entities: Option<i64>,
    #[serde(default)]
    pub dimensions: Option<HashMap<String, crate::model::DimensionStats>>,
    pub system: Option<SuSystem>,
    pub players: Option<SuPlayers>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SuModEntry {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SuMods {
    pub ok: bool,
    #[serde(default)]
    pub mods: Vec<SuModEntry>,
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    core: &crate::Core,
    base_url: &str,
    path: &str,
) -> Result<T> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let response = core
        .http
        .get(&url)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| Error::ServerUtilsUnavailable(format!("server-utils unreachable: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::ServerUtilsUnavailable(format!(
            "server-utils {path} returned HTTP {}",
            response.status().as_u16()
        )));
    }
    response.json::<T>().await.map_err(|e| {
        Error::ServerUtilsUnavailable(format!("server-utils {path} invalid JSON: {e}"))
    })
}

pub async fn status(core: &crate::Core, base_url: &str) -> Result<SuStatus> {
    fetch_json(core, base_url, "/status").await
}

pub async fn metrics(core: &crate::Core, base_url: &str) -> Result<SuMetrics> {
    fetch_json(core, base_url, "/metrics").await
}

pub async fn mods(core: &crate::Core, base_url: &str) -> Result<SuMods> {
    fetch_json(core, base_url, "/mods").await
}
