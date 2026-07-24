//! Java discovery + `-version` parsing (contract §3.1).

use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::model::JavaCheck;

/// Parse the first `java -version` stderr line, e.g.
/// `openjdk version "21.0.4" 2024-07-16` or `java version "1.8.0_392"`.
pub fn parse_version_output(stderr: &str) -> Option<String> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#"version "([^"]+)""#).unwrap());
    RE.captures(stderr)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Major version: `1.8.0_392` → 8; `21.0.4` → 21; `21` → 21.
pub fn major_version(version: &str) -> Option<u32> {
    let mut parts = version.split(['.', '_', '-', '+']);
    let first = parts.next()?.parse::<u32>().ok()?;
    if first == 1 {
        parts.next()?.parse::<u32>().ok()
    } else {
        Some(first)
    }
}

/// Resolve the java binary: explicit override → JAVA_HOME/bin/java → `java`
/// on PATH. Returns None when nothing exists.
pub fn resolve_binary(java_path_override: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = java_path_override {
        return if path.is_file() {
            Some(path.to_path_buf())
        } else {
            None
        };
    }
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.trim().is_empty() {
            let candidate = Path::new(&home).join("bin").join(java_exe_name());
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // PATH search
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(java_exe_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn java_exe_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

/// Run `<java> -version` and parse the reported version.
pub async fn probe(binary: &Path) -> Option<(String, u32)> {
    let output = tokio::process::Command::new(binary)
        .arg("-version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // `java -version` prints to stderr; some builds use stdout.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = parse_version_output(&stderr).or_else(|| parse_version_output(&stdout))?;
    let major = major_version(&version)?;
    Some((version, major))
}

/// `java_check` command (§3.1): resolve, probe, and compare against
/// `required_major` from the current instance metadata when present.
pub async fn check(
    java_path_override: Option<&Path>,
    required_major: Option<u32>,
) -> Result<JavaCheck> {
    let Some(binary) = resolve_binary(java_path_override) else {
        return Ok(JavaCheck {
            found: false,
            path: None,
            version: None,
            major_version: None,
            required_major,
            compatible: None,
        });
    };
    let Some((version, major)) = probe(&binary).await else {
        return Ok(JavaCheck {
            found: false,
            path: Some(binary.to_string_lossy().to_string()),
            version: None,
            major_version: None,
            required_major,
            compatible: None,
        });
    };
    let compatible = required_major.map(|required| major >= required);
    Ok(JavaCheck {
        found: true,
        path: Some(binary.to_string_lossy().to_string()),
        version: Some(version),
        major_version: Some(major),
        required_major,
        compatible,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_version() {
        let stderr = "openjdk version \"21.0.4\" 2024-07-16\nOpenJDK Runtime Environment";
        assert_eq!(parse_version_output(stderr).unwrap(), "21.0.4");
        assert_eq!(major_version("21.0.4"), Some(21));
    }

    #[test]
    fn parses_legacy_version() {
        let stderr = "java version \"1.8.0_392\"";
        let v = parse_version_output(stderr).unwrap();
        assert_eq!(v, "1.8.0_392");
        assert_eq!(major_version(&v), Some(8));
    }

    #[test]
    fn parses_bare_major() {
        assert_eq!(major_version("21"), Some(21));
        assert_eq!(major_version("17.0.1"), Some(17));
        assert_eq!(major_version("weird"), None);
    }
}
