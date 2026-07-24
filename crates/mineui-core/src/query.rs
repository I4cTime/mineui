//! Minecraft Server List Ping client (contract §3.2, module map §8).
//! Hand-rolled: handshake (next state = status) + status request + ping,
//! 3 s overall timeout.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::{Error, Result};
use crate::model::{SampleName, ServerStatus, StatusPlayers};

const TIMEOUT: Duration = Duration::from_secs(3);

fn write_varint(out: &mut Vec<u8>, value: i32) {
    let mut v = value as u32;
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
}

async fn read_varint(stream: &mut TcpStream) -> Result<i32> {
    let mut result: u32 = 0;
    for i in 0..5 {
        let mut byte = [0u8; 1];
        stream
            .read_exact(&mut byte)
            .await
            .map_err(|e| Error::QueryUnavailable(format!("ping read failed: {e}")))?;
        result |= ((byte[0] & 0x7f) as u32) << (7 * i);
        if byte[0] & 0x80 == 0 {
            return Ok(result as i32);
        }
    }
    Err(Error::QueryUnavailable("varint too long".into()))
}

fn frame(packet: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(packet.len() + 5);
    write_varint(&mut out, packet.len() as i32);
    out.extend_from_slice(packet);
    out
}

/// Extract plain text from a chat-component `description` (string, or object
/// with `text` + `extra`).
fn motd_text(value: &serde_json::Value) -> Option<String> {
    fn collect(value: &serde_json::Value, out: &mut String) {
        match value {
            serde_json::Value::String(s) => out.push_str(s),
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(s)) = map.get("text") {
                    out.push_str(s);
                }
                if let Some(serde_json::Value::Array(extra)) = map.get("extra") {
                    for item in extra {
                        collect(item, out);
                    }
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    collect(item, out);
                }
            }
            _ => {}
        }
    }
    let mut out = String::new();
    collect(value, &mut out);
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

async fn ping_inner(host: &str, port: u16) -> Result<ServerStatus> {
    let mut stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| Error::QueryUnavailable(format!("connect failed ({host}:{port}): {e}")))?;

    // Handshake: id 0x00, protocol -1, host, port, next state 1 (status).
    let mut handshake = Vec::new();
    write_varint(&mut handshake, 0x00);
    write_varint(&mut handshake, -1);
    write_varint(&mut handshake, host.len() as i32);
    handshake.extend_from_slice(host.as_bytes());
    handshake.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut handshake, 1);

    // Status request: id 0x00, empty.
    let mut request = Vec::new();
    write_varint(&mut request, 0x00);

    let mut buf = frame(&handshake);
    buf.extend_from_slice(&frame(&request));
    stream
        .write_all(&buf)
        .await
        .map_err(|e| Error::QueryUnavailable(format!("ping write failed: {e}")))?;

    // Status response: length, id 0x00, JSON string.
    let _len = read_varint(&mut stream).await?;
    let packet_id = read_varint(&mut stream).await?;
    if packet_id != 0x00 {
        return Err(Error::QueryUnavailable(format!(
            "unexpected status packet id {packet_id}"
        )));
    }
    let json_len = read_varint(&mut stream).await?;
    if !(0..=1_048_576).contains(&json_len) {
        return Err(Error::QueryUnavailable("status JSON too large".into()));
    }
    let mut json_buf = vec![0u8; json_len as usize];
    stream
        .read_exact(&mut json_buf)
        .await
        .map_err(|e| Error::QueryUnavailable(format!("ping read failed: {e}")))?;
    let value: serde_json::Value = serde_json::from_slice(&json_buf)
        .map_err(|e| Error::QueryUnavailable(format!("invalid status JSON: {e}")))?;

    // Ping packet: id 0x01 + i64 payload; the server echoes it back.
    let ping_ms = {
        let started = std::time::Instant::now();
        let mut ping = Vec::new();
        write_varint(&mut ping, 0x01);
        ping.extend_from_slice(&0i64.to_le_bytes());
        let ok = stream.write_all(&frame(&ping)).await.is_ok();
        if ok {
            let mut echo = vec![0u8; 10];
            match stream.read(&mut echo).await {
                Ok(n) if n > 0 => Some(started.elapsed().as_millis() as u64),
                _ => None,
            }
        } else {
            None
        }
    };

    let players = value.get("players");
    let sample = players
        .and_then(|p| p.get("sample"))
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    entry
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|name| SampleName {
                            name: name.to_string(),
                        })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ServerStatus {
        online: true,
        version: value
            .get("version")
            .and_then(|v| v.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.to_string()),
        motd: value.get("description").and_then(motd_text),
        players: StatusPlayers {
            online: players
                .and_then(|p| p.get("online"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            max: players
                .and_then(|p| p.get("max"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            sample,
        },
        ping_ms,
        source: "query".into(),
        error: None,
    })
}

/// Server list ping with a 3 s overall timeout. Errors are returned as `Err`;
/// the status composition layer converts them to an offline `ServerStatus`.
pub async fn ping(host: &str, port: u16) -> Result<ServerStatus> {
    tokio::time::timeout(TIMEOUT, ping_inner(host, port))
        .await
        .map_err(|_| Error::QueryUnavailable(format!("ping timed out ({host}:{port})")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_encoding() {
        let mut buf = Vec::new();
        write_varint(&mut buf, 0);
        assert_eq!(buf, [0x00]);
        buf.clear();
        write_varint(&mut buf, 300);
        assert_eq!(buf, [0xac, 0x02]);
        buf.clear();
        write_varint(&mut buf, -1);
        assert_eq!(buf, [0xff, 0xff, 0xff, 0xff, 0x0f]);
    }

    #[test]
    fn motd_text_variants() {
        assert_eq!(
            motd_text(&serde_json::json!("A Minecraft Server")),
            Some("A Minecraft Server".into())
        );
        assert_eq!(
            motd_text(&serde_json::json!({ "text": "Hello", "extra": [{ "text": " World" }] })),
            Some("Hello World".into())
        );
        assert_eq!(motd_text(&serde_json::json!({})), None);
    }
}
