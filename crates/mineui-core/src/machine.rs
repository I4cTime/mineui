//! Facts about the Podman machine behind the runtime (§3.2, §3.13). On
//! Windows, whether a published port ever reaches the user's loopback depends
//! on the machine's provider and mode; the answers change only when the user
//! reconfigures the machine, so they are cached for a minute per profile.

use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::runtime::Runtime;

const TTL: Duration = Duration::from_secs(60);
const DEFAULT_MACHINE: &str = "podman-machine-default";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MachineFacts {
    /// "wsl", "hyperv", "applehv", … (`podman machine info`).
    pub vm_type: Option<String>,
    pub rootful: Option<bool>,
    /// First address of the WSL machine (`wsl.exe -d <name> hostname -I`).
    pub ip: Option<String>,
}

impl MachineFacts {
    /// WSL's localhost relay mirrors listening sockets only; a rootful
    /// machine publishes with NAT rules, so Windows never sees its ports
    /// (verified on a tester's machine, 2.7.3).
    pub fn ports_unreachable_from_windows(&self) -> bool {
        cfg!(windows) && self.vm_type.as_deref() == Some("wsl") && self.rootful == Some(true)
    }
}

/// The machine behind `runtime`; `Default` (nothing known) for docker and
/// off Windows, where the question does not arise.
pub async fn facts(core: &crate::Core, runtime: &dyn Runtime) -> MachineFacts {
    if !cfg!(windows) || runtime.kind() != "podman" {
        return MachineFacts::default();
    }
    if let Some((at, facts)) = core.machine_facts.lock().await.as_ref() {
        if at.elapsed() < TTL {
            return facts.clone();
        }
    }
    let vm_type = runtime.machine_vm_type().await;
    let (rootful, ip) = if vm_type.as_deref() == Some("wsl") {
        let name = runtime
            .machine_name()
            .await
            .unwrap_or_else(|| DEFAULT_MACHINE.to_string());
        (runtime.machine_rootful().await, wsl_address(&name).await)
    } else {
        (None, None)
    };
    let facts = MachineFacts {
        vm_type,
        rootful,
        ip,
    };
    *core.machine_facts.lock().await = Some((Instant::now(), facts.clone()));
    facts
}

/// `wsl.exe -d <machine> hostname -I` → the first address (the VM's eth0;
/// podman's bridge comes second). The VM's address survives WSL restarts
/// only by luck, hence the short cache above.
async fn wsl_address(machine: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new("wsl.exe");
    crate::util::hide_console(&mut cmd);
    let out = cmd
        .args(["-d", machine, "hostname", "-I"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .map(str::to_string)
}

/// What to tell the user when `ports_unreachable_from_windows` (§3.2).
pub fn rootful_wsl_note(ip: Option<&str>, port: u16) -> String {
    let mut note = String::from(
        "Windows cannot reach ports published by a rootful Podman machine (WSL). \
         Switch it to rootless — podman machine stop; podman machine set --rootful=false; \
         podman machine start — then create the server again",
    );
    if let Some(ip) = ip {
        note.push_str(&format!(". Until then the server answers at {ip}:{port}"));
    }
    note.push('.');
    note
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names_the_fix_and_the_interim_address() {
        let with_ip = rootful_wsl_note(Some("172.21.76.85"), 25565);
        assert!(with_ip.contains("podman machine set --rootful=false"));
        assert!(with_ip.ends_with("answers at 172.21.76.85:25565."));
        let without = rootful_wsl_note(None, 25565);
        assert!(without.ends_with("create the server again."));
        assert!(!without.contains("answers at"));
    }

    #[test]
    fn only_a_rootful_wsl_machine_is_unreachable() {
        let wsl_rootful = MachineFacts {
            vm_type: Some("wsl".into()),
            rootful: Some(true),
            ip: None,
        };
        // The check is also gated on cfg!(windows): true there, false here.
        assert_eq!(wsl_rootful.ports_unreachable_from_windows(), cfg!(windows));
        let wsl_rootless = MachineFacts {
            rootful: Some(false),
            ..wsl_rootful.clone()
        };
        assert!(!wsl_rootless.ports_unreachable_from_windows());
        let hyperv = MachineFacts {
            vm_type: Some("hyperv".into()),
            ..wsl_rootful
        };
        assert!(!hyperv.ports_unreachable_from_windows());
        assert!(!MachineFacts::default().ports_unreachable_from_windows());
    }
}
