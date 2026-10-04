//! App facts and the manual update check (contract §3.15, 2.10.0).
//!
//! `check_for_update` runs only when the user asks for it - MineUI never
//! checks on its own, and never downloads or installs anything here.

use std::cmp::Ordering;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{AppInfo, UpdateCheck};
use crate::Paths;

/// The app's version: the release process keeps the crate version equal to it.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const LATEST_RELEASE_API: &str = "https://api.github.com/repos/I4cTime/mineui/releases/latest";
pub const RELEASE_PAGE_PREFIX: &str = "https://github.com/I4cTime/mineui/";
pub const RELEASES_LATEST_PAGE: &str = "https://github.com/I4cTime/mineui/releases/latest";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// `get_app_info` (§3.15) for the app-level roots.
pub fn info(root: &Paths) -> AppInfo {
    AppInfo {
        version: APP_VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: root.data_dir.to_string_lossy().to_string(),
        config_dir: root.config_dir.to_string_lossy().to_string(),
    }
}

/// `tag_name` → bare version: trimmed, without a leading `v`/`V`.
pub fn normalize_tag(tag: &str) -> &str {
    let tag = tag.trim();
    tag.strip_prefix(['v', 'V']).unwrap_or(tag)
}

/// Dotted numeric comparison (§3.15): a `-pre`/`+build` suffix is dropped,
/// parts compare as numbers left to right, missing parts are 0, and a part
/// that is not a number counts as 0.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parts(v: &str) -> Vec<u64> {
        let core = normalize_tag(v)
            .split(['-', '+'])
            .next()
            .unwrap_or_default();
        core.split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

#[derive(Debug, Deserialize)]
struct LatestRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

/// Build the result from the API body; pure so it can be tested offline.
pub fn update_check_from_body(current: &str, body: &str) -> Result<UpdateCheck> {
    let release: LatestRelease = serde_json::from_str(body)
        .map_err(|_| Error::DownloadFailed("GitHub returned an unreadable release".into()))?;
    let latest = normalize_tag(&release.tag_name).to_string();
    if latest.is_empty() {
        return Err(Error::DownloadFailed(
            "GitHub returned a release without a tag".into(),
        ));
    }
    let url = release
        .html_url
        .filter(|u| u.starts_with(RELEASE_PAGE_PREFIX))
        .unwrap_or_else(|| RELEASES_LATEST_PAGE.to_string());
    Ok(UpdateCheck {
        newer: compare_versions(&latest, current) == Ordering::Greater,
        current: current.to_string(),
        latest,
        url,
        published_at: release.published_at,
    })
}

/// `check_for_update` (§3.15): one GET to the fixed latest-release URL.
pub async fn check_for_update(http: &reqwest::Client) -> Result<UpdateCheck> {
    let response = http
        .get(LATEST_RELEASE_API)
        .header(
            reqwest::header::USER_AGENT,
            format!("I4cTime/mineui/{APP_VERSION} (mineui.i4c.studio)"),
        )
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|_| Error::DownloadFailed("could not reach GitHub to check for updates".into()))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "GitHub answered HTTP {} to the update check",
            response.status().as_u16()
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|_| Error::DownloadFailed("the update check response was cut off".into()))?;
    update_check_from_body(APP_VERSION, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_normalisation() {
        assert_eq!(normalize_tag("v2.10.0"), "2.10.0");
        assert_eq!(normalize_tag("V2.10.0"), "2.10.0");
        assert_eq!(normalize_tag(" 2.10.0 "), "2.10.0");
        assert_eq!(normalize_tag("vv1"), "v1");
        assert_eq!(normalize_tag(""), "");
    }

    #[test]
    fn comparator_is_numeric_not_lexical() {
        assert_eq!(compare_versions("2.10.0", "2.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("2.9.0", "2.10.0"), Ordering::Less);
        assert_eq!(compare_versions("10.0.0", "9.99.99"), Ordering::Greater);
        assert_eq!(compare_versions("2.9.1", "2.9.0"), Ordering::Greater);
    }

    #[test]
    fn comparator_pads_and_treats_junk_as_zero() {
        assert_eq!(compare_versions("2.9", "2.9.0"), Ordering::Equal);
        assert_eq!(compare_versions("2.9.0.1", "2.9"), Ordering::Greater);
        assert_eq!(compare_versions("v2.9.0", "2.9.0"), Ordering::Equal);
        assert_eq!(compare_versions("2.x.5", "2.0.5"), Ordering::Equal);
        assert_eq!(compare_versions("", "0.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("garbage", "0.0.1"), Ordering::Less);
    }

    #[test]
    fn comparator_drops_prerelease_and_build_suffixes() {
        assert_eq!(compare_versions("2.10.0-rc.1", "2.10.0"), Ordering::Equal);
        assert_eq!(compare_versions("2.10.0+abc", "2.9.9"), Ordering::Greater);
    }

    #[test]
    fn body_parsing_and_url_fallback() {
        let body = r#"{"tag_name":"v2.10.0","html_url":"https://github.com/I4cTime/mineui/releases/tag/v2.10.0","published_at":"2026-10-03T12:00:00Z"}"#;
        let u = update_check_from_body("2.9.0", body).unwrap();
        assert_eq!(u.latest, "2.10.0");
        assert!(u.newer);
        assert_eq!(u.current, "2.9.0");
        assert_eq!(
            u.url,
            "https://github.com/I4cTime/mineui/releases/tag/v2.10.0"
        );
        assert_eq!(u.published_at.as_deref(), Some("2026-10-03T12:00:00Z"));

        let same = update_check_from_body("2.10.0", body).unwrap();
        assert!(!same.newer);
        let ahead = update_check_from_body("2.11.0", body).unwrap();
        assert!(!ahead.newer);

        let evil = r#"{"tag_name":"2.10.0","html_url":"https://evil.example/I4cTime/mineui/"}"#;
        let u = update_check_from_body("2.9.0", evil).unwrap();
        assert_eq!(u.url, RELEASES_LATEST_PAGE);
        assert!(u.published_at.is_none());

        let lookalike =
            r#"{"tag_name":"2.10.0","html_url":"https://github.com/I4cTime/mineui-fake/x"}"#;
        assert_eq!(
            update_check_from_body("2.9.0", lookalike).unwrap().url,
            RELEASES_LATEST_PAGE
        );
    }

    #[test]
    fn bad_bodies_are_download_failed() {
        for body in ["not json", "{}", r#"{"tag_name":"  v "}"#] {
            let err = update_check_from_body("2.9.0", body).unwrap_err();
            assert_eq!(err.code(), "DOWNLOAD_FAILED", "{body}");
        }
    }

    #[test]
    fn info_uses_roots_and_crate_version() {
        let root = Paths {
            config_dir: "/c".into(),
            data_dir: "/d".into(),
        };
        let i = info(&root);
        assert_eq!(i.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(i.os, std::env::consts::OS);
        assert_eq!(i.arch, std::env::consts::ARCH);
        assert_eq!(i.config_dir, "/c");
        assert_eq!(i.data_dir, "/d");
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["dataDir"], "/d");
        assert_eq!(v["configDir"], "/c");
    }

    /// Opt-in: hits the real GitHub API.
    /// `cargo test -p mineui-core appinfo::tests::live -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn live_check_for_update() {
        let u = check_for_update(&crate::download::build_client())
            .await
            .unwrap();
        assert!(!u.latest.is_empty());
        assert!(!u.latest.starts_with('v'));
        assert!(u.url.starts_with(RELEASE_PAGE_PREFIX));
        assert_eq!(u.current, APP_VERSION);
        eprintln!("{u:?}");
    }
}
