//! Modpacks (contract §3.13, §3.14): Modrinth search for packs that can run
//! on a server, and the reference normalization `create_container` uses.
//!
//! The only network call goes to a fixed host; the caller controls nothing
//! but the query text, which travels as a URL-encoded parameter.

use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::{ModpackHit, ModpackRef, ModpackSource};

const SEARCH_URL: &str = "https://api.modrinth.com/v2/search";
/// Modpacks only, and only those that can run server-side.
const FACETS: &str =
    r#"[["project_type:modpack"],["server_side:required","server_side:optional"]]"#;
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_LIMIT: u32 = 12;
pub const MAX_LIMIT: u32 = 30;
pub const MAX_QUERY_CHARS: usize = 100;

const MODRINTH_PAGE: &str = "https://modrinth.com/modpack/";
const CURSEFORGE_PAGE: &str = "https://www.curseforge.com/minecraft/modpacks/";
const KNOWN_LOADERS: [&str; 4] = ["forge", "neoforge", "fabric", "quilt"];

/// Modrinth asks every client to identify itself.
fn user_agent() -> String {
    format!(
        "I4cTime/mineui/{} (mineui.i4c.studio)",
        env!("CARGO_PKG_VERSION")
    )
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    hits: Vec<RawHit>,
}

#[derive(Debug, Deserialize)]
struct RawHit {
    slug: String,
    project_id: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    versions: Vec<String>,
    #[serde(default)]
    categories: Vec<String>,
}

fn to_hit(raw: RawHit) -> ModpackHit {
    ModpackHit {
        source: ModpackSource::Modrinth,
        slug: raw.slug,
        id: raw.project_id,
        title: raw.title,
        description: raw.description,
        author: raw.author,
        icon_url: raw.icon_url.filter(|u| !u.is_empty()),
        downloads: raw.downloads,
        game_versions: raw.versions,
        loaders: raw
            .categories
            .into_iter()
            .filter(|c| KNOWN_LOADERS.contains(&c.as_str()))
            .collect(),
    }
}

/// Parse a Modrinth `/v2/search` body.
pub fn parse_search(body: &str) -> Result<Vec<ModpackHit>> {
    let parsed: SearchResponse = serde_json::from_str(body)
        .map_err(|e| Error::DownloadFailed(format!("unexpected Modrinth response: {e}")))?;
    Ok(parsed.hits.into_iter().map(to_hit).collect())
}

/// `search_modpacks` (§3.14).
pub async fn search(
    core: &crate::Core,
    query: &str,
    limit: Option<u32>,
) -> Result<Vec<ModpackHit>> {
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(Error::InvalidInput(format!(
            "search text must be at most {MAX_QUERY_CHARS} characters"
        )));
    }
    let limit = limit
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
        .to_string();
    // An empty query means "show me what is popular".
    let index = if query.is_empty() {
        "downloads"
    } else {
        "relevance"
    };
    let response = core
        .http
        .get(SEARCH_URL)
        .query(&[
            ("query", query),
            ("facets", FACETS),
            ("limit", limit.as_str()),
            ("index", index),
        ])
        .header(reqwest::header::USER_AGENT, user_agent())
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not reach Modrinth: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::DownloadFailed(format!(
            "Modrinth search returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let body = response
        .text()
        .await
        .map_err(|e| Error::DownloadFailed(format!("could not read Modrinth's response: {e}")))?;
    parse_search(&body)
}

/// §3.13 step 3 for `modpack.project`: reduce a page URL of that source to
/// its slug, then require `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. The value
/// lands on an env-file line, so the charset is also what keeps it there.
pub fn normalize_project(modpack: &ModpackRef) -> Result<String> {
    let input = modpack.project.trim();
    let page = match modpack.source {
        ModpackSource::Modrinth => MODRINTH_PAGE,
        ModpackSource::Curseforge => CURSEFORGE_PAGE,
    };
    let slug = match input.strip_prefix(page) {
        // First path segment after the page prefix; drops /version/…, ?query, #hash.
        Some(rest) => rest.split(['/', '?', '#']).next().unwrap_or(""),
        None => input,
    };
    let mut chars = slug.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    if !first_ok || !rest_ok || slug.len() > 64 {
        return Err(Error::InvalidInput(format!(
            "not a modpack slug or {page}… address: {input}"
        )));
    }
    Ok(slug.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(source: ModpackSource, project: &str) -> ModpackRef {
        ModpackRef {
            source,
            project: project.into(),
        }
    }

    #[test]
    fn parses_a_real_search_hit() {
        // Trimmed verbatim from api.modrinth.com/v2/search (2026-10-01).
        let body = r#"{"hits":[{
            "slug":"cobblemon-fabric","project_id":"5FFgwNNP",
            "title":"Cobblemon Official Modpack [Fabric]",
            "description":"The official modpack of the Cobblemon mod, for Fabric!",
            "downloads":10988768,
            "icon_url":"https://cdn.modrinth.com/data/5FFgwNNP/icon.png",
            "categories":["adventure","fabric","lightweight","multiplayer","optimization"],
            "versions":["1.20.1","1.21.1"],
            "latest_version":"Cqimd3JM","server_side":"required","client_side":"required",
            "author":"CobbledStudios"
        }],"offset":0,"limit":1,"total_hits":1}"#;
        let hits = parse_search(body).unwrap();
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        assert_eq!(hit.slug, "cobblemon-fabric");
        assert_eq!(hit.id, "5FFgwNNP");
        assert_eq!(hit.author, "CobbledStudios");
        assert_eq!(hit.downloads, 10_988_768);
        assert_eq!(hit.game_versions, vec!["1.20.1", "1.21.1"]);
        assert_eq!(hit.loaders, vec!["fabric"], "only loader categories");
        let v = serde_json::to_value(hit).unwrap();
        assert_eq!(v["source"], "modrinth");
        assert!(v["iconUrl"].is_string());
        assert!(v.get("gameVersions").is_some());
    }

    #[test]
    fn tolerates_missing_optional_fields_and_rejects_garbage() {
        let hits =
            parse_search(r#"{"hits":[{"slug":"a","project_id":"b","title":"t","icon_url":""}]}"#)
                .unwrap();
        assert!(hits[0].icon_url.is_none());
        assert!(hits[0].loaders.is_empty());
        assert!(parse_search(r#"{"hits":[]}"#).unwrap().is_empty());
        assert_eq!(
            parse_search("<html>rate limited</html>")
                .unwrap_err()
                .code(),
            "DOWNLOAD_FAILED"
        );
    }

    #[test]
    fn project_accepts_slugs_ids_and_page_urls() {
        use ModpackSource::{Curseforge, Modrinth};
        for (source, input, slug) in [
            (Modrinth, "cobblemon-fabric", "cobblemon-fabric"),
            (Modrinth, " 5FFgwNNP ", "5FFgwNNP"),
            (
                Modrinth,
                "https://modrinth.com/modpack/cobblemon-fabric",
                "cobblemon-fabric",
            ),
            (
                Modrinth,
                "https://modrinth.com/modpack/cobblemon-fabric/version/1.3.2",
                "cobblemon-fabric",
            ),
            (Curseforge, "all-the-mods-10", "all-the-mods-10"),
            (
                Curseforge,
                "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10?page=2",
                "all-the-mods-10",
            ),
        ] {
            assert_eq!(
                normalize_project(&reference(source, input)).unwrap(),
                slug,
                "{input}"
            );
        }
    }

    #[test]
    fn project_rejects_anything_that_is_not_a_slug() {
        use ModpackSource::{Curseforge, Modrinth};
        for (source, input) in [
            (Modrinth, ""),
            (Modrinth, "two words"),
            (Modrinth, "pack\nTYPE=VANILLA"),
            (Modrinth, "-leading"),
            (Modrinth, "https://example.com/modpack/x"),
            // A page URL of the *other* source is not this source's slug.
            (
                Modrinth,
                "https://www.curseforge.com/minecraft/modpacks/atm10",
            ),
            (Curseforge, "https://modrinth.com/modpack/cobblemon-fabric"),
            (Curseforge, "https://www.curseforge.com/minecraft/modpacks/"),
        ] {
            assert_eq!(
                normalize_project(&reference(source, input))
                    .unwrap_err()
                    .code(),
                "INVALID_INPUT",
                "{input:?}"
            );
        }
        let long = "a".repeat(65);
        assert!(normalize_project(&reference(Modrinth, &long)).is_err());
    }

    #[tokio::test]
    async fn search_rejects_an_oversized_query_before_any_request() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let err = search(&core, &"x".repeat(MAX_QUERY_CHARS + 1), None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
    }
}
