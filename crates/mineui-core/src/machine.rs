//! Facts about the Podman machine behind the runtime (§3.2, §3.13). On
//! Windows, whether a published port ever reaches the user's loopback depends
//! on the machine's provider and mode; the answers change only when the user
//! reconfigures the machine, so they are cached for a minute per profile.

use std::net::Ipv4Addr;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::runtime::Runtime;

const TTL: Duration = Duration::from_secs(60);
const DEFAULT_MACHINE: &str = "podman-machine-default";
/// `wsl.exe` and `cmd /C ver` answer at once; a hung WSL must not hold up
/// `get_join_info`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MachineFacts {
    /// "wsl", "hyperv", "applehv", … (`podman machine info`).
    pub vm_type: Option<String>,
    pub rootful: Option<bool>,
    /// The WSL machine's address (`wsl.exe -d <name> -e hostname -I`,
    /// `parse_wsl_address`).
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

/// Run `program args` with a timeout; stdout when it exits 0.
async fn probe_stdout(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    crate::util::prepare_child(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `wsl.exe -d <machine> -e hostname -I` → the VM's address (§3.16
/// `wslAddress`, 2.11.1). The VM's address survives WSL restarts only by
/// luck, hence the short cache above.
async fn wsl_address(machine: &str) -> Option<String> {
    let stdout = probe_stdout("wsl.exe", &["-d", machine, "-e", "hostname", "-I"]).await?;
    parse_wsl_address(&stdout)
}

/// The first usable IPv4 address in `hostname -I` output that is not on
/// Podman's own bridge (`10.88.0.0/16`); a tester's machine printed
/// `172.21.76.85 10.88.0.1`.
pub fn parse_wsl_address(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .filter_map(|token| token.parse::<Ipv4Addr>().ok())
        .find(|ip| {
            let [a, b, ..] = ip.octets();
            !(a == 10 && b == 88)
                && !(ip.is_unspecified()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_broadcast()
                    || ip.is_multicast())
        })
        .map(|ip| ip.to_string())
}

/// The Windows build number (§3.16 `windowsBuild`, 2.11.1): `cmd /C ver`
/// once per process. Always `None` off Windows, where nothing is run.
pub async fn windows_build() -> Option<u32> {
    if !cfg!(windows) {
        return None;
    }
    static BUILD: tokio::sync::OnceCell<Option<u32>> = tokio::sync::OnceCell::const_new();
    *BUILD
        .get_or_init(|| async {
            // A compile-time-constant argv; `ver` is a cmd builtin.
            let stdout = probe_stdout("cmd", &["/C", "ver"]).await?;
            parse_windows_build(&stdout)
        })
        .await
}

/// `Microsoft Windows [Version 10.0.19045.6466]` → `19045`: the third
/// number of the first `a.b.c[.d]` token, inside the brackets when there are
/// any. The words around it are localized (`[Versión 10.0.22631.4317]`).
pub fn parse_windows_build(stdout: &str) -> Option<u32> {
    let text = match (stdout.find('['), stdout.rfind(']')) {
        (Some(open), Some(close)) if open < close => &stdout[open + 1..close],
        _ => stdout,
    };
    text.split_whitespace().find_map(|token| {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() < 3
            || !parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        parts[2].parse().ok()
    })
}

/// What to tell the user when `ports_unreachable_from_windows` (§3.2).
pub fn rootful_wsl_note(ip: Option<&str>, port: u16) -> String {
    let mut note = String::from(
        "Windows cannot reach ports published by a rootful Podman machine (WSL). \
         Switch it to rootless - podman machine stop; podman machine set --rootful=false; \
         podman machine start - then create the server again",
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
    fn windows_build_from_ver() {
        assert_eq!(
            parse_windows_build("\r\nMicrosoft Windows [Version 10.0.19045.6466]\r\n"),
            Some(19045)
        );
        assert_eq!(
            parse_windows_build("Microsoft Windows [Version 10.0.26100.4652]"),
            Some(26100)
        );
        assert_eq!(
            parse_windows_build("Microsoft Windows [Versión 10.0.22631.4317]"),
            Some(22631)
        );
        assert_eq!(
            parse_windows_build("Microsoft Windows [Version 10.0.22621]"),
            Some(22621)
        );
        for garbage in [
            "",
            "Microsoft Windows",
            "[Version ten]",
            "[Version 10.0]",
            "[Version 10..19045.1]",
            "[Version 10.0.x.1]",
        ] {
            assert_eq!(parse_windows_build(garbage), None, "{garbage:?}");
        }
    }

    #[test]
    fn wsl_address_skips_the_podman_bridge() {
        assert_eq!(
            parse_wsl_address("172.21.76.85 10.88.0.1 \n").as_deref(),
            Some("172.21.76.85")
        );
        assert_eq!(
            parse_wsl_address("10.88.0.1 172.21.76.85").as_deref(),
            Some("172.21.76.85")
        );
        assert_eq!(
            parse_wsl_address("fe80::1 127.0.0.1 169.254.3.3 192.168.50.7").as_deref(),
            Some("192.168.50.7")
        );
        // 10.x outside 10.88/16 is a real address.
        assert_eq!(parse_wsl_address("10.89.0.4").as_deref(), Some("10.89.0.4"));
        assert_eq!(parse_wsl_address("10.88.0.1"), None);
        assert_eq!(parse_wsl_address(""), None);
        assert_eq!(parse_wsl_address("<3>WSL error"), None);
    }

    #[tokio::test]
    async fn no_windows_build_off_windows() {
        if !cfg!(windows) {
            assert_eq!(windows_build().await, None);
        }
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
