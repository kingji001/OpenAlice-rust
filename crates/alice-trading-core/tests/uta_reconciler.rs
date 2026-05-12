//! Phase 4d Task D — missing-snapshot detection.

use alice_trading_core::types::{GitCommit, GitExportState, GitState};
use alice_trading_core::uta::{find_missing_snapshots, persist_commit_atomic};
use tempfile::TempDir;

fn empty_state() -> GitState {
    GitState {
        net_liquidation: "0".into(),
        total_cash_value: "0".into(),
        unrealized_pn_l: "0".into(),
        realized_pn_l: "0".into(),
        positions: vec![],
        pending_orders: vec![],
    }
}

fn commit(hash: &str) -> GitCommit {
    GitCommit {
        hash: hash.into(),
        parent_hash: None,
        message: "x".into(),
        operations: vec![],
        results: vec![],
        state_after: empty_state(),
        timestamp: "2026-01-01T00:00:00.000Z".into(),
        round: None,
        hash_version: Some(2),
        intent_full_hash: Some(format!("{}{}", hash, "x".repeat(56))),
        hash_input_timestamp: Some("2026-01-01T00:00:00.000Z".into()),
        entry_hash_version: None,
        entry_full_hash: None,
    }
}

#[tokio::test]
async fn detects_3_of_5_missing() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![
            commit("aaaa1111"),
            commit("bbbb2222"),
            commit("cccc3333"),
            commit("dddd4444"),
            commit("eeee5555"),
        ],
        head: Some("eeee5555".into()),
    };
    persist_commit_atomic("acct-r", &state, dir.path())
        .await
        .unwrap();

    let snap_dir = dir.path().join("snapshots/acct-r");
    std::fs::create_dir_all(&snap_dir).unwrap();
    std::fs::write(snap_dir.join("aaaa1111.json"), "{}").unwrap();
    std::fs::write(snap_dir.join("cccc3333.json"), "{}").unwrap();
    std::fs::write(snap_dir.join("eeee5555.json"), "{}").unwrap();

    let report = find_missing_snapshots("acct-r", dir.path()).await.unwrap();
    assert_eq!(
        report.missing_commit_hashes,
        vec!["bbbb2222".to_string(), "dddd4444".to_string()],
    );
    assert_eq!(report.account_id, "acct-r");
}

#[tokio::test]
async fn no_commits_returns_empty() {
    let dir = TempDir::new().unwrap();
    let report = find_missing_snapshots("acct-nothing", dir.path())
        .await
        .unwrap();
    assert!(report.missing_commit_hashes.is_empty());
    assert_eq!(report.account_id, "acct-nothing");
}

#[tokio::test]
async fn no_snapshots_dir_means_all_missing() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![commit("h1"), commit("h2")],
        head: Some("h2".into()),
    };
    persist_commit_atomic("acct-snap-missing", &state, dir.path())
        .await
        .unwrap();

    let report = find_missing_snapshots("acct-snap-missing", dir.path())
        .await
        .unwrap();
    assert_eq!(report.missing_commit_hashes.len(), 2);
    assert!(report.missing_commit_hashes.contains(&"h1".to_string()));
    assert!(report.missing_commit_hashes.contains(&"h2".to_string()));
}

#[tokio::test]
async fn all_snapshots_present_returns_empty_missing() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![commit("hash1")],
        head: Some("hash1".into()),
    };
    persist_commit_atomic("acct-full", &state, dir.path())
        .await
        .unwrap();
    let snap = dir.path().join("snapshots/acct-full");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join("hash1.json"), "{}").unwrap();

    let report = find_missing_snapshots("acct-full", dir.path())
        .await
        .unwrap();
    assert!(report.missing_commit_hashes.is_empty());
}
