//! UtaCommand discriminated union — one variant per public UTA operation.
//!
//! Uses oneshot::Sender for replies so callers await the result without
//! polluting the actor with reply-routing logic.

use crate::brokers::error::BrokerError;
use crate::brokers::types::BrokerHealthInfo;
use crate::types::{
    AddResult, CommitPrepareResult, GitExportState, GitState, Operation, OrderStatusUpdate,
    PushResult, RejectResult, SyncResult,
};
use tokio::sync::oneshot;

pub enum UtaCommand {
    Add {
        op: Operation,
        reply: oneshot::Sender<Result<AddResult, String>>,
    },
    Commit {
        message: String,
        reply: oneshot::Sender<Result<CommitPrepareResult, String>>,
    },
    Push {
        reply: oneshot::Sender<Result<PushResult, BrokerError>>,
    },
    Reject {
        reason: Option<String>,
        reply: oneshot::Sender<Result<RejectResult, BrokerError>>,
    },
    Sync {
        updates: Vec<OrderStatusUpdate>,
        current_state: GitState,
        reply: oneshot::Sender<Result<SyncResult, BrokerError>>,
    },
    GetHealth {
        reply: oneshot::Sender<BrokerHealthInfo>,
    },
    NudgeRecovery,
    ExportState {
        reply: oneshot::Sender<GitExportState>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

pub enum UtaEvent {
    CommitNotify {
        account_id: String,
        commit_hash: String,
    },
    HealthChange {
        account_id: String,
        info: BrokerHealthInfo,
    },
}

/// Internal signal from the recovery task back to the actor.
pub enum RecoverySignal {
    Recovered,
    Attempt { attempt: u32, error: String },
}
