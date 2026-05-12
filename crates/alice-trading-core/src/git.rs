//! TradingGit — Rust port of `src/domain/trading/git/TradingGit.ts`.
//!
//! Phase 3 ships only the state-machine + v2 hash logic. Broker callbacks
//! (`executeOperation`, `getGitState`, `onCommit`) are abstracted via the
//! [`TradingGitConfig`] struct — Phase 3 stubs them, Phase 4d wires real
//! brokers via napi.
//!
//! Critical invariants — see plan doc Task C section.
//! 1. v1 commits emitted by the v1 fallback path have NO `hashVersion` field.
//! 2. For v2 commits: `commit.timestamp == commit.hashInputTimestamp`.
//! 3. `pendingV2` cleared at end of `push()` AND `reject()`.
//! 4. `sync()` does NOT touch `pendingV2`.
//! 5. `reject()` recomputes the v2 hash with the FINAL `[rejected]` message.

use crate::hash_v2::{generate_intent_hash_v2, HashV2Input};
use crate::types::*;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;

/// Closure type executing a single operation against the broker.
pub type ExecuteOperationFn = Box<dyn Fn(&Operation) -> OperationResult + Send + Sync>;
/// Closure type producing the current GitState snapshot from the broker.
pub type GetGitStateFn = Box<dyn Fn() -> GitState + Send + Sync>;
/// Closure type invoked after each commit is persisted.
pub type OnCommitFn = Box<dyn Fn(&GitExportState) + Send + Sync>;

/// Configuration handed to TradingGit. In Phase 3, broker callbacks are
/// `Box<dyn Fn>` so tests can stub them; Phase 4d wires real brokers via napi.
pub struct TradingGitConfig {
    pub execute_operation: ExecuteOperationFn,
    pub get_git_state: GetGitStateFn,
    pub on_commit: Option<OnCommitFn>,
    /// 1 or 2; defaults to 2.
    pub hash_version: u8,
}

impl TradingGitConfig {
    /// Convenience: synthetic config for tests.
    pub fn stub() -> Self {
        Self {
            execute_operation: Box::new(|op| OperationResult {
                action: op.action_name().to_string(),
                success: true,
                order_id: Some("stub-order-1".to_string()),
                status: OperationStatus::Submitted,
                execution: None,
                order_state: None,
                filled_qty: None,
                filled_price: None,
                error: None,
                raw: None,
            }),
            get_git_state: Box::new(stub_state),
            on_commit: None,
            hash_version: 2,
        }
    }
}

fn stub_state() -> GitState {
    GitState {
        net_liquidation: "100000".to_string(),
        total_cash_value: "100000".to_string(),
        unrealized_pn_l: "0".to_string(),
        realized_pn_l: "0".to_string(),
        positions: vec![],
        pending_orders: vec![],
    }
}

#[derive(Clone)]
struct PendingV2 {
    hash_input_timestamp: String,
    intent_full_hash: String,
}

pub struct TradingGit {
    config: TradingGitConfig,
    staging_area: Vec<Operation>,
    pending_message: Option<String>,
    pending_hash: Option<CommitHash>,
    pending_v2: Option<PendingV2>,
    commits: Vec<GitCommit>,
    head: Option<CommitHash>,
    current_round: Option<u32>,
}

impl TradingGit {
    pub fn new(config: TradingGitConfig) -> Self {
        Self {
            config,
            staging_area: vec![],
            pending_message: None,
            pending_hash: None,
            pending_v2: None,
            commits: vec![],
            head: None,
            current_round: None,
        }
    }

    pub fn add(&mut self, operation: Operation) -> AddResult {
        let index = self.staging_area.len() as u32;
        self.staging_area.push(operation.clone());
        AddResult {
            staged: true,
            index,
            operation,
        }
    }

    pub fn commit(&mut self, message: String) -> Result<CommitPrepareResult, String> {
        if self.staging_area.is_empty() {
            return Err("Nothing to commit: staging area is empty".to_string());
        }

        let hash_input_timestamp = now_iso();
        let staging_json: Vec<Value> = self
            .staging_area
            .iter()
            .map(|op| serde_json::to_value(op).expect("serialize op"))
            .collect();

        let (pending_hash, pending_v2) = if self.config.hash_version == 2 {
            let out = generate_intent_hash_v2(HashV2Input {
                parent_hash: self.head.as_deref(),
                message: &message,
                operations: &staging_json,
                hash_input_timestamp: &hash_input_timestamp,
            });
            (
                out.short_hash,
                Some(PendingV2 {
                    hash_input_timestamp: hash_input_timestamp.clone(),
                    intent_full_hash: out.intent_full_hash,
                }),
            )
        } else {
            // v1 fallback — see TS lines 71-76: SHA-256 of
            // JSON.stringify({message, operations, timestamp, parentHash}).slice(0,8)
            (
                v1_hash(
                    &message,
                    &staging_json,
                    &hash_input_timestamp,
                    self.head.as_deref(),
                ),
                None,
            )
        };

        self.pending_hash = Some(pending_hash.clone());
        self.pending_message = Some(message.clone());
        self.pending_v2 = pending_v2;

        Ok(CommitPrepareResult {
            prepared: true,
            hash: pending_hash,
            message,
            operation_count: self.staging_area.len() as u32,
        })
    }

    pub fn push(&mut self) -> Result<PushResult, String> {
        let (operations, pending_message, pending_hash) = self.prepare_push()?;
        let mut results = Vec::with_capacity(operations.len());
        for op in &operations {
            results.push((self.config.execute_operation)(op));
        }
        Ok(self.finalize_push_commit(operations, results, pending_message, pending_hash))
    }

    /// Shared prep: validates staging + extracts pending_message/pending_hash.
    /// Used by both `push` and `push_with_dispatcher`.
    fn prepare_push(&self) -> Result<(Vec<Operation>, String, String), String> {
        if self.staging_area.is_empty() {
            return Err("Nothing to push: staging area is empty".to_string());
        }
        let pending_message = self
            .pending_message
            .clone()
            .ok_or("Nothing to push: please commit first")?;
        let pending_hash = self
            .pending_hash
            .clone()
            .ok_or("Nothing to push: please commit first")?;
        Ok((self.staging_area.clone(), pending_message, pending_hash))
    }

    /// Shared finalization: build GitCommit, push to log, fire on_commit,
    /// clear pending state, return PushResult. Used by both `push` (sync)
    /// and `push_with_dispatcher` (async).
    fn finalize_push_commit(
        &mut self,
        operations: Vec<Operation>,
        results: Vec<OperationResult>,
        pending_message: String,
        pending_hash: String,
    ) -> PushResult {
        let state_after = (self.config.get_git_state)();

        // INVARIANT 2: timestamp == hash_input_timestamp for v2 commits.
        let timestamp = self
            .pending_v2
            .as_ref()
            .map(|v| v.hash_input_timestamp.clone())
            .unwrap_or_else(now_iso);

        let commit = GitCommit {
            hash: pending_hash.clone(),
            parent_hash: self.head.clone(),
            message: pending_message.clone(),
            operations: operations.clone(),
            results: results.clone(),
            state_after,
            timestamp,
            round: self.current_round,
            // INVARIANT 1: hash_version is None when v1 path → field absent in JSON.
            hash_version: self.pending_v2.as_ref().map(|_| 2),
            intent_full_hash: self.pending_v2.as_ref().map(|v| v.intent_full_hash.clone()),
            hash_input_timestamp: self
                .pending_v2
                .as_ref()
                .map(|v| v.hash_input_timestamp.clone()),
            entry_hash_version: None,
            entry_full_hash: None,
        };

        self.commits.push(commit);
        self.head = Some(pending_hash.clone());

        if let Some(cb) = &self.config.on_commit {
            cb(&self.export_state());
        }

        // INVARIANT 3: clear pending state at end of push().
        self.staging_area.clear();
        self.pending_message = None;
        self.pending_hash = None;
        self.pending_v2 = None;

        let submitted = results.iter().filter(|r| r.success).cloned().collect();
        let rejected = results.iter().filter(|r| !r.success).cloned().collect();

        PushResult {
            hash: pending_hash,
            message: pending_message,
            operation_count: operations.len() as u32,
            submitted,
            rejected,
        }
    }

    /// Async push variant — accepts an async dispatcher closure that returns a
    /// raw broker payload (`serde_json::Value`) per operation. Mirrors the TS
    /// `push()` flow (`TradingGit.ts:108-172`): execute each op, parse the
    /// result with the IBKR-style status mapping, build the commit, fire
    /// `on_commit`, clear staging.
    ///
    /// Phase 4d Task D — used by `UtaActor` so async broker calls compose with
    /// the existing v2-hash machinery without forcing the sync
    /// `execute_operation` callback to become async.
    ///
    /// The dispatcher returns `Result<Value, String>` so it can be backed by
    /// any error type — `UtaActor` adapts `BrokerError` via `Display`.
    pub async fn push_with_dispatcher<F>(&mut self, dispatcher: &F) -> Result<PushResult, String>
    where
        F: Fn(&Operation) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Sync,
    {
        let (operations, pending_message, pending_hash) = self.prepare_push()?;
        let mut results: Vec<OperationResult> = Vec::with_capacity(operations.len());
        for op in &operations {
            match dispatcher(op).await {
                Ok(raw) => results.push(parse_broker_payload(op, raw)),
                Err(err) => results.push(OperationResult {
                    action: op.action_name().to_string(),
                    success: false,
                    order_id: None,
                    status: OperationStatus::Rejected,
                    execution: None,
                    order_state: None,
                    filled_qty: None,
                    filled_price: None,
                    error: Some(err),
                    raw: None,
                }),
            }
        }
        Ok(self.finalize_push_commit(operations, results, pending_message, pending_hash))
    }

    pub fn reject(&mut self, reason: Option<String>) -> Result<RejectResult, String> {
        if self.staging_area.is_empty() {
            return Err("Nothing to reject: staging area is empty".to_string());
        }
        let pending_message_orig = self
            .pending_message
            .clone()
            .ok_or("Nothing to reject: please commit first")?;
        let pending_hash = self
            .pending_hash
            .clone()
            .ok_or("Nothing to reject: please commit first")?;

        let operations = self.staging_area.clone();
        let final_message = match &reason {
            Some(r) => format!("[rejected] {} — {}", pending_message_orig, r),
            None => format!("[rejected] {}", pending_message_orig),
        };
        let results: Vec<OperationResult> = operations
            .iter()
            .map(|op| OperationResult {
                action: op.action_name().to_string(),
                success: false,
                order_id: None,
                status: OperationStatus::UserRejected,
                execution: None,
                order_state: None,
                filled_qty: None,
                filled_price: None,
                error: Some(
                    reason
                        .clone()
                        .unwrap_or_else(|| "Rejected by user".to_string()),
                ),
                raw: None,
            })
            .collect();
        let state_after = (self.config.get_git_state)();

        // INVARIANT 5: recompute v2 hash with FINAL [rejected] message.
        let (final_hash, v2_fields) = match (self.config.hash_version, &self.pending_v2) {
            (2, Some(pv2)) => {
                let staging_json: Vec<Value> = operations
                    .iter()
                    .map(|op| serde_json::to_value(op).expect("serialize op"))
                    .collect();
                let out = generate_intent_hash_v2(HashV2Input {
                    parent_hash: self.head.as_deref(),
                    message: &final_message,
                    operations: &staging_json,
                    hash_input_timestamp: &pv2.hash_input_timestamp,
                });
                (
                    out.short_hash,
                    Some((out.intent_full_hash, pv2.hash_input_timestamp.clone())),
                )
            }
            _ => (pending_hash, None),
        };

        // INVARIANT 2: for v2, commit.timestamp == hash_input_timestamp.
        let timestamp = v2_fields
            .as_ref()
            .map(|(_, t)| t.clone())
            .unwrap_or_else(now_iso);

        let commit = GitCommit {
            hash: final_hash.clone(),
            parent_hash: self.head.clone(),
            message: final_message.clone(),
            operations: operations.clone(),
            results,
            state_after,
            timestamp,
            round: self.current_round,
            hash_version: v2_fields.as_ref().map(|_| 2),
            intent_full_hash: v2_fields.as_ref().map(|(h, _)| h.clone()),
            hash_input_timestamp: v2_fields.as_ref().map(|(_, t)| t.clone()),
            entry_hash_version: None,
            entry_full_hash: None,
        };

        self.commits.push(commit);
        self.head = Some(final_hash.clone());
        if let Some(cb) = &self.config.on_commit {
            cb(&self.export_state());
        }

        // INVARIANT 3: clear pending state at end of reject().
        self.staging_area.clear();
        self.pending_message = None;
        self.pending_hash = None;
        self.pending_v2 = None;

        Ok(RejectResult {
            hash: final_hash,
            message: final_message,
            operation_count: operations.len() as u32,
        })
    }

    pub fn sync(
        &mut self,
        updates: Vec<OrderStatusUpdate>,
        current_state: GitState,
    ) -> Result<SyncResult, String> {
        if updates.is_empty() {
            return Ok(SyncResult {
                hash: self.head.clone().unwrap_or_default(),
                updated_count: 0,
                updates: vec![],
            });
        }

        // INVARIANT 4: sync does NOT touch self.pending_v2.
        let hash_input_timestamp = now_iso();
        let message = format!("[sync] {} order(s) updated", updates.len());
        let operations = vec![Operation::SyncOrders];
        let results: Vec<OperationResult> = updates
            .iter()
            .map(|u| OperationResult {
                action: "syncOrders".to_string(),
                success: true,
                order_id: Some(u.order_id.clone()),
                status: u.current_status,
                execution: None,
                order_state: None,
                filled_qty: u.filled_qty.clone(),
                filled_price: u.filled_price.clone(),
                error: None,
                raw: None,
            })
            .collect();

        let staging_json: Vec<Value> = operations
            .iter()
            .map(|op| serde_json::to_value(op).expect("serialize op"))
            .collect();

        let (hash, v2_fields) = if self.config.hash_version == 2 {
            let out = generate_intent_hash_v2(HashV2Input {
                parent_hash: self.head.as_deref(),
                message: &message,
                operations: &staging_json,
                hash_input_timestamp: &hash_input_timestamp,
            });
            (out.short_hash, Some(out.intent_full_hash))
        } else {
            // v1 fallback for sync — TS lines 323-327 hashes
            // {updates, timestamp, parentHash} (NOT same as commit's v1 input).
            (
                v1_sync_hash(&updates, &hash_input_timestamp, self.head.as_deref()),
                None,
            )
        };

        let is_v2 = v2_fields.is_some();
        let commit = GitCommit {
            hash: hash.clone(),
            parent_hash: self.head.clone(),
            message,
            operations,
            results,
            state_after: current_state,
            timestamp: hash_input_timestamp.clone(),
            round: self.current_round,
            hash_version: if is_v2 { Some(2) } else { None },
            intent_full_hash: v2_fields,
            hash_input_timestamp: if is_v2 {
                Some(hash_input_timestamp)
            } else {
                None
            },
            entry_hash_version: None,
            entry_full_hash: None,
        };

        self.commits.push(commit);
        self.head = Some(hash.clone());
        if let Some(cb) = &self.config.on_commit {
            cb(&self.export_state());
        }

        Ok(SyncResult {
            hash,
            updated_count: updates.len() as u32,
            updates,
        })
    }

    pub fn show(&self, hash: &str) -> Option<GitCommit> {
        self.commits.iter().find(|c| c.hash == hash).cloned()
    }

    pub fn status(&self) -> GitStatus {
        GitStatus {
            staged: self.staging_area.clone(),
            pending_message: self.pending_message.clone(),
            pending_hash: self.pending_hash.clone(),
            head: self.head.clone(),
            commit_count: self.commits.len() as u32,
        }
    }

    pub fn log(&self, limit: Option<u32>) -> Vec<CommitLogEntry> {
        let limit = limit.unwrap_or(10) as usize;
        self.commits
            .iter()
            .rev()
            .take(limit)
            .map(|c| CommitLogEntry {
                hash: c.hash.clone(),
                parent_hash: c.parent_hash.clone(),
                message: c.message.clone(),
                timestamp: c.timestamp.clone(),
                round: c.round,
                // CommitLogEntry summaries are TS-display-layer concern;
                // Phase 3 stubs as empty per plan.
                operations: vec![],
            })
            .collect()
    }

    pub fn export_state(&self) -> GitExportState {
        GitExportState {
            commits: self.commits.clone(),
            head: self.head.clone(),
        }
    }

    pub fn restore(state: GitExportState, config: TradingGitConfig) -> Self {
        let mut g = Self::new(config);
        g.commits = state.commits;
        g.head = state.head;
        g
    }

    pub fn set_current_round(&mut self, round: u32) {
        self.current_round = Some(round);
    }

    /// Return the pending commit hash (set by `commit()`, cleared by `push()` / `reject()`).
    pub fn pending_hash(&self) -> Option<String> {
        self.pending_hash.clone()
    }

    /// Read-only view of the staging area.
    pub fn staging_area(&self) -> &[Operation] {
        &self.staging_area
    }

    /// Replace the staging area with a new set of operations (used by Phase 4e
    /// to inject `clientOrderId` into `PlaceOrder` ops before `push_with_dispatcher`).
    pub fn replace_staging_area(&mut self, ops: Vec<Operation>) {
        self.staging_area = ops;
    }

    /// Get pending order IDs — mirrors TS `getPendingOrderIds`.
    pub fn get_pending_order_ids(&self) -> Vec<(String, String)> {
        use std::collections::{HashMap, HashSet};

        // Walk newest→oldest to find latest known status per orderId.
        let mut order_status: HashMap<String, OperationStatus> = HashMap::new();
        for c in self.commits.iter().rev() {
            for r in &c.results {
                if let Some(oid) = &r.order_id {
                    order_status.entry(oid.clone()).or_insert(r.status);
                }
            }
        }

        // Collect orders still pending (status = submitted), preserving first-seen order.
        let mut pending: Vec<(String, String)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for c in &self.commits {
            for (j, r) in c.results.iter().enumerate() {
                if let Some(oid) = &r.order_id {
                    if !seen.contains(oid)
                        && order_status.get(oid).copied() == Some(OperationStatus::Submitted)
                    {
                        let symbol = c
                            .operations
                            .get(j)
                            .map(operation_symbol)
                            .unwrap_or_else(|| "unknown".to_string());
                        pending.push((oid.clone(), symbol));
                        seen.insert(oid.clone());
                    }
                }
            }
        }
        pending
    }
}

/// Parse a raw broker payload (`PlaceOrderResult`-shaped JSON) into the
/// commit-log `OperationResult`. Mirrors TS `parseOperationResult` +
/// `mapOrderStatus` (`TradingGit.ts:621-667`).
fn parse_broker_payload(op: &Operation, raw: Value) -> OperationResult {
    let action = op.action_name().to_string();
    if !raw.is_object() {
        return OperationResult {
            action,
            success: false,
            order_id: None,
            status: OperationStatus::Rejected,
            execution: None,
            order_state: None,
            filled_qty: None,
            filled_price: None,
            error: Some("Invalid response from trading engine".to_string()),
            raw: Some(raw),
        };
    }
    let success = raw
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !success {
        let err = raw
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error")
            .to_string();
        return OperationResult {
            action,
            success: false,
            order_id: None,
            status: OperationStatus::Rejected,
            execution: None,
            order_state: None,
            filled_qty: None,
            filled_price: None,
            error: Some(err),
            raw: Some(raw),
        };
    }

    let order_id = raw
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let order_state = raw.get("orderState").cloned();
    let execution = raw.get("execution").cloned();
    let status = map_order_status(order_state.as_ref());

    OperationResult {
        action,
        success: true,
        order_id,
        status,
        execution,
        order_state,
        filled_qty: None,
        filled_price: None,
        error: None,
        raw: Some(raw),
    }
}

/// Map IBKR-style `OrderState.status` → `OperationStatus`.
/// Mirrors TS `mapOrderStatus` (`TradingGit.ts:660-667`).
fn map_order_status(order_state: Option<&Value>) -> OperationStatus {
    let status = order_state
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str());
    match status {
        Some("Filled") => OperationStatus::Filled,
        Some("Cancelled") => OperationStatus::Cancelled,
        Some("Inactive") => OperationStatus::Rejected,
        _ => OperationStatus::Submitted,
    }
}

/// Mirrors TS `getOperationSymbol`.
fn operation_symbol(op: &Operation) -> String {
    fn extract(v: &Value) -> Option<String> {
        let symbol = v
            .get("symbol")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty());
        if let Some(s) = symbol {
            return Some(s.to_string());
        }
        v.get("aliceId")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
    }
    match op {
        Operation::PlaceOrder { contract, .. } | Operation::ClosePosition { contract, .. } => {
            extract(contract).unwrap_or_else(|| "unknown".to_string())
        }
        _ => "unknown".to_string(),
    }
}

/// ISO-8601 timestamp matching `new Date().toISOString()` — millisecond precision,
/// `Z` suffix.
fn now_iso() -> String {
    use chrono::{SecondsFormat, Utc};
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// v1 commit hash — mirrors TS lines 71-76:
/// `SHA-256(JSON.stringify({message, operations, timestamp, parentHash})).slice(0, 8)`.
fn v1_hash(message: &str, ops: &[Value], timestamp: &str, parent: Option<&str>) -> CommitHash {
    use sha2::{Digest, Sha256};
    let body = json!({
        "message": message,
        "operations": ops,
        "timestamp": timestamp,
        "parentHash": parent,
    });
    let s = serde_json::to_string(&body).unwrap();
    let h = hex::encode(Sha256::digest(s.as_bytes()));
    h[..8].to_string()
}

/// v1 sync hash — mirrors TS lines 323-327:
/// `SHA-256(JSON.stringify({updates, timestamp, parentHash})).slice(0, 8)`.
fn v1_sync_hash(
    updates: &[OrderStatusUpdate],
    timestamp: &str,
    parent: Option<&str>,
) -> CommitHash {
    use sha2::{Digest, Sha256};
    let body = json!({
        "updates": updates,
        "timestamp": timestamp,
        "parentHash": parent,
    });
    let s = serde_json::to_string(&body).unwrap();
    let h = hex::encode(Sha256::digest(s.as_bytes()));
    h[..8].to_string()
}
