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
const MAX_PACKET_BODY: usize = 4096;

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

    /// Execute one command and return its output (single response packet,
    /// v1 parity: one connection per command).
    pub async fn exec(&mut self, command: &str) -> Result<String> {
        let _id = self.send_packet(TYPE_EXEC, command).await?;
        let (_id, _ptype, body) = self.read_packet().await?;
        Ok(body)
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
        let mut len_buf = [0u8; 4];
        tokio::time::timeout(IO_TIMEOUT, self.stream.read_exact(&mut len_buf))
            .await
            .map_err(|_| Error::RconUnavailable("RCON read timed out".into()))?
            .map_err(|e| Error::RconUnavailable(format!("RCON read failed: {e}")))?;
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
        decode_payload(&payload)
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
pub async fn run_allowlisted(core: &crate::Core, command: &str) -> Result<String> {
    let allowlist = core.settings().await.rcon_allowlist;
    let cleaned = crate::validate::rcon_command(command, &allowlist)?;
    run(core, &cleaned).await
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

    #[test]
    fn auth_failure_id_is_detectable() {
        let encoded = encode_packet(-1, TYPE_AUTH_RESPONSE, "");
        let (id, ptype, _) = decode_payload(&encoded[4..]).unwrap();
        assert_eq!(id, -1);
        assert_eq!(ptype, TYPE_AUTH_RESPONSE);
    }
}
