//! Container creation (contract §3.13): make an itzg/minecraft-server
//! container for an advanced-mode profile, then point the profile at it.
//!
//! Creation is one argv-array `run -d`. Secrets travel in a 0600 env file,
//! never in the argv; it never touches an existing container.
//!
//! Deletion (`delete_container`) exists for cleaning up a failed or unwanted
//! server. It runs only on an explicit, confirmed request, and removes a data
//! volume only when that was asked for too - never as a side effect of
//! anything else, and never a folder on the host.

use std::net::{Ipv4Addr, TcpListener, UdpSocket};
use std::path::Path;

use crate::error::{Error, Result};
use crate::model::{
    AuditSource, CreateContainerArgs, DeletedContainer, ExtraPort, ModpackSource, PortProtocol,
    ServerState,
};
use crate::runtime::Mount;
use crate::runtime::{ContainerSpec, PublishedPort, Runtime};
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

/// Marks a container MineUI created (2.11.0), so `update_container_ports`
/// may rebuild it.
pub const MANAGED_LABEL: &str = "studio.i4c.mineui.managed";
pub const MAX_EXTRA_PORTS: usize = 16;
/// The name the old container carries while its replacement is made.
pub const OLD_SUFFIX: &str = "-mineui-old";

/// The extra-port rules (§3.13 step 3, 2.11.0).
pub fn validate_extra_ports(extra: &[ExtraPort], game_port: u16, rcon_port: u16) -> Result<()> {
    if extra.len() > MAX_EXTRA_PORTS {
        return Err(Error::InvalidInput(format!(
            "at most {MAX_EXTRA_PORTS} extra ports"
        )));
    }
    for (i, p) in extra.iter().enumerate() {
        let proto = p.protocol.as_str();
        if p.port == 0 {
            return Err(Error::InvalidInput("ports must be in 1-65535".into()));
        }
        if p.protocol == PortProtocol::Tcp && p.port == game_port {
            return Err(Error::InvalidInput(format!(
                "extra port {}/{proto} is the game port",
                p.port
            )));
        }
        if p.protocol == PortProtocol::Tcp && p.port == rcon_port {
            return Err(Error::InvalidInput(format!(
                "extra port {}/{proto} is the RCON port",
                p.port
            )));
        }
        if extra[..i].contains(p) {
            return Err(Error::InvalidInput(format!(
                "extra port {}/{proto} is listed twice",
                p.port
            )));
        }
    }
    Ok(())
}

/// The bind addresses for (the game and extra ports, RCON): "keep on this
/// computer" binds 127.0.0.1 - unless that loopback is a VM's rather than
/// the user's: Podman on Windows with the WSL provider publishes inside the
/// machine, and WSL's localhost relay only reaches ports bound on all
/// interfaces there (§3.13). Published without an address, the port arrives
/// on the Windows host's own 127.0.0.1.
async fn bind_addresses(
    runtime: &dyn Runtime,
    expose_to_network: bool,
) -> (Option<String>, Option<String>) {
    let loopback_is_a_vms = cfg!(windows)
        && runtime.kind() == "podman"
        && runtime.machine_vm_type().await.as_deref() == Some("wsl");
    let local_bind = (!loopback_is_a_vms).then(|| LOOPBACK.to_string());
    let game_bind = if expose_to_network {
        Some(ALL_INTERFACES.to_string())
    } else {
        local_bind.clone()
    };
    (game_bind, local_bind)
}

/// Every `-p` of a MineUI container, in argv order (§3.13).
pub fn published_ports(
    game_bind: Option<String>,
    local_bind: Option<String>,
    game_port: u16,
    rcon_port: u16,
    extra: &[ExtraPort],
) -> Vec<PublishedPort> {
    let mut ports = vec![
        PublishedPort::tcp(game_bind.clone(), game_port, CONTAINER_GAME_PORT),
        PublishedPort::tcp(local_bind, rcon_port, CONTAINER_RCON_PORT),
    ];
    ports.extend(extra.iter().map(|p| PublishedPort {
        bind: game_bind.clone(),
        host: p.port,
        container: p.port,
        protocol: p.protocol,
    }));
    ports
}

fn managed_labels() -> Vec<(String, String)> {
    vec![(MANAGED_LABEL.to_string(), "1".to_string())]
}

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
    /// A CurseForge app export on the host (2.8.0); `slug` names it in the
    /// container, from the manifest once `create` has read it.
    CurseforgeZip {
        host_path: std::path::PathBuf,
        slug: String,
    },
}

impl Workload {
    /// `FORGE`, `MODRINTH:<slug>`, `AUTO_CURSEFORGE:<slug>` - the audit label.
    pub fn label(&self) -> String {
        match self {
            Workload::Loader(itzg_type) => (*itzg_type).to_string(),
            Workload::Modrinth(slug) => format!("MODRINTH:{slug}"),
            Workload::Curseforge(slug) => format!("AUTO_CURSEFORGE:{slug}"),
            Workload::CurseforgeZip { slug, .. } => format!("AUTO_CURSEFORGE:zip:{slug}"),
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
    // A zip pack's manifest fixes the version (read in `create`); the
    // argument may be empty then.
    let from_zip = matches!(
        args.modpack.as_ref().map(|m| m.source),
        Some(ModpackSource::CurseforgeZip)
    );
    let version = if from_zip && args.mc_version.trim().is_empty() {
        String::new()
    } else {
        normalize_version(&args.mc_version)?
    };
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
    validate_extra_ports(&args.extra_ports, args.game_port, args.rcon_port)?;
    let workload = match &args.modpack {
        None => Workload::Loader(args.loader.itzg_type()),
        Some(modpack) if modpack.source == ModpackSource::CurseforgeZip => {
            let host_path = modpack.project.trim();
            if host_path.is_empty() {
                return Err(Error::InvalidInput("choose the modpack zip".into()));
            }
            Workload::CurseforgeZip {
                host_path: host_path.into(),
                slug: crate::cfpack::DEFAULT_SLUG.into(),
            }
        }
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
                ModpackSource::Curseforge | ModpackSource::CurseforgeZip => {
                    Workload::Curseforge(slug)
                }
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
        // The zip is copied to CONTAINER_PATH before the first start (§3.13).
        Workload::CurseforgeZip { slug, .. } => format!(
            "TYPE=AUTO_CURSEFORGE\nCF_SLUG={slug}\nCF_MODPACK_ZIP={}\n",
            crate::cfpack::CONTAINER_PATH
        ),
    };
    format!(
        "EULA=TRUE\n{what}MEMORY={memory_mb}M\nENABLE_RCON=true\nRCON_PASSWORD={rcon_password}\n"
    )
}

/// `run -d` - or, with a pack zip that must be inside before the first
/// start, `create` + `cp` + `start` (§3.13). A `cp`/`start` failure is
/// reported like a failed `run`: the caller removes the half-made container
/// and the pids-limit retry can still read the runtime's words.
async fn launch(
    runtime: &dyn crate::runtime::Runtime,
    spec: &ContainerSpec,
    zip: Option<&std::path::Path>,
) -> Result<crate::runtime::ExecOutput> {
    let Some(zip) = zip else {
        return runtime.run_detached(spec).await;
    };
    let created = runtime.create(spec).await?;
    if !created.success() {
        return Ok(created);
    }
    let failed = |e: Error| crate::runtime::ExecOutput {
        stdout: String::new(),
        stderr: e.to_string(),
        exit_code: Some(1),
    };
    if let Err(e) = runtime
        .cp_to(&spec.name, zip, crate::cfpack::CONTAINER_PATH)
        .await
    {
        return Ok(failed(e));
    }
    Ok(match runtime.start(&spec.name).await {
        Ok(()) => crate::runtime::ExecOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
        },
        Err(e) => failed(e),
    })
}

/// §3.13 step 6: can the host port be bound right now?
fn ensure_port_free(bind: Ipv4Addr, port: u16) -> Result<()> {
    ensure_port_free_proto(bind, port, PortProtocol::Tcp)
}

fn ensure_port_free_proto(bind: Ipv4Addr, port: u16, protocol: PortProtocol) -> Result<()> {
    let bound = match protocol {
        PortProtocol::Tcp => TcpListener::bind((bind, port)).map(drop),
        PortProtocol::Udp => UdpSocket::bind((bind, port)).map(drop),
    };
    bound.map_err(|e| {
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
    let mut plan = validate(args)?;
    let name = args.container_name.as_str();

    // A zip pack: its manifest says what it is (§3.13).
    let zip = match &plan.workload {
        Workload::CurseforgeZip { host_path, .. } => {
            let info = crate::cfpack::inspect(&host_path.to_string_lossy()).await?;
            let host_path = crate::mods::validate_upload_source(host_path).await?;
            plan.version = info.mc_version.clone();
            plan.workload = Workload::CurseforgeZip {
                host_path: host_path.clone(),
                slug: crate::cfpack::slug_for(&info.name),
            };
            Some(host_path)
        }
        _ => None,
    };

    let runtime = crate::runtime::resolve(&settings.advanced).await?;
    if runtime.ps_state(name).await?.exists {
        return Err(Error::ContainerExists(format!(
            "a container named '{name}' already exists - attach to it in the server's settings"
        )));
    }

    let game_bind = if args.expose_to_network {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    };
    ensure_port_free(game_bind, args.game_port)?;
    ensure_port_free(Ipv4Addr::LOCALHOST, args.rcon_port)?;

    let java_major = required_java_major(core, &plan.version).await;
    if zip.is_some() && matches!(java_major, Some(0..=8)) {
        // The java8 image carries no CurseForge API key (image docs), and
        // MineUI does not take one.
        return Err(Error::InvalidInput(format!(
            "this pack is for Minecraft {}, which runs on Java 8; the java8 image cannot download CurseForge files",
            plan.version
        )));
    }
    let tag = image_tag_for_java(java_major);
    let image = format!("{ITZG_IMAGE}:{tag}");
    let rcon_password = crate::instance::generate_rcon_password();

    let env_file = write_env_file(
        &core.paths.data_dir.join("tmp"),
        &env_file_body(&plan, args.memory_mb, &rcon_password),
    )
    .await?;
    let (game_bind, local_bind) = bind_addresses(runtime.as_ref(), args.expose_to_network).await;
    let spec = ContainerSpec {
        name: name.to_string(),
        image: image.clone(),
        env_file: env_file.clone(),
        ports: published_ports(
            game_bind,
            local_bind,
            args.game_port,
            args.rcon_port,
            &args.extra_ports,
        ),
        volume: (format!("{name}-data"), DATA_PATH.to_string()),
        labels: managed_labels(),
        pids_limit: None,
    };
    let mut outcome = launch(runtime.as_ref(), &spec, zip.as_deref()).await;
    if let Ok(out) = &outcome {
        if !out.success() && crate::runtime::is_pids_controller_unavailable(&out.stderr) {
            // The runtime's default pids limit cannot be applied on this
            // machine (§3.13; Podman on WSL without pids delegation). The
            // container it half-made is ours to remove; then once more with
            // no limit at all.
            let _ = runtime.remove_force(name, false).await;
            let retry = ContainerSpec {
                pids_limit: Some(0),
                ..spec
            };
            outcome = launch(runtime.as_ref(), &retry, zip.as_deref()).await;
        }
    }
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

/* ---------- update_container_ports (§3.13, 2.11.0) ---------- */

/// A container state in which it may be renamed and replaced.
pub fn is_stopped_status(status: Option<&str>) -> bool {
    matches!(
        status.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("exited" | "created" | "stopped" | "configured" | "dead" | "initialized")
    ) || status.is_some_and(|s| s.trim().to_ascii_lowercase().starts_with("exited"))
}

/// The environment the new container gets through its env file: the old
/// container's, minus what its image defines with the same value (`PATH`,
/// `JAVA_HOME`, the image's own defaults) - those come from the image again.
/// Keys an env file cannot carry are dropped.
pub fn env_to_carry(
    container_env: &[(String, String)],
    image_env: &[(String, String)],
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (key, value) in container_env {
        let key_ok = !key.is_empty() && !key.contains(|c: char| c.is_whitespace() || c == '=');
        if !key_ok || value.contains(['\n', '\r']) {
            continue;
        }
        if image_env.iter().any(|(k, v)| k == key && v == value) {
            continue;
        }
        match out.iter_mut().find(|(k, _)| k == key) {
            Some(seen) => seen.1 = value.clone(),
            None => out.push((key.clone(), value.clone())),
        }
    }
    out
}

/// `KEY=VALUE` lines for `--env-file`.
pub fn env_file_from_pairs(pairs: &[(String, String)]) -> String {
    pairs.iter().map(|(k, v)| format!("{k}={v}\n")).collect()
}

/// The audit detail: `network` / `this computer`, then `; +<port>/<proto>`.
pub fn ports_audit_detail(expose_to_network: bool, extra: &[ExtraPort]) -> String {
    let mut detail = if expose_to_network {
        "network".to_string()
    } else {
        "this computer".to_string()
    };
    for p in extra {
        detail.push_str(&format!("; +{}/{}", p.port, p.protocol.as_str()));
    }
    detail
}

fn runtime_reason(out: &crate::runtime::ExecOutput) -> String {
    if out.stderr.is_empty() {
        out.stdout.trim().to_string()
    } else {
        out.stderr.clone()
    }
}

/// Steps 8-9: set the old container aside, create the new one under its
/// name, then remove the old one - or, on any failure, remove the half-made
/// new one and put the old one back.
pub(crate) async fn swap_container(runtime: &dyn Runtime, spec: &ContainerSpec) -> Result<()> {
    let name = spec.name.as_str();
    let old = format!("{name}{OLD_SUFFIX}");
    runtime.rename(name, &old).await.map_err(|e| {
        Error::ContainerCreateFailed(format!("could not set the old container aside: {e}"))
    })?;
    let mut outcome = runtime.create(spec).await;
    if let Ok(out) = &outcome {
        if !out.success() && crate::runtime::is_pids_controller_unavailable(&out.stderr) {
            let _ = runtime.remove_force(name, false).await;
            let retry = ContainerSpec {
                pids_limit: Some(0),
                ..spec.clone()
            };
            outcome = runtime.create(&retry).await;
        }
    }
    let failure = match outcome {
        Ok(out) if out.success() => None,
        Ok(out) => Some(runtime_reason(&out)),
        Err(e) => Some(e.to_string()),
    };
    if let Some(reason) = failure {
        // The old container carries the other name now, so whatever has
        // this name is the half-made new one.
        let _ = runtime.remove_force(name, false).await;
        return Err(Error::ContainerCreateFailed(match runtime.rename(&old, name).await {
            Ok(()) => format!(
                "{} could not create the container with the new ports: {reason}. The old container is back, unchanged.",
                runtime.kind()
            ),
            Err(e) => format!(
                "{} could not create the container with the new ports: {reason}. The old container could not be renamed back ({e}); it is kept as '{old}' - rename it to '{name}' to use it again.",
                runtime.kind()
            ),
        }));
    }
    // The old container's volume is the new one's; `rm -f` without `-v`
    // never removes a named volume.
    let _ = runtime.remove_force(&old, false).await;
    Ok(())
}

/// The pids limit a rebuilt container keeps (2.11.1): `Some(0)` only when
/// the old one has none - set by the create retry or the start fallback
/// (§3.2) because this machine cannot apply one. Anything else, including an
/// unreadable value, gets the runtime's default again: `--pids-limit=0`
/// breaks forking under systemd, so it is never applied by default.
pub(crate) async fn pids_limit_to_keep(runtime: &dyn Runtime, name: &str) -> Option<i64> {
    match runtime.inspect_pids_limit(name).await {
        Ok(Some(0)) => Some(0),
        _ => None,
    }
}

async fn update_ports_inner(
    core: &crate::Core,
    expose_to_network: bool,
    extra_ports: &[ExtraPort],
    confirm: bool,
) -> Result<()> {
    let settings = core.settings().await;
    if settings.active_mode != Mode::Advanced {
        return Err(Error::WrongMode(
            "changing a container's ports is only available in advanced mode".into(),
        ));
    }
    if !confirm {
        return Err(Error::InvalidInput(
            "update_container_ports requires confirm: true".into(),
        ));
    }
    let advanced = &settings.advanced;
    let (game_port, rcon_port) = (advanced.query_port, advanced.rcon_port);
    validate_extra_ports(extra_ports, game_port, rcon_port)?;
    let name = advanced.container_name.as_str();
    let runtime = crate::runtime::resolve(advanced).await?;
    let detail = runtime.ps_state(name).await?;
    if !detail.exists {
        return Err(Error::ContainerNotFound(format!(
            "container '{name}' does not exist"
        )));
    }
    if !is_stopped_status(detail.status.as_deref()) {
        return Err(Error::ServerRunning(
            "Stop the server before changing its ports.".into(),
        ));
    }
    let (can, why_not) = crate::joininfo::rebuild_check(runtime.as_ref(), name).await;
    if !can {
        return Err(Error::InvalidInput(
            why_not.unwrap_or_else(|| crate::joininfo::WHY_NOT_FOREIGN.to_string()),
        ));
    }
    let old = format!("{name}{OLD_SUFFIX}");
    if runtime.ps_state(&old).await?.exists {
        return Err(Error::InvalidInput(format!(
            "a container named '{old}' is left over from an earlier port change - check it and remove it, then try again"
        )));
    }

    let Some(image) = runtime.inspect_image(name).await? else {
        return Err(Error::Internal(format!(
            "cannot read the image of container '{name}'"
        )));
    };
    let mounts = runtime.inspect_mounts(name).await?;
    let volume = match plan_data_deletion(&mounts) {
        DataPlan::NamedVolume(volume) => volume,
        _ => {
            return Err(Error::InvalidInput(format!(
                "container '{name}' has no named volume at /data, so MineUI cannot rebuild it without losing the world"
            )))
        }
    };
    let env = env_to_carry(
        &runtime.inspect_env(name).await?,
        &runtime.image_env(&image).await?,
    );

    // The new bindings must be free: `create` does not check them, and a
    // container that only fails at its first start is worse than a refusal.
    let (game_bind, local_bind) = bind_addresses(runtime.as_ref(), expose_to_network).await;
    let probe = |bind: &Option<String>| match bind.as_deref() {
        Some(LOOPBACK) => Ipv4Addr::LOCALHOST,
        _ => Ipv4Addr::UNSPECIFIED,
    };
    ensure_port_free(probe(&game_bind), game_port)?;
    for p in extra_ports {
        ensure_port_free_proto(probe(&game_bind), p.port, p.protocol)?;
    }

    let pids_limit = pids_limit_to_keep(runtime.as_ref(), name).await;
    let env_file =
        write_env_file(&core.paths.data_dir.join("tmp"), &env_file_from_pairs(&env)).await?;
    let spec = ContainerSpec {
        name: name.to_string(),
        image,
        env_file: env_file.clone(),
        ports: published_ports(game_bind, local_bind, game_port, rcon_port, extra_ports),
        volume: (volume, DATA_PATH.to_string()),
        labels: managed_labels(),
        pids_limit,
    };
    core.logs.shutdown().await;
    let result = swap_container(runtime.as_ref(), &spec).await;
    let _ = tokio::fs::remove_file(&env_file).await;
    *core.container_kind.lock().unwrap() = None;
    result
}

/// `update_container_ports` (§3.13, 2.11.0), audited as `container.ports`.
pub async fn update_ports(
    core: &crate::Core,
    expose_to_network: bool,
    extra_ports: &[ExtraPort],
    confirm: bool,
) -> Result<ServerState> {
    let result = update_ports_inner(core, expose_to_network, extra_ports, confirm).await;
    let settings = core.settings().await;
    crate::audit::record(
        core,
        AuditSource::User,
        "container.ports",
        Some(settings.advanced.container_name.as_str()),
        Some(&ports_audit_detail(expose_to_network, extra_ports)),
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
            extra_ports: vec![],
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

    fn port(port: u16, protocol: PortProtocol) -> ExtraPort {
        ExtraPort { port, protocol }
    }

    #[test]
    fn extra_port_rules() {
        use PortProtocol::{Tcp, Udp};
        validate_extra_ports(&[], 25565, 25575).unwrap();
        validate_extra_ports(&[port(24454, Udp), port(8100, Tcp)], 25565, 25575).unwrap();
        // UDP on the game port's number is another port.
        validate_extra_ports(&[port(25565, Udp)], 25565, 25575).unwrap();
        // Same number, both protocols: two ports.
        validate_extra_ports(&[port(24454, Udp), port(24454, Tcp)], 25565, 25575).unwrap();

        for (bad, why) in [
            (vec![port(0, Udp)], "1-65535"),
            (vec![port(25565, Tcp)], "game port"),
            (vec![port(25575, Tcp)], "RCON port"),
            (vec![port(24454, Udp), port(24454, Udp)], "twice"),
        ] {
            let err = validate_extra_ports(&bad, 25565, 25575).unwrap_err();
            assert_eq!(err.code(), "INVALID_INPUT");
            assert!(err.to_string().contains(why), "{err}");
        }
        let many: Vec<ExtraPort> = (0..17).map(|i| port(30000 + i, Tcp)).collect();
        assert!(validate_extra_ports(&many, 25565, 25575).is_err());
        validate_extra_ports(&many[..16], 25565, 25575).unwrap();

        // create_container applies the same rules.
        let mut a = args();
        a.extra_ports = vec![port(a.game_port, Tcp)];
        assert_eq!(validate(&a).unwrap_err().code(), "INVALID_INPUT");
        a.extra_ports = vec![port(a.game_port, Udp)];
        validate(&a).unwrap();
    }

    #[test]
    fn extra_ports_follow_the_game_port_bind() {
        let extra = [
            port(24454, PortProtocol::Udp),
            port(8100, PortProtocol::Tcp),
        ];
        let args_of = |ports: Vec<PublishedPort>| ports.iter().map(|p| p.arg()).collect::<Vec<_>>();
        // Network: game and extras on every interface, RCON local.
        assert_eq!(
            args_of(published_ports(
                Some(ALL_INTERFACES.into()),
                Some(LOOPBACK.into()),
                25566,
                25576,
                &extra
            )),
            [
                "0.0.0.0:25566:25565",
                "127.0.0.1:25576:25575",
                "0.0.0.0:24454:24454/udp",
                "0.0.0.0:8100:8100"
            ]
        );
        // This computer only.
        assert_eq!(
            args_of(published_ports(
                Some(LOOPBACK.into()),
                Some(LOOPBACK.into()),
                25566,
                25576,
                &extra
            )),
            [
                "127.0.0.1:25566:25565",
                "127.0.0.1:25576:25575",
                "127.0.0.1:24454:24454/udp",
                "127.0.0.1:8100:8100"
            ]
        );
        // Windows + Podman WSL machine, local: no address anywhere.
        assert_eq!(
            args_of(published_ports(None, None, 25566, 25576, &extra)),
            ["25566:25565", "25576:25575", "24454:24454/udp", "8100:8100"]
        );
    }

    #[test]
    fn carried_env_drops_the_image_defaults_only() {
        let kv = |k: &str, v: &str| (k.to_string(), v.to_string());
        let image = [
            kv("PATH", "/opt/java/openjdk/bin:/usr/bin"),
            kv("JAVA_HOME", "/opt/java/openjdk"),
            kv("TYPE", "VANILLA"),
            kv("VERSION", "LATEST"),
            kv("EULA", ""),
        ];
        let container = [
            kv("PATH", "/opt/java/openjdk/bin:/usr/bin"),
            kv("JAVA_HOME", "/opt/java/openjdk"),
            kv("EULA", "TRUE"),
            kv("TYPE", "FABRIC"),
            kv("VERSION", "1.21.1"),
            kv("MEMORY", "2048M"),
            kv("RCON_PASSWORD", "abc=def"),
            kv("bad key", "x"),
            kv("", "x"),
        ];
        let carried = env_to_carry(&container, &image);
        assert_eq!(
            carried,
            [
                kv("EULA", "TRUE"),
                kv("TYPE", "FABRIC"),
                kv("VERSION", "1.21.1"),
                kv("MEMORY", "2048M"),
                kv("RCON_PASSWORD", "abc=def"),
            ]
        );
        assert_eq!(
            env_file_from_pairs(&carried),
            "EULA=TRUE\nTYPE=FABRIC\nVERSION=1.21.1\nMEMORY=2048M\nRCON_PASSWORD=abc=def\n"
        );
        // A vanilla LATEST server equals the image defaults: those come back
        // from the image, so dropping them changes nothing.
        let vanilla = env_to_carry(&[kv("TYPE", "VANILLA"), kv("EULA", "TRUE")], &image);
        assert_eq!(vanilla, [kv("EULA", "TRUE")]);
    }

    #[test]
    fn stopped_states_and_audit_detail() {
        for s in [
            "exited",
            "Exited (0) 5 minutes ago",
            "created",
            "stopped",
            "configured",
        ] {
            assert!(is_stopped_status(Some(s)), "{s}");
        }
        for s in [
            "running",
            "Up 5 minutes",
            "paused",
            "restarting",
            "removing",
        ] {
            assert!(!is_stopped_status(Some(s)), "{s}");
        }
        assert!(!is_stopped_status(None));
        assert_eq!(
            ports_audit_detail(true, &[port(24454, PortProtocol::Udp)]),
            "network; +24454/udp"
        );
        assert_eq!(ports_audit_detail(false, &[]), "this computer");
    }

    /// Records the calls `swap_container` makes; only those are implemented.
    struct FakeRuntime {
        calls: std::sync::Mutex<Vec<String>>,
        create_ok: bool,
        rename_back_ok: bool,
    }

    impl FakeRuntime {
        fn new(create_ok: bool, rename_back_ok: bool) -> Self {
            FakeRuntime {
                calls: Default::default(),
                create_ok,
                rename_back_ok,
            }
        }
        fn log(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl Runtime for FakeRuntime {
        fn kind(&self) -> &'static str {
            "podman"
        }
        async fn rename(&self, old: &str, new: &str) -> Result<()> {
            self.log(format!("rename {old} {new}"));
            if !self.rename_back_ok && old.ends_with(OLD_SUFFIX) {
                return Err(Error::Internal("rename failed".into()));
            }
            Ok(())
        }
        async fn create(&self, spec: &ContainerSpec) -> Result<crate::runtime::ExecOutput> {
            self.log(format!("create {}", spec.name));
            Ok(crate::runtime::ExecOutput {
                stdout: String::new(),
                stderr: if self.create_ok {
                    String::new()
                } else {
                    "Error: image not known".into()
                },
                exit_code: Some(if self.create_ok { 0 } else { 125 }),
            })
        }
        async fn remove_force(&self, name: &str, anonymous_volumes: bool) -> Result<()> {
            assert!(!anonymous_volumes, "a port change never drops volumes");
            self.log(format!("rm {name}"));
            Ok(())
        }
        async fn ps_state(&self, _: &str) -> Result<crate::model::ContainerDetail> {
            unimplemented!()
        }
        async fn start(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn stop(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn restart(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn logs_tail(&self, _: &str, _: u32) -> Result<Vec<String>> {
            unimplemented!()
        }
        async fn spawn_follow_logs(&self, _: &str) -> Result<tokio::process::Child> {
            unimplemented!()
        }
        async fn exec(&self, _: &str, _: &[&str]) -> Result<crate::runtime::ExecOutput> {
            unimplemented!()
        }
        async fn run_with_volumes_from(
            &self,
            _: &str,
            _: &[&str],
        ) -> Result<crate::runtime::ExecOutput> {
            unimplemented!()
        }
        async fn cp_to(&self, _: &str, _: &Path, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn cp_from(&self, _: &str, _: &str, _: &Path) -> Result<()> {
            unimplemented!()
        }
        async fn stats(&self, _: &str) -> Result<crate::runtime::RawStats> {
            unimplemented!()
        }
        async fn inspect_started_at(&self, _: &str) -> Result<Option<String>> {
            unimplemented!()
        }
        async fn inspect_env(&self, _: &str) -> Result<Vec<(String, String)>> {
            unimplemented!()
        }
        async fn run_detached(&self, _: &ContainerSpec) -> Result<crate::runtime::ExecOutput> {
            unimplemented!()
        }
        async fn inspect_mounts(&self, _: &str) -> Result<Vec<Mount>> {
            unimplemented!()
        }
        async fn remove_volume(&self, _: &str) -> Result<()> {
            panic!("a port change never removes a volume")
        }
        async fn inspect_ports(&self, _: &str) -> Result<Vec<crate::runtime::PortBinding>> {
            unimplemented!()
        }
        async fn inspect_pids_limit(&self, _: &str) -> Result<Option<i64>> {
            unimplemented!()
        }
        async fn set_pids_limit_unlimited(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn inspect_labels(&self, _: &str) -> Result<Vec<(String, String)>> {
            unimplemented!()
        }
        async fn inspect_image(&self, _: &str) -> Result<Option<String>> {
            unimplemented!()
        }
        async fn image_env(&self, _: &str) -> Result<Vec<(String, String)>> {
            unimplemented!()
        }
        async fn machine_vm_type(&self) -> Option<String> {
            None
        }
        async fn machine_rootful(&self) -> Option<bool> {
            None
        }
        async fn machine_name(&self) -> Option<String> {
            None
        }
    }

    fn swap_spec() -> ContainerSpec {
        ContainerSpec {
            name: "mc".into(),
            image: "docker.io/itzg/minecraft-server:java21".into(),
            env_file: "/tmp/x.env".into(),
            ports: vec![],
            volume: ("mc-data".into(), "/data".into()),
            labels: managed_labels(),
            pids_limit: None,
        }
    }

    #[tokio::test]
    async fn swap_replaces_the_container_and_drops_the_old_one() {
        let rt = FakeRuntime::new(true, true);
        swap_container(&rt, &swap_spec()).await.unwrap();
        assert_eq!(
            rt.calls(),
            ["rename mc mc-mineui-old", "create mc", "rm mc-mineui-old"]
        );
    }

    #[tokio::test]
    async fn a_failed_swap_puts_the_old_container_back() {
        let rt = FakeRuntime::new(false, true);
        let err = swap_container(&rt, &swap_spec()).await.unwrap_err();
        assert_eq!(err.code(), "CONTAINER_CREATE_FAILED");
        assert!(err.to_string().contains("image not known"), "{err}");
        assert!(err.to_string().contains("back, unchanged"), "{err}");
        assert_eq!(
            rt.calls(),
            [
                "rename mc mc-mineui-old",
                "create mc",
                "rm mc",
                "rename mc-mineui-old mc"
            ]
        );

        // Even the rename back failed: the message says where the old one is.
        let rt = FakeRuntime::new(false, false);
        let err = swap_container(&rt, &swap_spec()).await.unwrap_err();
        assert!(err.to_string().contains("kept as 'mc-mineui-old'"), "{err}");
        assert!(!rt.calls().contains(&"rm mc-mineui-old".to_string()));
    }

    #[tokio::test]
    async fn a_rebuild_keeps_a_lifted_pids_limit_only() {
        use crate::fake_runtime::FakeRuntime as Scripted;
        for (old, flag) in [(Some(0), true), (Some(2048), false), (None, false)] {
            let rt = Scripted {
                pids_limit: old,
                ..Default::default()
            };
            let spec = ContainerSpec {
                pids_limit: pids_limit_to_keep(&rt, "mc").await,
                ..swap_spec()
            };
            swap_container(&rt, &spec).await.unwrap();
            let create = rt
                .calls()
                .into_iter()
                .find(|c| c.starts_with("create "))
                .expect("a create call");
            assert_eq!(
                create.split(' ').any(|a| a == "--pids-limit=0"),
                flag,
                "old {old:?}: {create}"
            );
            assert!(!create.contains("--pids-limit=2048"), "{create}");
        }
    }

    #[tokio::test]
    async fn port_update_is_gated_before_the_runtime_is_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        assert_eq!(
            update_ports(&core, true, &[], true)
                .await
                .unwrap_err()
                .code(),
            "WRONG_MODE"
        );
        let mut s = core.settings().await;
        s.active_mode = Mode::Advanced;
        let game = s.advanced.query_port;
        core.update_settings(s).await.unwrap();
        assert_eq!(
            update_ports(&core, true, &[], false)
                .await
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );
        assert_eq!(
            update_ports(&core, true, &[port(game, PortProtocol::Tcp)], true)
                .await
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );
        let log = crate::audit::recent(&core, None).await.unwrap();
        let refused: Vec<_> = log
            .entries
            .iter()
            .filter(|e| e.action == "container.ports" && !e.ok)
            .collect();
        assert_eq!(refused.len(), 3, "refused attempts are in the activity log");
        assert!(!tmp.path().join("data/tmp").exists());
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

        // CurseForge: the pack file fixes the version, so none is sent - the
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
