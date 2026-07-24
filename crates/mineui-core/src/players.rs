//! Online players + player history (contract §3.4) with the CORRECTED
//! regexes — the v1 source double-escaped `\s`/`\d`/`[Not Secure]` inside
//! regex literals so join/left lines never matched; v2 uses real classes.

use std::collections::HashMap;

use regex::Regex;
use std::sync::LazyLock;

use crate::error::Result;
use crate::model::{PlayerHistory, PlayerHistoryRow, PlayersResult};
use crate::settings::Mode;

static LOGIN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s+\[[^\]]+\]:\s+([^\[]+)\[/([\d.:]+)\]\s+logged in")
        .unwrap()
});
static LOGIN_NO_IP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s+\[[^\]]+\]:\s+(.+)\s+logged in with entity id")
        .unwrap()
});
static JOIN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\[(\d{2}):(\d{2}):(\d{2})\]\s+\[[^\]]+\]:\s+(?:\[Not Secure\]\s+)?(.+?)\s+joined the game$",
    )
    .unwrap()
});
static LEFT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\[(\d{2}):(\d{2}):(\d{2})\]\s+\[[^\]]+\]:\s+(?:\[Not Secure\]\s+)?(.+?)\s+left the game$",
    )
    .unwrap()
});
static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s+\[[^\]]+\]:\s+UUID of player (.+?) is").unwrap()
});

/// Parse RCON `list` output: "There are 2 of a max of 20 players online: A, B".
pub fn parse_list_output(output: &str) -> Vec<String> {
    let Some((_, names)) = output.split_once(':') else {
        return Vec::new();
    };
    names
        .split(',')
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

#[derive(Debug, Default, Clone)]
struct HistoryEntry {
    last_seen_epoch_ms: Option<i64>,
    ip_address: Option<String>,
}

fn caps_time(caps: &regex::Captures) -> Option<i64> {
    let hh: u32 = caps.get(1)?.as_str().parse().ok()?;
    let mm: u32 = caps.get(2)?.as_str().parse().ok()?;
    let ss: u32 = caps.get(3)?.as_str().parse().ok()?;
    crate::util::log_time_to_epoch_ms(hh, mm, ss)
}

/// Parse the v1 line patterns (login with IP, login without IP, joined/left,
/// UUID announcement), ANSI-stripped. Later lines win (log order).
fn parse_log_lines(lines: &[String]) -> HashMap<String, HistoryEntry> {
    let mut users: HashMap<String, HistoryEntry> = HashMap::new();
    for raw in lines {
        let line = crate::util::strip_ansi(raw);

        if let Some(caps) = LOGIN_RE.captures(&line) {
            let name = caps
                .get(4)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let entry = users.entry(name).or_default();
            entry.ip_address = caps.get(5).map(|m| m.as_str().to_string());
            entry.last_seen_epoch_ms = caps_time(&caps);
            continue;
        }
        for re in [&*LOGIN_NO_IP_RE, &*JOIN_RE, &*LEFT_RE, &*UUID_RE] {
            if let Some(caps) = re.captures(&line) {
                let name = caps
                    .get(4)
                    .map(|m| m.as_str().trim().to_string())
                    .unwrap_or_default();
                if !name.is_empty() {
                    let entry = users.entry(name).or_default();
                    entry.last_seen_epoch_ms = caps_time(&caps);
                }
                break;
            }
        }
    }
    users
}

/// `get_players` (§3.4): RCON `list`.
pub async fn online(core: &crate::Core) -> Result<PlayersResult> {
    let raw = crate::rcon::run(core, "list").await?;
    Ok(PlayersResult {
        players: parse_list_output(&raw),
        raw,
    })
}

async fn read_log_lines(core: &crate::Core) -> Vec<String> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            // argv-array exec, no `sh -c` (§3.4). Missing files just fail the
            // exec; treat as empty.
            let Ok(runtime) = crate::runtime::resolve(&settings.advanced).await else {
                return Vec::new();
            };
            let name = &settings.advanced.container_name;
            let mut lines: Vec<String> = Vec::new();
            for (file, tail) in [
                ("/data/logs/latest.log", "4000"),
                ("/data/logs/latest.log.1", "2000"),
            ] {
                if let Ok(out) = runtime.exec(name, &["tail", "-n", tail, file]).await {
                    if out.success() {
                        lines.extend(
                            out.stdout
                                .lines()
                                .filter(|l| !l.is_empty())
                                .map(String::from),
                        );
                    }
                }
            }
            lines
        }
        Mode::Simple => {
            let dir = settings.simple.instance_dir.join("logs");
            let mut lines: Vec<String> = Vec::new();
            for (file, tail) in [("latest.log", 4000usize), ("latest.log.1", 2000usize)] {
                if let Ok(content) = tokio::fs::read_to_string(dir.join(file)).await {
                    let all: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
                    let start = all.len().saturating_sub(tail);
                    lines.extend(all[start..].iter().map(|s| s.to_string()));
                }
            }
            lines
        }
    }
}

/// `get_player_history` (§3.4).
pub async fn history(core: &crate::Core) -> Result<PlayerHistory> {
    let list_output = crate::rcon::run(core, "list").await?;
    let online_players = parse_list_output(&list_output);
    let log_lines = read_log_lines(core).await;
    let parsed = parse_log_lines(&log_lines);

    let mut usernames: Vec<String> = online_players.clone();
    for name in parsed.keys() {
        if !usernames.contains(name) {
            usernames.push(name.clone());
        }
    }

    let mut rows: Vec<PlayerHistoryRow> = usernames
        .into_iter()
        .map(|username| {
            let entry = parsed.get(&username).cloned().unwrap_or_default();
            PlayerHistoryRow {
                is_online: online_players.contains(&username),
                last_seen_epoch_ms: entry.last_seen_epoch_ms,
                ip_address: entry.ip_address,
                username,
            }
        })
        .collect();

    // v1 sort: online first, then lastSeen desc.
    rows.sort_by(|a, b| {
        b.is_online.cmp(&a.is_online).then_with(|| {
            b.last_seen_epoch_ms
                .unwrap_or(0)
                .cmp(&a.last_seen_epoch_ms.unwrap_or(0))
        })
    });
    Ok(PlayerHistory { users: rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_output() {
        assert_eq!(
            parse_list_output("There are 2 of a max of 20 players online: Alice, Bob"),
            vec!["Alice", "Bob"]
        );
        assert_eq!(
            parse_list_output("There are 0 of a max of 20 players online:"),
            Vec::<String>::new()
        );
        assert_eq!(parse_list_output("garbage"), Vec::<String>::new());
    }

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_login_with_ip() {
        let parsed = parse_log_lines(&lines(&[
            "[10:15:30] [Server thread/INFO]: Alice[/192.168.1.50:51234] logged in with entity id 261 at (8.5, 64.0, 8.5)",
        ]));
        let entry = parsed.get("Alice").unwrap();
        assert_eq!(entry.ip_address.as_deref(), Some("192.168.1.50:51234"));
        assert!(entry.last_seen_epoch_ms.is_some());
    }

    #[test]
    fn parses_join_and_left_including_not_secure_prefix() {
        // These are exactly the lines the v1 double-escaped regexes missed.
        let parsed = parse_log_lines(&lines(&[
            "[10:16:00] [Server thread/INFO]: Alice joined the game",
            "[10:17:00] [Server thread/INFO]: [Not Secure] Bob joined the game",
            "[10:18:00] [Server thread/INFO]: [Not Secure] Bob left the game",
        ]));
        assert!(parsed.contains_key("Alice"));
        assert!(parsed.contains_key("Bob"));
        assert!(parsed.get("Bob").unwrap().last_seen_epoch_ms.is_some());
    }

    #[test]
    fn parses_uuid_announcement() {
        let parsed = parse_log_lines(&lines(&[
            "[09:00:01] [User Authenticator #1/INFO]: UUID of player Carol is 12345678-1234-1234-1234-123456789abc",
        ]));
        assert!(parsed.contains_key("Carol"));
    }

    #[test]
    fn strips_ansi_before_matching() {
        let parsed = parse_log_lines(&lines(&[
            "\x1b[32m[10:16:00] [Server thread/INFO]: Dave joined the game\x1b[0m",
        ]));
        assert!(parsed.contains_key("Dave"));
    }

    #[test]
    fn later_lines_update_last_seen() {
        let parsed = parse_log_lines(&lines(&[
            "[01:00:00] [Server thread/INFO]: Eve joined the game",
            "[02:00:00] [Server thread/INFO]: Eve left the game",
        ]));
        let entry = parsed.get("Eve").unwrap();
        let two_am = crate::util::log_time_to_epoch_ms(2, 0, 0).unwrap();
        assert_eq!(entry.last_seen_epoch_ms, Some(two_am));
    }

    #[test]
    fn ignores_unrelated_lines() {
        let parsed = parse_log_lines(&lines(&[
            "[10:00:00] [Server thread/INFO]: Preparing spawn area: 0%",
            "[10:00:00] [Server thread/INFO]: Done (12.3s)! For help, type \"help\"",
        ]));
        assert!(parsed.is_empty());
    }
}
