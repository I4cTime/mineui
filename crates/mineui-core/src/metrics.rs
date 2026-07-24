//! Metrics composition (contract §3.9). Never rejects for "server offline";
//! rejects only for hard faults (RUNTIME_NOT_FOUND, CONTAINER_NOT_FOUND, IO).

use crate::error::{Error, Result};
use crate::model::{DiskStats, IoPair, MemStats, Metrics, MetricsPlayers, Mspt, Tps};
use crate::settings::Mode;

/// Parse `df -k /data` output (fixed argv, parsed in Rust).
fn parse_df_output(stdout: &str) -> Option<DiskStats> {
    let line = stdout.lines().last()?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let total = parts[1].parse::<u64>().ok().map(|kb| kb * 1024);
    let used = parts[2].parse::<u64>().ok().map(|kb| kb * 1024);
    let percent = crate::util::parse_percent(parts[4]);
    Some(DiskStats {
        used_bytes: used,
        total_bytes: total,
        percent,
    })
}

async fn tps_via_rcon(core: &crate::Core) -> Option<Tps> {
    let output = crate::rcon::run(core, "tps").await.ok()?;
    // Vanilla has no `tps` command → parse failure → None (not an error).
    crate::util::parse_tps(&output)
}

async fn advanced_metrics(core: &crate::Core) -> Result<Metrics> {
    let settings = core.settings().await;
    let runtime = crate::runtime::resolve(&settings.advanced).await?;
    let name = settings.advanced.container_name.clone();

    let detail = runtime.ps_state(&name).await?;
    if !detail.exists {
        return Err(Error::ContainerNotFound(format!(
            "container '{name}' does not exist"
        )));
    }

    let mut metrics = Metrics::empty("container");

    let stats = runtime.stats(&name).await.unwrap_or_default();
    metrics.cpu_percent = stats.cpu_percent;
    metrics.mem = MemStats {
        used_bytes: stats.mem_used_bytes,
        total_bytes: stats.mem_total_bytes,
        percent: stats.mem_percent,
    };
    metrics.net = Some(IoPair {
        input_bytes: stats.net_input_bytes,
        output_bytes: stats.net_output_bytes,
    });
    metrics.block = Some(IoPair {
        input_bytes: stats.block_input_bytes,
        output_bytes: stats.block_output_bytes,
    });

    metrics.started_at = runtime.inspect_started_at(&name).await.unwrap_or(None);
    metrics.uptime_seconds = metrics
        .started_at
        .as_deref()
        .and_then(crate::util::seconds_since);

    // Disk: fixed argv `df -k /data`, parsed in Rust.
    if let Ok(out) = runtime.exec(&name, &["df", "-k", "/data"]).await {
        if out.success() {
            metrics.disk = parse_df_output(&out.stdout);
        }
    }

    // Enrichment (advanced + serverUtilsUrl): container > system > runtime
    // stats, exactly per v1 precedence. Unreachable server-utils degrades
    // silently to base.
    if let Some(base_url) = settings.advanced.server_utils_url.as_deref() {
        if let Ok(su) = crate::serverutils::metrics(core, base_url).await {
            if su.ok {
                metrics.enriched = true;
                if let Some(tps) = &su.tps {
                    metrics.tps = Some(Tps {
                        one: tps.one,
                        five: tps.five,
                        fifteen: tps.fifteen,
                        raw: tps.raw.clone().unwrap_or_else(|| {
                            format!(
                                "TPS avg 1m/5m/15m: {}, {}, {}",
                                tps.one, tps.five, tps.fifteen
                            )
                        }),
                    });
                }
                if let Some(mspt) = &su.mspt {
                    metrics.mspt = Some(Mspt {
                        one: mspt.one,
                        five: mspt.five,
                        fifteen: mspt.fifteen,
                    });
                }
                metrics.chunks = su.chunks;
                metrics.entities = su.entities;
                metrics.dimensions = su.dimensions.clone();
                if let Some(players) = &su.players {
                    metrics.players = Some(MetricsPlayers {
                        online: players.online,
                        max: players.max,
                    });
                }
                if let Some(system) = &su.system {
                    let container = system.container.as_ref();
                    // cpu: container > system > runtime stats
                    if let Some(cpu) = container.and_then(|c| c.cpu_percent).or(system.cpu_percent)
                    {
                        metrics.cpu_percent = Some(cpu);
                    }
                    // mem
                    if let Some(mem) = container.and_then(|c| c.mem.as_ref()) {
                        metrics.mem = MemStats {
                            used_bytes: mem.used_bytes,
                            total_bytes: mem.limit_bytes.or(mem.total_bytes),
                            percent: mem.percent,
                        };
                    } else if let Some(mem) = system.mem.as_ref() {
                        let percent = match (mem.used_bytes, mem.total_bytes) {
                            (Some(used), Some(total)) if total > 0 => {
                                Some(used as f64 / total as f64 * 100.0)
                            }
                            _ => None,
                        };
                        metrics.mem = MemStats {
                            used_bytes: mem.used_bytes,
                            total_bytes: mem.total_bytes,
                            percent,
                        };
                    }
                    // net
                    if let Some(net) = container
                        .and_then(|c| c.net.as_ref())
                        .or(system.net.as_ref())
                    {
                        metrics.net = Some(IoPair {
                            input_bytes: net.input_bytes,
                            output_bytes: net.output_bytes,
                        });
                    }
                    // block: container.block > system.disk (read/write) > runtime
                    if let Some(block) = container.and_then(|c| c.block.as_ref()) {
                        metrics.block = Some(IoPair {
                            input_bytes: block.read_bytes,
                            output_bytes: block.write_bytes,
                        });
                    } else if let Some(disk) = system.disk.as_ref() {
                        metrics.block = Some(IoPair {
                            input_bytes: disk.read_bytes,
                            output_bytes: disk.write_bytes,
                        });
                    }
                }
            }
        }
    }

    if metrics.tps.is_none() {
        metrics.tps = tps_via_rcon(core).await;
    }
    Ok(metrics)
}

/// Simple-mode base: process CPU/RSS via sysinfo for the supervised pid,
/// disk usage of the instanceDir volume, startedAt from the supervisor.
async fn simple_metrics(core: &crate::Core) -> Result<Metrics> {
    let settings = core.settings().await;
    let mut metrics = Metrics::empty("process");

    metrics.started_at = if core.supervisor.is_active() {
        core.supervisor.started_at()
    } else {
        None
    };
    metrics.uptime_seconds = metrics
        .started_at
        .as_deref()
        .and_then(crate::util::seconds_since);

    let pid = core.supervisor.pid();
    let instance_dir = settings.simple.instance_dir.clone();

    let (cpu, mem, disk) = tokio::task::spawn_blocking(move || {
        use sysinfo::{Disks, Pid, ProcessesToUpdate, System};

        let mut system = System::new();
        let mut cpu: Option<f64> = None;
        let mut used: Option<u64> = None;

        if let Some(pid) = pid {
            let pid = Pid::from_u32(pid);
            system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
            system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if let Some(process) = system.process(pid) {
                cpu = Some(process.cpu_usage() as f64);
                used = Some(process.memory());
            }
        }
        system.refresh_memory();
        let total = system.total_memory();
        let mem = MemStats {
            used_bytes: used,
            total_bytes: if total > 0 { Some(total) } else { None },
            percent: match (used, total) {
                (Some(u), t) if t > 0 => Some(u as f64 / t as f64 * 100.0),
                _ => None,
            },
        };

        // Disk = usage of the volume holding instanceDir (longest mount-point
        // prefix match).
        let disks = Disks::new_with_refreshed_list();
        let disk = disks
            .list()
            .iter()
            .filter(|d| instance_dir.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| {
                let total = d.total_space();
                let used = total.saturating_sub(d.available_space());
                DiskStats {
                    used_bytes: Some(used),
                    total_bytes: Some(total),
                    percent: if total > 0 {
                        Some(used as f64 / total as f64 * 100.0)
                    } else {
                        None
                    },
                }
            });
        (cpu, mem, disk)
    })
    .await
    .map_err(|e| Error::Internal(format!("metrics task panicked: {e}")))?;

    metrics.cpu_percent = cpu;
    metrics.mem = mem;
    metrics.disk = disk;
    // net/block: container-only unless future enrichment (§3.9) — stay None.

    if core.supervisor.is_active() {
        metrics.tps = tps_via_rcon(core).await;
    }
    Ok(metrics)
}

/// `get_metrics` (§3.9).
pub async fn get(core: &crate::Core) -> Result<Metrics> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => advanced_metrics(core).await,
        Mode::Simple => simple_metrics(core).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_df_output() {
        let stdout = "Filesystem     1K-blocks      Used Available Use% Mounted on\n/dev/sda1      102400000  51200000  51200000  50% /data";
        let disk = parse_df_output(stdout).unwrap();
        assert_eq!(disk.total_bytes, Some(102400000 * 1024));
        assert_eq!(disk.used_bytes, Some(51200000 * 1024));
        assert_eq!(disk.percent, Some(50.0));
    }

    #[test]
    fn df_garbage_is_none() {
        assert!(parse_df_output("").is_none());
        assert!(parse_df_output("nonsense").is_none());
    }
}
