//! Live check of the six server-type version lists (contract §3.6, §6.3c).
//! Needs the network: `cargo test -p mineui-core --test live_loader_versions -- --ignored`.

use std::collections::HashSet;

use mineui_core::loader_versions::fetch_supported;
use mineui_core::model::ContainerLoader;

#[tokio::test]
#[ignore]
async fn live_every_type_list_overlaps_mojang() {
    let tmp = tempfile::tempdir().unwrap();
    let core = mineui_core::Core::init(tmp.path().join("config"), tmp.path().join("data"))
        .await
        .unwrap();
    let releases: HashSet<String> = mineui_core::mojang::list_versions(&core, false)
        .await
        .expect("Mojang manifest")
        .into_iter()
        .map(|v| v.id)
        .collect();
    for loader in [
        ContainerLoader::Paper,
        ContainerLoader::Purpur,
        ContainerLoader::Fabric,
        ContainerLoader::Quilt,
        ContainerLoader::Forge,
        ContainerLoader::Neoforge,
    ] {
        let list = fetch_supported(loader)
            .await
            .unwrap_or_else(|e| panic!("{loader:?}: {e}"));
        assert!(!list.is_empty(), "{loader:?}: empty");
        let shared = list.iter().filter(|id| releases.contains(*id)).count();
        assert!(
            shared > 0,
            "{loader:?}: no version in common with Mojang's releases"
        );

        // The same list through the command's entry point, by wire name.
        let wire = serde_json::to_value(loader).unwrap();
        let filtered = mineui_core::loader_versions::list_versions(&core, false, wire.as_str())
            .await
            .unwrap();
        assert!(filtered.iter().all(|v| list.contains(&v.id)), "{loader:?}");
        let newest: Vec<&str> = filtered.iter().take(3).map(|v| v.id.as_str()).collect();
        println!(
            "{loader:?}: {} ids listed, {shared} Mojang releases, newest {newest:?}",
            list.len()
        );
    }
}
