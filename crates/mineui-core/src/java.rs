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

/// Scan `root`'s direct children for `<child>/<suffix...>/bin/java`,
/// keeping only children whose name passes `filter` (case-insensitive
/// substring) when one is given.
fn scan_install_root(root: &Path, suffix: &[&str], filter: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        if let Some(f) = filter {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.contains(f) {
                continue;
            }
        }
        let mut dir = entry.path();
        for part in suffix {
            dir = dir.join(part);
        }
        let candidate = dir.join("bin").join(java_exe_name());
        if candidate.is_file() {
            out.push(candidate);
        }
    }
    out
}

/// Well-known install roots, searched in addition to PATH/JAVA_HOME.
/// GUI-launched apps don't inherit shell-rc PATH edits (sdkman, tarball
/// installs), and some distro JRE packages never symlink into PATH, so a
/// working install can be invisible to a plain PATH search.
fn well_known_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "linux") {
        for root in ["/usr/lib/jvm", "/usr/lib64/jvm", "/opt/java", "/opt"] {
            let filter = (root == "/opt").then_some("jdk");
            out.extend(scan_install_root(Path::new(root), &[], filter));
        }
        if let Some(home) = &home {
            out.extend(scan_install_root(
                &home.join(".sdkman/candidates/java"),
                &[],
                None,
            ));
            out.extend(scan_install_root(&home.join(".jdks"), &[], None));
            // Common no-sudo convention: tarballs unpacked under ~/.local/jvm.
            out.extend(scan_install_root(&home.join(".local/jvm"), &[], None));
        }
    } else if cfg!(target_os = "macos") {
        out.extend(scan_install_root(
            Path::new("/Library/Java/JavaVirtualMachines"),
            &["Contents", "Home"],
            None,
        ));
        if let Some(home) = &home {
            out.extend(scan_install_root(
                &home.join("Library/Java/JavaVirtualMachines"),
                &["Contents", "Home"],
                None,
            ));
        }
        for root in ["/opt/homebrew/opt", "/usr/local/opt"] {
            out.extend(scan_install_root(Path::new(root), &[], Some("jdk")));
        }
    } else if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            let Some(pf) = std::env::var_os(var).map(PathBuf::from) else {
                continue;
            };
            for sub in ["Java", "Eclipse Adoptium", "Zulu", "Amazon Corretto"] {
                out.extend(scan_install_root(&pf.join(sub), &[], None));
            }
            out.extend(scan_install_root(&pf.join("Microsoft"), &[], Some("jdk")));
        }
    }
    out
}

/// All java binaries worth probing, most-authoritative first:
/// JAVA_HOME, then every PATH hit, then well-known install roots.
/// Deduplicated by canonical path (PATH symlinks often point into jvm dirs).
fn collect_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    let push = |candidate: PathBuf, out: &mut Vec<PathBuf>, seen: &mut Vec<PathBuf>| {
        let canonical = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone());
        if !seen.contains(&canonical) {
            seen.push(canonical);
            out.push(candidate);
        }
    };
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.trim().is_empty() {
            let candidate = Path::new(&home).join("bin").join(java_exe_name());
            if candidate.is_file() {
                push(candidate, &mut out, &mut seen);
            }
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(java_exe_name());
            if candidate.is_file() {
                push(candidate, &mut out, &mut seen);
            }
        }
    }
    for candidate in well_known_candidates() {
        push(candidate, &mut out, &mut seen);
    }
    out
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

/// Probes stop after this many candidates; discovery is bounded even if an
/// install root is pathologically full.
const MAX_PROBES: usize = 16;

/// `java_check` command (§3.1): discover installs, probe them, and pick the
/// best — a compatible one when `required_major` is known, else the highest
/// major. An explicit override is authoritative: it is never silently
/// substituted with a discovered install.
pub async fn check(
    java_path_override: Option<&Path>,
    required_major: Option<u32>,
) -> Result<JavaCheck> {
    if let Some(path) = java_path_override {
        if !path.is_file() {
            return Ok(not_found(None, required_major));
        }
        return Ok(match probe(path).await {
            Some((version, major)) => found(path, version, major, required_major),
            None => not_found(Some(path), required_major),
        });
    }

    let candidates = collect_candidates();
    let mut best: Option<(PathBuf, String, u32)> = None;
    for candidate in candidates.iter().take(MAX_PROBES) {
        let Some((version, major)) = probe(candidate).await else {
            continue;
        };
        let better = match &best {
            None => true,
            Some((_, _, best_major)) => {
                let meets = |m: u32| required_major.is_none_or(|r| m >= r);
                (meets(major) && !meets(*best_major))
                    || (meets(major) == meets(*best_major) && major > *best_major)
            }
        };
        if better {
            best = Some((candidate.clone(), version, major));
        }
    }
    Ok(match best {
        Some((path, version, major)) => found(&path, version, major, required_major),
        None => not_found(candidates.first().map(PathBuf::as_path), required_major),
    })
}

fn found(path: &Path, version: String, major: u32, required_major: Option<u32>) -> JavaCheck {
    JavaCheck {
        found: true,
        path: Some(path.to_string_lossy().to_string()),
        version: Some(version),
        major_version: Some(major),
        required_major,
        compatible: required_major.map(|required| major >= required),
    }
}

fn not_found(path: Option<&Path>, required_major: Option<u32>) -> JavaCheck {
    JavaCheck {
        found: false,
        path: path.map(|p| p.to_string_lossy().to_string()),
        version: None,
        major_version: None,
        required_major,
        compatible: None,
    }
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

    fn fake_java(root: &Path, child: &str, suffix: &[&str]) -> PathBuf {
        let mut dir = root.join(child);
        for part in suffix {
            dir = dir.join(part);
        }
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(java_exe_name());
        std::fs::write(&exe, b"").unwrap();
        exe
    }

    #[test]
    fn scans_flat_install_root() {
        let tmp = tempfile::tempdir().unwrap();
        let a = fake_java(tmp.path(), "java-21-openjdk-amd64", &[]);
        let b = fake_java(tmp.path(), "java-17-openjdk-amd64", &[]);
        // A child without bin/java is skipped.
        std::fs::create_dir_all(tmp.path().join("empty-dir")).unwrap();
        let mut hits = scan_install_root(tmp.path(), &[], None);
        hits.sort();
        assert_eq!(hits, {
            let mut expected = vec![a, b];
            expected.sort();
            expected
        });
    }

    #[test]
    fn scans_nested_suffix_root() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = fake_java(tmp.path(), "temurin-21.jdk", &["Contents", "Home"]);
        let hits = scan_install_root(tmp.path(), &["Contents", "Home"], None);
        assert_eq!(hits, vec![exe]);
    }

    #[test]
    fn scan_filter_matches_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let jdk = fake_java(tmp.path(), "OpenJDK-21", &[]);
        fake_java(tmp.path(), "node", &[]);
        let hits = scan_install_root(tmp.path(), &[], Some("jdk"));
        assert_eq!(hits, vec![jdk]);
    }

    #[test]
    fn scans_local_jvm_tarball_layout() {
        // Real-world no-sudo layout: ~/.local/jvm/jdk-21.0.12+8-jre/bin/java
        let tmp = tempfile::tempdir().unwrap();
        let exe = fake_java(tmp.path(), "jdk-21.0.12+8-jre", &[]);
        assert_eq!(scan_install_root(tmp.path(), &[], None), vec![exe]);
    }

    #[test]
    fn missing_root_yields_empty() {
        assert!(scan_install_root(Path::new("/nonexistent-mineui-test"), &[], None).is_empty());
    }
}
