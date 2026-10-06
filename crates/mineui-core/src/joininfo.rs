//! How players reach the server (contract §3.16, 2.11.0): the reach of the
//! published ports, whether MineUI may rebuild the container with other
//! ports, this computer's LAN address, and - on an explicit request only -
//! the public address as the internet sees it.
//!
//! Everything here is read-only; nothing touches a container.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::time::Duration;

use crate::error::{Error, Result};
use crate::model::{JoinInfo, PortProtocol, PortReach, PublicAddress, ReachablePort};
use crate::runtime::{Mount, PortBinding, Runtime};
use crate::settings::Mode;

pub const PUBLIC_ADDRESS_URL: &str = "https://api.ipify.org";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const CONTAINER_GAME_PORT: u16 = 25565;
const CONTAINER_RCON_PORT: u16 = 25575;
/// TEST-NET-1 (RFC 5737): never routed, and a UDP `connect` sends nothing.
const PROBE_TARGET: (Ipv4Addr, u16) = (Ipv4Addr::new(192, 0, 2, 1), 9);

pub const WHY_NOT_NO_CONTAINER: &str = "There is no container yet.";
pub const WHY_NOT_FOREIGN: &str = "This container was not created by MineUI, so MineUI cannot rebuild it with other ports. Change its ports where you created it.";
pub const WHY_NOT_SIMPLE: &str = "A plain server listens on this computer directly - there is nothing to publish. A firewall may still need to allow the port.";
pub const REACH_NO_SERVER: &str = "There is no server yet.";

/// "Podman" / "Docker" for a runtime kind, as the user knows it.
fn runtime_display_name(kind: &str) -> &'static str {
    match kind {
        "docker" => "Docker",
        _ => "Podman",
    }
}

/// `reachProblem` when the container has no binding for the game port.
pub fn reach_problem_no_game_port(query_port: u16) -> String {
    format!(
        "The container does not publish the game port MineUI expects ({query_port}). Check the game port in Server Settings."
    )
}

/// Reach of one binding by its host address.
pub fn reach_of_host_ip(host_ip: &str) -> PortReach {
    let ip = host_ip.trim().trim_start_matches('[').trim_end_matches(']');
    if ip.is_empty() {
        return PortReach::Network;
    }
    match ip.parse::<IpAddr>() {
        Ok(addr) if addr.is_loopback() => PortReach::ThisComputer,
        // 0.0.0.0 / :: and one specific interface are both reachable from
        // other machines.
        _ => PortReach::Network,
    }
}

/// Game port reach and the extra ports, from a container's bindings.
pub fn summarize_bindings(
    bindings: &[PortBinding],
    game_port: u16,
    rcon_port: u16,
) -> (PortReach, Vec<ReachablePort>) {
    let is_game = |b: &PortBinding| {
        b.protocol == PortProtocol::Tcp
            && (b.container_port == CONTAINER_GAME_PORT || b.host_port == game_port)
    };
    let is_rcon = |b: &PortBinding| {
        b.protocol == PortProtocol::Tcp
            && (b.container_port == CONTAINER_RCON_PORT || b.host_port == rcon_port)
    };
    let game = bindings
        .iter()
        .find(|b| b.protocol == PortProtocol::Tcp && b.container_port == CONTAINER_GAME_PORT)
        .or_else(|| {
            bindings
                .iter()
                .find(|b| b.protocol == PortProtocol::Tcp && b.host_port == game_port)
        });
    // Two bindings of one port (docker's IPv4 + IPv6 pair) count once, with
    // the widest reach.
    let mut extra: Vec<ReachablePort> = Vec::new();
    for b in bindings.iter().filter(|b| !is_game(b) && !is_rcon(b)) {
        let reach = reach_of_host_ip(&b.host_ip);
        match extra
            .iter_mut()
            .find(|e| e.port == b.host_port && e.protocol == b.protocol)
        {
            Some(seen) if reach == PortReach::Network => seen.reach = reach,
            Some(_) => {}
            None => extra.push(ReachablePort {
                port: b.host_port,
                protocol: b.protocol,
                reach,
            }),
        }
    }
    extra.sort_by_key(|e| (e.port, e.protocol));
    let reach = match game {
        None => PortReach::Unknown,
        Some(_) => {
            let any_network = bindings
                .iter()
                .filter(|b| is_game(b))
                .any(|b| reach_of_host_ip(&b.host_ip) == PortReach::Network);
            if any_network {
                PortReach::Network
            } else {
                PortReach::ThisComputer
            }
        }
    };
    (reach, extra)
}

/// `itzg/minecraft-server`, with or without `docker.io/`, any tag or digest.
pub fn is_itzg_image(image: &str) -> bool {
    let image = image.trim();
    let without_digest = image.split('@').next().unwrap_or_default();
    // A `:` after the last `/` is the tag (a registry port comes before it).
    let repo = match without_digest.rfind(':') {
        Some(colon) if !without_digest[colon..].contains('/') => &without_digest[..colon],
        _ => without_digest,
    };
    let repo = repo
        .strip_prefix("docker.io/")
        .or_else(|| repo.strip_prefix("index.docker.io/"))
        .unwrap_or(repo);
    repo == "itzg/minecraft-server"
}

/// The shape every container MineUI created before 2.11.0 has: the itzg
/// image and exactly one mount, the named volume `<name>-data` at `/data`.
pub fn has_pre_211_shape(name: &str, image: &str, mounts: &[Mount]) -> bool {
    let volume = format!("{name}-data");
    is_itzg_image(image)
        && matches!(mounts, [m] if m.kind == "volume" && m.name == volume && m.destination == "/data")
}

/// Is `labels` carrying the 2.11.0 managed marker?
pub fn has_managed_label(labels: &[(String, String)]) -> bool {
    labels
        .iter()
        .any(|(k, v)| k == crate::provision::MANAGED_LABEL && v.trim() == "1")
}

/// `canChangePorts` / `whyNot` for an existing container (§3.16).
pub async fn rebuild_check(runtime: &dyn Runtime, name: &str) -> (bool, Option<String>) {
    if has_managed_label(&runtime.inspect_labels(name).await.unwrap_or_default()) {
        return (true, None);
    }
    let image = runtime.inspect_image(name).await.ok().flatten();
    let mounts = runtime.inspect_mounts(name).await.unwrap_or_default();
    match image {
        Some(image) if has_pre_211_shape(name, &image, &mounts) => (true, None),
        _ => (false, Some(WHY_NOT_FOREIGN.to_string())),
    }
}

/// An address players on the LAN can use: not loopback, link-local,
/// unspecified, broadcast or multicast.
pub fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation())
}

/// The primary IPv4 address: the source address the OS would pick for an
/// outside destination. No packet is sent.
fn primary_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(PROBE_TARGET).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

/// `lanAddresses` (§3.16): primary first; std only, so only the primary.
pub fn lan_addresses() -> Vec<String> {
    primary_ipv4()
        .filter(|ip| is_usable_lan_ipv4(*ip))
        .map(|ip| vec![ip.to_string()])
        .unwrap_or_default()
}

/// Simple mode: reach from `server.properties` `server-ip`.
pub fn reach_from_server_ip(server_ip: Option<&str>) -> PortReach {
    match server_ip.map(str::trim) {
        None | Some("") => PortReach::Network,
        Some(ip) => reach_of_host_ip(ip),
    }
}

/// The container part of `get_join_info` (§3.16): reach, extra ports,
/// `canChangePorts`/`whyNot`, and - whenever reach stays unknown - the
/// reason in `reachProblem` (2.11.1).
pub(crate) async fn fill_from_container(
    runtime: &dyn Runtime,
    name: &str,
    query_port: u16,
    rcon_port: u16,
    info: &mut JoinInfo,
) {
    match runtime.ps_state(name).await {
        Ok(detail) if detail.exists => {}
        Ok(_) => {
            info.why_not = Some(WHY_NOT_NO_CONTAINER.to_string());
            info.reach_problem = Some(WHY_NOT_NO_CONTAINER.to_string());
            return;
        }
        Err(e) => {
            info.why_not = Some(e.to_string());
            info.reach_problem = Some(format!(
                "MineUI could not ask {} about the container: {e}",
                runtime_display_name(runtime.kind())
            ));
            return;
        }
    }
    match runtime.inspect_ports(name).await {
        Ok(bindings) => {
            let (reach, extra) = summarize_bindings(&bindings, query_port, rcon_port);
            info.reach = reach;
            info.extra_ports = extra;
            if reach == PortReach::Unknown {
                info.reach_problem = Some(reach_problem_no_game_port(query_port));
            }
        }
        Err(e) => {
            info.reach_problem = Some(format!(
                "MineUI could not read the container's published ports: {e}"
            ));
        }
    }
    let (can, why_not) = rebuild_check(runtime, name).await;
    info.can_change_ports = can;
    info.why_not = why_not;
}

/// `get_join_info` (§3.16). Never rejects for a missing runtime or
/// container: those become `unknown` with the reason in `whyNot` and
/// `reachProblem`.
pub async fn join_info(core: &crate::Core) -> Result<JoinInfo> {
    let settings = core.settings().await;
    let lan = tokio::task::spawn_blocking(lan_addresses)
        .await
        .unwrap_or_default();
    let windows_build = crate::machine::windows_build().await;
    if settings.active_mode == Mode::Simple {
        let props = settings.simple.instance_dir.join("server.properties");
        let reach = if settings
            .simple
            .instance_dir
            .join(crate::instance::META_FILE)
            .is_file()
        {
            match tokio::fs::read_to_string(&props).await {
                Ok(content) => {
                    reach_from_server_ip(crate::instance::read_property(&content, "server-ip"))
                }
                // Created but never started: the server's default binds all.
                Err(_) => PortReach::Network,
            }
        } else {
            PortReach::Unknown
        };
        return Ok(JoinInfo {
            port: settings.simple.server_port,
            reach,
            lan_addresses: lan,
            extra_ports: Vec::new(),
            can_change_ports: false,
            why_not: Some(WHY_NOT_SIMPLE.to_string()),
            wsl_nat: false,
            reach_problem: (reach == PortReach::Unknown).then(|| REACH_NO_SERVER.to_string()),
            windows_build,
            wsl_address: None,
        });
    }

    let advanced = &settings.advanced;
    let mut info = JoinInfo {
        port: advanced.query_port,
        reach: PortReach::Unknown,
        lan_addresses: lan,
        extra_ports: Vec::new(),
        can_change_ports: false,
        why_not: None,
        wsl_nat: false,
        reach_problem: None,
        windows_build,
        wsl_address: None,
    };
    let runtime = match crate::runtime::resolve(advanced).await {
        Ok(runtime) => runtime,
        Err(e) => {
            info.why_not = Some(e.to_string());
            info.reach_problem = Some(e.to_string());
            return Ok(info);
        }
    };
    let facts = crate::machine::facts(core, runtime.as_ref()).await;
    info.wsl_nat = cfg!(windows) && facts.vm_type.as_deref() == Some("wsl");
    if info.wsl_nat {
        info.wsl_address = facts.ip.clone();
    }
    fill_from_container(
        runtime.as_ref(),
        advanced.container_name.as_str(),
        advanced.query_port,
        advanced.rcon_port,
        &mut info,
    )
    .await;
    Ok(info)
}

/// The ipify body → the address; anything but one IP address is refused.
pub fn parse_public_address(body: &str) -> Result<String> {
    let text = body.trim();
    if text.len() > 64 {
        return Err(Error::DownloadFailed(
            "the address service sent something unexpected".into(),
        ));
    }
    text.parse::<IpAddr>()
        .map(|ip| ip.to_string())
        .map_err(|_| Error::DownloadFailed("the address service sent something unexpected".into()))
}

/// `get_public_address` (§3.16): one GET, on an explicit user action only.
pub async fn public_address(http: &reqwest::Client) -> Result<PublicAddress> {
    let response = http
        .get(PUBLIC_ADDRESS_URL)
        .header(
            reqwest::header::USER_AGENT,
            format!(
                "I4cTime/mineui/{} (mineui.i4c.studio)",
                crate::appinfo::APP_VERSION
            ),
        )
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|_| {
            Error::DownloadFailed("could not reach the address service (api.ipify.org)".into())
        })?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "the address service answered HTTP {}",
            response.status().as_u16()
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|_| Error::DownloadFailed("the address service response was cut off".into()))?;
    Ok(PublicAddress {
        ip: parse_public_address(&body)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(
        container_port: u16,
        protocol: PortProtocol,
        ip: &str,
        host_port: u16,
    ) -> PortBinding {
        PortBinding {
            container_port,
            protocol,
            host_ip: ip.into(),
            host_port,
        }
    }

    #[test]
    fn reach_by_host_address() {
        for ip in ["", "0.0.0.0", "::", "[::]", "192.168.1.20"] {
            assert_eq!(reach_of_host_ip(ip), PortReach::Network, "{ip:?}");
        }
        for ip in ["127.0.0.1", "::1", "[::1]", "127.0.1.1"] {
            assert_eq!(reach_of_host_ip(ip), PortReach::ThisComputer, "{ip:?}");
        }
    }

    #[test]
    fn bindings_split_into_game_rcon_and_extra() {
        use PortProtocol::{Tcp, Udp};
        let bindings = [
            binding(25565, Tcp, "127.0.0.1", 25566),
            binding(25575, Tcp, "127.0.0.1", 25576),
            binding(24454, Udp, "0.0.0.0", 24454),
            binding(24454, Udp, "::", 24454),
            binding(8100, Tcp, "127.0.0.1", 8100),
            // UDP on the game port number is an extra port, not the game.
            binding(25566, Udp, "0.0.0.0", 25566),
        ];
        let (reach, extra) = summarize_bindings(&bindings, 25566, 25576);
        assert_eq!(reach, PortReach::ThisComputer);
        assert_eq!(
            extra,
            [
                ReachablePort {
                    port: 8100,
                    protocol: Tcp,
                    reach: PortReach::ThisComputer
                },
                ReachablePort {
                    port: 24454,
                    protocol: Udp,
                    reach: PortReach::Network
                },
                ReachablePort {
                    port: 25566,
                    protocol: Udp,
                    reach: PortReach::Network
                },
            ]
        );

        // Docker: empty HostIp = every interface.
        let (reach, extra) = summarize_bindings(&[binding(25565, Tcp, "", 25565)], 25565, 25575);
        assert_eq!(reach, PortReach::Network);
        assert!(extra.is_empty());

        // Nothing published for the game.
        let (reach, _) = summarize_bindings(&[], 25565, 25575);
        assert_eq!(reach, PortReach::Unknown);
    }

    #[test]
    fn itzg_image_names() {
        for ok in [
            "itzg/minecraft-server",
            "itzg/minecraft-server:java21",
            "docker.io/itzg/minecraft-server:latest",
            "index.docker.io/itzg/minecraft-server:java8",
            "docker.io/itzg/minecraft-server@sha256:abcd",
        ] {
            assert!(is_itzg_image(ok), "{ok}");
        }
        for bad in [
            "ghcr.io/itzg/minecraft-server:java21",
            "itzg/minecraft-bedrock-server",
            "localhost:5000/itzg/minecraft-server",
            "myfork/minecraft-server",
            "",
        ] {
            assert!(!is_itzg_image(bad), "{bad}");
        }
    }

    #[test]
    fn pre_211_shape() {
        let m = |kind: &str, name: &str, dest: &str| Mount {
            kind: kind.into(),
            name: name.into(),
            source: "/x".into(),
            destination: dest.into(),
        };
        let img = "docker.io/itzg/minecraft-server:java21";
        assert!(has_pre_211_shape(
            "mc",
            img,
            &[m("volume", "mc-data", "/data")]
        ));
        assert!(!has_pre_211_shape(
            "mc",
            img,
            &[m("volume", "other", "/data")]
        ));
        assert!(!has_pre_211_shape("mc", img, &[m("bind", "", "/data")]));
        assert!(!has_pre_211_shape(
            "mc",
            img,
            &[m("volume", "mc-data", "/data"), m("bind", "", "/mods")]
        ));
        assert!(!has_pre_211_shape("mc", img, &[]));
        assert!(!has_pre_211_shape(
            "mc",
            "itzg/minecraft-bedrock-server",
            &[m("volume", "mc-data", "/data")]
        ));
    }

    #[test]
    fn managed_label() {
        let l = |k: &str, v: &str| (k.to_string(), v.to_string());
        assert!(has_managed_label(&[
            l("org.opencontainers.image.title", "x"),
            l("studio.i4c.mineui.managed", "1")
        ]));
        assert!(!has_managed_label(&[l("studio.i4c.mineui.managed", "0")]));
        assert!(!has_managed_label(&[]));
    }

    #[test]
    fn lan_filter_drops_loopback_and_link_local() {
        for bad in [
            "127.0.0.1",
            "127.5.5.5",
            "169.254.10.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "192.0.2.1",
        ] {
            assert!(!is_usable_lan_ipv4(bad.parse().unwrap()), "{bad}");
        }
        for ok in ["192.168.1.20", "10.0.0.5", "172.16.3.4", "100.64.1.1"] {
            assert!(is_usable_lan_ipv4(ok.parse().unwrap()), "{ok}");
        }
        // Whatever this machine has, nothing filtered comes back.
        for addr in lan_addresses() {
            assert!(is_usable_lan_ipv4(addr.parse().unwrap()), "{addr}");
        }
    }

    #[test]
    fn simple_mode_reach_from_server_ip() {
        assert_eq!(reach_from_server_ip(None), PortReach::Network);
        assert_eq!(reach_from_server_ip(Some("")), PortReach::Network);
        assert_eq!(reach_from_server_ip(Some(" 0.0.0.0 ")), PortReach::Network);
        assert_eq!(
            reach_from_server_ip(Some("127.0.0.1")),
            PortReach::ThisComputer
        );
        assert_eq!(
            reach_from_server_ip(Some("192.168.1.2")),
            PortReach::Network
        );
    }

    #[test]
    fn public_address_body_validation() {
        assert_eq!(
            parse_public_address("203.0.113.7\n").unwrap(),
            "203.0.113.7"
        );
        assert_eq!(parse_public_address("2001:db8::1").unwrap(), "2001:db8::1");
        for bad in [
            "",
            "<html>rate limited</html>",
            "203.0.113.7; rm -rf",
            "not an ip",
            &"1".repeat(100),
        ] {
            assert_eq!(
                parse_public_address(bad).unwrap_err().code(),
                "DOWNLOAD_FAILED",
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn simple_mode_join_info() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let info = join_info(&core).await.unwrap();
        assert_eq!(info.port, 25565);
        assert_eq!(info.reach, PortReach::Unknown, "no instance yet");
        assert!(!info.can_change_ports);
        assert_eq!(info.why_not.as_deref(), Some(WHY_NOT_SIMPLE));
        assert!(info.extra_ports.is_empty());
        assert!(!info.wsl_nat);
        assert_eq!(info.reach_problem.as_deref(), Some(REACH_NO_SERVER));
        assert_eq!(info.wsl_address, None);
        if !cfg!(windows) {
            assert_eq!(info.windows_build, None);
        }

        let dir = core.settings().await.simple.instance_dir;
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(crate::instance::META_FILE), "{}").unwrap();
        std::fs::write(dir.join("server.properties"), "server-ip=127.0.0.1\n").unwrap();
        let info = join_info(&core).await.unwrap();
        assert_eq!(info.reach, PortReach::ThisComputer);
        assert_eq!(info.reach_problem, None);
        std::fs::write(dir.join("server.properties"), "motd=x\nserver-ip=\n").unwrap();
        assert_eq!(join_info(&core).await.unwrap().reach, PortReach::Network);
    }

    fn blank_info() -> JoinInfo {
        JoinInfo {
            port: 25566,
            reach: PortReach::Unknown,
            lan_addresses: Vec::new(),
            extra_ports: Vec::new(),
            can_change_ports: false,
            why_not: None,
            wsl_nat: false,
            reach_problem: None,
            windows_build: None,
            wsl_address: None,
        }
    }

    async fn filled(rt: &crate::fake_runtime::FakeRuntime) -> JoinInfo {
        let mut info = blank_info();
        fill_from_container(rt, "mc", 25566, 25576, &mut info).await;
        info
    }

    #[tokio::test]
    async fn reach_problem_names_every_unknown() {
        use crate::fake_runtime::FakeRuntime;
        use PortProtocol::Tcp;

        let rt = FakeRuntime {
            ps: Err("Cannot connect to Podman".into()),
            ..Default::default()
        };
        let info = filled(&rt).await;
        assert_eq!(info.reach, PortReach::Unknown);
        assert_eq!(
            info.reach_problem.as_deref(),
            Some("MineUI could not ask Podman about the container: Cannot connect to Podman")
        );

        let rt = FakeRuntime {
            ps: Ok(None),
            ..Default::default()
        };
        let info = filled(&rt).await;
        assert_eq!(info.reach_problem.as_deref(), Some(WHY_NOT_NO_CONTAINER));
        assert_eq!(info.why_not.as_deref(), Some(WHY_NOT_NO_CONTAINER));

        // The inspect failed: its words reach the user, and whyNot still
        // answers the other question.
        let rt = FakeRuntime {
            ports: Err("Error: no such object: \"mc\"".into()),
            labels: vec![(crate::provision::MANAGED_LABEL.into(), "1".into())],
            ..Default::default()
        };
        let info = filled(&rt).await;
        assert_eq!(info.reach, PortReach::Unknown);
        assert_eq!(
            info.reach_problem.as_deref(),
            Some("MineUI could not read the container's published ports: Error: no such object: \"mc\"")
        );
        assert!(info.can_change_ports);
        assert_eq!(info.why_not, None);

        // Published, but not the game port.
        let rt = FakeRuntime {
            ports: Ok(vec![binding(8100, Tcp, "0.0.0.0", 8100)]),
            ..Default::default()
        };
        let info = filled(&rt).await;
        assert_eq!(
            info.reach_problem.as_deref(),
            Some("The container does not publish the game port MineUI expects (25566). Check the game port in Server Settings.")
        );
        assert_eq!(info.why_not.as_deref(), Some(WHY_NOT_FOREIGN));

        // Known reach: no problem.
        let rt = FakeRuntime {
            ports: Ok(vec![binding(25565, Tcp, "127.0.0.1", 25566)]),
            ..Default::default()
        };
        let info = filled(&rt).await;
        assert_eq!(info.reach, PortReach::ThisComputer);
        assert_eq!(info.reach_problem, None);
    }

    #[tokio::test]
    async fn unresolvable_runtime_is_the_reach_problem() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let mut s = core.settings().await;
        s.active_mode = Mode::Advanced;
        s.advanced.runtime = crate::settings::RuntimeKind::Podman;
        s.advanced.runtime_binary = Some(tmp.path().join("no-such-podman"));
        core.update_settings(s).await.unwrap();
        let info = join_info(&core).await.unwrap();
        assert_eq!(info.reach, PortReach::Unknown);
        let problem = info.reach_problem.expect("a reason");
        assert!(!problem.is_empty());
        assert_eq!(Some(problem), info.why_not);
    }
}
