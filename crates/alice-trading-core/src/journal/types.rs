//! Execution journal data types — what gets written to disk per push.

use crate::types::{Operation, OperationResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionIntent {
    pub commit_hash: String,
    pub client_order_ids: Vec<String>,
    pub operations: Vec<Operation>,
    pub started_at: String,
    pub broker_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionResult {
    pub commit_hash: String,
    pub completed_at: String,
    pub results: Vec<OperationResult>,
    pub success: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryState {
    Executing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub state: EntryState,
    pub intent: ExecutionIntent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ExecutionResult>,
}

#[derive(Debug, Clone)]
pub struct JournalHandle {
    pub commit_hash: String,
}
