# Phase 4e — Broker-execution journal + restart reconciliation

**Status:** approved 2026-05-12.
**Source:** [`docs/RUST_MIGRATION_PLAN.v4.md:979-1078`](../../RUST_MIGRATION_PLAN.v4.md) Phase 4e.

## Resolved decisions

| # | Decision |
|---|----------|
| 1 | **`client_order_ids: Vec<String>`** — one id per operation in the push batch. Explicit > derived; matches Alpaca/Mock natural pattern. |
| 2 | **Mark failed on broker no-match** during reconciliation — emit a sync commit with `OperationStatus::Rejected`. Per v4. |
| 3 | **No retention policy** for `done/` entries in Phase 4e — keep forever. Later phase can add time/count-based pruning. |
| 4 | **Hand-written crash-point tests** covering each step of the 5-step recipe (~5-7 scenarios). Property-based "100 random crashes" deferred. |
| 5 | **Real-broker (Alpaca/IBKR/CCXT) journal integration deferred to post-cutover.** Phase 4e only wires MockBroker in Rust. Real brokers stay TS via FFI proxy (Phase 4f); their journaling is a follow-on. |
| 6 | **Disk-full → `BrokerError(NETWORK)`** (transient, not silently swallowed). Per v4 failure mode. |

## Goal

Close the broker-execution crash window (v4 §6.11). Every broker call wrapped in a 5-step journaled sequence:

1. `journal.record_intent(intent)` — fsync; intent persisted before any network call
2. `broker.placeOrder(...)` — network call
3. `journal.record_completion(handle, result)` — fsync; result persisted before commit log update
4. `trading_git.append_commit(commit)` — atomic commit.json update (Phase 4d)
5. `journal.close(handle)` — move `executing/<hash>.json` → `executing/done/<hash>.json`

On restart, `UtaActor::run` calls `reconcile_journal` which scans `executing/` for incomplete entries and either:
- Queries the broker by `client_order_id` and emits a sync commit reflecting the actual state, OR
- Marks the entry failed (broker has no record) and emits a rejected commit

This addresses a real failure mode in the current TS code (push completes, broker order submitted, commit.json not yet written → crash → restart finds no record of the order). Phase 4e's journal makes this case recoverable instead of silently lost.

Rust crate stays dead code at end of Phase 4e. Phase 4f cutover wires the actor (with journaling) via napi.

## Architecture

New module tree under `crates/alice-trading-core/src/journal/`. Pure Rust — no napi exposure.

```
crates/alice-trading-core/src/journal/
├── mod.rs                  # re-exports
├── types.rs                # ExecutionIntent, ExecutionResult, JournalHandle, JournalEntry, EntryState
├── store.rs                # ExecutionJournal + record_intent/record_completion/close + list_pending
└── reconcile.rs            # reconcile_journal — applied at UtaActor startup
```

Modifies:
- `crates/alice-trading-core/src/brokers/traits.rs` — add `allocate_client_order_id`, `lookup_by_client_order_id` to `Broker` trait
- `crates/alice-trading-core/src/brokers/mock.rs` — implement the two new methods (monotonic counter; lookup against `orders` map)
- `crates/alice-trading-core/src/uta/state.rs` — add `journal: ExecutionJournal` field
- `crates/alice-trading-core/src/uta/actor.rs` — wire 5-step recipe into `handle_push`; call `reconcile_journal` at startup

## Deliverable 1: ExecutionJournal

```rust
// crates/alice-trading-core/src/journal/types.rs

use serde::{Deserialize, Serialize};
use crate::types::{Operation, OperationResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionIntent {
    pub commit_hash: String,            // v2 intent hash from Phase 2 (8-char short hash)
    pub client_order_ids: Vec<String>,  // one per operation; broker-allocated
    pub operations: Vec<Operation>,
    pub started_at: String,             // ISO-8601
    pub broker_id: String,              // e.g., "mock-paper", "alpaca-paper"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub commit_hash: String,
    pub completed_at: String,
    pub results: Vec<OperationResult>,
    pub success: bool,                  // true if all ops succeeded
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
    pub result: Option<ExecutionResult>,
}

#[derive(Debug, Clone)]
pub struct JournalHandle {
    pub commit_hash: String,            // primary key — maps to filename
}
```

```rust
// crates/alice-trading-core/src/journal/store.rs

pub struct ExecutionJournal {
    dir: PathBuf,   // data/trading/<account_id>/executing/
}

impl ExecutionJournal {
    pub fn new(account_id: &str, data_root: &Path) -> Self {
        let dir = data_root.join(format!("trading/{}/executing", account_id));
        Self { dir }
    }

    /// Step 1 of the 5-step recipe: write executing/<commit-hash>.json with state='executing', fsync.
    /// Returns BrokerError(NETWORK) on disk-full or I/O failure.
    pub async fn record_intent(&self, intent: ExecutionIntent) -> Result<JournalHandle, BrokerError>;

    /// Step 3: rewrite executing/<commit-hash>.json with state='completed' | 'failed', fsync.
    pub async fn record_completion(&self, handle: &JournalHandle, result: ExecutionResult) -> Result<(), BrokerError>;

    /// Step 5: move executing/<commit-hash>.json → executing/done/<commit-hash>.json.
    pub async fn close(&self, handle: JournalHandle) -> Result<(), BrokerError>;

    /// Reconciliation helper: list all non-done entries (executing OR completed/failed not yet closed).
    pub async fn list_pending(&self) -> Result<Vec<JournalEntry>, BrokerError>;
}
```

All fs ops use the same atomic-write pattern as Phase 4d's `persist_commit_atomic` (write tmp → fsync → rename) via `tokio::task::spawn_blocking`. Disk-full propagates as `BrokerError(NETWORK)` (transient).

## Deliverable 2: Broker trait extension

```rust
// crates/alice-trading-core/src/brokers/traits.rs

#[async_trait]
pub trait Broker: Send + Sync {
    // ... existing methods ...

    /// Allocate a client-order-id for the next broker call.
    /// IBKR derives from nextValidId; Alpaca uses commit-hash-suffixed; Mock uses monotonic counter.
    fn allocate_client_order_id(&self) -> String;

    /// Look up an order by its client-order-id. Used by restart reconciliation
    /// to determine whether an in-flight order was actually accepted by the broker.
    /// Returns None if no order with that id exists.
    async fn lookup_by_client_order_id(&self, id: &str) -> Result<Option<OpenOrder>, BrokerError>;
}
```

MockBroker impl: `allocate_client_order_id` returns `format!("mock-cli-{}", self.next_order_id.fetch_add(1, ...))`. `lookup_by_client_order_id` scans `state.orders` for an entry whose `order.clientOrderId` matches.

NOTE: The Mock's existing order-id allocation (`mock-1`, `mock-2`, ...) is the BROKER-side order id (returned in `PlaceOrderResult.order_id`). The new `client_order_id` is a SEPARATE id allocated client-side and passed TO the broker. The Mock can use the same monotonic counter for both since it doesn't actually go over a network — or two separate counters for clarity. Choose two separate counters (`next_order_id` and `next_client_order_id`) to avoid coupling.

## Deliverable 3: Wired UtaActor.handle_push

```rust
async fn handle_push(&mut self) -> Result<PushResult, BrokerError> {
    // ... existing disabled/offline checks ...

    // Step 1: record intent
    let client_order_ids: Vec<String> = (0..self.state.git.staging_area_len())
        .map(|_| self.state.broker.allocate_client_order_id())
        .collect();
    let intent = ExecutionIntent {
        commit_hash: pending_hash.clone(),
        client_order_ids: client_order_ids.clone(),
        operations: self.state.git.staging_area().clone(),
        started_at: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        broker_id: self.state.account_id.clone(),
    };
    let handle = self.state.journal.record_intent(intent).await?;

    // Step 2: broker calls (via the existing dispatcher)
    let push_result = self.state.git.push_with_dispatcher(&dispatcher).await
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e))?;

    // Step 3: record completion
    let exec_result = ExecutionResult {
        commit_hash: push_result.hash.clone(),
        completed_at: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        results: push_result.submitted.iter().chain(push_result.rejected.iter()).cloned().collect(),
        success: push_result.rejected.is_empty(),
    };
    self.state.journal.record_completion(&handle, exec_result).await?;

    // Step 4: persist commit
    let export = self.state.git.export_state();
    if let Err(e) = persist_commit_atomic(&self.state.account_id, &export, &self.state.data_root).await {
        tracing::error!(...);
    }

    // Step 5: close journal entry (move to done/)
    self.state.journal.close(handle).await?;

    // Emit event
    if let Some(tx) = &self.state.event_tx {
        let _ = tx.send(UtaEvent::CommitNotify { ... }).await;
    }

    Ok(push_result)
}
```

The `client_order_id` per op needs to be threaded into the broker dispatch — the broker's `place_order` / `modify_order` / `cancel_order` / `close_position` calls need to know the client-allocated id. This requires:
- Phase 4b's Broker trait methods accepting a `client_order_id: &str` parameter, OR
- A separate `with_client_order_id(id, op)` helper that the dispatcher uses to attach the id

Choose the first option (trait extension) for clarity. This is a breaking change to the Broker trait — every impl (currently just MockBroker) needs an update. Real-broker (Alpaca/IBKR/CCXT) impls don't exist in Rust yet; they're TS-only.

NOTE: The existing Phase 4b trait methods (`place_order(&self, contract, order, tpsl)`) don't take a `client_order_id`. The broker today extracts it from `order.clientOrderId` if set. Two approaches:
- **Augment in-place**: set `order.clientOrderId = client_order_id` before calling `place_order`. The broker reads it from order. No trait change.
- **Explicit parameter**: add `client_order_id: &str` to each broker method. Trait change.

The **in-place** approach is less invasive — the Operation enum's `order` field is `serde_json::Value`, so injecting `clientOrderId` is straightforward. The broker reads it as it would from any other field.

Pick **in-place**: simpler, no Broker trait churn beyond `allocate_client_order_id` + `lookup_by_client_order_id`.

## Deliverable 4: Restart reconciliation

```rust
// crates/alice-trading-core/src/journal/reconcile.rs

pub struct ReconciliationOutcome {
    pub commit_hash: String,
    pub action: ReconcileAction,
}

pub enum ReconcileAction {
    AlreadyCommitted,      // entry.state was Completed; commit.json contains this hash → no action
    SyncCommitEmitted,     // broker had the order; emitted sync commit reflecting actual state
    MarkedFailed,          // broker had no record; emitted rejected commit
    Idempotent,            // entry.state was Failed; commit.json contains rejection → no action
}

pub async fn reconcile_journal(
    journal: &ExecutionJournal,
    broker: &Arc<dyn Broker>,
    git: &mut TradingGit,
    account_id: &str,
    data_root: &Path,
) -> Result<Vec<ReconciliationOutcome>, BrokerError> {
    let pending = journal.list_pending().await?;
    let mut outcomes = Vec::new();
    for entry in pending {
        match entry.state {
            EntryState::Executing => {
                // Did the broker accept any of the orders?
                let mut any_found = false;
                for cli_id in &entry.intent.client_order_ids {
                    if broker.lookup_by_client_order_id(cli_id).await?.is_some() {
                        any_found = true;
                        break;
                    }
                }
                if any_found {
                    // Emit a sync commit reflecting current broker state
                    // (per-op status fetched, full update committed via git.sync())
                    // ... (calls git.sync with reconstructed updates)
                    outcomes.push(ReconciliationOutcome {
                        commit_hash: entry.intent.commit_hash.clone(),
                        action: ReconcileAction::SyncCommitEmitted,
                    });
                } else {
                    // Mark as rejected — broker has no record
                    // ... (writes a [reconciled-rejected] commit via git.reject equivalent)
                    outcomes.push(ReconciliationOutcome { ... action: MarkedFailed });
                }
            }
            EntryState::Completed | EntryState::Failed => {
                // Idempotent: check if commit.json contains this hash
                // ... (read commit.json, check)
                outcomes.push(ReconciliationOutcome { ... action: AlreadyCommitted });
            }
        }
        // Always close the entry after handling
        let handle = JournalHandle { commit_hash: entry.intent.commit_hash.clone() };
        journal.close(handle).await?;
    }
    Ok(outcomes)
}
```

The reconciliation logic has subtle edge cases:
- Idempotent re-runs (process crashes during reconciliation itself)
- Partial accept (some orders landed, others didn't): treat the entry as Completed with mixed success/rejected results
- Broker `lookup_by_client_order_id` returns Err: surface the error, halt reconciliation (don't risk inconsistent state)

Plan will tighten these edge cases.

## Deliverable 5: Integration tests

Three integration tests:

### `tests/journal_crash_recovery.rs`

For each of 5 crash points in the 5-step recipe, simulate a crash:
1. After Step 1 (intent recorded, no broker call): journal has 'executing' entry; reconciler queries broker → broker has nothing → mark failed
2. After Step 2 (broker called, no completion record): broker has the order; reconciler queries → finds it → emit sync commit
3. After Step 3 (completion recorded, no commit.json update): commit.json doesn't have the hash; reconciler reads journal completion → idempotently write commit
4. After Step 4 (commit.json updated, journal not closed): commit.json HAS the hash; reconciler observes completion entry → close idempotently
5. After Step 5 (journal entry closed): no pending entries; reconciler returns empty outcomes

Each test:
- Setup: MockBroker + temp data_root + UtaActor
- Drive: stage + commit + push, but inject the crash at the specified step
- Restart: spawn fresh UtaActor (loads from disk + runs reconcile_journal)
- Assert: outcomes vector contains the expected `ReconcileAction`; commit.json reflects correct state; no duplicate orders

### `tests/journal_disk_full.rs`

Simulate `EACCES` / `ENOSPC` via a read-only directory or quota'd tempfile. Assert `BrokerError(NETWORK)` is returned (not Unknown, not silently swallowed).

### `tests/journal_lifecycle.rs`

Unit tests on ExecutionJournal: record_intent + record_completion + close round-trip, list_pending semantics, atomic-write tmp cleanup.

## Files

**New Rust:**
- `crates/alice-trading-core/src/journal/mod.rs` (~30 lines)
- `crates/alice-trading-core/src/journal/types.rs` (~80 lines)
- `crates/alice-trading-core/src/journal/store.rs` (~200 lines)
- `crates/alice-trading-core/src/journal/reconcile.rs` (~150 lines)
- `crates/alice-trading-core/tests/journal_lifecycle.rs` (~150 lines)
- `crates/alice-trading-core/tests/journal_crash_recovery.rs` (~250 lines)
- `crates/alice-trading-core/tests/journal_disk_full.rs` (~60 lines)

**Modify Rust:**
- `crates/alice-trading-core/src/lib.rs` (add `pub mod journal;`)
- `crates/alice-trading-core/src/brokers/traits.rs` (add `allocate_client_order_id` + `lookup_by_client_order_id`)
- `crates/alice-trading-core/src/brokers/mock.rs` (implement the two new methods)
- `crates/alice-trading-core/src/uta/state.rs` (add `journal: ExecutionJournal` field; restore_or_new builds it)
- `crates/alice-trading-core/src/uta/actor.rs` (wire 5-step recipe into handle_push; call reconcile_journal at startup)

## DoD

```bash
cargo test -p alice-trading-core journal::
cargo test -p alice-trading-core --test journal_lifecycle
cargo test -p alice-trading-core --test journal_crash_recovery
cargo test -p alice-trading-core --test journal_disk_full
cargo clippy -p alice-trading-core --all-targets -- -D warnings
cargo fmt -p alice-trading-core --check
pnpm test                                          # 2244 TS tests unchanged
```

## Cutover gate

- All 5 crash-point scenarios produce coherent commit.json + zero duplicate orders + zero lost commits
- Disk-full propagates as `BrokerError(NETWORK)`
- Restart reconciliation idempotent — running it twice produces identical outcomes
- Existing tests unchanged (cargo + TS)
- Rust crate is dead code (Phase 4f wires it)

## Rollback

`git revert` Phase 4e commits. Rust crate is dead code — no live consumer until Phase 4f. The journal directory `data/trading/<acct>/executing/` is unused by current TS code; reverting leaves it empty.

## Estimated effort

6-8 eng-days (per v4):
- Day 1-2: ExecutionJournal types + store (record_intent / completion / close / list_pending) + lifecycle unit tests
- Day 3: Broker trait extension + MockBroker impl
- Day 4: Wire UtaActor.handle_push through the 5-step recipe + journal field on UtaState
- Day 5-6: reconcile_journal + 5 crash-recovery integration tests
- Day 7: disk-full test + edge cases + clippy/fmt polish

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Partial accept (3/5 orders land, 2 fail) edge case in reconciliation | Medium | High | Reconciler queries EACH client_order_id; if mixed, emit a sync commit reflecting per-order status |
| Idempotency on reconciler re-run | Medium | High | Reconciler checks commit.json BEFORE acting; if hash already present, no-op + close journal entry |
| Disk-full during journal write → silent push hang | Medium | High | All journal fs ops return Result; disk-full mapped to `BrokerError(NETWORK)`; integration test |
| Order of operations subtly wrong (e.g., record_completion before commit.json) | Low | High | 5-step recipe documented inline; integration tests exercise each crash point |
| MockBroker.lookup_by_client_order_id returns stale data | Low | Medium | Lookup uses a fresh read of state.orders; integration test verifies after partial completion |
| Journal entry filename collision (two pushes with same intent hash) | Very Low | Critical | Phase 2's v2 hash is content-addressed — collision would require SHA-256 break. Acceptable risk. |

## Out of scope

- **Real-broker journal integration** (Alpaca/IBKR/CCXT). Their journaling is a follow-on after Phase 4f.
- **Pruning policy for `done/` entries.** Phase 4e keeps forever.
- **100-random-crash property test.** Hand-written crash-point tests suffice.
- **napi exposure of the journal.** Phase 4f.
- **Real-time replay** (e.g., live monitoring of executing/ for debug). Not needed for restart correctness.
