//! Phase 4d Task C — atomic-write persistence + legacy path fallback.

use alice_trading_core::types::{GitCommit, GitExportState, GitState};
use alice_trading_core::uta::{
    commit_path, legacy_commit_path, load_git_state, persist_commit_atomic,
};
use std::path::PathBuf;
use tempfile::TempDir;

fn empty_git_state() -> GitState {
    GitState {
        net_liquidation: "0".into(),
        total_cash_value: "0".into(),
        unrealized_pn_l: "0".into(),
        realized_pn_l: "0".into(),
        positions: vec![],
        pending_orders: vec![],
    }
}

fn make_commit(hash: &str, message: &str) -> GitCommit {
    GitCommit {
        hash: hash.to_string(),
        parent_hash: None,
        message: message.to_string(),
        operations: vec![],
        results: vec![],
        state_after: empty_git_state(),
        timestamp: "2026-01-01T00:00:00.000Z".to_string(),
        round: None,
        hash_version: Some(2),
        intent_full_hash: Some(format!("{}{}", hash, "x".repeat(56))),
        hash_input_timestamp: Some("2026-01-01T00:00:00.000Z".to_string()),
        entry_hash_version: None,
        entry_full_hash: None,
    }
}

#[tokio::test]
async fn write_then_read_round_trip() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![make_commit("abc12345", "test")],
        head: Some("abc12345".to_string()),
    };
    persist_commit_atomic("acct-1", &state, dir.path())
        .await
        .unwrap();
    let loaded = load_git_state("acct-1", dir.path()).await.unwrap();
    assert_eq!(loaded.commits.len(), 1);
    assert_eq!(loaded.commits[0].hash, "abc12345");
    assert_eq!(loaded.head.as_deref(), Some("abc12345"));
}

#[tokio::test]
async fn primary_path_format() {
    let root = PathBuf::from("/tmp/test-root");
    assert_eq!(
        commit_path("acct-1", &root),
        PathBuf::from("/tmp/test-root/trading/acct-1/commit.json"),
    );
}

#[tokio::test]
async fn legacy_path_bybit_main() {
    let root = PathBuf::from("/data");
    assert_eq!(
        legacy_commit_path("bybit-main", &root),
        Some(PathBuf::from("/data/crypto-trading/commit.json")),
    );
}

#[tokio::test]
async fn legacy_path_alpaca() {
    let root = PathBuf::from("/data");
    assert_eq!(
        legacy_commit_path("alpaca-paper", &root),
        Some(PathBuf::from("/data/securities-trading/commit.json")),
    );
    assert_eq!(
        legacy_commit_path("alpaca-live", &root),
        Some(PathBuf::from("/data/securities-trading/commit.json")),
    );
}

#[tokio::test]
async fn legacy_path_none_for_unknown() {
    let root = PathBuf::from("/data");
    assert_eq!(legacy_commit_path("custom-acct", &root), None);
}

#[tokio::test]
async fn load_falls_back_to_legacy_path_for_bybit_main() {
    let dir = TempDir::new().unwrap();
    // Write only to legacy path
    let state = GitExportState {
        commits: vec![make_commit("legacy01", "from legacy")],
        head: Some("legacy01".to_string()),
    };
    let legacy = dir.path().join("crypto-trading");
    std::fs::create_dir_all(&legacy).unwrap();
    let legacy_file = legacy.join("commit.json");
    std::fs::write(&legacy_file, serde_json::to_string_pretty(&state).unwrap()).unwrap();

    let loaded = load_git_state("bybit-main", dir.path()).await.unwrap();
    assert_eq!(loaded.commits[0].hash, "legacy01");
}

#[tokio::test]
async fn load_returns_none_when_no_state_exists() {
    let dir = TempDir::new().unwrap();
    let loaded = load_git_state("acct-missing", dir.path()).await;
    assert!(loaded.is_none());
}

#[tokio::test]
async fn atomic_write_does_not_leave_tmp_files() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![make_commit("clean001", "test")],
        head: Some("clean001".to_string()),
    };
    persist_commit_atomic("acct-2", &state, dir.path())
        .await
        .unwrap();

    // List files in the account dir — should only be commit.json, no tmp files
    let acct_dir = dir.path().join("trading/acct-2");
    let entries: Vec<_> = std::fs::read_dir(&acct_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries, vec!["commit.json".to_string()]);
}

#[tokio::test]
async fn write_overwrites_previous_state() {
    let dir = TempDir::new().unwrap();
    let s1 = GitExportState {
        commits: vec![make_commit("first001", "first")],
        head: Some("first001".to_string()),
    };
    persist_commit_atomic("acct-3", &s1, dir.path())
        .await
        .unwrap();

    let s2 = GitExportState {
        commits: vec![
            make_commit("first001", "first"),
            make_commit("secnd001", "second"),
        ],
        head: Some("secnd001".to_string()),
    };
    persist_commit_atomic("acct-3", &s2, dir.path())
        .await
        .unwrap();

    let loaded = load_git_state("acct-3", dir.path()).await.unwrap();
    assert_eq!(loaded.commits.len(), 2);
    assert_eq!(loaded.head.as_deref(), Some("secnd001"));
}
