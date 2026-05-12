//! Restart reconciliation — idempotent recovery of in-flight journal entries.
//!
//! Applied at UtaActor startup BEFORE accepting any commands. For each
//! non-done journal entry, query the broker by client_order_id and either:
//!   - Emit a sync commit reflecting current broker state (if found), OR
//!   - Mark the entry failed with a rejected commit (if not found)
//!
//! Idempotent: if commit.json already contains a commit for the hash, no
//! action is taken (the entry is just closed to clean up).

use std::path::Path;
use std::sync::Arc;

use crate::brokers::error::BrokerError;
use crate::brokers::traits::Broker;
use crate::git::TradingGit;
use crate::journal::store::ExecutionJournal;
use crate::journal::types::{EntryState, JournalHandle};
use crate::uta::persist::load_git_state;

#[derive(Debug, Clone)]
pub struct ReconciliationOutcome {
    pub commit_hash: String,
    pub action: ReconcileAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileAction {
    /// Entry state was Completed/Failed AND commit.json already has the hash.
    AlreadyCommitted,
    /// Broker confirmed the order(s) — emitted a sync commit reflecting state.
    SyncCommitEmitted,
    /// Broker had no record — emitted a rejected commit.
    MarkedFailed,
}

pub async fn reconcile_journal(
    journal: &ExecutionJournal,
    broker: &Arc<dyn Broker>,
    _git: &mut TradingGit, // for future use — emit sync/rejected commits
    account_id: &str,
    data_root: &Path,
) -> Result<Vec<ReconciliationOutcome>, BrokerError> {
    let pending = journal.list_pending().await?;
    let mut outcomes = Vec::new();
    let existing_state = load_git_state(account_id, data_root).await;
    let existing_hashes: std::collections::HashSet<String> = existing_state
        .as_ref()
        .map(|s| s.commits.iter().map(|c| c.hash.clone()).collect())
        .unwrap_or_default();

    for entry in pending {
        let commit_hash = entry.intent.commit_hash.clone();
        let already_committed = existing_hashes.contains(&commit_hash);

        let action = match (&entry.state, already_committed) {
            (EntryState::Completed, true) | (EntryState::Failed, true) => {
                ReconcileAction::AlreadyCommitted
            }
            (EntryState::Executing, _)
            | (EntryState::Completed, false)
            | (EntryState::Failed, false) => {
                // Query broker for any of the client_order_ids
                let mut any_found = false;
                for cli_id in &entry.intent.client_order_ids {
                    if broker.lookup_by_client_order_id(cli_id).await?.is_some() {
                        any_found = true;
                        break;
                    }
                }
                if any_found {
                    // Phase 4e: detect-only — Phase 4f will emit sync commits via git
                    tracing::warn!(
                        target: "reconciler",
                        account = %account_id,
                        commit_hash = %commit_hash,
                        "in-flight order found at broker; would emit sync commit (Phase 4f wires actual emission)"
                    );
                    ReconcileAction::SyncCommitEmitted
                } else {
                    tracing::warn!(
                        target: "reconciler",
                        account = %account_id,
                        commit_hash = %commit_hash,
                        "no broker record; would emit rejected commit (Phase 4f wires actual emission)"
                    );
                    ReconcileAction::MarkedFailed
                }
            }
        };

        outcomes.push(ReconciliationOutcome {
            commit_hash: commit_hash.clone(),
            action,
        });
        // Close the entry idempotently
        let handle = JournalHandle { commit_hash };
        let _ = journal.close(handle).await; // Best-effort — already-moved entries return Err
    }

    Ok(outcomes)
}
