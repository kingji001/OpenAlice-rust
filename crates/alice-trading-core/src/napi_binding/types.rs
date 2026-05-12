//! Typed napi structs for the TradingCore FFI boundary.
//!
//! Constraint: no `serde_json::Value` in any napi-exposed field — every
//! dynamic shape is a typed struct or an opaque JSON string.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TradingCoreConfig {
    pub data_root: String,
    /// Per-UTA event channel capacity. Default: 1024.
    pub event_queue_capacity: Option<u32>,
    /// Consecutive panic threshold before UTA is permanently disabled. Default: 5.
    pub panic_disable_threshold: Option<u32>,
}

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AccountConfig {
    pub id: String,
    /// 'alpaca' | 'ibkr' | 'ccxt' | 'mock'
    pub account_type: String,
    /// 'mock-paper' for Phase 4f
    pub broker_id: String,
    pub enabled: bool,
    pub guards: Vec<GuardConfig>,
    pub broker_config: BrokerConfigPayload,
}

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GuardConfig {
    pub guard_type: String,
    /// Serialized JSON object — opaque to napi.
    pub config_json: String,
}

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BrokerConfigPayload {
    /// Serialized JSON — opaque to napi.
    pub config_json: String,
}

/// Per-UTA event emitted to the TypeScript host via ThreadsafeFunction.
///
/// `seq` is u32 (not u64) so that napi-rs v2 maps it to a JS `number` rather
/// than a `BigInt`. At the trading event rate, u32 provides ~4 billion events
/// per UTA — decades of headroom. The TS side gap-detects by comparing
/// `event.seq !== lastSeq + 1` which works cleanly with plain numbers.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TradingCoreEvent {
    pub uta_id: String,
    /// Per-UTA monotonic counter. u32 → JS number (napi-rs v2).
    pub seq: u32,
    /// Milliseconds since Unix epoch as f64. napi-rs v2 maps i64 to JS BigInt,
    /// which breaks TS `number` consumers; f64 maps to JS `number` and safely
    /// represents all timestamps well past year 2100 (2^53 ms ≈ 285616 years).
    pub timestamp_ms: f64,
    /// 'commit.notify' | 'reject.notify' | 'account.health'
    pub event_type: String,
    /// Serialized payload — TS parses based on event_type.
    pub payload_json: String,
}

// ---------------------------------------------------------------------------
// Command parameter structs (Task B)
//
// All serde_json::Value fields in the canonical types are replaced with opaque
// JSON strings so that napi-rs v2 can map them to JS strings without issues.
// ---------------------------------------------------------------------------

/// Parameters for `stage_place_order`. All broker-shape fields are opaque JSON
/// strings; the Rust layer deserializes them back to `serde_json::Value` before
/// constructing the `Operation`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StagePlaceOrderParams {
    /// JSON-serialized contract object (broker-shape passthrough).
    pub contract_json: String,
    /// JSON-serialized order object (broker-shape passthrough).
    pub order_json: String,
    /// Optional JSON-serialized TpSl params. `None` means no take-profit/stop-loss.
    pub tpsl_json: Option<String>,
}

/// Parameters for `stage_modify_order`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StageModifyOrderParams {
    pub order_id: String,
    /// JSON-serialized changes object (broker-shape passthrough).
    pub changes_json: String,
}

/// Parameters for `stage_close_position`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StageClosePositionParams {
    /// JSON-serialized contract object (broker-shape passthrough).
    pub contract_json: String,
    /// Optional partial-close quantity as a decimal string.
    pub quantity: Option<String>,
}

/// Parameters for `sync`. `current_state_json` is a JSON-serialized `GitState`.
/// `updates` is a list of order status updates.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrderStatusUpdateNapi {
    pub order_id: String,
    pub symbol: String,
    pub previous_status: String,
    pub current_status: String,
    pub filled_price: Option<String>,
    pub filled_qty: Option<String>,
}

// ---------------------------------------------------------------------------
// Mirror result structs (Task B)
//
// Canonical result types in `src/types.rs` contain `serde_json::Value` fields
// (e.g. `Operation`, `OperationResult.execution`) that are not napi-compatible.
// We expose typed mirror structs here and provide `From` impls. This keeps the
// canonical types clean and lets the napi surface evolve independently.
// ---------------------------------------------------------------------------

/// Mirror of `crate::types::AddResult`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AddResultNapi {
    pub staged: bool,
    /// Zero-based index of the operation in the staging area.
    pub index: u32,
    /// JSON-serialized `Operation` (tagged enum — TS parses by `action` field).
    pub operation_json: String,
}

/// Mirror of `crate::types::CommitPrepareResult`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CommitPrepareResultNapi {
    pub prepared: bool,
    pub hash: String,
    pub message: String,
    pub operation_count: u32,
}

/// Thin mirror of a single `OperationResult` for use inside `PushResultNapi`.
/// `execution` and `order_state` are opaque JSON strings.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OperationResultNapi {
    pub action: String,
    pub success: bool,
    pub order_id: Option<String>,
    /// OperationStatus as a string ('submitted' | 'filled' | 'rejected' | 'cancelled' | 'user-rejected').
    pub status: String,
    /// JSON-serialized execution object, or `null`.
    pub execution_json: Option<String>,
    /// JSON-serialized order_state object, or `null`.
    pub order_state_json: Option<String>,
    pub filled_qty: Option<String>,
    pub filled_price: Option<String>,
    pub error: Option<String>,
}

/// Mirror of `crate::types::PushResult`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PushResultNapi {
    pub hash: String,
    pub message: String,
    pub operation_count: u32,
    pub submitted: Vec<OperationResultNapi>,
    pub rejected: Vec<OperationResultNapi>,
}

/// Mirror of `crate::types::RejectResult`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RejectResultNapi {
    pub hash: String,
    pub message: String,
    pub operation_count: u32,
}

/// Mirror of `crate::types::SyncResult` (without the `Vec<OrderStatusUpdate>`
/// to avoid exposing the canonical type directly through napi).
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SyncResultNapi {
    pub hash: String,
    pub updated_count: u32,
}

/// Mirror of `crate::types::GitExportState` — the full state as JSON strings.
/// `commits_json` is a JSON array of `GitCommit` objects.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GitExportStateNapi {
    /// JSON-serialized array of `GitCommit` objects.
    pub commits_json: String,
    pub head: Option<String>,
}

/// Mirror of `crate::brokers::types::BrokerHealthInfo`.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BrokerHealthInfoNapi {
    /// 'healthy' | 'unhealthy' | 'offline'
    pub status: String,
    pub last_check: String,
    pub message: Option<String>,
    /// u32 → JS number (napi-rs v2).
    pub consecutive_failures: Option<u32>,
}

/// Account snapshot derived from the latest commit's `state_after` in `GitExportState`.
/// All decimal fields are strings (precision-safe passthrough).
///
/// Phase 4f: derived from `export_state()` — no UtaCommand extensions needed.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AccountSnapshotNapi {
    pub net_liquidation: String,
    pub total_cash_value: String,
    pub unrealized_pn_l: String,
    pub realized_pn_l: String,
}

/// A single position from the latest commit's `state_after.positions`.
///
/// `position_json` is the broker-shape position object serialized to a JSON string.
/// This matches `GitState.positions: Vec<Value>` — the shape is broker-specific and
/// is passed through opaquely to the TS host.
#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PositionSnapshotNapi {
    /// Serialized broker-shape position object.
    pub position_json: String,
}
