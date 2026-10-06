//! Container runtime adapter (module map §8): `trait Runtime` over the
//! podman/docker CLIs. **All subprocess calls use argv arrays** - the only
//! `sh -c` permitted anywhere is a compile-time-constant script with zero
//! interpolation (used for directory listings, see `mods`/`backups`).

use std::path::Path;
use std::process::Stdio;

use async_trait::async_trait;

use crate::error::{Error, Result};
use crate::model::{ContainerDetail, PortProtocol, RuntimeHit, RuntimeProbe};
use crate::settings::{AdvancedModeSettings, RuntimeKind};

#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Everything `run_detached` needs to make a new container (§3.13). Built by
/// `provision`; the argv is assembled here so CLI knowledge stays in one file.
#[derive(Debug, Clone)]
pub struct ContainerSpec {
    pub name: String,
    /// Full image reference including the tag.
    pub image: String,
    /// `KEY=VALUE` lines; keeps secrets out of the argv.
    pub env_file: std::path::PathBuf,
    /// Published ports, in argv order.
    pub ports: Vec<PublishedPort>,
    /// (named volume, container path).
    pub volume: (String, String),
    /// `--label key=value` pairs (2.11.0: the managed marker).
    pub labels: Vec<(String, String)>,
    /// `None` leaves the runtime's own default; `Some(0)` asks for no pids
    /// limit at all - the one retry of §3.13, where the default cannot be
    /// applied.
    pub pids_limit: Option<i64>,
}

/// One `-p` of a new container (§3.13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedPort {
    /// Host bind address; `None` publishes on every interface the runtime
    /// has (the Windows + WSL case of §3.13).
    pub bind: Option<String>,
    pub host: u16,
    pub container: u16,
    pub protocol: PortProtocol,
}

impl PublishedPort {
    pub fn tcp(bind: Option<String>, host: u16, container: u16) -> Self {
        PublishedPort {
            bind,
            host,
            container,
            protocol: PortProtocol::Tcp,
        }
    }

    /// The `-p` value: `[bind:]host:container[/udp]`.
    pub fn arg(&self) -> String {
        let suffix = match self.protocol {
            PortProtocol::Tcp => "",
            PortProtocol::Udp => "/udp",
        };
        match &self.bind {
            Some(bind) => format!("{bind}:{}:{}{suffix}", self.host, self.container),
            None => format!("{}:{}{suffix}", self.host, self.container),
        }
    }
}

/// One configured port binding of a container, from `inspect` (§3.16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortBinding {
    pub container_port: u16,
    pub protocol: PortProtocol,
    /// As the runtime reports it; empty means every interface (docker).
    pub host_ip: String,
    pub host_port: u16,
}

impl ContainerSpec {
    /// The `run -d` argv (without the binary).
    pub fn run_args(&self) -> Vec<String> {
        self.argv(&["run", "-d"])
    }

    /// The `create` argv: the same container, not started (§3.13 zip packs).
    pub fn create_args(&self) -> Vec<String> {
        self.argv(&["create"])
    }

    fn argv(&self, verb: &[&str]) -> Vec<String> {
        let mut args: Vec<String> = verb.iter().map(|s| (*s).to_string()).collect();
        args.extend([
            "--name".into(),
            self.name.clone(),
            "--env-file".into(),
            self.env_file.to_string_lossy().to_string(),
        ]);
        for (key, value) in &self.labels {
            args.push("--label".into());
            args.push(format!("{key}={value}"));
        }
        for port in &self.ports {
            args.push("-p".into());
            args.push(port.arg());
        }
        args.push("-v".into());
        args.push(format!("{}:{}", self.volume.0, self.volume.1));
        if let Some(limit) = self.pids_limit {
            args.push(format!("--pids-limit={limit}"));
        }
        args.push(self.image.clone());
        args
    }
}

/// Did `run` fail because the runtime could not apply a pids limit? The
/// text is crun's ("controller `pids` is not available under …"); runc has
/// no equivalent because it does not check first. Matched loosely since
/// podman wraps it and users paste it without the backticks.
pub fn is_pids_controller_unavailable(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("controller") && text.contains("pids") && text.contains("is not available")
}

/// One mount of a container, from `inspect`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mount {
    /// "volume" or "bind" (as the runtime reports it).
    pub kind: String,
    /// Volume name; empty for a bind mount.
    pub name: String,
    /// Host path backing the mount.
    pub source: String,
    /// Path inside the container.
    pub destination: String,
}

impl Mount {
    /// Runtimes name an anonymous volume with a 64-character hex id.
    pub fn is_anonymous_volume(&self) -> bool {
        self.kind == "volume"
            && self.name.len() == 64
            && self.name.chars().all(|c| c.is_ascii_hexdigit())
    }
}

/// Raw (pre-normalization) container stats parsed from `stats --no-stream`.
#[derive(Debug, Clone, Default)]
pub struct RawStats {
    pub cpu_percent: Option<f64>,
    pub mem_used_bytes: Option<u64>,
    pub mem_total_bytes: Option<u64>,
    pub mem_percent: Option<f64>,
    pub net_input_bytes: Option<u64>,
    pub net_output_bytes: Option<u64>,
    pub block_input_bytes: Option<u64>,
    pub block_output_bytes: Option<u64>,
}

#[async_trait]
pub trait Runtime: Send + Sync {
    /// "podman" or "docker".
    fn kind(&self) -> &'static str;

    /// `ps --all --filter name=^<name>$ --format json`.
    async fn ps_state(&self, name: &str) -> Result<ContainerDetail>;
    async fn start(&self, name: &str) -> Result<()>;
    async fn stop(&self, name: &str) -> Result<()>;
    async fn restart(&self, name: &str) -> Result<()>;
    /// `logs --tail N <name>` (stdout + stderr merged, v1 parity).
    async fn logs_tail(&self, name: &str, tail: u32) -> Result<Vec<String>>;
    /// Spawn `logs --follow --tail 0 <name>`; caller owns the child.
    async fn spawn_follow_logs(&self, name: &str) -> Result<tokio::process::Child>;
    /// `exec <name> <argv...>` - argv array, never a shell string.
    /// Only works on a **running** container.
    async fn exec(&self, name: &str, argv: &[&str]) -> Result<ExecOutput>;
    /// `run --rm --volumes-from <name> --entrypoint <argv0> <image> <argv1..>`
    /// where `<image>` is `<name>`'s own image (via inspect). Unlike `exec`
    /// this works while the container is **stopped** (verified live on
    /// rootless podman 4.9.3) - restore uses it, since restore requires the
    /// server stopped and `exec` cannot run in a stopped container.
    async fn run_with_volumes_from(&self, name: &str, argv: &[&str]) -> Result<ExecOutput>;
    /// `cp <host_src> <name>:<container_dest>`.
    async fn cp_to(&self, name: &str, host_src: &Path, container_dest: &str) -> Result<()>;
    /// `cp <name>:<container_src> <host_dest>` (works on stopped containers too).
    async fn cp_from(&self, name: &str, container_src: &str, host_dest: &Path) -> Result<()>;
    /// `stats --no-stream --format json <name>`.
    async fn stats(&self, name: &str) -> Result<RawStats>;
    /// `inspect -f {{.State.StartedAt}} <name>` → normalized RFC 3339.
    async fn inspect_started_at(&self, name: &str) -> Result<Option<String>>;
    /// The container's configured environment as (key, value) pairs; empty
    /// when the container cannot be inspected.
    async fn inspect_env(&self, name: &str) -> Result<Vec<(String, String)>>;
    /// `run -d …` per `spec` (§3.13). Pulls the image when missing, so this
    /// can take minutes. The raw outcome is returned for the caller to map.
    async fn run_detached(&self, spec: &ContainerSpec) -> Result<ExecOutput>;
    /// `create …` - the same container as `run_detached`, not started; for a
    /// pack zip that `cp` must put in place first (§3.13).
    async fn create(&self, spec: &ContainerSpec) -> Result<ExecOutput>;
    /// `rm -f <name>` (`rm -f -v` with `anonymous_volumes`). Callers: the
    /// cleanup of a container this app failed to finish creating, and the
    /// explicitly confirmed `delete_container` (§3.13). Nothing else.
    async fn remove_force(&self, name: &str, anonymous_volumes: bool) -> Result<()>;
    /// The container's mounts; empty when it cannot be inspected.
    async fn inspect_mounts(&self, name: &str) -> Result<Vec<Mount>>;
    /// `volume rm <volume>` - `delete_container` with `deleteData` only.
    async fn remove_volume(&self, volume: &str) -> Result<()>;
    /// The configured port bindings (`.HostConfig.PortBindings`, present on a
    /// stopped container too). An error carrying the runtime's own words when
    /// the container cannot be inspected (2.11.1; it used to be empty).
    async fn inspect_ports(&self, name: &str) -> Result<Vec<PortBinding>>;
    /// `inspect -f {{.HostConfig.PidsLimit}}`: the container's pids limit
    /// (`Some(0)` = none asked for), `None` when unset or unreadable output;
    /// an error when the command fails (2.11.1).
    async fn inspect_pids_limit(&self, name: &str) -> Result<Option<i64>>;
    /// `update --pids-limit=0 <name>`: lift the pids limit of an existing,
    /// stopped container in place (§3.2 start fallback, 2.11.1).
    async fn set_pids_limit_unlimited(&self, name: &str) -> Result<()>;
    /// The container's labels (image labels included); empty when it cannot
    /// be inspected.
    async fn inspect_labels(&self, name: &str) -> Result<Vec<(String, String)>>;
    /// The image reference the container was created from (`.Config.Image`),
    /// `None` when it cannot be inspected.
    async fn inspect_image(&self, name: &str) -> Result<Option<String>>;
    /// The environment an image defines itself (`image inspect`); empty when
    /// the image cannot be inspected.
    async fn image_env(&self, image: &str) -> Result<Vec<(String, String)>>;
    /// `rename <old> <new>` - only `update_container_ports` (§3.13).
    async fn rename(&self, old: &str, new: &str) -> Result<()>;
    /// Podman: `machine info --format {{.Host.VMType}}` ("wsl", "hyperv",
    /// "applehv", "qemu", …), lower-cased; `None` for docker or when the
    /// command fails. `create_container` uses it to tell whose loopback a
    /// published port lands on (§3.13).
    async fn machine_vm_type(&self) -> Option<String>;
    /// Podman: `machine inspect --format {{.Rootful}}` of the current machine.
    async fn machine_rootful(&self) -> Option<bool>;
    /// Podman: `machine info --format {{.Host.CurrentMachine}}`.
    async fn machine_name(&self) -> Option<String>;
}

/// Shared CLI backend. Podman and docker take identical argv for everything we
/// use; only environment (socket variable) and some JSON output shapes differ.
#[derive(Debug, Clone)]
pub struct CliBackend {
    pub binary: String,
    pub kind: RuntimeKind,
    pub socket_path: Option<String>,
}

impl CliBackend {
    fn command(&self, args: &[&str]) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.binary);
        crate::util::prepare_child(&mut cmd);
        cmd.args(args);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);
        if let Some(socket) = &self.socket_path {
            match self.kind {
                RuntimeKind::Docker => {
                    cmd.env("DOCKER_HOST", socket);
                }
                _ => {
                    let host = if socket.contains("://") {
                        socket.clone()
                    } else {
                        format!("unix://{socket}")
                    };
                    cmd.env("CONTAINER_HOST", host);
                }
            }
        }
        cmd
    }

    async fn run(&self, args: &[&str]) -> Result<ExecOutput> {
        let output =
            self.command(args).output().await.map_err(|e| {
                Error::RuntimeNotFound(format!("failed to run {}: {e}", self.binary))
            })?;
        Ok(ExecOutput {
            // stdout must stay raw: `exec cat` powers read_config_file, and
            // trimming here silently ate files' trailing newlines (caught by
            // the live round-trip test). Parsers trim at their own call
            // sites; stderr is only ever used in error messages.
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr)
                .trim_end()
                .to_string(),
            exit_code: output.status.code(),
        })
    }

    /// `RUNTIME_UNAVAILABLE` for this backend (§3.1, 2.9.0).
    fn unavailable(&self, stderr: &str) -> Error {
        unavailable_error(self.kind(), std::env::consts::OS, stderr)
    }

    async fn run_ok(&self, args: &[&str]) -> Result<ExecOutput> {
        let out = self.run(args).await?;
        if !out.success() {
            if engine_unreachable(&out.stderr) {
                return Err(self.unavailable(&out.stderr));
            }
            return Err(Error::Internal(format!(
                "{} {} failed: {}",
                self.binary,
                args.first().unwrap_or(&""),
                if out.stderr.is_empty() {
                    out.stdout.trim_end()
                } else {
                    out.stderr.as_str()
                }
            )));
        }
        Ok(out)
    }
}

/// Does this stderr say the CLI could not reach its engine (§3.1, 2.9.0)?
/// Docker Desktop not started, the daemon/service down, a stopped
/// `podman machine`, a dead remote socket. Matched on the runtimes' own
/// wording, lower-cased.
pub fn engine_unreachable(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "cannot connect to the docker daemon",
        "is the docker daemon running",
        "error during connect",
        "failed to connect to the docker api",
        "dockerdesktoplinuxengine",
        "cannot connect to podman",
        "unable to connect to podman",
        "podman machine start",
    ];
    if NEEDLES.iter().any(|n| text.contains(n)) {
        return true;
    }
    // A socket that is configured but not served.
    (text.contains("dial unix") || text.contains("dial tcp"))
        && (text.contains("connection refused") || text.contains("no such file or directory"))
}

/// The usual fix for an unresponsive engine, per runtime and host OS.
/// `podman machine` exists only where podman runs in a VM (Windows, macOS).
pub fn unavailable_hint(kind: &str, os: &str) -> &'static str {
    let vm_host = os == "windows" || os == "macos";
    match (kind, vm_host) {
        ("docker", true) => "start Docker Desktop and try again",
        ("docker", false) => "start the Docker service (e.g. `sudo systemctl start docker`) and try again",
        (_, true) => "run `podman machine start` (or start the machine in Podman Desktop) and try again",
        (_, false) => "check that `podman info` works in a terminal; if you use a remote socket, start that service",
    }
}

/// `RUNTIME_UNAVAILABLE` with the runtime's name, the hint, and the first
/// line of what the CLI said (trimmed; never contains secrets - it is the
/// runtime's own connection error).
pub fn unavailable_error(kind: &str, os: &str, stderr: &str) -> Error {
    // podman prints a generic "Cannot connect to Podman … try `podman
    // machine start`" banner (on Linux too) before the real `Error:` line;
    // quote the `Error:` line when there is one.
    let mut lines = stderr.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.clone().next().unwrap_or("");
    let detail: String = lines
        .find(|l| l.starts_with("Error:"))
        .unwrap_or(first)
        .chars()
        .take(300)
        .collect();
    let mut message = format!(
        "{kind} is installed but not responding - {}.",
        unavailable_hint(kind, os)
    );
    if !detail.is_empty() {
        message.push_str(&format!(" ({kind} said: {detail})"));
    }
    Error::RuntimeUnavailable(message)
}

/// The argv (without the binary) of the stopped-container helper (§3.8):
/// `run --rm --volumes-from <name> --entrypoint <argv0> <image> <argv1..>`.
/// `None` for an empty argv.
pub fn helper_run_args<'a>(
    name: &'a str,
    image: &'a str,
    argv: &[&'a str],
) -> Option<Vec<&'a str>> {
    let (entrypoint, rest) = argv.split_first()?;
    let mut args: Vec<&str> = vec![
        "run",
        "--rm",
        "--volumes-from",
        name,
        "--entrypoint",
        entrypoint,
        image,
    ];
    args.extend_from_slice(rest);
    Some(args)
}

/// How to run a command against a container's files (§3.5, §3.8, 2.9.0).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerAccess {
    /// Running: `exec` in it.
    Exec,
    /// Exists but not running: the stopped-container helper.
    Helper,
    /// No such container.
    Missing,
}

impl ContainerAccess {
    pub fn for_detail(detail: &ContainerDetail) -> Self {
        match crate::lifecycle::phase_from_container(detail) {
            crate::model::ServerPhase::NotCreated => ContainerAccess::Missing,
            crate::model::ServerPhase::Running => ContainerAccess::Exec,
            _ => ContainerAccess::Helper,
        }
    }
}

/// Run `argv` against `name`'s files whether or not it is running: `exec`
/// while it runs, the `run --rm --volumes-from` helper otherwise (2.9.0).
/// Missing container → `CONTAINER_NOT_FOUND`; an unreachable engine →
/// `RUNTIME_UNAVAILABLE` (from `ps`). The raw outcome is returned for the
/// caller to judge.
pub async fn run_in_container(
    runtime: &dyn Runtime,
    name: &str,
    argv: &[&str],
) -> Result<ExecOutput> {
    let detail = runtime.ps_state(name).await?;
    match ContainerAccess::for_detail(&detail) {
        ContainerAccess::Missing => Err(Error::ContainerNotFound(format!(
            "container '{name}' does not exist"
        ))),
        ContainerAccess::Exec => runtime.exec(name, argv).await,
        ContainerAccess::Helper => runtime.run_with_volumes_from(name, argv).await,
    }
}

/// Parse `ps --format json` output: podman emits a JSON array, docker emits
/// one JSON object per line (NDJSON).
fn parse_ps_json(stdout: &str) -> Option<serde_json::Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return match value {
            serde_json::Value::Array(items) => items.into_iter().next(),
            other => Some(other),
        };
    }
    // NDJSON: take the first parseable line.
    trimmed
        .lines()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
}

fn str_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Parse one container's `stats --format json` entry tolerantly across
/// podman/docker key spellings.
fn parse_stats_json(stdout: &str) -> RawStats {
    let Some(entry) = parse_ps_json(stdout) else {
        return RawStats::default();
    };
    let mut stats = RawStats::default();
    if let Some(cpu) = str_field(&entry, &["CPUPerc", "CPU", "cpu_percent"]) {
        stats.cpu_percent = crate::util::parse_percent(&cpu);
    }
    if let Some(mem) = str_field(&entry, &["MemUsage", "mem_usage"]) {
        let (used, total) = crate::util::parse_usage_pair(&mem);
        stats.mem_used_bytes = used;
        stats.mem_total_bytes = total;
    }
    if let Some(memp) = str_field(&entry, &["MemPerc", "mem_percent"]) {
        stats.mem_percent = crate::util::parse_percent(&memp);
    }
    if let Some(net) = str_field(&entry, &["NetIO", "net_io"]) {
        let (input, output) = crate::util::parse_usage_pair(&net);
        stats.net_input_bytes = input;
        stats.net_output_bytes = output;
    }
    if let Some(block) = str_field(&entry, &["BlockIO", "block_io"]) {
        let (input, output) = crate::util::parse_usage_pair(&block);
        stats.block_input_bytes = input;
        stats.block_output_bytes = output;
    }
    stats
}

#[async_trait]
impl Runtime for CliBackend {
    fn kind(&self) -> &'static str {
        match self.kind {
            RuntimeKind::Docker => "docker",
            _ => "podman",
        }
    }

    async fn ps_state(&self, name: &str) -> Result<ContainerDetail> {
        let filter = format!("name=^{name}$");
        let out = self
            .run(&["ps", "--all", "--filter", &filter, "--format", "json"])
            .await?;
        if !out.success() {
            // The binary ran (resolve probed `--version`), so a failing `ps`
            // is the engine, not a missing install (§3.1, 2.9.0).
            return Err(self.unavailable(&out.stderr));
        }
        let Some(container) = parse_ps_json(&out.stdout) else {
            return Ok(ContainerDetail {
                exists: false,
                id: None,
                status: None,
                created_at: None,
                started_at: None,
            });
        };
        let status = str_field(&container, &["State", "Status"]);
        Ok(ContainerDetail {
            exists: true,
            id: str_field(&container, &["Id", "ID"]),
            status,
            created_at: str_field(&container, &["CreatedAt", "Created"]),
            started_at: None, // filled by lifecycle via inspect_started_at
        })
    }

    async fn start(&self, name: &str) -> Result<()> {
        self.run_ok(&["start", name]).await.map(|_| ())
    }

    async fn stop(&self, name: &str) -> Result<()> {
        self.run_ok(&["stop", name]).await.map(|_| ())
    }

    async fn restart(&self, name: &str) -> Result<()> {
        self.run_ok(&["restart", name]).await.map(|_| ())
    }

    async fn logs_tail(&self, name: &str, tail: u32) -> Result<Vec<String>> {
        let tail_arg = tail.to_string();
        let out = self.run(&["logs", "--tail", &tail_arg, name]).await?;
        if !out.success() {
            return Err(Error::ContainerNotFound(format!(
                "cannot read logs for container '{name}': {}",
                out.stderr
            )));
        }
        // Runtimes write server console output to both streams; merge.
        let mut lines: Vec<String> = Vec::new();
        for chunk in [&out.stdout, &out.stderr] {
            for line in chunk.lines() {
                if !line.is_empty() {
                    lines.push(line.to_string());
                }
            }
        }
        Ok(lines)
    }

    async fn spawn_follow_logs(&self, name: &str) -> Result<tokio::process::Child> {
        self.command(&["logs", "--follow", "--tail", "0", name])
            .spawn()
            .map_err(|e| Error::RuntimeNotFound(format!("failed to spawn log follower: {e}")))
    }

    async fn exec(&self, name: &str, argv: &[&str]) -> Result<ExecOutput> {
        let mut args: Vec<&str> = vec!["exec", name];
        args.extend_from_slice(argv);
        self.run(&args).await
    }

    async fn run_with_volumes_from(&self, name: &str, argv: &[&str]) -> Result<ExecOutput> {
        let image_out = self.run(&["inspect", "-f", "{{.Image}}", name]).await?;
        if !image_out.success() {
            if engine_unreachable(&image_out.stderr) {
                return Err(self.unavailable(&image_out.stderr));
            }
            return Err(Error::ContainerNotFound(format!(
                "cannot inspect container '{name}': {}",
                image_out.stderr
            )));
        }
        let image = image_out.stdout.trim().to_string();
        if image.is_empty() {
            return Err(Error::ContainerNotFound(format!(
                "container '{name}' has no image"
            )));
        }
        let Some(args) = helper_run_args(name, &image, argv) else {
            return Err(Error::Internal("helper run needs a non-empty argv".into()));
        };
        self.run(&args).await
    }

    async fn cp_to(&self, name: &str, host_src: &Path, container_dest: &str) -> Result<()> {
        let src = host_src.to_string_lossy().to_string();
        let dest = format!("{name}:{container_dest}");
        self.run_ok(&["cp", &src, &dest]).await.map(|_| ())
    }

    async fn cp_from(&self, name: &str, container_src: &str, host_dest: &Path) -> Result<()> {
        let src = format!("{name}:{container_src}");
        let dest = host_dest.to_string_lossy().to_string();
        self.run_ok(&["cp", &src, &dest]).await.map(|_| ())
    }

    async fn stats(&self, name: &str) -> Result<RawStats> {
        let out = self
            .run(&["stats", "--no-stream", "--format", "json", name])
            .await?;
        if !out.success() {
            // Stopped container: degrade to empty stats (metrics never rejects
            // for "server offline").
            return Ok(RawStats::default());
        }
        Ok(parse_stats_json(&out.stdout))
    }

    async fn inspect_started_at(&self, name: &str) -> Result<Option<String>> {
        let out = self
            .run(&["inspect", "-f", "{{.State.StartedAt}}", name])
            .await?;
        if !out.success() {
            return Ok(None);
        }
        Ok(crate::util::normalize_timestamp(&out.stdout))
    }

    async fn inspect_env(&self, name: &str) -> Result<Vec<(String, String)>> {
        let out = self
            .run(&[
                "inspect",
                "-f",
                "{{range .Config.Env}}{{println .}}{{end}}",
                name,
            ])
            .await?;
        if !out.success() {
            return Ok(Vec::new());
        }
        Ok(parse_env_lines(&out.stdout))
    }

    async fn run_detached(&self, spec: &ContainerSpec) -> Result<ExecOutput> {
        let args = spec.run_args();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&args).await
    }

    async fn create(&self, spec: &ContainerSpec) -> Result<ExecOutput> {
        let args = spec.create_args();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&args).await
    }

    async fn remove_force(&self, name: &str, anonymous_volumes: bool) -> Result<()> {
        let args: &[&str] = if anonymous_volumes {
            &["rm", "-f", "-v", name]
        } else {
            &["rm", "-f", name]
        };
        self.run_ok(args).await.map(|_| ())
    }

    async fn inspect_mounts(&self, name: &str) -> Result<Vec<Mount>> {
        let out = self
            .run(&[
                "inspect",
                "-f",
                "{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}{{println}}{{end}}",
                name,
            ])
            .await?;
        if !out.success() {
            return Ok(Vec::new());
        }
        Ok(parse_mount_lines(&out.stdout))
    }

    async fn remove_volume(&self, volume: &str) -> Result<()> {
        self.run_ok(&["volume", "rm", volume]).await.map(|_| ())
    }

    async fn inspect_ports(&self, name: &str) -> Result<Vec<PortBinding>> {
        // `.HostConfig.PortBindings` is the configuration, so it is filled on
        // a stopped container too (`.NetworkSettings.Ports` is empty until it
        // runs on docker). Same shape on podman and docker.
        let out = self
            .run(&[
                "inspect",
                "-f",
                "{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{$p}}|{{.HostIp}}|{{.HostPort}}{{println}}{{end}}{{end}}",
                name,
            ])
            .await?;
        if !out.success() {
            if engine_unreachable(&out.stderr) {
                return Err(self.unavailable(&out.stderr));
            }
            let reason = if out.stderr.is_empty() {
                out.stdout.trim().to_string()
            } else {
                out.stderr.clone()
            };
            return Err(Error::Internal(reason));
        }
        Ok(parse_port_lines(&out.stdout))
    }

    async fn inspect_pids_limit(&self, name: &str) -> Result<Option<i64>> {
        let out = self
            .run_ok(&["inspect", "-f", "{{.HostConfig.PidsLimit}}", name])
            .await?;
        Ok(parse_pids_limit(&out.stdout))
    }

    async fn set_pids_limit_unlimited(&self, name: &str) -> Result<()> {
        self.run_ok(&["update", "--pids-limit=0", name])
            .await
            .map(|_| ())
    }

    async fn inspect_labels(&self, name: &str) -> Result<Vec<(String, String)>> {
        let out = self
            .run(&[
                "inspect",
                "-f",
                "{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}",
                name,
            ])
            .await?;
        if !out.success() {
            return Ok(Vec::new());
        }
        Ok(parse_env_lines(&out.stdout))
    }

    async fn inspect_image(&self, name: &str) -> Result<Option<String>> {
        let out = self
            .run(&["inspect", "-f", "{{.Config.Image}}", name])
            .await?;
        let image = out.stdout.trim();
        Ok((out.success() && !image.is_empty()).then(|| image.to_string()))
    }

    async fn image_env(&self, image: &str) -> Result<Vec<(String, String)>> {
        let out = self
            .run(&[
                "image",
                "inspect",
                "-f",
                "{{range .Config.Env}}{{println .}}{{end}}",
                image,
            ])
            .await?;
        if !out.success() {
            return Ok(Vec::new());
        }
        Ok(parse_env_lines(&out.stdout))
    }

    async fn rename(&self, old: &str, new: &str) -> Result<()> {
        self.run_ok(&["rename", old, new]).await.map(|_| ())
    }

    async fn machine_vm_type(&self) -> Option<String> {
        if self.kind == RuntimeKind::Docker {
            return None;
        }
        let out = self
            .run(&["machine", "info", "--format", "{{.Host.VMType}}"])
            .await
            .ok()?;
        let vm_type = out.stdout.trim().to_ascii_lowercase();
        (out.success() && !vm_type.is_empty()).then_some(vm_type)
    }

    async fn machine_rootful(&self) -> Option<bool> {
        if self.kind == RuntimeKind::Docker {
            return None;
        }
        let out = self
            .run(&["machine", "inspect", "--format", "{{.Rootful}}"])
            .await
            .ok()?;
        match out.stdout.trim() {
            "true" if out.success() => Some(true),
            "false" if out.success() => Some(false),
            _ => None,
        }
    }

    async fn machine_name(&self) -> Option<String> {
        if self.kind == RuntimeKind::Docker {
            return None;
        }
        let out = self
            .run(&["machine", "info", "--format", "{{.Host.CurrentMachine}}"])
            .await
            .ok()?;
        let name = out.stdout.trim().to_string();
        (out.success() && !name.is_empty()).then_some(name)
    }
}

/// `Type|Name|Source|Destination` per line → mounts; malformed lines skipped.
fn parse_mount_lines(stdout: &str) -> Vec<Mount> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim().splitn(4, '|');
            let mount = Mount {
                kind: parts.next()?.to_string(),
                name: parts.next()?.to_string(),
                source: parts.next()?.to_string(),
                destination: parts.next()?.to_string(),
            };
            (!mount.kind.is_empty() && !mount.destination.is_empty()).then_some(mount)
        })
        .collect()
}

/// `<port>/<proto>|<hostIp>|<hostPort>` per line → bindings; malformed lines
/// skipped.
fn parse_port_lines(stdout: &str) -> Vec<PortBinding> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim().splitn(3, '|');
            let (port, proto) = parts.next()?.split_once('/')?;
            let protocol = match proto.to_ascii_lowercase().as_str() {
                "tcp" => PortProtocol::Tcp,
                "udp" => PortProtocol::Udp,
                _ => return None,
            };
            let host_ip = parts.next()?.trim().to_string();
            let host_port: u16 = parts.next()?.trim().parse().ok()?;
            let container_port: u16 = port.trim().parse().ok()?;
            (host_port != 0 && container_port != 0).then_some(PortBinding {
                container_port,
                protocol,
                host_ip,
                host_port,
            })
        })
        .collect()
}

/// `{{.HostConfig.PidsLimit}}` output → the limit; `<nil>`, empty or
/// anything unparseable → `None`.
pub fn parse_pids_limit(stdout: &str) -> Option<i64> {
    stdout.trim().parse().ok()
}

/// `KEY=VALUE` per line → pairs; lines without `=` are skipped.
fn parse_env_lines(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.to_string()))
        .collect()
}

pub struct PodmanCli(pub CliBackend);
pub struct DockerCli(pub CliBackend);

macro_rules! delegate_runtime {
    ($ty:ty) => {
        #[async_trait]
        impl Runtime for $ty {
            fn kind(&self) -> &'static str {
                self.0.kind()
            }
            async fn ps_state(&self, name: &str) -> Result<ContainerDetail> {
                self.0.ps_state(name).await
            }
            async fn start(&self, name: &str) -> Result<()> {
                self.0.start(name).await
            }
            async fn stop(&self, name: &str) -> Result<()> {
                self.0.stop(name).await
            }
            async fn restart(&self, name: &str) -> Result<()> {
                self.0.restart(name).await
            }
            async fn logs_tail(&self, name: &str, tail: u32) -> Result<Vec<String>> {
                self.0.logs_tail(name, tail).await
            }
            async fn spawn_follow_logs(&self, name: &str) -> Result<tokio::process::Child> {
                self.0.spawn_follow_logs(name).await
            }
            async fn exec(&self, name: &str, argv: &[&str]) -> Result<ExecOutput> {
                self.0.exec(name, argv).await
            }
            async fn run_with_volumes_from(&self, name: &str, argv: &[&str]) -> Result<ExecOutput> {
                self.0.run_with_volumes_from(name, argv).await
            }
            async fn cp_to(&self, name: &str, host_src: &Path, dest: &str) -> Result<()> {
                self.0.cp_to(name, host_src, dest).await
            }
            async fn cp_from(&self, name: &str, src: &str, host_dest: &Path) -> Result<()> {
                self.0.cp_from(name, src, host_dest).await
            }
            async fn stats(&self, name: &str) -> Result<RawStats> {
                self.0.stats(name).await
            }
            async fn inspect_started_at(&self, name: &str) -> Result<Option<String>> {
                self.0.inspect_started_at(name).await
            }
            async fn inspect_env(&self, name: &str) -> Result<Vec<(String, String)>> {
                self.0.inspect_env(name).await
            }
            async fn run_detached(&self, spec: &ContainerSpec) -> Result<ExecOutput> {
                self.0.run_detached(spec).await
            }
            async fn create(&self, spec: &ContainerSpec) -> Result<ExecOutput> {
                self.0.create(spec).await
            }
            async fn remove_force(&self, name: &str, anonymous_volumes: bool) -> Result<()> {
                self.0.remove_force(name, anonymous_volumes).await
            }
            async fn inspect_mounts(&self, name: &str) -> Result<Vec<Mount>> {
                self.0.inspect_mounts(name).await
            }
            async fn remove_volume(&self, volume: &str) -> Result<()> {
                self.0.remove_volume(volume).await
            }
            async fn inspect_ports(&self, name: &str) -> Result<Vec<PortBinding>> {
                self.0.inspect_ports(name).await
            }
            async fn inspect_pids_limit(&self, name: &str) -> Result<Option<i64>> {
                self.0.inspect_pids_limit(name).await
            }
            async fn set_pids_limit_unlimited(&self, name: &str) -> Result<()> {
                self.0.set_pids_limit_unlimited(name).await
            }
            async fn inspect_labels(&self, name: &str) -> Result<Vec<(String, String)>> {
                self.0.inspect_labels(name).await
            }
            async fn inspect_image(&self, name: &str) -> Result<Option<String>> {
                self.0.inspect_image(name).await
            }
            async fn image_env(&self, image: &str) -> Result<Vec<(String, String)>> {
                self.0.image_env(image).await
            }
            async fn rename(&self, old: &str, new: &str) -> Result<()> {
                self.0.rename(old, new).await
            }
            async fn machine_vm_type(&self) -> Option<String> {
                self.0.machine_vm_type().await
            }
            async fn machine_rootful(&self) -> Option<bool> {
                self.0.machine_rootful().await
            }
            async fn machine_name(&self) -> Option<String> {
                self.0.machine_name().await
            }
        }
    };
}

delegate_runtime!(PodmanCli);
delegate_runtime!(DockerCli);

/* ---------- detection & resolution (§3.1) ---------- */

/// Parse a `--version` line: "podman version 4.9.3" /
/// "Docker version 27.5.1, build ...".
fn parse_version_line(line: &str) -> Option<String> {
    let after = line.split(" version ").nth(1)?;
    let version = after.split([',', ' ']).next()?.trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

/// Which runtime a `--version` line belongs to (2.9.0): "podman version …"
/// → podman, "Docker version …" → docker.
pub fn kind_from_version_line(line: &str) -> Option<RuntimeKind> {
    let lower = line.trim().to_ascii_lowercase();
    if lower.starts_with("podman version") {
        Some(RuntimeKind::Podman)
    } else if lower.starts_with("docker version") {
        Some(RuntimeKind::Docker)
    } else {
        None
    }
}

/// Fallback when the version line names neither: the binary's file name.
fn kind_from_binary_name(binary: &str) -> Option<RuntimeKind> {
    let name = Path::new(binary)
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    if name.contains("podman") {
        Some(RuntimeKind::Podman)
    } else if name.contains("docker") {
        Some(RuntimeKind::Docker)
    } else {
        None
    }
}

/// The kind of an override binary (§3.1, 2.9.0): version line first, then
/// file name; `None` = ignore the override.
pub fn infer_override_kind(binary: &str, version_line: &str) -> Option<RuntimeKind> {
    kind_from_version_line(version_line).or_else(|| kind_from_binary_name(binary))
}

/// `<binary> --version` → its first stdout line, when it runs and exits 0.
async fn probe_line(binary: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(binary);
    crate::util::prepare_child(&mut cmd);
    let output = cmd
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().next().map(str::to_string)
}

fn hit_from_line(binary: &str, line: &str) -> RuntimeHit {
    RuntimeHit {
        binary: binary.to_string(),
        version: parse_version_line(line).unwrap_or_else(|| line.trim().to_string()),
    }
}

async fn probe_binary(binary: &str) -> Option<RuntimeHit> {
    let line = probe_line(binary).await?;
    Some(hit_from_line(binary, &line))
}

fn override_binary(advanced: &AdvancedModeSettings) -> Option<String> {
    advanced
        .runtime_binary
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
}

/// Auto with an override set (2.9.0): probe it first and infer its kind.
async fn probe_auto_override(advanced: &AdvancedModeSettings) -> Option<(RuntimeKind, RuntimeHit)> {
    if advanced.runtime != RuntimeKind::Auto {
        return None;
    }
    let binary = override_binary(advanced)?;
    let line = probe_line(&binary).await?;
    let kind = infer_override_kind(&binary, &line)?;
    Some((kind, hit_from_line(&binary, &line)))
}

/// `detect_runtimes`: probe `podman --version` and `docker --version`
/// (argv arrays), honoring the configured binary override - on Auto too,
/// where a working override takes its kind's slot and wins `resolved`.
pub async fn detect(advanced: &AdvancedModeSettings) -> RuntimeProbe {
    if let Some((kind, hit)) = probe_auto_override(advanced).await {
        return match kind {
            RuntimeKind::Docker => RuntimeProbe {
                podman: probe_binary("podman").await,
                docker: Some(hit),
                resolved: Some("docker".into()),
            },
            _ => RuntimeProbe {
                podman: Some(hit),
                docker: probe_binary("docker").await,
                resolved: Some("podman".into()),
            },
        };
    }
    let override_bin = override_binary(advanced);
    let (podman_bin, docker_bin) = match advanced.runtime {
        RuntimeKind::Podman => (
            override_bin.clone().unwrap_or_else(|| "podman".into()),
            "docker".to_string(),
        ),
        RuntimeKind::Docker => (
            "podman".to_string(),
            override_bin.clone().unwrap_or_else(|| "docker".into()),
        ),
        RuntimeKind::Auto => ("podman".to_string(), "docker".to_string()),
    };
    let (podman, docker) = tokio::join!(probe_binary(&podman_bin), probe_binary(&docker_bin));
    let resolved = if podman.is_some() {
        Some("podman".to_string())
    } else if docker.is_some() {
        Some("docker".to_string())
    } else {
        None
    };
    RuntimeProbe {
        podman,
        docker,
        resolved,
    }
}

/// Resolve the runtime to use per settings: explicit setting is respected,
/// "auto" tries a working override first (2.9.0), then podman, then docker.
/// RUNTIME_NOT_FOUND when nothing usable.
pub async fn resolve(advanced: &AdvancedModeSettings) -> Result<Box<dyn Runtime>> {
    let override_bin = override_binary(advanced);
    let backend = |binary: String, kind: RuntimeKind| CliBackend {
        binary,
        kind,
        socket_path: advanced.socket_path.clone(),
    };
    match advanced.runtime {
        RuntimeKind::Podman => {
            let bin = override_bin.unwrap_or_else(|| "podman".into());
            if probe_binary(&bin).await.is_none() {
                return Err(Error::RuntimeNotFound(format!(
                    "podman CLI not found (binary: {bin})"
                )));
            }
            Ok(Box::new(PodmanCli(backend(bin, RuntimeKind::Podman))))
        }
        RuntimeKind::Docker => {
            let bin = override_bin.unwrap_or_else(|| "docker".into());
            if probe_binary(&bin).await.is_none() {
                return Err(Error::RuntimeNotFound(format!(
                    "docker CLI not found (binary: {bin})"
                )));
            }
            Ok(Box::new(DockerCli(backend(bin, RuntimeKind::Docker))))
        }
        RuntimeKind::Auto => {
            if let Some((kind, hit)) = probe_auto_override(advanced).await {
                return Ok(match kind {
                    RuntimeKind::Docker => {
                        Box::new(DockerCli(backend(hit.binary, RuntimeKind::Docker)))
                    }
                    _ => Box::new(PodmanCli(backend(hit.binary, RuntimeKind::Podman))),
                });
            }
            if probe_binary("podman").await.is_some() {
                Ok(Box::new(PodmanCli(backend(
                    "podman".into(),
                    RuntimeKind::Podman,
                ))))
            } else if probe_binary("docker").await.is_some() {
                Ok(Box::new(DockerCli(backend(
                    "docker".into(),
                    RuntimeKind::Docker,
                ))))
            } else {
                Err(Error::RuntimeNotFound(match override_bin {
                    Some(bin) => format!(
                        "no usable podman or docker CLI found (override {bin} is not a usable podman/docker, nor is either on PATH)"
                    ),
                    None => "no usable podman or docker CLI found on PATH".into(),
                }))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_podman_ps_array() {
        let stdout = r#"[{"Id":"abc123","State":"running","CreatedAt":"2026-07-23 10:00:00"}]"#;
        let entry = parse_ps_json(stdout).unwrap();
        assert_eq!(str_field(&entry, &["State"]).unwrap(), "running");
        assert_eq!(str_field(&entry, &["Id", "ID"]).unwrap(), "abc123");
    }

    #[test]
    fn parses_docker_ps_ndjson() {
        let stdout = r#"{"ID":"deadbeef","State":"exited","CreatedAt":"2026-07-20"}"#;
        let entry = parse_ps_json(stdout).unwrap();
        assert_eq!(str_field(&entry, &["Id", "ID"]).unwrap(), "deadbeef");
    }

    #[test]
    fn empty_ps_output_means_not_found() {
        assert!(parse_ps_json("").is_none());
        assert!(parse_ps_json("[]").is_none());
    }

    #[test]
    fn parses_stats_docker_keys() {
        let stdout = r#"{"CPUPerc":"12.5%","MemUsage":"1GiB / 4GiB","MemPerc":"25%","NetIO":"1KB / 2KB","BlockIO":"0B / 3MB"}"#;
        let stats = parse_stats_json(stdout);
        assert_eq!(stats.cpu_percent, Some(12.5));
        assert_eq!(stats.mem_used_bytes, Some(1024 * 1024 * 1024));
        assert_eq!(stats.mem_total_bytes, Some(4 * 1024 * 1024 * 1024));
        assert_eq!(stats.mem_percent, Some(25.0));
        assert_eq!(stats.net_input_bytes, Some(1000));
        assert_eq!(stats.net_output_bytes, Some(2000));
        assert_eq!(stats.block_output_bytes, Some(3_000_000));
    }

    #[test]
    fn parses_stats_podman_493_snake_case_keys() {
        // Verbatim (trimmed) `podman stats --no-stream --format json` from a
        // live rootless podman 4.9.3 - snake_case keys, decimal units,
        // lowercase "kB" spelling.
        let stdout = r#"[
 {
  "id": "9758e78b8c7e",
  "name": "minecraft-server",
  "cpu_time": "51.374424s",
  "cpu_percent": "190.35%",
  "avg_cpu": "190.35%",
  "mem_usage": "1.895GB / 33.31GB",
  "mem_percent": "5.69%",
  "net_io": "61.69MB / 126kB",
  "block_io": "0B / 0B",
  "pids": "104"
 }
]"#;
        let stats = parse_stats_json(stdout);
        assert_eq!(stats.cpu_percent, Some(190.35));
        assert_eq!(stats.mem_used_bytes, Some(1_895_000_000));
        assert_eq!(stats.mem_total_bytes, Some(33_310_000_000));
        assert_eq!(stats.mem_percent, Some(5.69));
        assert_eq!(stats.net_input_bytes, Some(61_690_000));
        assert_eq!(stats.net_output_bytes, Some(126_000));
        assert_eq!(stats.block_input_bytes, Some(0));
        assert_eq!(stats.block_output_bytes, Some(0));
    }

    #[test]
    fn parses_stats_podman_493_stopped_container_zeros() {
        // podman 4.9.3 `stats` on a *stopped* container exits 0 and reports
        // zeroed values (it does not fail as docker does) - verified live.
        let stdout = r#"[{"id":"9758e78b8c7e","name":"minecraft-server","cpu_percent":"0.00%","mem_usage":"0B / 0B","mem_percent":"0.00%","net_io":"0B / 0B","block_io":"0B / 0B","pids":"0"}]"#;
        let stats = parse_stats_json(stdout);
        assert_eq!(stats.cpu_percent, Some(0.0));
        assert_eq!(stats.mem_used_bytes, Some(0));
        assert_eq!(stats.mem_total_bytes, Some(0));
    }

    #[test]
    fn parses_podman_493_ps_shape() {
        // Trimmed verbatim `podman ps --all --filter name=^minecraft-server$
        // --format json` from live podman 4.9.3: note the human-relative
        // "CreatedAt" string and the *numeric* "Created"/"StartedAt" epochs
        // (which str_field correctly ignores - startedAt comes from inspect).
        let stdout = r#"[
  {
    "CreatedAt": "16 seconds ago",
    "Exited": false,
    "ExitCode": 0,
    "Id": "9758e78b8c7e18bbb13686245be58c4e9a26b9415bd05b2dcc4cd60b01385bd2",
    "Image": "docker.io/itzg/minecraft-server:latest",
    "Names": ["minecraft-server"],
    "StartedAt": 1784926231,
    "State": "running",
    "Status": "Up 16 seconds",
    "Created": 1784926231
  }
]"#;
        let entry = parse_ps_json(stdout).unwrap();
        assert_eq!(str_field(&entry, &["State", "Status"]).unwrap(), "running");
        assert!(str_field(&entry, &["Id", "ID"])
            .unwrap()
            .starts_with("9758e78b"));
        assert_eq!(
            str_field(&entry, &["CreatedAt", "Created"]).unwrap(),
            "16 seconds ago"
        );
    }

    #[test]
    fn parses_inspect_env_lines() {
        let env = parse_env_lines("TYPE=FORGE\nVERSION=1.21.1\nMOTD=a=b c\nnoequals\n\n");
        assert_eq!(
            env,
            vec![
                ("TYPE".to_string(), "FORGE".to_string()),
                ("VERSION".to_string(), "1.21.1".to_string()),
                ("MOTD".to_string(), "a=b c".to_string()),
            ]
        );
    }

    #[test]
    fn parses_mounts_and_tells_anonymous_volumes_apart() {
        // Verbatim shapes from rootless podman 6.1 (paths shortened).
        let stdout = "volume|mc-forge-data|/var/volumes/mc-forge-data/_data|/data\n\
volume|e93e7a2a6ce31d191e8d4c0d35ef47ae26215748b07eeeda035fc171ed1c27ef|/var/volumes/e93e/_data|/anon\n\
bind||/home/me/minecraft|/extra\n\nnot-a-mount\n";
        let mounts = parse_mount_lines(stdout);
        assert_eq!(mounts.len(), 3);
        assert_eq!(mounts[0].name, "mc-forge-data");
        assert_eq!(mounts[0].destination, "/data");
        assert!(!mounts[0].is_anonymous_volume());
        assert!(mounts[1].is_anonymous_volume());
        assert_eq!(mounts[2].kind, "bind");
        assert_eq!(mounts[2].name, "");
        assert_eq!(mounts[2].source, "/home/me/minecraft");
        assert!(!mounts[2].is_anonymous_volume());
    }

    #[test]
    fn container_spec_builds_run_argv() {
        let spec = ContainerSpec {
            name: "mc-forge".into(),
            image: "docker.io/itzg/minecraft-server:java21".into(),
            env_file: "/tmp/x.env".into(),
            ports: vec![
                PublishedPort::tcp(Some("0.0.0.0".into()), 25566, 25565),
                PublishedPort::tcp(Some("127.0.0.1".into()), 25576, 25575),
            ],
            volume: ("mc-forge-data".into(), "/data".into()),
            labels: vec![],
            pids_limit: None,
        };
        assert_eq!(
            spec.run_args(),
            [
                "run",
                "-d",
                "--name",
                "mc-forge",
                "--env-file",
                "/tmp/x.env",
                "-p",
                "0.0.0.0:25566:25565",
                "-p",
                "127.0.0.1:25576:25575",
                "-v",
                "mc-forge-data:/data",
                "docker.io/itzg/minecraft-server:java21",
            ]
        );
    }

    #[test]
    fn no_pids_limit_goes_before_the_image() {
        let spec = ContainerSpec {
            name: "mc".into(),
            image: "docker.io/itzg/minecraft-server:java21".into(),
            env_file: "/tmp/x.env".into(),
            ports: vec![],
            volume: ("mc-data".into(), "/data".into()),
            labels: vec![],
            pids_limit: Some(0),
        };
        let args = spec.run_args();
        assert_eq!(
            &args[args.len() - 2..],
            ["--pids-limit=0", "docker.io/itzg/minecraft-server:java21"]
        );
    }

    #[test]
    fn create_args_are_run_args_without_the_detach() {
        let spec = ContainerSpec {
            name: "mc".into(),
            image: "docker.io/itzg/minecraft-server:java21".into(),
            env_file: "/tmp/x.env".into(),
            ports: vec![PublishedPort::tcp(Some("127.0.0.1".into()), 25566, 25565)],
            volume: ("mc-data".into(), "/data".into()),
            labels: vec![("studio.i4c.mineui.managed".into(), "1".into())],
            pids_limit: None,
        };
        let run = spec.run_args();
        let create = spec.create_args();
        assert_eq!(&run[..2], ["run", "-d"]);
        assert_eq!(create[0], "create");
        assert_eq!(&run[2..], &create[1..]);
    }

    #[test]
    fn a_port_without_a_bind_address_is_published_plainly() {
        // Podman on Windows/WSL: the machine's loopback is not the user's (§3.13)
        let spec = ContainerSpec {
            name: "mc".into(),
            image: "docker.io/itzg/minecraft-server:java21".into(),
            env_file: "/tmp/x.env".into(),
            ports: vec![
                PublishedPort::tcp(None, 25566, 25565),
                PublishedPort::tcp(None, 25576, 25575),
            ],
            volume: ("mc-data".into(), "/data".into()),
            labels: vec![],
            pids_limit: None,
        };
        let args = spec.run_args();
        assert_eq!(&args[6..10], ["-p", "25566:25565", "-p", "25576:25575"]);
    }

    #[test]
    fn extra_ports_and_the_label_in_the_argv() {
        let udp = |bind: Option<&str>, port| PublishedPort {
            bind: bind.map(Into::into),
            host: port,
            container: port,
            protocol: PortProtocol::Udp,
        };
        let spec = ContainerSpec {
            name: "mc".into(),
            image: "docker.io/itzg/minecraft-server:java21".into(),
            env_file: "/tmp/x.env".into(),
            ports: vec![
                PublishedPort::tcp(Some("0.0.0.0".into()), 25566, 25565),
                PublishedPort::tcp(Some("127.0.0.1".into()), 25576, 25575),
                udp(Some("0.0.0.0"), 24454),
                PublishedPort::tcp(Some("0.0.0.0".into()), 8100, 8100),
                udp(None, 19132),
            ],
            volume: ("mc-data".into(), "/data".into()),
            labels: vec![("studio.i4c.mineui.managed".into(), "1".into())],
            pids_limit: None,
        };
        assert_eq!(
            spec.create_args(),
            [
                "create",
                "--name",
                "mc",
                "--env-file",
                "/tmp/x.env",
                "--label",
                "studio.i4c.mineui.managed=1",
                "-p",
                "0.0.0.0:25566:25565",
                "-p",
                "127.0.0.1:25576:25575",
                "-p",
                "0.0.0.0:24454:24454/udp",
                "-p",
                "0.0.0.0:8100:8100",
                "-p",
                "19132:19132/udp",
                "-v",
                "mc-data:/data",
                "docker.io/itzg/minecraft-server:java21",
            ]
        );
    }

    #[test]
    fn port_bindings_parse_and_skip_junk() {
        // podman fills HostIp; docker leaves it empty for "every interface".
        let stdout = "24454/udp|0.0.0.0|24454\n25565/tcp|127.0.0.1|25566\n25575/tcp||25576\n\
                      garbage\n25565/sctp|0.0.0.0|1\n8100/tcp|0.0.0.0|notaport\n/tcp|x|5\n\n";
        let ports = parse_port_lines(stdout);
        assert_eq!(
            ports,
            [
                PortBinding {
                    container_port: 24454,
                    protocol: PortProtocol::Udp,
                    host_ip: "0.0.0.0".into(),
                    host_port: 24454,
                },
                PortBinding {
                    container_port: 25565,
                    protocol: PortProtocol::Tcp,
                    host_ip: "127.0.0.1".into(),
                    host_port: 25566,
                },
                PortBinding {
                    container_port: 25575,
                    protocol: PortProtocol::Tcp,
                    host_ip: String::new(),
                    host_port: 25576,
                },
            ]
        );
    }

    #[test]
    fn recognises_the_missing_pids_controller() {
        // crun through podman, as the runtime prints it
        assert!(is_pids_controller_unavailable(
            "Error: crun: controller `pids` is not available under /sys/fs/cgroup/non-systemd/machine.slice/libpod-c362.scope/container/cgroup.controllers: OCI runtime error"
        ));
        // as a user pasted it, backticks lost
        assert!(is_pids_controller_unavailable(
            "Error: crun: controller pids is not available under /sys/fs/cgroup/x/cgroup.controllers: OCI runtime error"
        ));
        assert!(!is_pids_controller_unavailable(
            "Error: crun: the requested cgroup controller `cpu` is not available"
        ));
        assert!(!is_pids_controller_unavailable(
            "Error: rootlessport listen tcp 127.0.0.1:25566: bind: address already in use"
        ));
        assert!(!is_pids_controller_unavailable(""));
        // the tester's 2.11.0 start error, wrapped by run_ok
        assert!(is_pids_controller_unavailable(
            "podman start failed: Error: unable to start container \"06cd\": crun: controller pids is not available under /sys/fs/cgroup/non-systemd/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-06cd.scope/container/cgroup.controllers: OCI runtime error"
        ));
    }

    #[test]
    fn pids_limit_output() {
        assert_eq!(parse_pids_limit("2048\n"), Some(2048));
        assert_eq!(parse_pids_limit("0"), Some(0));
        assert_eq!(parse_pids_limit("-1"), Some(-1));
        assert_eq!(parse_pids_limit("<nil>\n"), None);
        assert_eq!(parse_pids_limit(""), None);
        assert_eq!(parse_pids_limit("lots"), None);
    }

    #[test]
    fn parses_version_lines() {
        assert_eq!(parse_version_line("podman version 4.9.3").unwrap(), "4.9.3");
        assert_eq!(
            parse_version_line("Docker version 27.5.1, build a187fa5").unwrap(),
            "27.5.1"
        );
        assert!(parse_version_line("gibberish").is_none());
    }

    #[test]
    fn version_line_tells_the_kind() {
        assert_eq!(
            kind_from_version_line("podman version 6.1.0"),
            Some(RuntimeKind::Podman)
        );
        assert_eq!(
            kind_from_version_line("Docker version 27.5.1, build a187fa5"),
            Some(RuntimeKind::Docker)
        );
        assert_eq!(kind_from_version_line("nerdctl version 2.0"), None);
        // podman-docker's `docker` shim reports podman: the line wins.
        assert_eq!(
            infer_override_kind("/usr/bin/docker", "podman version 5.2.2"),
            Some(RuntimeKind::Podman)
        );
        // An unhelpful line falls back to the file name.
        assert_eq!(
            infer_override_kind("C:\\Tools\\docker.exe", "v27"),
            Some(RuntimeKind::Docker)
        );
        assert_eq!(
            infer_override_kind("/opt/podman/bin/podman-remote", "4.9"),
            Some(RuntimeKind::Podman)
        );
        assert_eq!(
            infer_override_kind("/usr/local/bin/nerdctl", "nerdctl 2"),
            None
        );
    }

    #[test]
    fn recognises_an_unreachable_engine() {
        // Docker Desktop not started (Windows)
        assert!(engine_unreachable(
            "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."
        ));
        // Docker daemon down (Linux)
        assert!(engine_unreachable(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
        ));
        // podman machine stopped (Windows/macOS)
        assert!(engine_unreachable(
            "Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start` to manage a new Linux VM\nError: unable to connect to Podman socket: failed to connect: dial tcp 127.0.0.1:53717: connectex: No connection could be made because the target machine actively refused it."
        ));
        // CONTAINER_HOST pointing at a dead socket
        assert!(engine_unreachable(
            "Error: unable to connect to Podman socket: Get \"http://d/v5.0.0/libpod/_ping\": dial unix /run/user/1000/podman/podman.sock: connect: no such file or directory"
        ));
        assert!(!engine_unreachable(
            "Error: no container with name or ID \"mc\" found: no such container"
        ));
        assert!(!engine_unreachable(
            "Error: crun: controller `pids` is not available"
        ));
        assert!(!engine_unreachable(""));
    }

    #[test]
    fn unavailable_message_names_runtime_and_fix() {
        let e = unavailable_error(
            "docker",
            "windows",
            "\nerror during connect: open //./pipe/dockerDesktopLinuxEngine\nmore",
        );
        assert_eq!(e.code(), "RUNTIME_UNAVAILABLE");
        let m = e.to_string();
        assert!(
            m.starts_with("docker is installed but not responding"),
            "{m}"
        );
        assert!(m.contains("start Docker Desktop"), "{m}");
        assert!(m.contains("error during connect"), "{m}");
        assert!(!m.contains("more"), "first line only: {m}");

        let m = unavailable_error("podman", "macos", "").to_string();
        assert!(m.contains("podman machine start"), "{m}");
        assert!(!m.contains("said"), "{m}");
        // No machine on Linux: never suggest it there - not even by quoting
        // podman's own banner (verbatim podman 6.1.1, dead CONTAINER_HOST).
        let m = unavailable_error(
            "podman",
            "linux",
            "Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start` to manage a new Linux VM\nError: unable to connect to Podman socket: Get \"http://d/v6.1.1/libpod/_ping\": dial unix /tmp/mineui-nope.sock: connect: no such file or directory",
        )
        .to_string();
        assert!(!m.contains("machine"), "{m}");
        assert!(m.contains("dial unix /tmp/mineui-nope.sock"), "{m}");
        let m = unavailable_error("docker", "linux", "x").to_string();
        assert!(!m.contains("Docker Desktop"), "{m}");
    }

    #[test]
    fn helper_argv_runs_the_command_over_the_volumes() {
        let script = "for f in /data/x/*; do :; done";
        let args = helper_run_args("mc-forge", "sha256:abc", &["sh", "-c", script]).unwrap();
        assert_eq!(
            args,
            [
                "run",
                "--rm",
                "--volumes-from",
                "mc-forge",
                "--entrypoint",
                "sh",
                "sha256:abc",
                "-c",
                script
            ]
        );
        assert!(helper_run_args("mc", "img", &[]).is_none());
    }

    #[test]
    fn container_access_follows_the_state() {
        let detail = |exists: bool, status: Option<&str>| ContainerDetail {
            exists,
            id: None,
            status: status.map(String::from),
            created_at: None,
            started_at: None,
        };
        assert_eq!(
            ContainerAccess::for_detail(&detail(false, None)),
            ContainerAccess::Missing
        );
        assert_eq!(
            ContainerAccess::for_detail(&detail(true, Some("running"))),
            ContainerAccess::Exec
        );
        for status in ["exited", "created", "paused", "stopped"] {
            assert_eq!(
                ContainerAccess::for_detail(&detail(true, Some(status))),
                ContainerAccess::Helper,
                "{status}"
            );
        }
    }
}
