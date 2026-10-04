//! Live test for `change_instance_version` (contract §3.6, 2.10.0).
//! **Opt-in** - `#[ignore]`; CI never runs it. Needs network (Mojang's
//! manifest + two ~55 MB server jars) and Java 21 on PATH; no container.
//! Everything lives in a temp dir.
//!
//! ```sh
//! cargo test -p mineui-core --test live_change_version -- --ignored
//! ```

use mineui_core::model::{CreateInstanceArgs, InstanceMeta};
use mineui_core::settings::{Mode, Settings};
use mineui_core::Core;
use sha1::{Digest, Sha1};

const FROM: &str = "1.21.3";
const TO: &str = "1.21.4";

fn sha1_hex(path: &std::path::Path) -> String {
    hex::encode(Sha1::digest(std::fs::read(path).unwrap()))
}

#[tokio::test]
#[ignore]
async fn live_change_version_keeps_world_and_backs_up() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default_with_data_dir(&tmp.path().join("data"));
    settings.active_mode = Mode::Simple;
    let core =
        Core::init_with_settings(tmp.path().join("config"), tmp.path().join("data"), settings)
            .await;
    let dir = core.settings().await.simple.instance_dir.clone();

    mineui_core::instance::create(
        &core,
        &CreateInstanceArgs {
            mc_version: FROM.into(),
            accept_eula: true,
            memory_mb: None,
        },
    )
    .await
    .expect("create 1.21.3");
    let before: InstanceMeta =
        serde_json::from_str(&std::fs::read_to_string(dir.join("mineui-instance.json")).unwrap())
            .unwrap();

    // A world the server would have written.
    std::fs::create_dir_all(dir.join("world/region")).unwrap();
    std::fs::write(dir.join("world/level.dat"), b"not really nbt").unwrap();

    let changed = mineui_core::instance::change_version(&core, TO, false)
        .await
        .expect("upgrade needs no allowDowngrade");
    assert_eq!(changed.from_version, FROM);
    assert_eq!(changed.to_version, TO);
    let backup = changed.backup.clone().expect("world existed → backup");
    assert!(dir.join("backups").join(&backup).is_file());
    assert_eq!(changed.status.mc_version.as_deref(), Some(TO));

    let after: InstanceMeta =
        serde_json::from_str(&std::fs::read_to_string(dir.join("mineui-instance.json")).unwrap())
            .unwrap();
    assert_eq!(after.mc_version, TO);
    assert_eq!(after.created_at, before.created_at);
    assert_ne!(after.jar_sha1, before.jar_sha1);
    assert_eq!(sha1_hex(&dir.join("server.jar")), after.jar_sha1);
    assert_eq!(core.settings().await.simple.mc_version, TO);
    assert!(dir.join("world/level.dat").is_file(), "world kept");

    // No temp jar left behind.
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".download"))
        .collect();
    assert!(leftovers.is_empty());

    // Going back needs allowDowngrade; refused before any download.
    let err = mineui_core::instance::change_version(&core, FROM, false)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");
    assert!(err.to_string().contains("allowDowngrade"));
    assert_eq!(sha1_hex(&dir.join("server.jar")), after.jar_sha1);

    // Unknown version.
    let err = mineui_core::instance::change_version(&core, "9.99.99", true)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_INPUT");

    let log = mineui_core::audit::recent(&core, Some(50)).await.unwrap();
    let ok = log
        .entries
        .iter()
        .find(|e| e.action == "instance.change-version" && e.ok)
        .expect("success audited");
    assert_eq!(ok.target.as_deref(), Some("1.21.3 → 1.21.4"));
    assert_eq!(ok.detail.as_deref(), Some(backup.as_str()));
}
