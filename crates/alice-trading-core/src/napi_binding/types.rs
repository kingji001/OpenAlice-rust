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
    pub timestamp_ms: i64,
    /// 'commit.notify' | 'reject.notify' | 'account.health'
    pub event_type: String,
    /// Serialized payload — TS parses based on event_type.
    pub payload_json: String,
}
