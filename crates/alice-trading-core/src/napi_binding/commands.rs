//! Per-UTA command methods on `TradingCore` — Phase 4f Task B.
//!
//! Each method:
//!   1. Calls `handle_for()` to look up the UTA actor handle (clone, then
//!      drop the lock before any `.await`).
//!   2. Delegates to the appropriate `UtaHandle` method.
//!   3. Converts domain results to napi mirror types.
//!   4. Converts errors via `error_map::broker_error_to_napi` or
//!      `error_map::string_error_to_napi`.
//!   5. Wraps the entire body in `async_catch_unwind_napi` so Rust panics
//!      surface as typed `RUST_PANIC:` errors rather than aborting Node.js.
//!
//! `serde_json::Value` never appears in any napi signature — broker-shape
//! objects are passed as opaque JSON strings and deserialized inside the method.

use napi_derive::napi;

use crate::napi_binding::error_map::{
    broker_error_to_napi, json_parse_error_to_napi, string_error_to_napi,
};
use crate::napi_binding::panic::async_catch_unwind_napi;
use crate::napi_binding::trading_core::TradingCore;
use crate::napi_binding::types::{
    AddResultNapi, BrokerHealthInfoNapi, CommitPrepareResultNapi, GitExportStateNapi,
    OperationResultNapi, OrderStatusUpdateNapi, PushResultNapi, RejectResultNapi,
    StageClosePositionParams, StageModifyOrderParams, StagePlaceOrderParams, SyncResultNapi,
};
use crate::types::{GitState, Operation, OperationStatus, OrderStatusUpdate};

// ---------------------------------------------------------------------------
// Conversion helpers (canonical → napi mirror)
// ---------------------------------------------------------------------------

fn operation_status_to_str(s: OperationStatus) -> String {
    match s {
        OperationStatus::Submitted => "submitted".to_string(),
        OperationStatus::Filled => "filled".to_string(),
        OperationStatus::Rejected => "rejected".to_string(),
        OperationStatus::Cancelled => "cancelled".to_string(),
        OperationStatus::UserRejected => "user-rejected".to_string(),
    }
}

fn operation_status_from_str(s: &str) -> napi::Result<OperationStatus> {
    match s {
        "submitted" => Ok(OperationStatus::Submitted),
        "filled" => Ok(OperationStatus::Filled),
        "rejected" => Ok(OperationStatus::Rejected),
        "cancelled" => Ok(OperationStatus::Cancelled),
        "user-rejected" => Ok(OperationStatus::UserRejected),
        other => Err(napi::Error::new(
            napi::Status::InvalidArg,
            format!("unknown OperationStatus: '{}'", other),
        )),
    }
}

fn op_result_to_napi(r: crate::types::OperationResult) -> OperationResultNapi {
    OperationResultNapi {
        action: r.action,
        success: r.success,
        order_id: r.order_id,
        status: operation_status_to_str(r.status),
        execution_json: r.execution.as_ref().map(|v| v.to_string()),
        order_state_json: r.order_state.as_ref().map(|v| v.to_string()),
        filled_qty: r.filled_qty,
        filled_price: r.filled_price,
        error: r.error,
    }
}

// ---------------------------------------------------------------------------
// Command surface — one `#[napi] impl TradingCore` block
// ---------------------------------------------------------------------------

#[napi]
impl TradingCore {
    // -----------------------------------------------------------------------
    // Staging methods (Add operations)
    // -----------------------------------------------------------------------

    /// Stage a place-order operation for the given UTA.
    ///
    /// `params.contract_json` and `params.order_json` are JSON-serialized
    /// broker-shape objects (opaque to napi; deserialized inside this method).
    #[napi]
    pub async fn stage_place_order(
        &self,
        uta_id: String,
        params: StagePlaceOrderParams,
    ) -> napi::Result<AddResultNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;

            let contract = serde_json::from_str(&params.contract_json)
                .map_err(|e| json_parse_error_to_napi("contract_json", e))?;
            let order = serde_json::from_str(&params.order_json)
                .map_err(|e| json_parse_error_to_napi("order_json", e))?;
            let tpsl = params
                .tpsl_json
                .as_deref()
                .map(|s| {
                    serde_json::from_str(s).map_err(|e| json_parse_error_to_napi("tpsl_json", e))
                })
                .transpose()?;

            let op = Operation::PlaceOrder {
                contract,
                order,
                tpsl,
            };

            let result = handle.add(op).await.map_err(string_error_to_napi)?;

            let operation_json = serde_json::to_string(&result.operation).map_err(|e| {
                napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("serialize operation: {}", e),
                )
            })?;

            Ok(AddResultNapi {
                staged: result.staged,
                index: result.index,
                operation_json,
            })
        })
        .await
    }

    /// Stage a modify-order operation for the given UTA.
    ///
    /// `params.changes_json` is a JSON-serialized changes object.
    #[napi]
    pub async fn stage_modify_order(
        &self,
        uta_id: String,
        params: StageModifyOrderParams,
    ) -> napi::Result<AddResultNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;

            let changes = serde_json::from_str(&params.changes_json)
                .map_err(|e| json_parse_error_to_napi("changes_json", e))?;

            let op = Operation::ModifyOrder {
                order_id: params.order_id,
                changes,
            };

            let result = handle.add(op).await.map_err(string_error_to_napi)?;

            let operation_json = serde_json::to_string(&result.operation).map_err(|e| {
                napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("serialize operation: {}", e),
                )
            })?;

            Ok(AddResultNapi {
                staged: result.staged,
                index: result.index,
                operation_json,
            })
        })
        .await
    }

    /// Stage a close-position operation for the given UTA.
    ///
    /// `params.contract_json` is a JSON-serialized contract object.
    /// `params.quantity` is an optional decimal string for partial closes.
    #[napi]
    pub async fn stage_close_position(
        &self,
        uta_id: String,
        params: StageClosePositionParams,
    ) -> napi::Result<AddResultNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;

            let contract = serde_json::from_str(&params.contract_json)
                .map_err(|e| json_parse_error_to_napi("contract_json", e))?;

            let op = Operation::ClosePosition {
                contract,
                quantity: params.quantity,
            };

            let result = handle.add(op).await.map_err(string_error_to_napi)?;

            let operation_json = serde_json::to_string(&result.operation).map_err(|e| {
                napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("serialize operation: {}", e),
                )
            })?;

            Ok(AddResultNapi {
                staged: result.staged,
                index: result.index,
                operation_json,
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Commit / push / reject
    // -----------------------------------------------------------------------

    /// Prepare a commit for the given UTA.
    ///
    /// Transitions the staging area into a pending commit with the given
    /// message. Does not execute any broker calls — call `push` for that.
    #[napi]
    pub async fn commit(
        &self,
        uta_id: String,
        message: String,
    ) -> napi::Result<CommitPrepareResultNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;
            let result = handle.commit(message).await.map_err(string_error_to_napi)?;
            Ok(CommitPrepareResultNapi {
                prepared: result.prepared,
                hash: result.hash,
                message: result.message,
                operation_count: result.operation_count,
            })
        })
        .await
    }

    /// Execute the pending commit for the given UTA against the broker.
    ///
    /// On success, returns a `PushResultNapi` with the commit hash and
    /// per-operation results split into `submitted` and `rejected` lists.
    /// On broker failure, returns a `BROKER_ERROR:{json}` napi error.
    #[napi]
    pub async fn push(&self, uta_id: String) -> napi::Result<PushResultNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;
            let result = handle.push().await.map_err(broker_error_to_napi)?;
            Ok(PushResultNapi {
                hash: result.hash,
                message: result.message,
                operation_count: result.operation_count,
                submitted: result
                    .submitted
                    .into_iter()
                    .map(op_result_to_napi)
                    .collect(),
                rejected: result.rejected.into_iter().map(op_result_to_napi).collect(),
            })
        })
        .await
    }

    /// Reject the pending commit for the given UTA.
    ///
    /// Records a `[rejected]` commit in the git log without invoking the broker.
    /// `reason` is appended to the commit message.
    #[napi]
    pub async fn reject(&self, uta_id: String, reason: String) -> napi::Result<RejectResultNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;
            let result = handle
                .reject(Some(reason))
                .await
                .map_err(broker_error_to_napi)?;
            Ok(RejectResultNapi {
                hash: result.hash,
                message: result.message,
                operation_count: result.operation_count,
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Sync
    // -----------------------------------------------------------------------

    /// Sync external order-status updates into the git log for the given UTA.
    ///
    /// `updates` is a list of order status changes. `current_state_json` is a
    /// JSON-serialized `GitState` snapshot from the broker.
    #[napi]
    pub async fn sync(
        &self,
        uta_id: String,
        updates: Vec<OrderStatusUpdateNapi>,
        current_state_json: String,
    ) -> napi::Result<SyncResultNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;

            // Convert napi update structs to canonical OrderStatusUpdate.
            let canonical_updates: Vec<OrderStatusUpdate> = updates
                .into_iter()
                .map(|u| {
                    let previous_status = operation_status_from_str(&u.previous_status)?;
                    let current_status = operation_status_from_str(&u.current_status)?;
                    Ok(OrderStatusUpdate {
                        order_id: u.order_id,
                        symbol: u.symbol,
                        previous_status,
                        current_status,
                        filled_price: u.filled_price,
                        filled_qty: u.filled_qty,
                    })
                })
                .collect::<napi::Result<Vec<_>>>()?;

            let current_state: GitState = serde_json::from_str(&current_state_json)
                .map_err(|e| json_parse_error_to_napi("current_state_json", e))?;

            let result = handle
                .sync(canonical_updates, current_state)
                .await
                .map_err(broker_error_to_napi)?;

            Ok(SyncResultNapi {
                hash: result.hash,
                updated_count: result.updated_count,
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // State export
    // -----------------------------------------------------------------------

    /// Export the full git state for the given UTA.
    ///
    /// Returns the commit log and HEAD hash as JSON strings (safe for napi
    /// boundary; TS parses from JSON).
    #[napi]
    pub async fn export_state(&self, uta_id: String) -> napi::Result<GitExportStateNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;
            let result = handle.export_state().await.map_err(string_error_to_napi)?;

            let commits_json = serde_json::to_string(&result.commits).map_err(|e| {
                napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("serialize commits: {}", e),
                )
            })?;

            Ok(GitExportStateNapi {
                commits_json,
                head: result.head,
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Health + recovery
    // -----------------------------------------------------------------------

    /// Get the current broker health info for the given UTA.
    #[napi]
    pub async fn get_health(&self, uta_id: String) -> napi::Result<BrokerHealthInfoNapi> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;
            let info = handle.get_health().await.map_err(string_error_to_napi)?;

            let status = match info.status {
                crate::brokers::types::BrokerHealth::Healthy => "healthy",
                crate::brokers::types::BrokerHealth::Unhealthy => "unhealthy",
                crate::brokers::types::BrokerHealth::Offline => "offline",
            }
            .to_string();

            Ok(BrokerHealthInfoNapi {
                status,
                last_check: info.last_check,
                message: info.message,
                consecutive_failures: info.consecutive_failures,
            })
        })
        .await
    }

    /// Nudge the recovery task for the given UTA to retry from attempt 0.
    ///
    /// Fire-and-forget — returns immediately. Useful when the operator knows
    /// the broker is back online and wants to skip the backoff window.
    #[napi]
    pub async fn nudge_recovery(&self, uta_id: String) -> napi::Result<()> {
        let uta_id_for_wrap = uta_id.clone();
        async_catch_unwind_napi(&uta_id_for_wrap, async move {
            let handle = self.handle_for(&uta_id)?;
            handle.nudge_recovery().await.map_err(string_error_to_napi)
        })
        .await
    }
}

// ---------------------------------------------------------------------------
// Unit tests — conversion helpers (no napi runtime required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::OperationStatus;

    #[test]
    fn operation_status_round_trips() {
        let statuses = [
            OperationStatus::Submitted,
            OperationStatus::Filled,
            OperationStatus::Rejected,
            OperationStatus::Cancelled,
            OperationStatus::UserRejected,
        ];
        for s in statuses {
            let encoded = operation_status_to_str(s);
            let decoded = operation_status_from_str(&encoded).unwrap();
            assert_eq!(s, decoded, "round-trip failed for {:?}", s);
        }
    }

    #[test]
    fn operation_status_from_str_rejects_unknown() {
        let result = operation_status_from_str("pending");
        assert!(result.is_err(), "should reject unknown status string");
    }

    #[test]
    fn op_result_to_napi_maps_fields() {
        let r = crate::types::OperationResult {
            action: "placeOrder".to_string(),
            success: true,
            order_id: Some("order-1".to_string()),
            status: OperationStatus::Submitted,
            execution: None,
            order_state: None,
            filled_qty: None,
            filled_price: None,
            error: None,
            raw: None,
        };
        let napi_r = op_result_to_napi(r);
        assert_eq!(napi_r.action, "placeOrder");
        assert!(napi_r.success);
        assert_eq!(napi_r.order_id, Some("order-1".to_string()));
        assert_eq!(napi_r.status, "submitted");
        assert!(napi_r.execution_json.is_none());
    }

    #[test]
    fn op_result_to_napi_serializes_execution() {
        use serde_json::json;
        let r = crate::types::OperationResult {
            action: "placeOrder".to_string(),
            success: true,
            order_id: None,
            status: OperationStatus::Filled,
            execution: Some(json!({"price": "100.5"})),
            order_state: Some(json!({"status": "filled"})),
            filled_qty: Some("10".to_string()),
            filled_price: Some("100.5".to_string()),
            error: None,
            raw: None,
        };
        let napi_r = op_result_to_napi(r);
        assert_eq!(napi_r.status, "filled");
        assert!(napi_r.execution_json.is_some());
        assert!(napi_r.order_state_json.is_some());
        // Verify the JSON is actually parseable
        let exec: serde_json::Value =
            serde_json::from_str(napi_r.execution_json.as_ref().unwrap()).unwrap();
        assert_eq!(exec["price"], "100.5");
    }
}
