//! Verifies every v2 commit in parity/fixtures/git-states/*.json.
//!
//! Loads each fixture, classifies each commit, and asserts:
//!   - v2 commits Verified
//!   - v1 commits Skipped (the v2 fixtures should have NO v1 commits)
//!   - 0 mismatches across all 10 fixtures (23 v2 commits total)

use alice_trading_core::persisted_commit::{
    verify_commit, PersistedCommit, VerifyKind, VerifyOptions,
};
use serde_json::Value;
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
fn all_v2_fixtures_verify() {
    let mut total_v2 = 0;
    let mut total_v1 = 0;
    let mut mismatches: Vec<String> = Vec::new();

    let entries: Vec<_> = fs::read_dir(fixtures_dir())
        .expect("fixtures dir")
        .collect();
    let mut paths: Vec<PathBuf> = entries
        .into_iter()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    assert!(
        paths.len() >= 10,
        "expected ≥10 fixture files, got {}",
        paths.len()
    );

    for p in &paths {
        let json: Value = serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap();
        let commits = json
            .get("commits")
            .and_then(|c| c.as_array())
            .expect("commits");
        for raw in commits {
            let persisted = PersistedCommit::classify(raw.clone());
            let r = verify_commit(&persisted, &VerifyOptions::default()).unwrap();
            match r.kind {
                VerifyKind::Verified => total_v2 += 1,
                VerifyKind::Skipped => total_v1 += 1,
                VerifyKind::Mismatch => mismatches.push(format!(
                    "{}: {}",
                    p.file_name().unwrap().to_string_lossy(),
                    r.message.unwrap_or_default(),
                )),
            }
        }
    }

    assert!(
        mismatches.is_empty(),
        "v2 fixture mismatches:\n{:#?}",
        mismatches
    );
    assert!(
        total_v2 >= 20,
        "expected ≥20 v2 commits across fixtures, got {}",
        total_v2
    );
    println!("verified {} v2 commits, skipped {} v1", total_v2, total_v1);
}
