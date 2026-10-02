//! Container creation (contract §3.13): make an itzg/minecraft-server
//! container for an advanced-mode profile, then point the profile at it.
//!
//! Creation is one argv-array `run -d`. Secrets travel in a 0600 env file,
//! never in the argv; it never touches an existing container.
//!
//! Deletion (`delete_container`) exists for cleaning up a failed or unwanted
//! server. It runs only on an explicit, confirmed request, and removes a data
//! volume only when that was asked for too — never as a side effect of
//! anything else, and never a folder on the host.

use std::net::{Ipv4Addr, TcpListener};
use std::path::Path;

use crate::error::{Error, Result};
use crate::model::{
    AuditSource, CreateContainerArgs, DeletedContainer, ModpackSource, ServerState,
};
use crate::runtime::ContainerSpec;
use crate::runtime::Mount;
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

/// What the container runs: a bare server type, or a modpack (2.7.0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Workload {
    Loader(&'static str),
    Modrinth(String),
    Curseforge(String),
}

impl Workload {
    /// `FORGE`, `MODRINTH:<slug>`, `AUTO_CURSEFORGE:<slug>` — the audit label.
    pub fn label(&self) -> String {
        match self {
            Workload::Loader(itzg_type) => (*itzg_type).to_string(),
            Workload::Modrinth(slug) => format!("MODRINTH:{slug}"),
            Workload::Curseforge(slug) => format!("AUTO_CURSEFORGE:{slug}"),
        }
    }
}

/// Validated, normalized inputs of one create call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub version: String,
    pub workload: Workload,
}

/// §3.13 step 3.
pub fn validate(args: &CreateContainerArgs) -> Result<Plan> {
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
    let workload = match &args.modpack {
        None => Workload::Loader(args.loader.itzg_type()),
        Some(modpack) => {
            let slug = crate::modpacks::normalize_project(modpack)?;
            // The version picks the Java image; a modpack on the wrong Java
            // does not start, so "whatever is newest" is not good enough.
            if version == LATEST {
                return Err(Error::InvalidInput(
                    "choose the Minecraft version the modpack is for".into(),
                ));
            }
            match modpack.source {
                ModpackSource::Modrinth => Workload::Modrinth(slug),
                ModpackSource::Curseforge => Workload::Curseforge(slug),
            }
        }
    };
    Ok(Plan { version, workload })
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
pub fn env_file_body(plan: &Plan, memory_mb: u32, rcon_password: &str) -> String {
    let version = &plan.version;
    let what = match &plan.workload {
        Workload::Loader(itzg_type) => format!("TYPE={itzg_type}\nVERSION={version}\n"),
        // The image installs the pack's newest release build for VERSION.
        Workload::Modrinth(slug) => {
            format!("TYPE=MODRINTH\nMODRINTH_MODPACK={slug}\nVERSION={version}\n")
        }
        // The pack file fixes the Minecraft version; no VERSION.
        Workload::Curseforge(slug) => format!("TYPE=AUTO_CURSEFORGE\nCF_SLUG={slug}\n"),
    };
    format!(
        "EULA=TRUE\n{what}MEMORY={memory_mb}M\nENABLE_RCON=true\nRCON_PASSWORD={rcon_password}\n"
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
    plan: Plan,
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
    let plan = validate(args)?;
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

    let tag = image_tag_for_java(required_java_major(core, &plan.version).await);
    let image = format!("{ITZG_IMAGE}:{tag}");
    let rcon_password = crate::instance::generate_rcon_password();

    let env_file = write_env_file(
        &core.paths.data_dir.join("tmp"),
        &env_file_body(&plan, args.memory_mb, &rcon_password),
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
        let _ = runtime.remove_force(name, false).await;
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

    Ok(Created { image, plan })
}

/// `create_container` (§3.13), audited as `container.create`.
pub async fn create(core: &crate::Core, args: &CreateContainerArgs) -> Result<ServerState> {
    let result = create_inner(core, args).await;
    let detail = result
        .as_ref()
        .ok()
        .map(|c| format!("{} {} {}", c.plan.workload.label(), c.plan.version, c.image));
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

/// What `deleteData` means for one container's `/data` mount (§3.13 step 4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataPlan {
    /// A named volume: removed with `volume rm` after the container.
    NamedVolume(String),
    /// An anonymous volume: removed by `rm -v` together with the container.
    AnonymousVolume,
    /// Not ours to delete; the string says why.
    Keep(String),
}

/// Decide what happens to the data when its deletion was asked for. Only a
/// volume mounted at `/data` qualifies; a host folder never does.
pub fn plan_data_deletion(mounts: &[Mount]) -> DataPlan {
    let Some(data) = mounts.iter().find(|m| m.destination == DATA_PATH) else {
        return DataPlan::Keep("the container has nothing mounted at /data".into());
    };
    if data.kind != "volume" {
        return DataPlan::Keep(format!(
            "the world lives in a folder on this computer ({}), which MineUI does not delete",
            data.source
        ));
    }
    if data.is_anonymous_volume() {
        DataPlan::AnonymousVolume
    } else {
        DataPlan::NamedVolume(data.name.clone())
    }
}

async fn delete_inner(
    core: &crate::Core,
    confirm: bool,
    delete_data: bool,
) -> Result<DeletedContainer> {
    let settings = core.settings().await;
    if settings.active_mode != Mode::Advanced {
        return Err(Error::WrongMode(
            "deleting a container is only available in advanced mode".into(),
        ));
    }
    if !confirm {
        return Err(Error::InvalidInput(
            "delete_container requires confirm: true".into(),
        ));
    }
    let name = settings.advanced.container_name.clone();
    let runtime = crate::runtime::resolve(&settings.advanced).await?;
    if !runtime.ps_state(&name).await?.exists {
        return Err(Error::ContainerNotFound(format!(
            "container '{name}' does not exist"
        )));
    }

    // Decided before anything is removed: the mounts cannot be read afterwards.
    let plan = if delete_data {
        Some(plan_data_deletion(&runtime.inspect_mounts(&name).await?))
    } else {
        None
    };

    core.logs.shutdown().await;
    runtime.remove_force(&name, delete_data).await?;
    *core.container_kind.lock().unwrap() = None;

    let (deleted_volume, data_kept) = match plan {
        None => (None, None),
        Some(DataPlan::Keep(why)) => (None, Some(why)),
        Some(DataPlan::AnonymousVolume) => (Some("anonymous volume".to_string()), None),
        Some(DataPlan::NamedVolume(volume)) => match runtime.remove_volume(&volume).await {
            Ok(()) => (Some(volume), None),
            // The container is already gone; say what is left rather than fail.
            Err(e) => (
                None,
                Some(format!("the volume '{volume}' could not be deleted: {e}")),
            ),
        },
    };
    Ok(DeletedContainer {
        container_name: name,
        deleted_volume,
        data_kept,
    })
}

/// `delete_container` (§3.13), audited as `container.delete`.
pub async fn delete(
    core: &crate::Core,
    confirm: bool,
    delete_data: bool,
) -> Result<DeletedContainer> {
    let result = delete_inner(core, confirm, delete_data).await;
    let settings = core.settings().await;
    let detail = match &result {
        Ok(done) => match &done.deleted_volume {
            Some(volume) => format!("data deleted: {volume}"),
            None => "data kept".to_string(),
        },
        Err(_) => if delete_data {
            "with data"
        } else {
            "data kept"
        }
        .to_string(),
    };
    crate::audit::record(
        core,
        AuditSource::User,
        "container.delete",
        Some(settings.advanced.container_name.as_str()),
        Some(&detail),
        result.as_ref().err(),
    )
    .await;
    if result.is_ok() {
        crate::lifecycle::poll_advanced_state(core).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ContainerLoader, ModpackRef};

    fn mount(kind: &str, name: &str, source: &str, destination: &str) -> Mount {
        Mount {
            kind: kind.into(),
            name: name.into(),
            source: source.into(),
            destination: destination.into(),
        }
    }

    #[test]
    fn only_a_volume_at_data_is_ever_deleted() {
        let named = [
            mount("bind", "", "/home/me/extra", "/extra"),
            mount("volume", "mc-forge-data", "/v/mc-forge-data/_data", "/data"),
        ];
        assert_eq!(
            plan_data_deletion(&named),
            DataPlan::NamedVolume("mc-forge-data".into())
        );

        let anonymous = [mount("volume", &"a1".repeat(32), "/v/x/_data", "/data")];
        assert_eq!(plan_data_deletion(&anonymous), DataPlan::AnonymousVolume);

        // The world in a host folder: never deleted, and the reason says where.
        let bind = [mount("bind", "", "/home/me/minecraft", "/data")];
        let DataPlan::Keep(why) = plan_data_deletion(&bind) else {
            panic!("a bind mount must be kept");
        };
        assert!(why.contains("/home/me/minecraft"));

        // A volume mounted elsewhere is not the world.
        let elsewhere = [mount("volume", "other", "/v/other/_data", "/config")];
        assert!(matches!(plan_data_deletion(&elsewhere), DataPlan::Keep(_)));
        assert!(matches!(plan_data_deletion(&[]), DataPlan::Keep(_)));
    }

    #[tokio::test]
    async fn delete_is_gated_before_the_runtime_is_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        // Default profile is simple mode.
        assert_eq!(
            delete(&core, true, true).await.unwrap_err().code(),
            "WRONG_MODE"
        );

        let mut s = core.settings().await;
        s.active_mode = Mode::Advanced;
        core.update_settings(s).await.unwrap();
        assert_eq!(
            delete(&core, false, true).await.unwrap_err().code(),
            "INVALID_INPUT"
        );
        let log = crate::audit::recent(&core, None).await.unwrap();
        let attempts = log
            .entries
            .iter()
            .filter(|e| e.action == "container.delete" && !e.ok)
            .count();
        assert_eq!(attempts, 2, "refused attempts are in the activity log");
    }

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
            modpack: None,
        }
    }

    fn with_modpack(source: ModpackSource, project: &str) -> CreateContainerArgs {
        CreateContainerArgs {
            modpack: Some(ModpackRef {
                source,
                project: project.into(),
            }),
            ..args()
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
        let plan = validate(&args()).unwrap();
        assert_eq!(plan.version, "1.21.1");
        assert_eq!(plan.workload, Workload::Loader("FORGE"));

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
        let plan = validate(&args()).unwrap();
        assert_eq!(
            env_file_body(&plan, 4096, "s3cretPassw0rd"),
            "EULA=TRUE\nTYPE=FORGE\nVERSION=1.21.1\nMEMORY=4096M\nENABLE_RCON=true\nRCON_PASSWORD=s3cretPassw0rd\n"
        );
    }

    #[test]
    fn modpacks_replace_the_type_and_version_pair() {
        // Modrinth: the image picks the pack's newest build for VERSION.
        let plan = validate(&with_modpack(
            ModpackSource::Modrinth,
            "https://modrinth.com/modpack/cobblemon-fabric",
        ))
        .unwrap();
        assert_eq!(plan.workload, Workload::Modrinth("cobblemon-fabric".into()));
        assert_eq!(plan.workload.label(), "MODRINTH:cobblemon-fabric");
        assert_eq!(
            env_file_body(&plan, 6144, "pw"),
            "EULA=TRUE\nTYPE=MODRINTH\nMODRINTH_MODPACK=cobblemon-fabric\nVERSION=1.21.1\nMEMORY=6144M\nENABLE_RCON=true\nRCON_PASSWORD=pw\n"
        );

        // CurseForge: the pack file fixes the version, so none is sent — the
        // version argument still picks the Java image.
        let plan = validate(&with_modpack(ModpackSource::Curseforge, "all-the-mods-10")).unwrap();
        assert_eq!(plan.version, "1.21.1");
        assert_eq!(
            env_file_body(&plan, 8192, "pw"),
            "EULA=TRUE\nTYPE=AUTO_CURSEFORGE\nCF_SLUG=all-the-mods-10\nMEMORY=8192M\nENABLE_RCON=true\nRCON_PASSWORD=pw\n"
        );
    }

    #[test]
    fn modpacks_need_a_concrete_version_and_a_clean_slug() {
        let mut latest = with_modpack(ModpackSource::Modrinth, "cobblemon-fabric");
        latest.mc_version = "latest".into();
        let err = validate(&latest).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains("Minecraft version"));

        for bad in ["", "two words", "pack\nEULA=FALSE", "https://example.com/x"] {
            let err = validate(&with_modpack(ModpackSource::Modrinth, bad)).unwrap_err();
            assert_eq!(err.code(), "INVALID_INPUT", "{bad:?}");
        }
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
