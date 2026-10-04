//! Small shared helpers: unit-string parsing, ANSI stripping, timestamps, TPS.

use chrono::{Local, TimeZone};

use crate::model::Tps;

/// Environment an AppImage's launcher injects for *its own* GTK process.
/// Handed on to podman/docker/java it breaks them: the bundled
/// `libseccomp.so.2` is older than the system's, so `podman --version` dies
/// with `undefined symbol: seccomp_export_bpf_mem` and MineUI reports no
/// runtime at all (2.8.1, seen on Arch with the 2.8.0 AppImage).
const APPIMAGE_CHILD_ENV: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GIO_MODULE_DIR",
    "GTK_PATH",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GSETTINGS_SCHEMA_DIR",
    "GI_TYPELIB_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_PATH_1_0",
    "GST_PLUGIN_SCANNER_1_0",
    "GST_PTP_HELPER_1_0",
    "GST_REGISTRY_REUSE_PLUGIN_SCANNER",
];

/// Prepare a child process spawned by a GUI app (§3.1): on Windows every
/// spawn would otherwise open a console window for its lifetime (the status
/// poll spawns several a second); inside an AppImage the launcher's library
/// and GTK overrides must not reach system binaries.
pub fn prepare_child(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let in_appimage =
        std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some();
    strip_appimage_env(cmd, in_appimage);
}

/// The AppImage part of `prepare_child`, with the detection as a parameter
/// so it can be tested outside an AppImage.
pub fn strip_appimage_env(cmd: &mut tokio::process::Command, in_appimage: bool) {
    if in_appimage {
        for key in APPIMAGE_CHILD_ENV {
            cmd.env_remove(key);
        }
    }
}

/// Parse container-runtime human byte strings ("1.2GiB", "512MB", "0B").
/// Decimal units use base 1000; binary (`*iB`) use 1024 (v1 parity).
pub fn parse_bytes(value: &str) -> Option<u64> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^([\d.]+)\s*([KMGT]?i?B)?$").unwrap());
    let trimmed = value.trim();
    let caps = RE.captures(trimmed)?;
    let size: f64 = caps.get(1)?.as_str().parse().ok()?;
    let unit = caps
        .get(2)
        .map(|m| m.as_str().to_uppercase())
        .unwrap_or_else(|| "B".to_string());
    let base: f64 = if unit.contains("IB") { 1024.0 } else { 1000.0 };
    let power = match unit.as_str() {
        "B" => 0,
        "KB" | "KIB" => 1,
        "MB" | "MIB" => 2,
        "GB" | "GIB" => 3,
        "TB" | "TIB" => 4,
        _ => 0,
    };
    Some((size * base.powi(power)).round() as u64)
}

/// Parse "12.34%" → 12.34.
pub fn parse_percent(value: &str) -> Option<f64> {
    let num: f64 = value.trim().trim_end_matches('%').trim().parse().ok()?;
    if num.is_finite() {
        Some(num)
    } else {
        None
    }
}

/// Parse "used / total" usage pairs from runtime stats.
pub fn parse_usage_pair(value: &str) -> (Option<u64>, Option<u64>) {
    let mut parts = value.splitn(2, '/');
    let used = parts.next().and_then(parse_bytes);
    let total = parts.next().and_then(parse_bytes);
    (used, total)
}

/// Strip ANSI SGR escape sequences and carriage returns.
pub fn strip_ansi(line: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\x1b\[[0-9;]*m").unwrap());
    RE.replace_all(line, "").replace('\r', "")
}

/// Atomic file write: temp sibling + rename, 0600 on unix. Shared by the
/// settings, notes and scheduler-state stores (§2 pattern).
pub(crate) async fn write_atomic_bytes(path: &std::path::Path, bytes: &[u8]) -> crate::Result<()> {
    use crate::error::Error;
    let dir = path
        .parent()
        .ok_or_else(|| Error::Internal(format!("{} has no parent dir", path.display())))?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| Error::Io(format!("failed to create {}: {e}", dir.display())))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::write(&tmp, bytes)
        .await
        .map_err(|e| Error::Io(format!("failed to write {}: {e}", tmp.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await;
    }
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| Error::Io(format!("failed to move {} into place: {e}", path.display())))?;
    Ok(())
}

pub fn now_epoch_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Resolve a `[HH:MM:SS]` log time against the local date; if the candidate is
/// more than 60 s in the future it is assumed to be from yesterday (v1 rule).
/// Returns epoch ms.
pub fn log_time_to_epoch_ms(hh: u32, mm: u32, ss: u32) -> Option<i64> {
    let now = Local::now();
    let date = now.date_naive();
    let time = chrono::NaiveTime::from_hms_opt(hh, mm, ss)?;
    let naive = date.and_time(time);
    let candidate = Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| Local.from_local_datetime(&naive).earliest())?;
    let candidate = if candidate.timestamp_millis() - now.timestamp_millis() > 60_000 {
        candidate - chrono::Duration::days(1)
    } else {
        candidate
    };
    Some(candidate.timestamp_millis())
}

/// Parse RCON `tps` output with real character classes (the v1 regex was
/// double-escaped and never matched - contract §3.9).
pub fn parse_tps(output: &str) -> Option<Tps> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)TPS from last 1m, 5m, 15m: (\d+\.?\d*),\s*(\d+\.?\d*),\s*(\d+\.?\d*)",
        )
        .unwrap()
    });
    let cleaned = strip_ansi(output);
    let caps = RE.captures(&cleaned)?;
    Some(Tps {
        one: caps.get(1)?.as_str().parse().ok()?,
        five: caps.get(2)?.as_str().parse().ok()?,
        fifteen: caps.get(3)?.as_str().parse().ok()?,
        raw: output.to_string(),
    })
}

/// Simple-mode "server is up" detection: vanilla logs `]: Done (12.345s)! ...`.
pub fn is_done_line(line: &str) -> bool {
    strip_ansi(line).contains("]: Done (")
}

/// Normalize a runtime-reported timestamp to RFC 3339, best effort.
/// Podman inspect: "2026-07-23 10:00:00.123456789 +0000 UTC" - but the zone
/// abbreviation follows the host's local zone (live 4.9.3:
/// "2026-07-24 15:50:31.847979382 -0500 CDT"), so any trailing alphabetic
/// zone name is stripped (the numeric offset is what gets parsed).
/// Docker inspect: "2026-07-23T10:00:00.123456789Z".
pub fn normalize_timestamp(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("0001-01-01") {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    // Strip a trailing zone abbreviation ("UTC", "CDT", ...) - chrono's %z
    // parses the numeric offset only.
    let without_zone_name = match trimmed.rsplit_once(' ') {
        Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_alphabetic()) => {
            head.trim()
        }
        _ => trimmed,
    };
    for fmt in ["%Y-%m-%d %H:%M:%S%.f %z", "%Y-%m-%d %H:%M:%S %z"] {
        if let Ok(dt) = chrono::DateTime::parse_from_str(without_zone_name, fmt) {
            return Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
    }
    None
}

/// Seconds elapsed since an RFC 3339 timestamp (for uptimeSeconds).
pub fn seconds_since(iso: &str) -> Option<i64> {
    let dt = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let secs = chrono::Utc::now().timestamp() - dt.timestamp();
    Some(secs.max(0))
}

/// Clamp the `tail` argument per §3.3: default 200, clamp [10, 1000].
pub fn clamp_tail(tail: Option<u32>) -> u32 {
    tail.unwrap_or(200).clamp(10, 1000)
}

/// v1 display-name rule for mod filenames.
pub fn mod_display_name(filename: &str) -> String {
    static STRIP: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.(jar\.disabled|jar|zip)$").unwrap());
    static SEP: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[_+]+").unwrap());
    static WS: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\s+").unwrap());
    let stripped = STRIP.replace(filename, "");
    let spaced = SEP.replace_all(&stripped, " ");
    WS.replace_all(&spaced, " ").trim().to_string()
}

/// v1 loader detection from filename.
pub fn detect_loader(filename: &str) -> crate::model::ModLoader {
    let lower = filename.to_lowercase();
    if lower.contains("neoforge") {
        crate::model::ModLoader::Neoforge
    } else if lower.contains("forge") {
        crate::model::ModLoader::Forge
    } else if lower.contains("fabric") {
        crate::model::ModLoader::Fabric
    } else {
        crate::model::ModLoader::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bytes_units() {
        assert_eq!(parse_bytes("0B"), Some(0));
        assert_eq!(parse_bytes("512"), Some(512));
        assert_eq!(parse_bytes("1.5KB"), Some(1500));
        assert_eq!(parse_bytes("1KiB"), Some(1024));
        assert_eq!(parse_bytes("2MiB"), Some(2 * 1024 * 1024));
        assert_eq!(parse_bytes("1.2GB"), Some(1_200_000_000));
        assert_eq!(parse_bytes("garbage"), None);
    }

    #[test]
    fn parse_usage_pair_splits() {
        let (used, total) = parse_usage_pair("1.2GiB / 4GiB");
        assert_eq!(
            used,
            Some((1.2f64 * 1024.0 * 1024.0 * 1024.0).round() as u64)
        );
        assert_eq!(total, Some(4 * 1024 * 1024 * 1024));
    }

    #[test]
    fn parse_percent_works() {
        assert_eq!(parse_percent("12.5%"), Some(12.5));
        assert_eq!(parse_percent(" 3 % "), Some(3.0));
        assert_eq!(parse_percent("x"), None);
    }

    #[test]
    fn strip_ansi_removes_sgr() {
        assert_eq!(strip_ansi("\x1b[32mhello\x1b[0m\r"), "hello");
    }

    #[test]
    fn tps_regex_matches_paper_output() {
        let out = "TPS from last 1m, 5m, 15m: 19.98, 20.0, 20.0";
        let tps = parse_tps(out).unwrap();
        assert_eq!(tps.one, 19.98);
        assert_eq!(tps.five, 20.0);
        assert_eq!(tps.fifteen, 20.0);
        assert_eq!(tps.raw, out);
    }

    #[test]
    fn tps_regex_matches_colored_prefixed_output() {
        let out = "\x1b[32m§6TPS from last 1m, 5m, 15m: \x1b[0m20.0, 20.0, 20.0";
        assert!(parse_tps(out).is_some());
        assert!(parse_tps("Unknown or incomplete command").is_none());
    }

    #[test]
    fn done_line_detection() {
        assert!(is_done_line(
            "[12:00:01] [Server thread/INFO]: Done (12.345s)! For help, type \"help\""
        ));
        assert!(!is_done_line(
            "[12:00:01] [Server thread/INFO]: Starting minecraft server"
        ));
    }

    #[test]
    fn normalize_timestamp_formats() {
        assert!(normalize_timestamp("2026-07-23T10:00:00.5Z").is_some());
        assert!(normalize_timestamp("2026-07-23 10:00:00.123456789 +0000 UTC").is_some());
        assert_eq!(normalize_timestamp("0001-01-01T00:00:00Z"), None);
        assert_eq!(normalize_timestamp(""), None);
    }

    #[test]
    fn normalize_timestamp_local_zone_abbreviation() {
        // Verbatim podman 4.9.3 `inspect -f {{.State.StartedAt}}` output on a
        // host in America/Chicago - the old parser only stripped " UTC" and
        // returned None for this.
        let normalized = normalize_timestamp("2026-07-24 15:50:31.847979382 -0500 CDT").unwrap();
        assert_eq!(normalized, "2026-07-24T15:50:31.847-05:00");
        // No zone abbreviation at all (offset only) also parses.
        assert!(normalize_timestamp("2026-07-24 15:50:31 -0500").is_some());
    }

    #[test]
    fn clamp_tail_bounds() {
        assert_eq!(clamp_tail(None), 200);
        assert_eq!(clamp_tail(Some(5)), 10);
        assert_eq!(clamp_tail(Some(5000)), 1000);
        assert_eq!(clamp_tail(Some(300)), 300);
    }

    #[test]
    fn mod_display_name_rules() {
        assert_eq!(
            mod_display_name("fabric_api-0.92.0+1.20.1.jar"),
            "fabric api-0.92.0 1.20.1"
        );
        assert_eq!(mod_display_name("Simple.zip"), "Simple");
    }

    #[test]
    fn log_time_resolution_is_not_in_future() {
        let ms = log_time_to_epoch_ms(23, 59, 59).unwrap();
        assert!(ms <= now_epoch_ms() + 60_000);
    }

    #[test]
    fn appimage_env_is_stripped_only_inside_an_appimage() {
        let mut inside = tokio::process::Command::new("podman");
        strip_appimage_env(&mut inside, true);
        let removed: Vec<_> = inside
            .as_std()
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        assert!(
            removed.contains(&"LD_LIBRARY_PATH".to_string()),
            "{removed:?}"
        );
        assert!(
            removed.contains(&"GIO_MODULE_DIR".to_string()),
            "{removed:?}"
        );

        let mut outside = tokio::process::Command::new("podman");
        strip_appimage_env(&mut outside, false);
        assert_eq!(outside.as_std().get_envs().count(), 0);
    }
}
