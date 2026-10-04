//! Opening links and folders outside the app (contract §3.15, 2.10.0).
//!
//! The app has no shell/opener plugin on purpose: the only things it opens
//! are https links to an allowlist of hosts and its own folders, through the
//! platform opener spawned with an argv array (never `cmd /C start`).

use std::path::Path;
use std::process::Stdio;

use crate::error::{Error, Result};
use crate::model::AppDir;
use crate::settings::{Mode, Settings};
use crate::Paths;

/// Exact hosts `open_url` accepts - no subdomain matching.
pub const ALLOWED_HOSTS: &[&str] = &[
    "mineui.i4c.studio",
    "github.com",
    "aka.ms",
    "podman.io",
    "podman-desktop.io",
    "docs.docker.com",
    "adoptium.net",
    "modrinth.com",
    "www.curseforge.com",
    "ko-fi.com",
];
pub const MAX_URL_CHARS: usize = 2048;

/// Which platform opener to use; a parameter so every branch is testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacOs,
    Windows,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        }
    }
}

/// The opener argv for one target (a normalized URL or an absolute path),
/// which always stays a single argument.
pub fn opener_argv(platform: Platform, target: &str) -> Vec<String> {
    let bin = match platform {
        Platform::Linux => "xdg-open",
        Platform::MacOs => "open",
        Platform::Windows => "explorer.exe",
    };
    vec![bin.to_string(), target.to_string()]
}

/// §3.15 URL rules; returns the normalized URL to hand to the opener.
pub fn validate_url(raw: &str) -> Result<String> {
    let invalid = |why: &str| Error::InvalidInput(format!("cannot open this link: {why}"));
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(invalid("it is empty"));
    }
    if raw.chars().count() > MAX_URL_CHARS {
        return Err(invalid("it is too long"));
    }
    let url = reqwest::Url::parse(raw).map_err(|_| invalid("it is not a valid URL"))?;
    if url.scheme() != "https" {
        return Err(invalid("only https links are opened"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("links with a user name or password are not opened"));
    }
    // `port()` is None for the scheme's default port (443, even if written).
    if url.port().is_some() {
        return Err(invalid("links with a custom port are not opened"));
    }
    let host = url.host_str().unwrap_or_default();
    if !ALLOWED_HOSTS.contains(&host) {
        return Err(invalid("its site is not on MineUI's list of known sites"));
    }
    Ok(url.to_string())
}

/// Spawn the platform opener without waiting for it (explorer.exe exits 1 even
/// on success); the child is reaped in the background.
async fn spawn_opener(target: &str) -> Result<()> {
    let argv = opener_argv(Platform::current(), target);
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::util::prepare_child(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Internal(format!("could not start {}: {e}", argv[0])))?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

/// `open_url` (§3.15).
pub async fn open_url(raw: &str) -> Result<()> {
    let url = validate_url(raw)?;
    spawn_opener(&url).await
}

/// §3.15 `open_app_dir` target: app roots for data/config, the simple-mode
/// instance folder of the targeted profile for server.
pub fn app_dir_path(
    root: &Paths,
    settings: &Settings,
    which: AppDir,
) -> Result<std::path::PathBuf> {
    match which {
        AppDir::Data => Ok(root.data_dir.clone()),
        AppDir::Config => Ok(root.config_dir.clone()),
        AppDir::Server => {
            if settings.active_mode != Mode::Simple {
                return Err(Error::WrongMode(
                    "a container server has no folder on this computer".into(),
                ));
            }
            Ok(settings.simple.instance_dir.clone())
        }
    }
}

/// `open_app_dir` (§3.15): the folder must exist.
pub async fn open_dir(dir: &Path) -> Result<()> {
    if !tokio::fs::metadata(dir)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return Err(Error::InvalidInput(format!(
            "folder does not exist yet: {}",
            dir.display()
        )));
    }
    spawn_opener(&dir.to_string_lossy()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejected(url: &str) {
        let err = validate_url(url).expect_err(url);
        assert_eq!(err.code(), "INVALID_INPUT", "{url}");
    }

    #[test]
    fn accepts_every_allowlisted_host() {
        for host in ALLOWED_HOSTS {
            let url = format!("https://{host}/some/path?q=1#frag");
            assert_eq!(validate_url(&url).unwrap(), url);
        }
    }

    #[test]
    fn normalizes_case_default_port_and_whitespace() {
        assert_eq!(
            validate_url("  HTTPS://GitHub.com:443/I4cTime/mineui ").unwrap(),
            "https://github.com/I4cTime/mineui"
        );
        assert_eq!(
            validate_url("https://github.com").unwrap(),
            "https://github.com/"
        );
    }

    #[test]
    fn rejects_other_schemes() {
        rejected("http://github.com/");
        rejected("javascript:alert(1)");
        rejected("file:///etc/passwd");
        rejected("ftp://github.com/");
        rejected("data:text/html,hi");
        rejected("github.com/I4cTime");
        rejected("//github.com/");
        rejected("");
    }

    #[test]
    fn rejects_other_hosts_and_lookalikes() {
        rejected("https://evil.example/");
        rejected("https://github.com.evil.example/");
        rejected("https://evilgithub.com/");
        rejected("https://api.github.com/");
        rejected("https://gist.github.com/");
        rejected("https://curseforge.com/");
        rejected("https://github.com./");
        rejected("https://140.82.121.4/");
        rejected("https://[::1]/");
        rejected("https://xn--github-9ua.com/");
    }

    #[test]
    fn rejects_userinfo_and_ports() {
        rejected("https://user@github.com/");
        rejected("https://user:pw@github.com/");
        rejected("https://github.com@evil.example/");
        rejected("https://github.com:8443/");
        rejected("https://github.com:80/");
    }

    #[test]
    fn rejects_overlong() {
        let long = format!("https://github.com/{}", "a".repeat(MAX_URL_CHARS));
        rejected(&long);
    }

    #[test]
    fn argv_per_platform_keeps_target_one_argument() {
        let url = "https://github.com/a b&c";
        assert_eq!(opener_argv(Platform::Linux, url), vec!["xdg-open", url]);
        assert_eq!(opener_argv(Platform::MacOs, url), vec!["open", url]);
        assert_eq!(
            opener_argv(Platform::Windows, url),
            vec!["explorer.exe", url]
        );
        let win = r"C:\Users\me\AppData\Roaming\studio.i4c.mineui";
        assert_eq!(
            opener_argv(Platform::Windows, win),
            vec!["explorer.exe", win]
        );
    }

    #[test]
    fn app_dir_paths_by_mode() {
        let root = Paths {
            config_dir: "/cfg".into(),
            data_dir: "/data".into(),
        };
        let mut settings = Settings::default_with_data_dir(Path::new("/data/servers/x"));
        settings.active_mode = Mode::Simple;
        assert_eq!(
            app_dir_path(&root, &settings, AppDir::Data).unwrap(),
            Path::new("/data")
        );
        assert_eq!(
            app_dir_path(&root, &settings, AppDir::Config).unwrap(),
            Path::new("/cfg")
        );
        assert_eq!(
            app_dir_path(&root, &settings, AppDir::Server).unwrap(),
            Path::new("/data/servers/x/instances/default")
        );
        settings.active_mode = Mode::Advanced;
        let err = app_dir_path(&root, &settings, AppDir::Server).unwrap_err();
        assert_eq!(err.code(), "WRONG_MODE");
        assert!(app_dir_path(&root, &settings, AppDir::Data).is_ok());
    }

    #[test]
    fn app_dir_wire_names() {
        let v: AppDir = serde_json::from_str("\"server\"").unwrap();
        assert_eq!(v, AppDir::Server);
        assert!(serde_json::from_str::<AppDir>("\"Server\"").is_err());
        assert!(serde_json::from_str::<AppDir>("\"home\"").is_err());
    }

    #[tokio::test]
    async fn open_dir_requires_an_existing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let err = open_dir(&tmp.path().join("missing")).await.unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        let file = tmp.path().join("f");
        tokio::fs::write(&file, b"x").await.unwrap();
        assert_eq!(open_dir(&file).await.unwrap_err().code(), "INVALID_INPUT");
    }
}
