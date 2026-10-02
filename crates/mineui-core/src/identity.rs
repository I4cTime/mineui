//! What a server profile actually points at (contract §3.12 overview): its
//! phase plus the container name, address, loader and version that tell two
//! similarly named servers apart.
//!
//! One runtime `ps` answers the phase; the loader/version come from the
//! container's env (`TYPE` / `VERSION`, the itzg convention), read once per
//! container id and cached on the core.

use crate::error::Result;
use crate::model::ServerPhase;
use crate::settings::{Mode, Settings};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub container_name: Option<String>,
    pub address: String,
    pub loader: Option<String>,
    pub mc_version: Option<String>,
}

/// `TYPE` / `VERSION` of one container, keyed by the container id so a
/// recreated container is re-read.
#[derive(Debug, Clone)]
pub(crate) struct ContainerKind {
    container_id: String,
    loader: Option<String>,
    mc_version: Option<String>,
}

/// (loader, mcVersion) from a container's env. `VERSION=LATEST` is not a
/// version anyone can read, so it maps to `None`.
pub fn kind_from_env(env: &[(String, String)]) -> (Option<String>, Option<String>) {
    let get = |key: &str| {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let loader = get("TYPE").map(|t| t.to_lowercase());
    let mc_version = get("VERSION").filter(|v| !v.eq_ignore_ascii_case("latest"));
    (loader, mc_version)
}

fn simple_identity(settings: &Settings) -> Identity {
    Identity {
        container_name: None,
        address: format!("127.0.0.1:{}", settings.simple.server_port),
        loader: Some("vanilla".into()),
        mc_version: Some(settings.simple.mc_version.clone()).filter(|v| !v.is_empty()),
    }
}

/// Phase + identity of one profile. The phase is a `Result` because a
/// missing runtime is a per-profile fault the overview reports; the identity
/// always resolves (to what the settings alone say, at minimum).
pub async fn probe(core: &crate::Core) -> (Result<ServerPhase>, Identity) {
    let settings = core.settings().await;
    if settings.active_mode == Mode::Simple {
        return (
            Ok(crate::lifecycle::simple_phase(core, &settings)),
            simple_identity(&settings),
        );
    }

    let name = &settings.advanced.container_name;
    let mut identity = Identity {
        container_name: Some(name.clone()),
        address: format!(
            "{}:{}",
            settings.advanced.query_host, settings.advanced.query_port
        ),
        loader: None,
        mc_version: None,
    };
    let runtime = match crate::runtime::resolve(&settings.advanced).await {
        Ok(runtime) => runtime,
        Err(e) => return (Err(e), identity),
    };
    let detail = match runtime.ps_state(name).await {
        Ok(detail) => detail,
        Err(e) => return (Err(e), identity),
    };
    let phase = crate::lifecycle::phase_from_container(&detail);
    let Some(container_id) = detail.id.filter(|_| detail.exists) else {
        *core.container_kind.lock().unwrap() = None;
        return (Ok(phase), identity);
    };

    let cached = core
        .container_kind
        .lock()
        .unwrap()
        .clone()
        .filter(|kind| kind.container_id == container_id);
    let kind = match cached {
        Some(kind) => kind,
        None => {
            let env = runtime.inspect_env(name).await.unwrap_or_default();
            let (loader, mc_version) = kind_from_env(&env);
            let kind = ContainerKind {
                container_id,
                loader,
                mc_version,
            };
            *core.container_kind.lock().unwrap() = Some(kind.clone());
            kind
        }
    };
    identity.loader = kind.loader;
    identity.mc_version = kind.mc_version;
    (Ok(phase), identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn kind_reads_itzg_type_and_version() {
        let e = env(&[("EULA", "TRUE"), ("TYPE", "FORGE"), ("VERSION", "1.21.1")]);
        assert_eq!(
            kind_from_env(&e),
            (Some("forge".into()), Some("1.21.1".into()))
        );
    }

    #[test]
    fn kind_treats_latest_and_missing_as_unknown() {
        let e = env(&[("TYPE", "Fabric"), ("VERSION", "latest")]);
        assert_eq!(kind_from_env(&e), (Some("fabric".into()), None));
        assert_eq!(kind_from_env(&env(&[("PATH", "/bin")])), (None, None));
        assert_eq!(kind_from_env(&env(&[("TYPE", "  ")])), (None, None));
    }

    #[tokio::test]
    async fn simple_profile_identity_comes_from_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let (phase, identity) = probe(&core).await;
        assert_eq!(phase.unwrap(), ServerPhase::NotCreated);
        assert_eq!(
            identity,
            Identity {
                container_name: None,
                address: "127.0.0.1:25565".into(),
                loader: Some("vanilla".into()),
                mc_version: None,
            }
        );

        let mut s = core.settings().await;
        s.simple.mc_version = "1.21.1".into();
        s.simple.server_port = 25570;
        core.update_settings(s).await.unwrap();
        let (_, identity) = probe(&core).await;
        assert_eq!(identity.address, "127.0.0.1:25570");
        assert_eq!(identity.mc_version.as_deref(), Some("1.21.1"));
    }
}
