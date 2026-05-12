//! Rust mirrors of TS types from `src/domain/trading/git/types.ts`.
//!
//! Decimal fields outside wire-schema (e.g. `closePosition.quantity`) are
//! kept as `String` to preserve precision. Broker-shape sub-objects
//! (Position, OpenOrder) are `serde_json::Value` passthrough — rehydration
//! lives in TS per v4 §6.2.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type CommitHash = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Operation {
    PlaceOrder {
        contract: Value,
        order: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        tpsl: Option<Value>,
    },
    ModifyOrder {
        #[serde(rename = "orderId")]
        order_id: String,
        changes: Value,
    },
    ClosePosition {
        contract: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        quantity: Option<String>,
    },
    CancelOrder {
        #[serde(rename = "orderId")]
        order_id: String,
        #[serde(rename = "orderCancel", skip_serializing_if = "Option::is_none")]
        order_cancel: Option<Value>,
    },
    SyncOrders,
}

impl Operation {
    /// Returns the canonical TS `action` string ("placeOrder", "modifyOrder", etc.).
    pub fn action_name(&self) -> &'static str {
        match self {
            Operation::PlaceOrder { .. } => "placeOrder",
            Operation::ModifyOrder { .. } => "modifyOrder",
            Operation::ClosePosition { .. } => "closePosition",
            Operation::CancelOrder { .. } => "cancelOrder",
            Operation::SyncOrders => "syncOrders",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OperationStatus {
    Submitted,
    Filled,
    Rejected,
    Cancelled,
    #[serde(rename = "user-rejected")]
    UserRejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub action: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    pub status: OperationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_qty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub net_liquidation: String,
    pub total_cash_value: String,
    #[serde(rename = "unrealizedPnL")]
    pub unrealized_pn_l: String,
    #[serde(rename = "realizedPnL")]
    pub realized_pn_l: String,
    pub positions: Vec<Value>,      // broker-shape passthrough
    pub pending_orders: Vec<Value>, // broker-shape passthrough
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: CommitHash,
    pub parent_hash: Option<CommitHash>,
    pub message: String,
    pub operations: Vec<Operation>,
    pub results: Vec<OperationResult>,
    pub state_after: GitState,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round: Option<u32>,

    // Phase 2 — v2 fields. None = absent (NOT serialized as null).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_full_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash_input_timestamp: Option<String>,

    // Phase 2.5 reservation — never set in Phase 2/3
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_hash_version: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_full_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub staged: bool,
    pub index: u32,
    pub operation: Operation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPrepareResult {
    pub prepared: bool,
    pub hash: CommitHash,
    pub message: String,
    pub operation_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub hash: CommitHash,
    pub message: String,
    pub operation_count: u32,
    pub submitted: Vec<OperationResult>,
    pub rejected: Vec<OperationResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectResult {
    pub hash: CommitHash,
    pub message: String,
    pub operation_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub staged: Vec<Operation>,
    pub pending_message: Option<String>,
    pub pending_hash: Option<CommitHash>,
    pub head: Option<CommitHash>,
    pub commit_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLogEntry {
    pub hash: CommitHash,
    pub parent_hash: Option<CommitHash>,
    pub message: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round: Option<u32>,
    pub operations: Vec<OperationSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSummary {
    pub symbol: String,
    pub action: String,
    pub change: String,
    pub status: OperationStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitExportState {
    pub commits: Vec<GitCommit>,
    pub head: Option<CommitHash>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStatusUpdate {
    pub order_id: String,
    pub symbol: String,
    pub previous_status: OperationStatus,
    pub current_status: OperationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled_qty: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub hash: CommitHash,
    pub updated_count: u32,
    pub updates: Vec<OrderStatusUpdate>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn deserialize_v2_fixture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("parity/fixtures/git-states/01-single-commit.json");
        let json = fs::read_to_string(path).unwrap();
        let state: GitExportState = serde_json::from_str(&json).expect("deserialize fixture");
        assert!(!state.commits.is_empty());
        assert_eq!(state.commits[0].hash_version, Some(2));
        assert!(state.commits[0].intent_full_hash.is_some());
    }
}
