//! CurseForge pack zips (contract §3.13, §3.14): what the CurseForge app's
//! "Export profile" produces — `manifest.json` next to an `overrides/` folder.
//! MineUI reads the manifest to learn the pack's name and Minecraft version,
//! then hands the whole zip to the image (`CF_MODPACK_ZIP`), which downloads
//! the listed files with its own API key and extracts the overrides.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::model::ModpackZipInfo;

/// Where the zip lives inside the container (§3.13); `/data` is the volume.
pub const CONTAINER_PATH: &str = "/data/curseforge-modpack.zip";
/// `CF_SLUG` when the manifest name yields nothing usable.
pub const DEFAULT_SLUG: &str = "custom";
const MANIFEST_MAX_BYTES: u64 = 4 * 1024 * 1024;
const SLUG_MAX_CHARS: usize = 48;

#[derive(Deserialize)]
struct Manifest {
    #[serde(default, rename = "manifestType")]
    manifest_type: String,
    #[serde(default)]
    name: String,
    minecraft: Option<ManifestMinecraft>,
    #[serde(default)]
    files: Vec<serde_json::Value>,
    #[serde(default)]
    overrides: Option<String>,
}

#[derive(Deserialize)]
struct ManifestMinecraft {
    #[serde(default)]
    version: String,
    #[serde(default, rename = "modLoaders")]
    mod_loaders: Vec<ManifestLoader>,
}

#[derive(Deserialize)]
struct ManifestLoader {
    #[serde(default)]
    id: String,
    #[serde(default)]
    primary: bool,
}

/// `inspect_modpack_zip` (§3.14): the host path comes from the dialog plugin.
pub async fn inspect(source_path: &str) -> Result<ModpackZipInfo> {
    let path = crate::mods::validate_upload_source(Path::new(source_path)).await?;
    tokio::task::spawn_blocking(move || read_manifest(&path))
        .await
        .map_err(|e| Error::Internal(format!("manifest read task failed: {e}")))?
}

/// Open the zip, find `manifest.json` (root, or under one wrapper folder),
/// parse it. Nothing else is extracted.
pub fn read_manifest(path: &Path) -> Result<ModpackZipInfo> {
    let file = std::fs::File::open(path)
        .map_err(|e| Error::InvalidInput(format!("cannot open the zip: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| Error::InvalidInput(format!("not a zip file: {e}")))?;
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    let (index, prefix) = find_manifest(&names).ok_or_else(|| {
        Error::InvalidInput(
            "no manifest.json in the zip — export the pack from the CurseForge app (profile → Export)"
                .into(),
        )
    })?;
    let entry = archive
        .by_index(index)
        .map_err(|e| Error::InvalidInput(format!("cannot read manifest.json: {e}")))?;
    if entry.size() > MANIFEST_MAX_BYTES {
        return Err(Error::FileTooLarge(
            "manifest.json is larger than 4 MB".into(),
        ));
    }
    let mut text = String::new();
    entry
        .take(MANIFEST_MAX_BYTES)
        .read_to_string(&mut text)
        .map_err(|e| Error::InvalidInput(format!("cannot read manifest.json: {e}")))?;
    let overrides_dir = format!("{prefix}{}/", "overrides");
    let info = parse_manifest(&text)?;
    let overrides_name = info.1.unwrap_or_else(|| "overrides".into());
    let has_overrides = names.iter().any(|n| {
        n.starts_with(&format!("{prefix}{overrides_name}/")) || n.starts_with(&overrides_dir)
    });
    Ok(ModpackZipInfo {
        has_overrides,
        ..info.0
    })
}

/// Index of `manifest.json` and the wrapper prefix it sits under ("" at the
/// root, "Pack/" under one folder).
fn find_manifest(names: &[String]) -> Option<(usize, String)> {
    if let Some(i) = names.iter().position(|n| n == "manifest.json") {
        return Some((i, String::new()));
    }
    names.iter().enumerate().find_map(|(i, n)| {
        let (dir, file) = n.rsplit_once('/')?;
        (file == "manifest.json" && !dir.contains('/')).then(|| (i, format!("{dir}/")))
    })
}

/// The manifest's facts; the second value is its `overrides` folder name.
fn parse_manifest(text: &str) -> Result<(ModpackZipInfo, Option<String>)> {
    let manifest: Manifest = serde_json::from_str(text)
        .map_err(|e| Error::InvalidInput(format!("manifest.json is not valid: {e}")))?;
    if manifest.manifest_type != "minecraftModpack" {
        return Err(Error::InvalidInput(
            "manifest.json is not a CurseForge modpack manifest (manifestType)".into(),
        ));
    }
    let minecraft = manifest
        .minecraft
        .ok_or_else(|| Error::InvalidInput("manifest.json names no Minecraft version".into()))?;
    let mc_version = minecraft.version.trim().to_string();
    if mc_version.is_empty()
        || !mc_version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(Error::InvalidInput(
            "manifest.json names no usable Minecraft version".into(),
        ));
    }
    let loader = minecraft
        .mod_loaders
        .iter()
        .find(|l| l.primary)
        .or_else(|| minecraft.mod_loaders.first())
        .map(|l| l.id.trim().to_lowercase())
        .filter(|id| !id.is_empty());
    let (loader, loader_version) = match loader {
        Some(id) => match id.split_once('-') {
            Some((name, version)) => (Some(name.to_string()), Some(version.to_string())),
            None => (Some(id), None),
        },
        None => (None, None),
    };
    let name = manifest.name.trim().to_string();
    Ok((
        ModpackZipInfo {
            name: if name.is_empty() {
                "CurseForge pack".into()
            } else {
                name
            },
            mc_version,
            loader,
            loader_version,
            files: manifest.files.len().min(u32::MAX as usize) as u32,
            has_overrides: false,
        },
        manifest
            .overrides
            .filter(|o| !o.is_empty() && !o.contains('/')),
    ))
}

/// `CF_SLUG` for a pack name: lowercase ASCII letters, digits and single
/// dashes, at most 48 chars; `custom` when nothing survives. The image wants
/// *a* slug with `CF_MODPACK_ZIP`; this one also names the pack in the
/// container's identity (`identity::kind_from_env`).
pub fn slug_for(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= SLUG_MAX_CHARS {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() || !slug.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        DEFAULT_SLUG.to_string()
    } else {
        slug.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const MANIFEST: &str = r#"{
      "minecraft": { "version": "1.21.1", "modLoaders": [ { "id": "forge-52.1.0", "primary": true } ] },
      "manifestType": "minecraftModpack", "manifestVersion": 1,
      "name": "All the Mods 10", "author": "x",
      "files": [ { "projectID": 1, "fileID": 2, "required": true }, { "projectID": 3, "fileID": 4, "required": true } ],
      "overrides": "overrides"
    }"#;

    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn reads_a_curseforge_export() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("atm10.zip");
        make_zip(
            &zip,
            &[
                ("manifest.json", MANIFEST.as_bytes()),
                ("modlist.html", b"<ul></ul>"),
                ("overrides/config/a.toml", b"x = 1"),
            ],
        );
        let info = read_manifest(&zip).unwrap();
        assert_eq!(
            info,
            ModpackZipInfo {
                name: "All the Mods 10".into(),
                mc_version: "1.21.1".into(),
                loader: Some("forge".into()),
                loader_version: Some("52.1.0".into()),
                files: 2,
                has_overrides: true,
            }
        );
    }

    #[test]
    fn accepts_one_wrapper_folder_and_no_overrides() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("wrapped.zip");
        make_zip(&zip, &[("My Pack/manifest.json", MANIFEST.as_bytes())]);
        let info = read_manifest(&zip).unwrap();
        assert_eq!(info.mc_version, "1.21.1");
        assert!(!info.has_overrides);
    }

    #[test]
    fn refuses_other_zips() {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path().join("mods.zip");
        make_zip(&mods, &[("mods/a.jar", b"PK")]);
        assert!(matches!(read_manifest(&mods), Err(Error::InvalidInput(_))));
        let modrinth = tmp.path().join("pack.mrpack");
        make_zip(&modrinth, &[("modrinth.index.json", b"{}")]);
        assert!(matches!(
            read_manifest(&modrinth),
            Err(Error::InvalidInput(_))
        ));
        let wrong = tmp.path().join("wrong.zip");
        make_zip(&wrong, &[("manifest.json", br#"{"manifestType":"other"}"#)]);
        assert!(matches!(read_manifest(&wrong), Err(Error::InvalidInput(_))));
        let no_version = tmp.path().join("nover.zip");
        make_zip(
            &no_version,
            &[(
                "manifest.json",
                br#"{"manifestType":"minecraftModpack","minecraft":{"version":""}}"#,
            )],
        );
        assert!(matches!(
            read_manifest(&no_version),
            Err(Error::InvalidInput(_))
        ));
        let not_zip = tmp.path().join("text.zip");
        std::fs::write(&not_zip, b"hello").unwrap();
        assert!(matches!(
            read_manifest(&not_zip),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn slugs_follow_the_curseforge_shape() {
        assert_eq!(slug_for("All the Mods 10"), "all-the-mods-10");
        assert_eq!(
            slug_for("  Better MC [FORGE] 1.21 v33 "),
            "better-mc-forge-1-21-v33"
        );
        assert_eq!(slug_for("***"), "custom");
        assert_eq!(slug_for(""), "custom");
        assert!(slug_for(&"x".repeat(200)).len() <= SLUG_MAX_CHARS);
    }
}
