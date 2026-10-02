//! Minimal Source-RCON client (contract §3.4, module map §8).
//!
//! Packet layout (little-endian):
//!   length: i32 (size of the rest), id: i32, type: i32, body: NUL-terminated,
//!   trailing NUL. Auth = type 3 (response type 2, id == -1 on failure);
//!   exec = type 2 (response type 0).

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::{Error, Result};

pub const TYPE_AUTH: i32 = 3;
pub const TYPE_AUTH_RESPONSE: i32 = 2;
pub const TYPE_EXEC: i32 = 2;
pub const TYPE_RESPONSE: i32 = 0;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to keep waiting for the terminator once output has arrived.
const TERMINATOR_GRACE: Duration = Duration::from_secs(1);
const MAX_PACKET_BODY: usize = 4096;
/// Cap on one command's reassembled output.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// Encode an RCON packet.
pub fn encode_packet(id: i32, ptype: i32, body: &str) -> Vec<u8> {
    let body_bytes = body.as_bytes();
    let len = (4 + 4 + body_bytes.len() + 2) as i32;
    let mut out = Vec::with_capacity(4 + len as usize);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&ptype.to_le_bytes());
    out.extend_from_slice(body_bytes);
    out.push(0);
    out.push(0);
    out
}

/// Decode a packet payload (everything after the 4-byte length prefix).
pub fn decode_payload(payload: &[u8]) -> Result<(i32, i32, String)> {
    if payload.len() < 10 {
        return Err(Error::RconUnavailable("RCON response too short".into()));
    }
    let id = i32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let ptype = i32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
    let body_bytes = &payload[8..payload.len().saturating_sub(2)];
    let body = String::from_utf8_lossy(body_bytes).to_string();
    Ok((id, ptype, body))
}

pub struct RconClient {
    stream: TcpStream,
    next_id: i32,
}

impl RconClient {
    /// Connect + authenticate. Failure of either → RCON_UNAVAILABLE.
    pub async fn connect(host: &str, port: u16, password: &str) -> Result<Self> {
        if password.is_empty() {
            return Err(Error::RconUnavailable(
                "RCON password not configured".into(),
            ));
        }
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .map_err(|_| Error::RconUnavailable(format!("RCON connect timed out ({host}:{port})")))?
            .map_err(|e| {
                Error::RconUnavailable(format!("RCON connect failed ({host}:{port}): {e}"))
            })?;
        let mut client = RconClient { stream, next_id: 1 };

        let auth_id = client.send_packet(TYPE_AUTH, password).await?;
        // The server may send an empty TYPE_RESPONSE before the auth response.
        loop {
            let (id, ptype, _body) = client.read_packet().await?;
            if ptype == TYPE_AUTH_RESPONSE {
                if id == -1 {
                    return Err(Error::RconUnavailable("RCON authentication failed".into()));
                }
                if id == auth_id {
                    break;
                }
            }
        }
        Ok(client)
    }

    /// Execute one command and return its output.
    ///
    /// The command is followed by an empty `TYPE_RESPONSE` packet, which
    /// every Minecraft server echoes back as "Unknown request 0" under its
    /// own id — a terminator (§3.4). Reading up to it is what makes two
    /// loader differences invisible: Forge sends **nothing** for a command
    /// with no output (`say`, `save-all` on some versions), where vanilla and
    /// Fabric send one empty packet; and output over 4096 bytes arrives as
    /// several packets.
    pub async fn exec(&mut self, command: &str) -> Result<String> {
        let exec_id = self.send_packet(TYPE_EXEC, command).await?;
        let end_id = self.send_packet(TYPE_RESPONSE, "").await?;
        let mut output = String::new();
        let mut answered = false;
        loop {
            let wait = if answered {
                TERMINATOR_GRACE
            } else {
                IO_TIMEOUT
            };
            let Some((id, _ptype, body)) = self.read_packet_within(wait).await? else {
                if answered {
                    // A server that ignores the terminator: keep what it said.
                    break;
                }
                return Err(Error::RconUnavailable("RCON read timed out".into()));
            };
            if id == end_id {
                break;
            }
            if id == exec_id {
                answered = true;
                if output.len() + body.len() <= MAX_OUTPUT_BYTES {
                    output.push_str(&body);
                }
            }
        }
        Ok(output)
    }

    async fn send_packet(&mut self, ptype: i32, body: &str) -> Result<i32> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        let packet = encode_packet(id, ptype, body);
        tokio::time::timeout(IO_TIMEOUT, self.stream.write_all(&packet))
            .await
            .map_err(|_| Error::RconUnavailable("RCON write timed out".into()))?
            .map_err(|e| Error::RconUnavailable(format!("RCON write failed: {e}")))?;
        Ok(id)
    }

    async fn read_packet(&mut self) -> Result<(i32, i32, String)> {
        self.read_packet_within(IO_TIMEOUT)
            .await?
            .ok_or_else(|| Error::RconUnavailable("RCON read timed out".into()))
    }

    /// One packet, or `None` if none starts arriving within `wait`.
    async fn read_packet_within(&mut self, wait: Duration) -> Result<Option<(i32, i32, String)>> {
        let mut len_buf = [0u8; 4];
        match tokio::time::timeout(wait, self.stream.read_exact(&mut len_buf)).await {
            Err(_) => return Ok(None),
            Ok(read) => {
                read.map_err(|e| Error::RconUnavailable(format!("RCON read failed: {e}")))?;
            }
        }
        let len = i32::from_le_bytes(len_buf);
        if !(10..=(MAX_PACKET_BODY as i32 + 10)).contains(&len) {
            return Err(Error::RconUnavailable(format!(
                "RCON packet length out of range: {len}"
            )));
        }
        let mut payload = vec![0u8; len as usize];
        tokio::time::timeout(IO_TIMEOUT, self.stream.read_exact(&mut payload))
            .await
            .map_err(|_| Error::RconUnavailable("RCON read timed out".into()))?
            .map_err(|e| Error::RconUnavailable(format!("RCON read failed: {e}")))?;
        decode_payload(&payload).map(Some)
    }
}

/// Resolve the RCON endpoint for the active mode (§3.4) and run one command
/// (no allowlist check — callers that accept user input use `run_allowlisted`).
pub async fn run(core: &crate::Core, command: &str) -> Result<String> {
    let settings = core.settings().await;
    let (host, port, password) = match settings.active_mode {
        crate::settings::Mode::Advanced => (
            settings.advanced.rcon_host.clone(),
            settings.advanced.rcon_port,
            settings.advanced.rcon_password.clone(),
        ),
        crate::settings::Mode::Simple => (
            "127.0.0.1".to_string(),
            settings.simple.rcon_port,
            settings.simple.rcon_password.clone(),
        ),
    };
    let mut client = RconClient::connect(&host, port, &password).await?;
    client.exec(command).await
}

/// §3.4 `run_rcon_command`: validate against the allowlist, then execute.
async fn run_allowlisted_inner(core: &crate::Core, command: &str) -> Result<String> {
    let allowlist = core.settings().await.rcon_allowlist;
    let cleaned = crate::validate::rcon_command(command, &allowlist)?;
    run(core, &cleaned).await
}

/// Player-management verbs whose audit action becomes `player.<verb>` with
/// the player name as target (§3.11).
const PLAYER_VERBS: [&str; 6] = ["kick", "ban", "pardon", "op", "deop", "whitelist"];

/// (action, target) for an allowlisted command line.
pub fn audit_action(command: &str) -> (String, Option<String>) {
    let cleaned = command.trim().trim_start_matches('/');
    let mut tokens = cleaned.split_whitespace();
    let verb = tokens.next().unwrap_or("").to_lowercase();
    if PLAYER_VERBS.contains(&verb.as_str()) {
        // `whitelist add <name>` / `kick <name> [reason]` / `ban <name> [reason]`
        let target = if verb == "whitelist" {
            tokens.nth(1)
        } else {
            tokens.next()
        };
        return (format!("player.{verb}"), target.map(str::to_string));
    }
    (
        "rcon.command".to_string(),
        (!verb.is_empty()).then_some(verb),
    )
}

/// §3.4 `run_rcon_command`, audited (§3.11): `player.<verb>` for
/// player-management commands, `rcon.command` otherwise. The full command is
/// recorded as detail.
pub async fn run_allowlisted(core: &crate::Core, command: &str) -> Result<String> {
    let r = run_allowlisted_inner(core, command).await;
    let (action, target) = audit_action(command);
    let detail = command.trim();
    crate::audit::record(
        core,
        crate::model::AuditSource::User,
        &action,
        target.as_deref(),
        (!detail.is_empty()).then_some(detail),
        r.as_ref().err(),
    )
    .await;
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_roundtrip() {
        let encoded = encode_packet(7, TYPE_EXEC, "list");
        // length prefix = 4 + 4 + 4 + 2 = 14
        assert_eq!(&encoded[0..4], &14i32.to_le_bytes());
        let (id, ptype, body) = decode_payload(&encoded[4..]).unwrap();
        assert_eq!(id, 7);
        assert_eq!(ptype, TYPE_EXEC);
        assert_eq!(body, "list");
    }

    #[test]
    fn empty_body_roundtrip() {
        let encoded = encode_packet(1, TYPE_AUTH, "");
        assert_eq!(&encoded[0..4], &10i32.to_le_bytes());
        let (id, ptype, body) = decode_payload(&encoded[4..]).unwrap();
        assert_eq!((id, ptype), (1, TYPE_AUTH));
        assert_eq!(body, "");
    }

    #[test]
    fn decode_rejects_short_payload() {
        assert!(decode_payload(&[0, 0, 0]).is_err());
    }

    /// How a fake server answers an exec packet.
    #[derive(Clone, Copy)]
    enum Loader {
        /// One packet per 4096 bytes, and one empty packet for no output.
        Vanilla,
        /// Like vanilla, but silent when there is no output (Forge 52).
        Forge,
        /// Vanilla answers, but the terminator packet is ignored.
        NoTerminator,
    }

    /// Minimal RCON server: accepts one client, authenticates anything, and
    /// answers every exec with `output` the way `loader` would.
    async fn fake_server(loader: Loader, output: &'static str) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            loop {
                let mut len_buf = [0u8; 4];
                if sock.read_exact(&mut len_buf).await.is_err() {
                    return;
                }
                let mut payload = vec![0u8; i32::from_le_bytes(len_buf) as usize];
                sock.read_exact(&mut payload).await.unwrap();
                let (id, ptype, _body) = decode_payload(&payload).unwrap();
                let replies: Vec<(i32, String)> = match ptype {
                    TYPE_AUTH => vec![(TYPE_AUTH_RESPONSE, String::new())],
                    TYPE_EXEC => {
                        let mut chunks: Vec<(i32, String)> = output
                            .as_bytes()
                            .chunks(MAX_PACKET_BODY)
                            .map(|c| (TYPE_RESPONSE, String::from_utf8(c.to_vec()).unwrap()))
                            .collect();
                        if chunks.is_empty() && !matches!(loader, Loader::Forge) {
                            chunks.push((TYPE_RESPONSE, String::new()));
                        }
                        chunks
                    }
                    _ if matches!(loader, Loader::NoTerminator) => Vec::new(),
                    other => vec![(TYPE_RESPONSE, format!("Unknown request {other:x}"))],
                };
                for (rtype, body) in replies {
                    sock.write_all(&encode_packet(id, rtype, &body))
                        .await
                        .unwrap();
                }
            }
        });
        port
    }

    async fn exec_against(loader: Loader, output: &'static str) -> Result<String> {
        let port = fake_server(loader, output).await;
        let mut client = RconClient::connect("127.0.0.1", port, "pw").await?;
        client.exec("say hi").await
    }

    #[tokio::test]
    async fn exec_returns_single_packet_output() {
        let out = exec_against(
            Loader::Vanilla,
            "There are 0 of a max of 20 players online: ",
        );
        assert_eq!(
            out.await.unwrap(),
            "There are 0 of a max of 20 players online: "
        );
    }

    #[tokio::test]
    async fn exec_with_no_output_is_empty_not_a_timeout() {
        // Vanilla/Fabric answer with an empty packet; Forge answers with
        // nothing at all (verified live on Forge 52.1.0 / 1.21.1).
        let started = std::time::Instant::now();
        assert_eq!(exec_against(Loader::Vanilla, "").await.unwrap(), "");
        assert_eq!(exec_against(Loader::Forge, "").await.unwrap(), "");
        assert!(
            started.elapsed() < IO_TIMEOUT,
            "must not wait out a timeout"
        );
    }

    #[tokio::test]
    async fn exec_reassembles_multi_packet_output() {
        let long: &'static str = Box::leak("0123456789".repeat(1000).into_boxed_str());
        for loader in [Loader::Vanilla, Loader::Forge] {
            assert_eq!(exec_against(loader, long).await.unwrap(), long);
        }
    }

    #[tokio::test]
    async fn exec_tolerates_a_server_that_ignores_the_terminator() {
        let out = exec_against(Loader::NoTerminator, "pong").await.unwrap();
        assert_eq!(out, "pong");
    }

    #[test]
    fn auth_failure_id_is_detectable() {
        let encoded = encode_packet(-1, TYPE_AUTH_RESPONSE, "");
        let (id, ptype, _) = decode_payload(&encoded[4..]).unwrap();
        assert_eq!(id, -1);
        assert_eq!(ptype, TYPE_AUTH_RESPONSE);
    }
}
