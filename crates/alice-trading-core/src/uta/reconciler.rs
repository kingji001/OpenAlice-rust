//! Missing-snapshot reconciler — detection-only in Phase 4d.
//!
//! Scans `data/trading/<accountId>/commit.json` against
//! `data/snapshots/<accountId>/` and returns commit hashes that lack a
//! corresponding snapshot file.
//!
//! Phase 4d: detection-only. Logs each gap via `tracing::warn!`.
//! Phase 4f wires the trigger (emit `commit.notify` via tsfn to the TS
//! snapshot service).

use std::collections::HashSet;
use std::path::Path;

use crate::uta::persist::load_git_state;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingSnapshotReport {
    pub account_id: String,
    pub missing_commit_hashes: Vec<String>,
}

pub async fn find_missing_snapshots(
    account_id: &str,
    data_root: &Path,
) -> Result<MissingSnapshotReport, std::io::Error> {
    let state = match load_git_state(account_id, data_root).await {
        Some(s) => s,
        None => {
            return Ok(MissingSnapshotReport {
                account_id: account_id.to_string(),
                missing_commit_hashes: vec![],
            });
        }
    };

    let snapshots_dir = data_root.join(format!("snapshots/{}", account_id));
    let existing: HashSet<String> = if snapshots_dir.exists() {
        std::fs::read_dir(&snapshots_dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.strip_suffix(".json").map(String::from)
            })
            .collect()
    } else {
        HashSet::new()
    };

    let missing: Vec<String> = state
        .commits
        .iter()
        .map(|c| c.hash.clone())
        .filter(|hash| !existing.contains(hash))
        .collect();

    for hash in &missing {
        tracing::warn!(
            target: "reconciler",
            account_id = %account_id,
            commit_hash = %hash,
            "missing snapshot for committed change",
        );
    }

    Ok(MissingSnapshotReport {
        account_id: account_id.to_string(),
        missing_commit_hashes: missing,
    })
}
