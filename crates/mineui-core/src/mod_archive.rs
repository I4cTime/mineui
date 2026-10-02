//! `unpack_mod_archive` (contract §3.5, §6.2a): install the `.jar` files that
//! are *inside* a `.zip` — a zipped folder of mods, or a server pack.
//!
//! The archive is unpacked host-side into a private temp dir, never inside
//! the container. Entry names are never used as paths: only a selected
//! entry's basename, after §6.2 sanitization, names the file written.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::model::{AuditSource, DownloadKind, ModTarget, UnpackedMods};
use crate::settings::Mode;

/// §6.2a limits. Enforced on bytes written, not on what the archive claims.
pub const MAX_ENTRIES: usize = 20_000;
pub const MAX_JARS: usize = 500;
pub const MAX_JAR_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Same cap as an upload source (§3.5).
const ARCHIVE_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// One archive entry chosen for installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picked {
    /// Index in the archive.
    pub index: usize,
    /// Sanitized filename to write (§6.2).
    pub filename: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub picked: Vec<Picked>,
    /// File entries that are not mods for this target.
    pub skipped: usize,
    /// The zip is a launcher modpack that lists mods instead of holding them.
    pub launcher_pack: Option<&'static str>,
}

fn is_jar(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".jar")
}

/// §6.2a selection — pure, on entry names only (index = position in `names`).
pub fn select_entries(names: &[String], target: ModTarget) -> Selection {
    // Files only, `\` read as `/`, macOS resource forks dropped.
    let files: Vec<(usize, Vec<&str>)> = names
        .iter()
        .enumerate()
        .filter(|(_, name)| !name.ends_with('/') && !name.ends_with('\\'))
        .map(|(index, name)| {
            let segments: Vec<&str> = name
                .split(['/', '\\'])
                .filter(|segment| !segment.is_empty())
                .collect();
            (index, segments)
        })
        .filter(|(_, segments)| !segments.is_empty() && segments[0] != "__MACOSX")
        .collect();

    // Rule 1: one wrapper folder around everything is ignored.
    let wrapper = files
        .first()
        .map(|(_, segments)| segments[0])
        .filter(|first| {
            !matches!(*first, "mods" | "plugins")
                && files
                    .iter()
                    .all(|(_, segments)| segments.len() >= 2 && segments[0] == *first)
        });
    let strip = usize::from(wrapper.is_some());
    let paths: Vec<(usize, &[&str])> = files
        .iter()
        .map(|(index, segments)| (*index, &segments[strip..]))
        .collect();

    // Rules 2–3: the target's folder if the archive has one, else the root.
    let folder = target.dir_name();
    let has_folder = paths
        .iter()
        .any(|(_, path)| path.len() >= 2 && path[0] == folder);
    let candidates = paths.iter().filter(|(_, path)| {
        if has_folder {
            path.len() == 2 && path[0] == folder && is_jar(path[1])
        } else {
            path.len() == 1 && is_jar(path[0])
        }
    });

    // Rule 4: sanitize, drop what fails §6.2 and repeats.
    let mut seen = HashSet::new();
    let mut picked = Vec::new();
    for (index, path) in candidates {
        let basename = path[path.len() - 1];
        let Ok(filename) = crate::validate::mod_filename(basename, true) else {
            continue;
        };
        if seen.insert(filename.to_lowercase()) {
            picked.push(Picked {
                index: *index,
                filename,
            });
        }
    }

    let root_has = |file: &str| {
        paths
            .iter()
            .any(|(_, path)| path.len() == 1 && path[0] == file)
    };
    let launcher_pack = if root_has("modrinth.index.json") {
        Some("Modrinth")
    } else if root_has("manifest.json") && picked.is_empty() {
        Some("CurseForge")
    } else {
        None
    };

    Selection {
        skipped: files.len() - picked.len(),
        picked,
        launcher_pack,
    }
}

fn too_large(what: &str) -> Error {
    Error::FileTooLarge(format!("the archive {what}"))
}

/// Unpack the selected jars of `archive` into `out_dir` (blocking).
/// Returns (installed filenames, skipped count).
fn extract_blocking(
    archive: &Path,
    out_dir: &Path,
    target: ModTarget,
) -> Result<(Vec<String>, usize)> {
    extract_with_limits(archive, out_dir, target, MAX_JAR_BYTES, MAX_TOTAL_BYTES)
}

/// `extract_blocking` with the byte limits as parameters, so the zip-bomb
/// defense can be tested without gigabyte fixtures.
fn extract_with_limits(
    archive: &Path,
    out_dir: &Path,
    target: ModTarget,
    max_jar_bytes: u64,
    max_total_bytes: u64,
) -> Result<(Vec<String>, usize)> {
    let unreadable =
        |e: zip::result::ZipError| Error::InvalidInput(format!("not a readable .zip archive: {e}"));
    let file = std::fs::File::open(archive)
        .map_err(|e| Error::Io(format!("cannot open the archive: {e}")))?;
    let mut zip = zip::ZipArchive::new(file).map_err(unreadable)?;
    if zip.len() > MAX_ENTRIES {
        return Err(too_large(&format!("has more than {MAX_ENTRIES} entries")));
    }
    let names: Vec<String> = (0..zip.len())
        .map(|i| zip.name_for_index(i).unwrap_or_default().to_string())
        .collect();
    let selection = select_entries(&names, target);

    if selection.picked.is_empty() {
        return Err(Error::InvalidInput(match selection.launcher_pack {
            Some(source) => format!(
                "this is a {source} modpack file: it lists mods to download instead of containing them. Add a new server and create it from the modpack instead."
            ),
            None => format!(
                "no .jar files found in the archive — expected them at the top level or in a {}/ folder",
                target.dir_name()
            ),
        }));
    }
    if selection.picked.len() > MAX_JARS {
        return Err(too_large(&format!("holds more than {MAX_JARS} jars")));
    }

    std::fs::create_dir_all(out_dir)
        .map_err(|e| Error::Io(format!("cannot create the unpack dir: {e}")))?;
    let mut total: u64 = 0;
    let mut installed = Vec::with_capacity(selection.picked.len());
    for picked in &selection.picked {
        let entry = zip.by_index(picked.index).map_err(unreadable)?;
        // The filename is sanitized and the dir is ours: no entry path is used.
        let dest = out_dir.join(&picked.filename);
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| Error::Io(format!("cannot write {}: {e}", picked.filename)))?;
        // Read one byte past the cap so an oversized entry is detected by
        // what it actually inflates to, whatever its header says.
        let written = std::io::copy(&mut entry.take(max_jar_bytes + 1), &mut out)
            .map_err(|e| Error::InvalidInput(format!("cannot unpack {}: {e}", picked.filename)))?;
        if written > max_jar_bytes {
            return Err(too_large(&format!(
                "holds a jar over the {} MiB limit ({})",
                max_jar_bytes / (1024 * 1024),
                picked.filename
            )));
        }
        total += written;
        if total > max_total_bytes {
            return Err(too_large(&format!(
                "unpacks to more than {} MiB of mods",
                max_total_bytes / (1024 * 1024)
            )));
        }
        installed.push(picked.filename.clone());
    }
    installed.sort_by_key(|name| name.to_lowercase());
    Ok((installed, selection.skipped))
}

/// Place every file of `dir` into the target root.
async fn place_dir(
    core: &crate::Core,
    dir: &Path,
    target: ModTarget,
    files: &[String],
) -> Result<()> {
    let settings = core.settings().await;
    match settings.active_mode {
        Mode::Advanced => {
            let runtime = crate::runtime::resolve(&settings.advanced).await?;
            let name = &settings.advanced.container_name;
            let root = crate::mods::container_root(target);
            let _ = runtime.exec(name, &["mkdir", "-p", root]).await;
            // `<dir>/.` = the directory's contents, in one runtime call.
            runtime.cp_to(name, &dir.join("."), root).await
        }
        Mode::Simple => {
            let dest = settings.simple.instance_dir.join(target.dir_name());
            tokio::fs::create_dir_all(&dest).await.map_err(|e| {
                Error::Io(format!("failed to create {} dir: {e}", target.dir_name()))
            })?;
            for file in files {
                tokio::fs::copy(dir.join(file), dest.join(file))
                    .await
                    .map_err(|e| Error::Io(format!("failed to copy {file}: {e}")))?;
            }
            Ok(())
        }
    }
}

/// Where the archive comes from — exactly one of the two.
enum Source<'a> {
    File(&'a str),
    Url(&'a str),
}

struct Acquired {
    path: PathBuf,
    /// Remove the file afterwards (it is our download, not the user's file).
    temporary: bool,
    download_id: Option<String>,
}

async fn acquire(
    core: &crate::Core,
    source: &Source<'_>,
    filename: Option<&str>,
) -> Result<Acquired> {
    match source {
        Source::File(source_path) => {
            let canonical = crate::mods::validate_upload_source(Path::new(source_path)).await?;
            let is_zip = canonical
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
            if !is_zip {
                return Err(Error::InvalidInput(
                    "only a .zip archive can be unpacked".into(),
                ));
            }
            Ok(Acquired {
                path: canonical,
                temporary: false,
                download_id: None,
            })
        }
        Source::Url(url) => {
            let allow_private = core.settings().await.allow_private_download_hosts;
            let parsed = crate::validate::download_url(url)?;
            crate::validate::ensure_public_download_host(&parsed, allow_private)?;
            let name = crate::validate::download_filename(&parsed, filename)?;
            if !name.to_ascii_lowercase().ends_with(".zip") {
                return Err(Error::InvalidInput(
                    "only a .zip archive can be unpacked — the link (or the file name given) must end in .zip".into(),
                ));
            }
            let download_id = uuid::Uuid::new_v4().to_string();
            let request = crate::download::DownloadRequest {
                url: parsed,
                kind: DownloadKind::Mod,
                filename: name,
                download_id: download_id.clone(),
                max_bytes: Some(ARCHIVE_MAX_BYTES),
                expected_sha1: None,
                allow_private_hosts: allow_private,
            };
            let result = crate::download::to_temp_file(core, &request).await?;
            Ok(Acquired {
                path: result.temp_path,
                temporary: true,
                download_id: Some(download_id),
            })
        }
    }
}

async fn unpack_inner(
    core: &crate::Core,
    source: &Source<'_>,
    filename: Option<&str>,
    target: ModTarget,
) -> Result<UnpackedMods> {
    let acquired = acquire(core, source, filename).await?;
    let out_dir = core
        .paths
        .data_dir
        .join("tmp")
        .join(format!("unpack-{}", uuid::Uuid::new_v4().simple()));

    let result = async {
        let (archive, dir) = (acquired.path.clone(), out_dir.clone());
        let (installed, skipped) =
            tokio::task::spawn_blocking(move || extract_blocking(&archive, &dir, target))
                .await
                .map_err(|e| Error::Internal(format!("unpack task failed: {e}")))??;
        place_dir(core, &out_dir, target, &installed).await?;
        Ok(UnpackedMods {
            installed,
            skipped,
            download_id: acquired.download_id.clone(),
        })
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&out_dir).await;
    if acquired.temporary {
        let _ = tokio::fs::remove_file(&acquired.path).await;
    }
    result
}

/// `unpack_mod_archive` (§3.5), audited as `mod.unpack`.
pub async fn unpack(
    core: &crate::Core,
    source_path: Option<&str>,
    url: Option<&str>,
    filename: Option<&str>,
    target: ModTarget,
) -> Result<UnpackedMods> {
    let source = match (source_path, url) {
        (Some(path), None) => Source::File(path),
        (None, Some(url)) => Source::Url(url),
        _ => {
            return Err(Error::InvalidInput(
                "give either a file or a link to unpack, not both or neither".into(),
            ))
        }
    };
    let result = unpack_inner(core, &source, filename, target).await;
    let label = crate::mods::target_label(target);
    let detail = match &result {
        Ok(done) => format!(
            "{label}: {} installed, {} skipped",
            done.installed.len(),
            done.skipped
        ),
        Err(_) => label.to_string(),
    };
    let archive_name = match source {
        Source::File(path) => Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string()),
        Source::Url(url) => url.to_string(),
    };
    crate::audit::record(
        core,
        AuditSource::User,
        "mod.unpack",
        Some(&archive_name),
        Some(&detail),
        result.as_ref().err(),
    )
    .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn picked(selection: &Selection) -> Vec<&str> {
        selection
            .picked
            .iter()
            .map(|p| p.filename.as_str())
            .collect()
    }

    /// Write a zip with the given (name, bytes) entries.
    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap();
    }

    #[test]
    fn flat_zip_of_jars() {
        let s = select_entries(
            &names(&["sodium.jar", "lithium.JAR", "readme.txt", "notes/"]),
            ModTarget::Mods,
        );
        assert_eq!(picked(&s), ["sodium.jar", "lithium.JAR"]);
        assert_eq!(
            s.skipped, 1,
            "readme.txt; the directory entry is not a file"
        );
        assert_eq!(s.launcher_pack, None);
    }

    #[test]
    fn server_pack_takes_only_the_mods_folder() {
        // Root jars are the server/installer, libraries/ are loader internals.
        let s = select_entries(
            &names(&[
                "forge-1.20.1-installer.jar",
                "server.jar",
                "mods/",
                "mods/create.jar",
                "mods/jei.jar",
                "mods/nested/ignored.jar",
                "libraries/net/minecraftforge/forge.jar",
                "config/create.toml",
                "plugins/essentials.jar",
            ]),
            ModTarget::Mods,
        );
        assert_eq!(picked(&s), ["create.jar", "jei.jar"]);
        assert_eq!(s.skipped, 6);

        // Same archive, plugins target: its plugins/ folder.
        let s = select_entries(
            &names(&["server.jar", "mods/create.jar", "plugins/essentials.jar"]),
            ModTarget::Plugins,
        );
        assert_eq!(picked(&s), ["essentials.jar"]);
    }

    #[test]
    fn a_single_wrapper_folder_is_ignored() {
        let s = select_entries(
            &names(&["MyPack/", "MyPack/mods/create.jar", "MyPack/server.jar"]),
            ModTarget::Mods,
        );
        assert_eq!(picked(&s), ["create.jar"]);
        let s = select_entries(&names(&["My Mods/a.jar", "My Mods/b.jar"]), ModTarget::Mods);
        assert_eq!(picked(&s), ["a.jar", "b.jar"]);
        // Windows-made archives use backslashes; macOS adds resource forks.
        let s = select_entries(
            &names(&["pack\\mods\\a.jar", "__MACOSX/pack/mods/._a.jar"]),
            ModTarget::Mods,
        );
        assert_eq!(picked(&s), ["a.jar"]);
        // A top-level folder called mods is the mods folder, not a wrapper.
        let s = select_entries(&names(&["mods/a.jar", "mods/b.jar"]), ModTarget::Mods);
        assert_eq!(picked(&s), ["a.jar", "b.jar"]);
    }

    #[test]
    fn names_are_sanitized_and_never_paths() {
        let s = select_entries(
            &names(&[
                "../../evil.jar",
                "/abs/root.jar",
                "we ird$name.jar",
                ".hidden.jar",
                "a.jar",
                "A.JAR",
            ]),
            ModTarget::Mods,
        );
        // `../../evil.jar` and `/abs/root.jar` are nested entries, not root
        // jars — and had they been picked, only the basename would be used.
        assert_eq!(picked(&s), ["we_ird_name.jar", "a.jar"]);
        assert!(s.picked.iter().all(|p| !p.filename.contains(['/', '\\'])));
    }

    #[test]
    fn launcher_modpacks_are_recognized() {
        let mrpack = select_entries(
            &names(&["modrinth.index.json", "overrides/config/x.toml"]),
            ModTarget::Mods,
        );
        assert!(mrpack.picked.is_empty());
        assert_eq!(mrpack.launcher_pack, Some("Modrinth"));
        let cf = select_entries(
            &names(&["manifest.json", "modlist.html", "overrides/"]),
            ModTarget::Mods,
        );
        assert_eq!(cf.launcher_pack, Some("CurseForge"));
        // A manifest.json next to real jars is just a file.
        let flat = select_entries(&names(&["manifest.json", "a.jar"]), ModTarget::Mods);
        assert_eq!(flat.launcher_pack, None);
    }

    #[test]
    fn extracts_selected_jars_with_their_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("mods.zip");
        make_zip(
            &archive,
            &[
                ("pack/mods/create.jar", b"create-bytes"),
                ("pack/mods/jei.jar", b"jei-bytes"),
                ("pack/server.jar", b"server"),
                ("pack/config/a.toml", b"x=1"),
            ],
        );
        let out = tmp.path().join("out");
        let (installed, skipped) = extract_blocking(&archive, &out, ModTarget::Mods).unwrap();
        assert_eq!(installed, ["create.jar", "jei.jar"]);
        assert_eq!(skipped, 2);
        assert_eq!(
            std::fs::read(out.join("create.jar")).unwrap(),
            b"create-bytes"
        );
        let written: Vec<_> = std::fs::read_dir(&out).unwrap().collect();
        assert_eq!(written.len(), 2, "nothing but the selected jars is written");
    }

    #[test]
    fn traversal_names_cannot_leave_the_unpack_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("evil.zip");
        make_zip(
            &archive,
            &[("mods/../../escape.jar", b"x"), ("mods/ok.jar", b"ok")],
        );
        let out = tmp.path().join("deep/out");
        let (installed, _) = extract_blocking(&archive, &out, ModTarget::Mods).unwrap();
        assert_eq!(installed, ["ok.jar"]);
        assert!(!tmp.path().join("escape.jar").exists());
        assert!(!tmp.path().join("deep/escape.jar").exists());
    }

    #[test]
    fn limits_count_the_bytes_actually_inflated() {
        // 4 MiB of zeros deflates to a few kilobytes: the archive is tiny,
        // what it unpacks to is not. The limits must go by the latter.
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("bomb.zip");
        let zeros = vec![0u8; 4 * 1024 * 1024];
        make_zip(&archive, &[("a.jar", &zeros), ("b.jar", &zeros)]);
        assert!(std::fs::metadata(&archive).unwrap().len() < 64 * 1024);

        let mib = 1024 * 1024;
        let per_jar = extract_with_limits(
            &archive,
            &tmp.path().join("o1"),
            ModTarget::Mods,
            mib,
            100 * mib,
        );
        let err = per_jar.unwrap_err();
        assert_eq!(err.code(), "FILE_TOO_LARGE");
        assert!(err.to_string().contains("a.jar"));

        let total = extract_with_limits(
            &archive,
            &tmp.path().join("o2"),
            ModTarget::Mods,
            5 * mib,
            6 * mib,
        );
        assert_eq!(total.unwrap_err().code(), "FILE_TOO_LARGE");

        let fits = extract_with_limits(
            &archive,
            &tmp.path().join("o3"),
            ModTarget::Mods,
            5 * mib,
            10 * mib,
        );
        assert_eq!(fits.unwrap().0, ["a.jar", "b.jar"]);
    }

    #[test]
    fn empty_and_launcher_archives_explain_themselves() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("out");

        let no_jars = tmp.path().join("docs.zip");
        make_zip(&no_jars, &[("readme.txt", b"hi")]);
        let err = extract_blocking(&no_jars, &out, ModTarget::Mods).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains("no .jar files"));

        let mrpack = tmp.path().join("pack.zip");
        make_zip(&mrpack, &[("modrinth.index.json", b"{}")]);
        let err = extract_blocking(&mrpack, &out, ModTarget::Mods).unwrap_err();
        assert!(err.to_string().contains("Modrinth modpack file"));

        let not_zip = tmp.path().join("fake.zip");
        std::fs::write(&not_zip, b"this is not a zip").unwrap();
        let err = extract_blocking(&not_zip, &out, ModTarget::Mods).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(!out.exists(), "nothing is created for a rejected archive");
    }

    #[tokio::test]
    async fn unpacks_a_file_into_a_simple_mode_server_and_audits_it() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let archive = tmp.path().join("my mods.zip");
        make_zip(
            &archive,
            &[("a.jar", b"aaa"), ("b.jar", b"bbbb"), ("notes.txt", b"n")],
        );

        let done = unpack(
            &core,
            Some(archive.to_str().unwrap()),
            None,
            None,
            ModTarget::Mods,
        )
        .await
        .unwrap();
        assert_eq!(done.installed, ["a.jar", "b.jar"]);
        assert_eq!(done.skipped, 1);
        assert_eq!(done.download_id, None);

        let mods_dir = core.settings().await.simple.instance_dir.join("mods");
        assert_eq!(std::fs::read(mods_dir.join("b.jar")).unwrap(), b"bbbb");
        // The user's archive is untouched and no temp dir is left behind.
        assert!(archive.is_file());
        let leftovers = std::fs::read_dir(tmp.path().join("data/tmp"))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0);

        let listed = crate::mods::list(&core).await.unwrap();
        assert_eq!(listed.mods.len(), 2);
        let log = crate::audit::recent(&core, None).await.unwrap();
        let entry = log
            .entries
            .iter()
            .find(|e| e.action == "mod.unpack")
            .unwrap();
        assert_eq!(entry.target.as_deref(), Some("my mods.zip"));
        assert_eq!(
            entry.detail.as_deref(),
            Some("mods: 2 installed, 1 skipped")
        );
    }

    #[tokio::test]
    async fn rejects_wrong_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::Core::init(tmp.path().join("config"), tmp.path().join("data"))
            .await
            .unwrap();
        let both = unpack(
            &core,
            Some("/x.zip"),
            Some("https://e.com/x.zip"),
            None,
            ModTarget::Mods,
        )
        .await;
        assert_eq!(both.unwrap_err().code(), "INVALID_INPUT");
        let neither = unpack(&core, None, None, None, ModTarget::Mods).await;
        assert_eq!(neither.unwrap_err().code(), "INVALID_INPUT");

        // A .jar is a mod, not an archive of mods.
        let jar = tmp.path().join("single.jar");
        std::fs::write(&jar, b"jar").unwrap();
        let err = unpack(
            &core,
            Some(jar.to_str().unwrap()),
            None,
            None,
            ModTarget::Mods,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("only a .zip"));

        // A link that is not a .zip is refused before any request.
        let err = unpack(
            &core,
            None,
            Some("https://example.com/mod.jar"),
            None,
            ModTarget::Mods,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
    }
}
