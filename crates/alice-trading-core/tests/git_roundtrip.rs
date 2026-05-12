//! Loads each v2 fixture, restores into TradingGit, exports state, and
//! asserts the new export round-trips byte-identical (value-identical) to
//! the source. This is the load-bearing assertion for Task C — if any
//! field's serde shape diverges from TS, this test fails.

use alice_trading_core::git::{TradingGit, TradingGitConfig};
use alice_trading_core::types::GitExportState;
use std::fs;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("parity/fixtures/git-states")
}

#[test]
fn restore_export_roundtrip_byte_identical() {
    let mut paths: Vec<_> = fs::read_dir(fixtures_dir())
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    assert!(
        paths.len() >= 10,
        "expected ≥10 fixture files, got {}",
        paths.len()
    );

    let mut total_commits = 0;
    for p in &paths {
        let raw = fs::read_to_string(p).unwrap();
        let original_json: serde_json::Value = serde_json::from_str(&raw).unwrap();

        let state: GitExportState = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("deserialize {}: {}", p.display(), e));

        total_commits += state.commits.len();

        let git = TradingGit::restore(state, TradingGitConfig::stub());
        let exported = git.export_state();
        let exported_json = serde_json::to_value(&exported).unwrap();

        assert_eq!(
            exported_json,
            original_json,
            "round-trip mismatch for {}",
            p.file_name().unwrap().to_string_lossy(),
        );
    }
    println!(
        "round-tripped {} commits across {} fixtures",
        total_commits,
        paths.len()
    );
}
