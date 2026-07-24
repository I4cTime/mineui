//! Security-relevant validators (contract §6). Pure functions, heavily tested.

use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

/// Extension allowlist for the config editor (§6.1 rule 5), lowercase.
pub const CONFIG_EXTENSIONS: [&str; 11] = [
    "json",
    "json5",
    "properties",
    "txt",
    "toml",
    "ini",
    "yml",
    "yaml",
    "conf",
    "cfg",
    "snbt",
];

/// Container-runtime name grammar (§2.3): `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`.
pub fn is_valid_container_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Single path segment: no `/`, `\`, not `.`/`..`, not empty (§2.3 worldDir).
pub fn is_single_path_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.contains('/')
        && !segment.contains('\\')
        && !segment.contains('\0')
}

/// §6.1 rules 1–2 + 4–5: validate a relative, `/`-separated config-editor path.
/// Root-join / canonicalization (rule 3) is done by [`join_under_root`].
pub fn validate_config_rel_path(path: &str) -> Result<()> {
    let deny = |msg: String| Err(Error::PathNotAllowed(msg));

    // Rule 1
    if path.is_empty() {
        return deny("path is empty".into());
    }
    if path.len() > 512 {
        return deny("path exceeds 512 characters".into());
    }
    if path.contains('\0') {
        return deny("path contains NUL".into());
    }
    if path.contains('\\') {
        return deny("backslashes are not allowed in paths".into());
    }
    // Rule 2
    if path.starts_with('/') {
        return deny("absolute paths are not allowed".into());
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return deny("empty path segments are not allowed".into());
        }
        if segment == "." || segment == ".." {
            return deny("'.' and '..' segments are not allowed".into());
        }
    }
    // Rule 4: exactly server.properties, or under config/
    let whitelisted = path == "server.properties" || path.starts_with("config/");
    if !whitelisted {
        return deny(format!(
            "path must be server.properties or under config/: {path}"
        ));
    }
    // Rule 5: extension allowlist (case-insensitive)
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    match ext {
        Some(ext) if CONFIG_EXTENSIONS.contains(&ext.as_str()) => Ok(()),
        _ => deny(format!("file extension is not editable: {path}")),
    }
}

/// §6.1 rule 3: join `rel` (already validated) to `root` and lexically verify
/// the canonicalized result is still under `root`. Returns the joined path.
pub fn join_under_root(root: &Path, rel: &str) -> Result<PathBuf> {
    validate_config_rel_path(rel)?;
    let joined = root.join(rel);
    let normalized = lexical_normalize(&joined);
    let root_normalized = lexical_normalize(root);
    if !normalized.starts_with(&root_normalized) {
        return Err(Error::PathNotAllowed(format!(
            "path escapes the allowed root: {rel}"
        )));
    }
    Ok(normalized)
}

/// Lexical (non-filesystem) normalization: resolves `.` and `..` components.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// §6.2: mod/plugin filename validation. When `sanitize` is true
/// (upload/download), out-of-alphabet characters are replaced with `_`;
/// when false (delete), the input must already be a clean bare filename.
pub fn mod_filename(input: &str, sanitize: bool) -> Result<String> {
    let inv = |msg: String| Err(Error::InvalidInput(msg));

    // Rule 1: basename only.
    let base = input.rsplit(['/', '\\']).next().unwrap_or("").to_string();
    if !sanitize && base != input {
        return inv("filename must be a bare filename, not a path".into());
    }

    let name = if sanitize {
        base.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "._+()-".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>()
    } else {
        if base
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || "._+()-".contains(c)))
        {
            return inv(format!("filename contains disallowed characters: {base}"));
        }
        base
    };

    // Rule 3
    if name.is_empty() {
        return inv("filename is empty".into());
    }
    if name.len() > 255 {
        return inv("filename exceeds 255 bytes".into());
    }
    if name.starts_with('.') || name.starts_with('-') {
        return inv("filename must not start with '.' or '-'".into());
    }
    if name == ".." {
        return inv("invalid filename".into());
    }
    let lower = name.to_lowercase();
    if !(lower.ends_with(".jar") || lower.ends_with(".zip")) {
        return inv("filename must end with .jar or .zip".into());
    }
    Ok(name)
}

/// §6.3 rule 1: parse and validate a download URL.
pub fn download_url(url: &str) -> Result<reqwest::Url> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| Error::InvalidInput(format!("invalid URL: {url}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(Error::InvalidInput(
            "URL scheme must be http or https".into(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Error::InvalidInput(
            "URLs with embedded credentials are not allowed".into(),
        ));
    }
    Ok(parsed)
}

/// §6.3 rule 2: pick the download filename (explicit arg wins, else URL path
/// basename, else reject). §6.2 sanitization is applied to the result.
pub fn download_filename(url: &reqwest::Url, explicit: Option<&str>) -> Result<String> {
    let candidate = match explicit {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => {
            let from_url = url
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .unwrap_or("")
                .to_string();
            let decoded = percent_decode(&from_url);
            if decoded.trim().is_empty() {
                return Err(Error::InvalidInput(
                    "no filename given and the URL has no usable basename".into(),
                ));
            }
            decoded
        }
    };
    mod_filename(&candidate, true)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// §3.8: backup archive filename pattern.
pub fn backup_filename(name: &str) -> Result<()> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^world-[0-9]{8}-[0-9]{6}\.tar\.gz$").unwrap()
    });
    if RE.is_match(name) {
        Ok(())
    } else {
        Err(Error::InvalidInput(format!(
            "invalid backup filename: {name}"
        )))
    }
}

/// §6.4: RCON command validation against the allowlist. Returns the cleaned
/// command to send.
pub fn rcon_command(command: &str, allowlist: &[String]) -> Result<String> {
    let trimmed = command.trim();
    let cleaned = trimmed.strip_prefix('/').unwrap_or(trimmed).to_string();
    if cleaned.is_empty() {
        return Err(Error::InvalidInput("command is empty".into()));
    }
    if cleaned.len() > 200 {
        return Err(Error::InvalidInput("command exceeds 200 characters".into()));
    }
    let first = cleaned
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    if !allowlist.iter().any(|entry| entry == &first) {
        return Err(Error::RconCommandBlocked(format!(
            "command '{first}' is not allowed; allowed commands: {}",
            allowlist.join(", ")
        )));
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- config paths (§6.1) ---------- */

    #[test]
    fn config_path_accepts_valid_paths() {
        assert!(validate_config_rel_path("server.properties").is_ok());
        assert!(validate_config_rel_path("config/foo.toml").is_ok());
        assert!(validate_config_rel_path("config/deep/nested/bar.yml").is_ok());
        assert!(validate_config_rel_path("config/UPPER.JSON").is_ok());
        assert!(validate_config_rel_path("config/mod.json5").is_ok());
        assert!(validate_config_rel_path("config/x.snbt").is_ok());
    }

    #[test]
    fn config_path_rejects_traversal_and_absolutes() {
        for bad in [
            "",
            "../server.properties",
            "config/../../etc/passwd.txt",
            "config/./a.toml",
            "/etc/passwd.txt",
            "/config/a.toml",
            "config//a.toml",
            "config/..",
            "config\\a.toml",
            "config/a\\b.toml",
            "config/$(reboot).toml", // allowed chars-wise? no: rule 4/5 pass but argv-only exec keeps it inert; path itself is fine — see below
        ]
        .iter()
        .take(10)
        {
            assert!(
                validate_config_rel_path(bad).is_err(),
                "should reject {bad:?}"
            );
        }
        // Shell metacharacters are NOT shell-interpreted (argv arrays only), and the
        // path is still confined to the root — the validator accepts them by design.
        assert!(validate_config_rel_path("config/$(cmd).toml").is_ok());
        // But they can never escape the root:
        let root = Path::new("/data");
        let joined = join_under_root(root, "config/$(cmd).toml").unwrap();
        assert!(joined.starts_with("/data/config"));
    }

    #[test]
    fn config_path_rejects_nul_and_long_paths() {
        assert!(validate_config_rel_path("config/a\0b.toml").is_err());
        let long = format!("config/{}.toml", "a".repeat(600));
        assert!(validate_config_rel_path(&long).is_err());
    }

    #[test]
    fn config_path_enforces_whitelist_and_extensions() {
        assert!(validate_config_rel_path("ops.json").is_err()); // not under config/, not server.properties
        assert!(validate_config_rel_path("config/mod.jar").is_err());
        assert!(validate_config_rel_path("config/script.sh").is_err());
        assert!(validate_config_rel_path("config/noext").is_err());
        assert!(validate_config_rel_path("server.properties.bak").is_err());
        assert!(validate_config_rel_path("configs/a.toml").is_err()); // prefix trick
    }

    #[test]
    fn join_under_root_defends_in_depth() {
        let root = Path::new("/data");
        assert!(join_under_root(root, "config/ok.toml").is_ok());
        assert!(join_under_root(root, "config/../../etc/passwd.txt").is_err());
    }

    #[test]
    fn lexical_normalize_resolves_dots() {
        assert_eq!(
            lexical_normalize(Path::new("/data/config/../x.toml")),
            PathBuf::from("/data/x.toml")
        );
        assert_eq!(
            lexical_normalize(Path::new("/data/./config/a.toml")),
            PathBuf::from("/data/config/a.toml")
        );
    }

    /* ---------- mod filenames (§6.2) ---------- */

    #[test]
    fn mod_filename_sanitizes_on_upload() {
        assert_eq!(
            mod_filename("/tmp/some dir/My Mod v1.2.jar", true).unwrap(),
            "My_Mod_v1.2.jar"
        );
        assert_eq!(
            mod_filename("weird;$(rm -rf)&.jar", true).unwrap(),
            "weird__(rm_-rf)_.jar" // ( ) are in the §6.2 allowed set; ; $ space & are not
        );
        assert_eq!(
            mod_filename("ok-mod_1.0+build(2).zip", true).unwrap(),
            "ok-mod_1.0+build(2).zip"
        );
    }

    #[test]
    fn mod_filename_rejects_bad_names() {
        assert!(mod_filename("", true).is_err());
        assert!(mod_filename("mod.exe", true).is_err());
        assert!(mod_filename(".hidden.jar", true).is_err());
        assert!(mod_filename("-flag.jar", true).is_err());
        assert!(mod_filename("..", true).is_err());
        assert!(mod_filename(&format!("{}.jar", "a".repeat(300)), true).is_err());
    }

    #[test]
    fn mod_filename_delete_requires_bare_clean_name() {
        assert!(mod_filename("../mods/x.jar", false).is_err());
        assert!(mod_filename("sub/x.jar", false).is_err());
        assert!(mod_filename("bad name.jar", false).is_err());
        assert_eq!(mod_filename("good-1.2.jar", false).unwrap(), "good-1.2.jar");
    }

    #[test]
    fn mod_filename_case_insensitive_extension() {
        assert!(mod_filename("MOD.JAR", true).is_ok());
        assert!(mod_filename("pack.Zip", true).is_ok());
        // extension bypass attempts
        assert!(mod_filename("mod.jar.exe", true).is_err());
        assert!(mod_filename("mod.jar ", false).is_err());
    }

    /* ---------- URLs (§6.3) ---------- */

    #[test]
    fn download_url_rules() {
        assert!(download_url("https://example.com/mod.jar").is_ok());
        assert!(download_url("http://example.com/mod.jar").is_ok());
        assert!(download_url("ftp://example.com/mod.jar").is_err());
        assert!(download_url("file:///etc/passwd").is_err());
        assert!(download_url("https://user:pass@example.com/mod.jar").is_err());
        assert!(download_url("not a url").is_err());
    }

    #[test]
    fn download_filename_resolution() {
        let url = download_url("https://example.com/files/fabric-api.jar").unwrap();
        assert_eq!(download_filename(&url, None).unwrap(), "fabric-api.jar");
        assert_eq!(
            download_filename(&url, Some("renamed.jar")).unwrap(),
            "renamed.jar"
        );
        // no basename and no explicit name → reject (v1's silent "mod.jar" dropped)
        let bare = download_url("https://example.com/").unwrap();
        assert!(download_filename(&bare, None).is_err());
        // basename lacking allowed extension → reject
        let html = download_url("https://example.com/download.php").unwrap();
        assert!(download_filename(&html, None).is_err());
    }

    /* ---------- backups ---------- */

    #[test]
    fn backup_filename_pattern() {
        assert!(backup_filename("world-20260723-101530.tar.gz").is_ok());
        assert!(backup_filename("world-2026-101530.tar.gz").is_err());
        assert!(backup_filename("../world-20260723-101530.tar.gz").is_err());
        assert!(backup_filename("world-20260723-101530.tar.gz.sh").is_err());
        assert!(backup_filename("anything.tar.gz").is_err());
    }

    /* ---------- rcon (§6.4) ---------- */

    fn allowlist() -> Vec<String> {
        vec!["list".into(), "say".into(), "save-all".into()]
    }

    #[test]
    fn rcon_command_allows_and_cleans() {
        assert_eq!(rcon_command("/list", &allowlist()).unwrap(), "list");
        assert_eq!(
            rcon_command("  say hello  ", &allowlist()).unwrap(),
            "say hello"
        );
        assert_eq!(rcon_command("SAY hi", &allowlist()).unwrap(), "SAY hi");
    }

    #[test]
    fn rcon_command_blocks_and_validates() {
        assert_eq!(
            rcon_command("", &allowlist()).unwrap_err().code(),
            "INVALID_INPUT"
        );
        assert_eq!(
            rcon_command(&"a".repeat(201), &allowlist())
                .unwrap_err()
                .code(),
            "INVALID_INPUT"
        );
        let err = rcon_command("op griefer", &allowlist()).unwrap_err();
        assert_eq!(err.code(), "RCON_COMMAND_BLOCKED");
        assert!(err.to_string().contains("list, say, save-all"));
        // only one leading slash is stripped; "//list" is not a valid command token
        assert!(rcon_command("//list", &allowlist()).is_err());
    }

    /* ---------- misc grammar ---------- */

    #[test]
    fn container_name_grammar() {
        assert!(is_valid_container_name("minecraft-server"));
        assert!(is_valid_container_name("mc_1.two-3"));
        assert!(!is_valid_container_name(""));
        assert!(!is_valid_container_name("-leading"));
        assert!(!is_valid_container_name("has space"));
        assert!(!is_valid_container_name("evil;rm"));
        assert!(!is_valid_container_name("$(cmd)"));
    }

    #[test]
    fn single_segment_grammar() {
        assert!(is_single_path_segment("world"));
        assert!(is_single_path_segment("world_nether"));
        assert!(!is_single_path_segment(""));
        assert!(!is_single_path_segment(".."));
        assert!(!is_single_path_segment("a/b"));
        assert!(!is_single_path_segment("a\\b"));
    }
}
