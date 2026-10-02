//! Container creation (contract §3.13): make an itzg/minecraft-server
//! container for an advanced-mode profile, then point the profile at it.
//!
//! One argv-array `run -d`. Secrets travel in a 0600 env file, never in the
//! argv. This module only ever creates: it never touches an existing
//! container and never removes a volume.

use std::net::{Ipv4Addr, TcpListener};
use std::path::Path;

use crate::error::{Error, Result};
use crate::model::{AuditSource, CreateContainerArgs, ServerState};
use crate::runtime::ContainerSpec;
use crate::settings::Mode;

pub const ITZG_IMAGE: &str = "docker.io/itzg/minecraft-server";
pub const LATEST: &str = "LATEST";
pub const MIN_MEMORY_MB: u32 = 512;
pub const MAX_MEMORY_MB: u32 = 65536;

const CONTAINER_GAME_PORT: u16 = 25565;
const CONTAINER_RCON_PORT: u16 = 25575;
const DATA_PATH: &str = "/data";
const LOOPBACK: &str = "127.0.0.1";
const ALL_INTERFACES: &str = "0.0.0.0";

/// §3.13 step 3 for `mcVersion`: empty / any-case "latest" → `LATEST`,
/// otherwise `^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$`. The value lands in an env
/// file line, so the charset is also what keeps it on that line.
pub fn normalize_version(input: &str) -> Result<String> {
    let version = input.trim();
    if version.is_empty() || version.eq_ignore_ascii_case(LATEST) {
        return Ok(LATEST.to_string());
    }
    let mut chars = version.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !first_ok || !rest_ok || version.len() > 32 {
        return Err(Error::InvalidInput(format!(
            "invalid Minecraft version: {version}"
        )));
    }
    Ok(version.to_string())
}

/// §3.13 step 3. Returns the normalized version.
pub fn validate(args: &CreateContainerArgs) -> Result<String> {
    if !crate::validate::is_valid_container_name(&args.container_name) {
        return Err(Error::InvalidInput(
            "container name must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$".into(),
        ));
    }
    let version = normalize_version(&args.mc_version)?;
    if !(MIN_MEMORY_MB..=MAX_MEMORY_MB).contains(&args.memory_mb) {
        return Err(Error::InvalidInput(format!(
            "memory must be {MIN_MEMORY_MB}-{MAX_MEMORY_MB} MB"
        )));
    }
    if args.game_port == 0 || args.rcon_port == 0 {
        return Err(Error::InvalidInput("ports must be in 1-65535".into()));
    }
    if args.game_port == args.rcon_port {
        return Err(Error::InvalidInput(
            "the game port and the RCON port must differ".into(),
        ));
    }
    Ok(version)
}

/// §3.13 step 7: image tag for the Java major a version needs.
pub fn image_tag_for_java(major: Option<u32>) -> &'static str {
    match major {
        Some(0..=8) => "java8",
        Some(9..=17) => "java17",
        Some(18..=21) => "java21",
        Some(22..=25) => "java25",
        _ => "latest",
    }
}

/// Java major the version needs, per Mojang's version detail; `None` when
/// it cannot be resolved (offline, or a version Mojang does not list).
async fn required_java_major(core: &crate::Core, version: &str) -> Option<u32> {
    let id = if version == LATEST {
        crate::mojang::list_versions(core, false)
            .await
            .ok()?
            .into_iter()
            .find(|v| v.latest)?
            .id
    } else {
        version.to_string()
    };
    let detail = crate::mojang::version_detail(core, &id).await.ok()?;
    detail.java_version.map(|j| j.major_version)
}

/// The env file body (§3.13 step 7). Every value is either a constant or
/// validated to a charset without newlines.
pub fn env_file_body(args: &CreateContainerArgs, version: &str, rcon_password: &str) -> String {
    format!(
        "EULA=TRUE\nTYPE={}\nVERSION={version}\nMEMORY={}M\nENABLE_RCON=true\nRCON_PASSWORD={rcon_password}\n",
        args.loader.itzg_type(),
        args.memory_mb,
    )
}

/// §3.13 step 6: can the host port be bound right now?
fn ensure_port_free(bind: Ipv4Addr, port: u16) -> Result<()> {
    TcpListener::bind((bind, port)).map(drop).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            Error::InvalidInput(format!("port {port} is already in use"))
        } else {
            Error::InvalidInput(format!("port {port} cannot be used: {e}"))
        }
    })
}

async fn write_env_file(dir: &Path, body: &str) -> Result<std::path::PathBuf> {
    let path = dir.join(format!("container-{}.env", uuid::Uuid::new_v4().simple()));
    crate::util::write_atomic_bytes(&path, body.as_bytes()).await?;
    Ok(path)
}

/// What was created, for the audit detail.
struct Created {
    image: String,
    version: String,
}

async fn create_inner(core: &crate::Core, args: &CreateContainerArgs) -> Result<Created> {
    let settings = core.settings().await;
    if settings.active_mode != Mode::Advanced {
        return Err(Error::WrongMode(
            "creating a container is only available in advanced mode".into(),
        ));
    }
    if !args.accept_eula {
        return Err(Error::EulaNotAccepted(
            "you must accept the Minecraft EULA to create a server".into(),
        ));
    }
    let version = validate(args)?;
    let name = args.container_name.as_str();

    let runtime = crate::runtime::resolve(&settings.advanced).await?;
    if runtime.ps_state(name).await?.exists {
        return Err(Error::ContainerExists(format!(
            "a container named '{name}' already exists — attach to it in the server's settings"
        )));
    }

    let game_bind = if args.expose_to_network {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    };
    ensure_port_free(game_bind, args.game_port)?;
    ensure_port_free(Ipv4Addr::LOCALHOST, args.rcon_port)?;

    let tag = image_tag_for_java(required_java_major(core, &version).await);
    let image = format!("{ITZG_IMAGE}:{tag}");
    let rcon_password = crate::instance::generate_rcon_password();

    let env_file = write_env_file(
        &core.paths.data_dir.join("tmp"),
        &env_file_body(args, &version, &rcon_password),
    )
    .await?;
    let spec = ContainerSpec {
        name: name.to_string(),
        image: image.clone(),
        env_file: env_file.clone(),
        ports: vec![
            (
                if args.expose_to_network {
                    ALL_INTERFACES.to_string()
                } else {
                    LOOPBACK.to_string()
                },
                args.game_port,
                CONTAINER_GAME_PORT,
            ),
            (LOOPBACK.to_string(), args.rcon_port, CONTAINER_RCON_PORT),
        ],
        volume: (format!("{name}-data"), DATA_PATH.to_string()),
    };
    let outcome = runtime.run_detached(&spec).await;
    let _ = tokio::fs::remove_file(&env_file).await;

    let out = outcome?;
    if !out.success() {
        // The runtime may have made the container before failing to start
        // it (a port taken in the meantime). It was not there before this
        // call (checked above), so removing it is ours to do.
        let _ = runtime.remove_force(name).await;
        let reason = if out.stderr.is_empty() {
            out.stdout.trim().to_string()
        } else {
            out.stderr
        };
        return Err(Error::ContainerCreateFailed(format!(
            "{} could not create the container: {reason}",
            runtime.kind()
        )));
    }

    let mut updated = core.settings().await;
    updated.advanced.container_name = name.to_string();
    updated.advanced.query_host = LOOPBACK.to_string();
    updated.advanced.query_port = args.game_port;
    updated.advanced.rcon_host = LOOPBACK.to_string();
    updated.advanced.rcon_port = args.rcon_port;
    updated.advanced.rcon_password = rcon_password;
    updated.advanced.world_dir = "world".to_string();
    core.update_settings(updated).await?;

    Ok(Created { image, version })
}

/// `create_container` (§3.13), audited as `container.create`.
pub async fn create(core: &crate::Core, args: &CreateContainerArgs) -> Result<ServerState> {
    let result = create_inner(core, args).await;
    let detail = result
        .as_ref()
        .ok()
        .map(|c| format!("{} {} {}", args.loader.itzg_type(), c.version, c.image));
    crate::audit::record(
        core,
        AuditSource::User,
        "container.create",
        Some(args.container_name.as_str()),
        detail.as_deref(),
        result.as_ref().err(),
    )
    .await;
    result?;
    crate::lifecycle::poll_advanced_state(core).await;
    crate::lifecycle::state(core).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ContainerLoader;

    fn args() -> CreateContainerArgs {
        CreateContainerArgs {
            loader: ContainerLoader::Forge,
            mc_version: "1.21.1".into(),
            container_name: "mc-forge".into(),
            memory_mb: 4096,
            game_port: 25566,
            rcon_port: 25576,
            expose_to_network: true,
            accept_eula: true,
        }
    }

    #[test]
    fn version_normalization() {
        assert_eq!(normalize_version("  1.21.1 ").unwrap(), "1.21.1");
        assert_eq!(normalize_version("26.2").unwrap(), "26.2");
        assert_eq!(normalize_version("24w14a").unwrap(), "24w14a");
        assert_eq!(normalize_version("1.21-pre1").unwrap(), "1.21-pre1");
        assert_eq!(normalize_version("").unwrap(), LATEST);
        assert_eq!(normalize_version("latest").unwrap(), LATEST);
        for bad in [
            "1.21 1",
            "1.21\nTYPE=X",
            "-1.21",
            "1.21;rm",
            &"1".repeat(33),
        ] {
            assert_eq!(
                normalize_version(bad).unwrap_err().code(),
                "INVALID_INPUT",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn validation_rules() {
        assert_eq!(validate(&args()).unwrap(), "1.21.1");

        let mut a = args();
        a.container_name = "-bad;name".into();
        assert_eq!(validate(&a).unwrap_err().code(), "INVALID_INPUT");

        let mut a = args();
        a.memory_mb = 256;
        assert!(validate(&a).is_err());
        a.memory_mb = 70000;
        assert!(validate(&a).is_err());

        let mut a = args();
        a.rcon_port = a.game_port;
        assert!(validate(&a).is_err());
        a.rcon_port = 0;
        assert!(validate(&a).is_err());
    }

    #[test]
    fn java_major_picks_the_image_tag() {
        assert_eq!(image_tag_for_java(Some(8)), "java8"); // ≤ 1.16
        assert_eq!(image_tag_for_java(Some(16)), "java17"); // 1.17
        assert_eq!(image_tag_for_java(Some(17)), "java17"); // 1.18–1.20.4
        assert_eq!(image_tag_for_java(Some(21)), "java21"); // 1.20.5–1.21.x
        assert_eq!(image_tag_for_java(Some(25)), "java25"); // 26.x
        assert_eq!(image_tag_for_java(Some(29)), "latest");
        assert_eq!(image_tag_for_java(None), "latest");
    }

    #[test]
    fn env_file_carries_the_itzg_variables() {
        let body = env_file_body(&args(), "1.21.1", "s3cretPassw0rd");
        assert_eq!(
            body,
            "EULA=TRUE\nTYPE=FORGE\nVERSION=1.21.1\nMEMORY=4096M\nENABLE_RCON=true\nRCON_PASSWORD=s3cretPassw0rd\n"
        );
    }

    #[test]
    fn loader_wire_names_and_itzg_types() {
        for (wire, itzg) in [
            ("vanilla", "VANILLA"),
            ("fabric", "FABRIC"),
            ("forge", "FORGE"),
            ("neoforge", "NEOFORGE"),
            ("paper", "PAPER"),
            ("quilt", "QUILT"),
            ("purpur", "PURPUR"),
        ] {
            let loader: ContainerLoader = serde_json::from_str(&format!("\"{wire}\"")).unwrap();
            assert_eq!(loader.itzg_type(), itzg);
        }
    }

    #[test]
    fn busy_port_is_reported_as_invalid_input() {
        let held = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let err = ensure_port_free(Ipv4Addr::LOCALHOST, port).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains("already in use"));
        drop(held);
        ensure_port_free(Ipv4Addr::LOCALHOST, port).unwrap();
    }

    #[tokio::test]
    async fn gates_run_before_anything_is_created() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        // Default profile is simple mode.
        assert_eq!(
            create(&core, &args()).await.unwrap_err().code(),
            "WRONG_MODE"
        );

        let mut s = core.settings().await;
        s.active_mode = Mode::Advanced;
        core.update_settings(s).await.unwrap();

        let mut a = args();
        a.accept_eula = false;
        assert_eq!(
            create(&core, &a).await.unwrap_err().code(),
            "EULA_NOT_ACCEPTED"
        );
        let mut a = args();
        a.mc_version = "1.21 && evil".into();
        assert_eq!(create(&core, &a).await.unwrap_err().code(), "INVALID_INPUT");

        // Every rejection is in the activity log, and no env file was left.
        let log = crate::audit::recent(&core, None).await.unwrap();
        let rejected = log
            .entries
            .iter()
            .filter(|e| e.action == "container.create" && !e.ok)
            .count();
        assert_eq!(rejected, 3);
        assert!(!tmp.path().join("data/tmp").exists());
    }
}
