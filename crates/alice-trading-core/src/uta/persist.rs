//! Atomic-write commit persistence.
//!
//! Path: data/trading/<accountId>/commit.json
//! Legacy fallbacks: bybit-main → data/crypto-trading/commit.json
//!                   alpaca-paper/alpaca-live → data/securities-trading/commit.json
//!
//! Atomic-write recipe:
//!   1. Write JSON to <dir>/commit.json.tmp.<pid>
//!   2. fsync the tmp file
//!   3. Atomic rename(tmp, primary)
//!   4. Best-effort fsync the parent directory
//!
//! Stronger than TS today (writeFile is non-atomic, no fsync).

use std::path::{Path, PathBuf};

use crate::types::GitExportState;

pub fn commit_path(account_id: &str, data_root: &Path) -> PathBuf {
    data_root.join(format!("trading/{}/commit.json", account_id))
}

/// Legacy path fallbacks — mirrors TS src/domain/trading/git-persistence.ts:18-22.
pub fn legacy_commit_path(account_id: &str, data_root: &Path) -> Option<PathBuf> {
    match account_id {
        "bybit-main" => Some(data_root.join("crypto-trading/commit.json")),
        "alpaca-paper" | "alpaca-live" => Some(data_root.join("securities-trading/commit.json")),
        _ => None,
    }
}

/// Read saved git state from disk, trying primary path then legacy fallback.
pub async fn load_git_state(account_id: &str, data_root: &Path) -> Option<GitExportState> {
    let primary = commit_path(account_id, data_root);
    if let Ok(bytes) = tokio::fs::read(&primary).await {
        if let Ok(state) = serde_json::from_slice::<GitExportState>(&bytes) {
            return Some(state);
        }
    }
    if let Some(legacy) = legacy_commit_path(account_id, data_root) {
        if let Ok(bytes) = tokio::fs::read(&legacy).await {
            if let Ok(state) = serde_json::from_slice::<GitExportState>(&bytes) {
                return Some(state);
            }
        }
    }
    None
}

/// Atomic-write commit.json. Returns I/O errors for the caller to handle.
pub async fn persist_commit_atomic(
    account_id: &str,
    state: &GitExportState,
    data_root: &Path,
) -> Result<(), std::io::Error> {
    let path = commit_path(account_id, data_root);
    let state_clone = state.clone();
    tokio::task::spawn_blocking(move || -> Result<(), std::io::Error> {
        let dir = path.parent().expect("commit_path always has a parent");
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("commit.json.tmp.{}", std::process::id()));
        let json = serde_json::to_string_pretty(&state_clone)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(&tmp, &json)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, &path)?;
        // Best-effort directory fsync — some filesystems don't support it
        if let Ok(dir_file) = std::fs::File::open(dir) {
            let _ = dir_file.sync_all();
        }
        Ok(())
    })
    .await
    .map_err(|e| std::io::Error::other(format!("join error: {}", e)))?
}
