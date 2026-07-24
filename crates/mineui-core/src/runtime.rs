//! Container runtime adapter (module map §8): `trait Runtime` over the
//! podman/docker CLIs. **All subprocess calls use argv arrays** — the only
//! `sh -c` permitted anywhere is a compile-time-constant script with zero
//! interpolation (used for directory listings, see `mods`/`backups`).

use std::path::Path;
use std::process::Stdio;

use async_trait::async_trait;

use crate::error::{Error, Result};
use crate::model::{ContainerDetail, RuntimeHit, RuntimeProbe};
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
    /// `exec <name> <argv...>` — argv array, never a shell string.
    /// Only works on a **running** container.
    async fn exec(&self, name: &str, argv: &[&str]) -> Result<ExecOutput>;
    /// `run --rm --volumes-from <name> --entrypoint <argv0> <image> <argv1..>`
    /// where `<image>` is `<name>`'s own image (via inspect). Unlike `exec`
    /// this works while the container is **stopped** (verified live on
    /// rootless podman 4.9.3) — restore uses it, since restore requires the
    /// server stopped and `exec` cannot run in a stopped container.
    async fn run_with_volumes_from(&self, name: &str, argv: &[&str]) -> Result<ExecOutput>;
    /// `cp <host_src> <name>:<container_dest>`.
    async fn cp_to(&self, name: &str, host_src: &Path, container_dest: &str) -> Result<()>;
    /// `stats --no-stream --format json <name>`.
    async fn stats(&self, name: &str) -> Result<RawStats>;
    /// `inspect -f {{.State.StartedAt}} <name>` → normalized RFC 3339.
    async fn inspect_started_at(&self, name: &str) -> Result<Option<String>>;
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

    async fn run_ok(&self, args: &[&str]) -> Result<ExecOutput> {
        let out = self.run(args).await?;
        if !out.success() {
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
            return Err(Error::RuntimeNotFound(format!(
                "{} ps failed: {}",
                self.binary, out.stderr
            )));
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
        let Some((entrypoint, rest)) = argv.split_first() else {
            return Err(Error::Internal("helper run needs a non-empty argv".into()));
        };
        let mut args: Vec<&str> = vec![
            "run",
            "--rm",
            "--volumes-from",
            name,
            "--entrypoint",
            entrypoint,
            &image,
        ];
        args.extend_from_slice(rest);
        self.run(&args).await
    }

    async fn cp_to(&self, name: &str, host_src: &Path, container_dest: &str) -> Result<()> {
        let src = host_src.to_string_lossy().to_string();
        let dest = format!("{name}:{container_dest}");
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
            async fn stats(&self, name: &str) -> Result<RawStats> {
                self.0.stats(name).await
            }
            async fn inspect_started_at(&self, name: &str) -> Result<Option<String>> {
                self.0.inspect_started_at(name).await
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

async fn probe_binary(binary: &str) -> Option<RuntimeHit> {
    let output = tokio::process::Command::new(binary)
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
    let line = stdout.lines().next()?;
    Some(RuntimeHit {
        binary: binary.to_string(),
        version: parse_version_line(line).unwrap_or_else(|| line.trim().to_string()),
    })
}

/// `detect_runtimes`: probe `podman --version` and `docker --version`
/// (argv arrays), honoring the configured binary override.
pub async fn detect(advanced: &AdvancedModeSettings) -> RuntimeProbe {
    let override_bin = advanced
        .runtime_binary
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
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
/// "auto" tries podman then docker. RUNTIME_NOT_FOUND when nothing usable.
pub async fn resolve(advanced: &AdvancedModeSettings) -> Result<Box<dyn Runtime>> {
    let override_bin = advanced
        .runtime_binary
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
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
                Err(Error::RuntimeNotFound(
                    "no usable podman or docker CLI found on PATH".into(),
                ))
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
        // live rootless podman 4.9.3 — snake_case keys, decimal units,
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
        // zeroed values (it does not fail as docker does) — verified live.
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
        // (which str_field correctly ignores — startedAt comes from inspect).
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
    fn parses_version_lines() {
        assert_eq!(parse_version_line("podman version 4.9.3").unwrap(), "4.9.3");
        assert_eq!(
            parse_version_line("Docker version 27.5.1, build a187fa5").unwrap(),
            "27.5.1"
        );
        assert!(parse_version_line("gibberish").is_none());
    }
}
