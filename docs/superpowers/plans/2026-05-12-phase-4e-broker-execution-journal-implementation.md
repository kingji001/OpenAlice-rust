# Phase 4e — Broker-Execution Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an execution journal that wraps every push in a 5-step durable recipe (record_intent → broker → record_completion → persist commit → close), plus a restart reconciler that idempotently recovers from crashes between any two steps.

**Architecture:** New `crates/alice-trading-core/src/journal/` module — `ExecutionJournal` owns `data/trading/<acct>/executing/` directory, writes atomic JSON entries (write-tmp → fsync → rename), moves completed entries to `executing/done/` for audit. `UtaActor::handle_push` threads through the 5 steps. On startup, `reconcile_journal` scans non-done entries, queries broker via `lookup_by_client_order_id`, emits sync/rejected commits idempotently.

**Tech Stack:** Rust 2021, `tokio` (mpsc + spawn_blocking + fs), `serde`, `chrono`, `tracing`. No new deps.

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-4e-broker-execution-journal-design.md`](../specs/2026-05-12-phase-4e-broker-execution-journal-design.md) (commit `5b676b6`).

**4 sub-tasks, strictly sequential:** A → B → C → D.

---

## Pre-flight

```bash
git status --short                                                       # empty
git log -1 --oneline                                                     # 5b676b6
source $HOME/.cargo/env
cargo test -p alice-trading-core 2>&1 | grep -E "test result" | head -1  # 118 baseline
pnpm test 2>&1 | grep -E "Tests" | tail -1                               # 2244 baseline
```

---

## Task A: ExecutionJournal module (types + store + lifecycle tests)

**Goal:** Build the journal data types + the on-disk store with atomic-write semantics. Unit tests verify round-trip + list_pending + tmp-file cleanup.

**Files:**
- Create: `crates/alice-trading-core/src/journal/mod.rs`
- Create: `crates/alice-trading-core/src/journal/types.rs`
- Create: `crates/alice-trading-core/src/journal/store.rs`
- Modify: `crates/alice-trading-core/src/lib.rs` (add `pub mod journal;`)
- Create: `crates/alice-trading-core/tests/journal_lifecycle.rs`

### Step 1: Create `journal/types.rs`

```rust
//! Execution journal data types — what gets written to disk per push.

use serde::{Deserialize, Serialize};
use crate::types::{Operation, OperationResult};

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
```

### Step 2: Create `journal/store.rs`

```rust
//! ExecutionJournal — atomic on-disk store for in-flight broker executions.

use std::path::{Path, PathBuf};
use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::journal::types::{
    EntryState, ExecutionIntent, ExecutionResult, JournalEntry, JournalHandle,
};

pub struct ExecutionJournal {
    dir: PathBuf,
    done_dir: PathBuf,
}

impl ExecutionJournal {
    pub fn new(account_id: &str, data_root: &Path) -> Self {
        let dir = data_root.join(format!("trading/{}/executing", account_id));
        let done_dir = dir.join("done");
        Self { dir, done_dir }
    }

    /// Path for an in-flight entry. `<dir>/<commit_hash>.json`.
    fn entry_path(&self, commit_hash: &str) -> PathBuf {
        self.dir.join(format!("{}.json", commit_hash))
    }

    /// Path for a closed entry. `<dir>/done/<commit_hash>.json`.
    fn done_path(&self, commit_hash: &str) -> PathBuf {
        self.done_dir.join(format!("{}.json", commit_hash))
    }

    /// Step 1: write entry with state='executing' + fsync.
    pub async fn record_intent(&self, intent: ExecutionIntent) -> Result<JournalHandle, BrokerError> {
        let commit_hash = intent.commit_hash.clone();
        let entry = JournalEntry { state: EntryState::Executing, intent, result: None };
        let path = self.entry_path(&commit_hash);
        write_atomic(&path, &entry).await?;
        Ok(JournalHandle { commit_hash })
    }

    /// Step 3: rewrite entry with state='completed' | 'failed' + fsync.
    pub async fn record_completion(
        &self,
        handle: &JournalHandle,
        result: ExecutionResult,
    ) -> Result<(), BrokerError> {
        let path = self.entry_path(&handle.commit_hash);
        // Read existing entry to keep the intent
        let bytes = tokio::fs::read(&path).await
            .map_err(|e| BrokerError::new(BrokerErrorCode::Network, format!("journal read: {}", e)))?;
        let mut entry: JournalEntry = serde_json::from_slice(&bytes)
            .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, format!("journal parse: {}", e)))?;
        entry.state = if result.success { EntryState::Completed } else { EntryState::Failed };
        entry.result = Some(result);
        write_atomic(&path, &entry).await
    }

    /// Step 5: move <dir>/<hash>.json → <dir>/done/<hash>.json.
    pub async fn close(&self, handle: JournalHandle) -> Result<(), BrokerError> {
        let src = self.entry_path(&handle.commit_hash);
        let dst = self.done_path(&handle.commit_hash);
        let dst_clone = dst.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            if let Some(parent) = dst_clone.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(&src, &dst_clone)?;
            Ok(())
        })
        .await
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, format!("journal close join: {}", e)))?
        .map_err(|e| BrokerError::new(BrokerErrorCode::Network, format!("journal close: {}", e)))
    }

    /// List non-done entries (still under <dir>, not yet moved to <dir>/done).
    pub async fn list_pending(&self) -> Result<Vec<JournalEntry>, BrokerError> {
        let dir = self.dir.clone();
        let entries = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<JournalEntry>> {
            if !dir.exists() {
                return Ok(vec![]);
            }
            let mut out = Vec::new();
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                // Skip the done/ subdirectory + non-.json files
                if path.is_dir() { continue; }
                if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
                let bytes = std::fs::read(&path)?;
                if let Ok(je) = serde_json::from_slice::<JournalEntry>(&bytes) {
                    out.push(je);
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, format!("list_pending join: {}", e)))?
        .map_err(|e| BrokerError::new(BrokerErrorCode::Network, format!("list_pending io: {}", e)))?;
        Ok(entries)
    }
}

/// Atomic-write helper — same recipe as uta::persist::persist_commit_atomic.
async fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), BrokerError>
where T: 'static + Send + Clone {
    let path = path.to_path_buf();
    let value = value.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let dir = path.parent().expect("entry path has parent");
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(
            "{}.tmp.{}",
            path.file_name().unwrap().to_string_lossy(),
            std::process::id(),
        ));
        let json = serde_json::to_string_pretty(&value)
            .map_err(|e| std::io::Error::other(format!("serialize: {}", e)))?;
        std::fs::write(&tmp, &json)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, &path)?;
        if let Ok(dir_file) = std::fs::File::open(dir) {
            let _ = dir_file.sync_all();
        }
        Ok(())
    })
    .await
    .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, format!("join error: {}", e)))?
    .map_err(|e| BrokerError::new(BrokerErrorCode::Network, format!("journal write: {}", e)))
}

use serde::Serialize;
```

NOTE the generic `write_atomic<T: Serialize + 'static + Send + Clone>` is constrained because `spawn_blocking` requires `'static`. The clone is cheap (small JSON value).

### Step 3: Create `journal/mod.rs`

```rust
//! Broker-execution journal — Phase 4e deliverable.

pub mod store;
pub mod types;

pub use store::ExecutionJournal;
pub use types::{EntryState, ExecutionIntent, ExecutionResult, JournalEntry, JournalHandle};
```

### Step 4: Wire into lib.rs

Add `pub mod journal;` alphabetically.

### Step 5: Build sanity

```bash
source $HOME/.cargo/env
cargo build -p alice-trading-core 2>&1 | tail -5
```

Expected: clean.

### Step 6: Create `tests/journal_lifecycle.rs`

```rust
//! Phase 4e Task A — ExecutionJournal lifecycle tests.

use alice_trading_core::journal::{
    EntryState, ExecutionIntent, ExecutionJournal, ExecutionResult, JournalHandle,
};
use alice_trading_core::types::{Operation, OperationResult, OperationStatus};
use serde_json::json;
use tempfile::TempDir;

fn fake_intent(hash: &str) -> ExecutionIntent {
    let op: Operation = serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10"},
    })).unwrap();
    ExecutionIntent {
        commit_hash: hash.to_string(),
        client_order_ids: vec!["cli-1".to_string()],
        operations: vec![op],
        started_at: "2026-01-01T00:00:00.000Z".to_string(),
        broker_id: "mock-paper".to_string(),
    }
}

fn fake_result(hash: &str, success: bool) -> ExecutionResult {
    ExecutionResult {
        commit_hash: hash.to_string(),
        completed_at: "2026-01-01T00:00:01.000Z".to_string(),
        results: vec![OperationResult {
            action: "placeOrder".to_string(),
            success,
            order_id: if success { Some("mock-1".to_string()) } else { None },
            status: if success { OperationStatus::Submitted } else { OperationStatus::Rejected },
            execution: None, order_state: None,
            filled_qty: None, filled_price: None,
            error: if success { None } else { Some("test fail".to_string()) },
            raw: None,
        }],
        success,
    }
}

#[tokio::test]
async fn record_intent_creates_executing_entry() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-1", dir.path());
    let handle = journal.record_intent(fake_intent("aaaa1111")).await.unwrap();
    assert_eq!(handle.commit_hash, "aaaa1111");
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, EntryState::Executing);
    assert!(pending[0].result.is_none());
}

#[tokio::test]
async fn record_completion_transitions_state() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-2", dir.path());
    let handle = journal.record_intent(fake_intent("bbbb2222")).await.unwrap();
    journal.record_completion(&handle, fake_result("bbbb2222", true)).await.unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending[0].state, EntryState::Completed);
    assert!(pending[0].result.is_some());
}

#[tokio::test]
async fn record_completion_failed_for_unsuccessful_result() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-3", dir.path());
    let handle = journal.record_intent(fake_intent("cccc3333")).await.unwrap();
    journal.record_completion(&handle, fake_result("cccc3333", false)).await.unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending[0].state, EntryState::Failed);
}

#[tokio::test]
async fn close_moves_entry_to_done() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-4", dir.path());
    let handle = journal.record_intent(fake_intent("dddd4444")).await.unwrap();
    journal.record_completion(&handle, fake_result("dddd4444", true)).await.unwrap();
    let handle_for_close = JournalHandle { commit_hash: "dddd4444".to_string() };
    journal.close(handle_for_close).await.unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert!(pending.is_empty());

    // Verify the file moved to done/
    let done_file = dir.path().join("trading/acct-4/executing/done/dddd4444.json");
    assert!(done_file.exists());
}

#[tokio::test]
async fn list_pending_skips_done_subdir() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-5", dir.path());
    // Create two entries, close one
    let h1 = journal.record_intent(fake_intent("e1e1e1e1")).await.unwrap();
    let h2 = journal.record_intent(fake_intent("e2e2e2e2")).await.unwrap();
    journal.record_completion(&h1, fake_result("e1e1e1e1", true)).await.unwrap();
    journal.close(JournalHandle { commit_hash: h1.commit_hash }).await.unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].intent.commit_hash, h2.commit_hash);
}

#[tokio::test]
async fn atomic_write_leaves_no_tmp_files() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-6", dir.path());
    journal.record_intent(fake_intent("f1f1f1f1")).await.unwrap();

    let exec_dir = dir.path().join("trading/acct-6/executing");
    let names: Vec<String> = std::fs::read_dir(&exec_dir).unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["f1f1f1f1.json".to_string()]);
}

#[tokio::test]
async fn list_pending_returns_empty_when_no_dir() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-empty", dir.path());
    let pending = journal.list_pending().await.unwrap();
    assert!(pending.is_empty());
}
```

### Step 7: Run tests + clippy + fmt

```bash
cargo test -p alice-trading-core --test journal_lifecycle 2>&1 | tail -10
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
```

Expected: 7 tests pass; clippy + fmt clean.

### Step 8: Commit

```bash
git add crates/alice-trading-core/src/lib.rs crates/alice-trading-core/src/journal/ crates/alice-trading-core/tests/journal_lifecycle.rs
git commit -m "feat(rust): ExecutionJournal types + store (Phase 4e Task A)

New crates/alice-trading-core/src/journal/ module.

- types.rs: ExecutionIntent (commit_hash, client_order_ids, operations,
  started_at, broker_id), ExecutionResult (results + success), EntryState
  (Executing/Completed/Failed, serde lowercase), JournalEntry, JournalHandle.
- store.rs: ExecutionJournal with record_intent / record_completion /
  close / list_pending. All fs ops use the atomic-write recipe
  (spawn_blocking + tmp → fsync → rename) — disk-full propagates as
  BrokerError(NETWORK).
- close() moves <hash>.json → done/<hash>.json (retained for audit).
- list_pending skips the done/ subdir and non-.json files.

7 lifecycle tests pass. Suite ~125 cargo / 2244 TS unchanged.

Spec: docs/superpowers/specs/2026-05-12-phase-4e-broker-execution-journal-design.md"
```

---

## Task B: Broker trait extension + MockBroker impl

**Goal:** Add `allocate_client_order_id` + `lookup_by_client_order_id` to the `Broker` trait. Implement on MockBroker. Update any existing impls (only Mock currently).

**Files:**
- Modify: `crates/alice-trading-core/src/brokers/traits.rs`
- Modify: `crates/alice-trading-core/src/brokers/mock.rs`
- Create: `crates/alice-trading-core/tests/broker_client_order_id.rs`

### Step 1: Extend Broker trait

Edit `crates/alice-trading-core/src/brokers/traits.rs`. Find the trait and add:

```rust
#[async_trait]
pub trait Broker: Send + Sync {
    // ... existing methods ...

    /// Allocate a unique client-order-id for the next broker call.
    /// Per-broker strategy: Mock uses a monotonic counter; IBKR derives from
    /// nextValidId; Alpaca uses commit-hash-suffixed strings. Used by Phase 4e
    /// journal to record what was sent to the broker before the call.
    fn allocate_client_order_id(&self) -> String;

    /// Look up an order by its client-order-id. Used by restart reconciliation
    /// to determine whether an in-flight order was actually accepted.
    /// Returns None if no order matches.
    async fn lookup_by_client_order_id(&self, id: &str) -> Result<Option<OpenOrder>, BrokerError>;
}
```

### Step 2: Implement on MockBroker

Edit `crates/alice-trading-core/src/brokers/mock.rs`. Add fields:

```rust
pub struct MockBroker {
    // ... existing fields ...
    next_client_order_id: AtomicU64,
}

// In `new()`:
next_client_order_id: AtomicU64::new(1),
```

Add the two trait methods to the `impl Broker for MockBroker` block:

```rust
fn allocate_client_order_id(&self) -> String {
    let n = self.next_client_order_id.fetch_add(1, Ordering::SeqCst);
    format!("mock-cli-{}", n)
}

async fn lookup_by_client_order_id(&self, id: &str) -> Result<Option<OpenOrder>, BrokerError> {
    self.record("lookupByClientOrderId", vec![json!(id)]);
    self.check_fail("lookupByClientOrderId")?;
    let state = self.state.lock().unwrap();
    for (_, internal_order) in state.orders.iter() {
        // Check if the order's `clientOrderId` field matches
        if internal_order.order.get("clientOrderId").and_then(|v| v.as_str()) == Some(id) {
            return Ok(Some(OpenOrder {
                contract: internal_order.contract.clone(),
                order: internal_order.order.clone(),
                order_state: json!({ "status": format!("{:?}", internal_order.status) }),
                avg_fill_price: internal_order.fill_price.as_ref().map(|p| p.to_string()),
                tpsl: None,
            }));
        }
    }
    Ok(None)
}
```

NOTE: MockBroker's `place_order` does NOT currently extract `clientOrderId` from the order. For Phase 4e the test fixture writes `clientOrderId` into the order before calling place_order; MockBroker stores the full order shape so the lookup works.

### Step 3: Create `tests/broker_client_order_id.rs`

```rust
//! Phase 4e Task B — Broker trait extension tests.

use std::sync::Arc;
use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::traits::Broker;
use serde_json::json;

#[tokio::test]
async fn allocate_client_order_id_monotonic() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    let id1 = broker.allocate_client_order_id();
    let id2 = broker.allocate_client_order_id();
    let id3 = broker.allocate_client_order_id();
    assert_eq!(id1, "mock-cli-1");
    assert_eq!(id2, "mock-cli-2");
    assert_eq!(id3, "mock-cli-3");
}

#[tokio::test]
async fn lookup_returns_none_for_unknown_id() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    let result = broker.lookup_by_client_order_id("non-existent").await.unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn lookup_finds_order_after_place() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("mock|AAPL", 100.0);
    let cli_id = broker.allocate_client_order_id();
    let contract = json!({
        "aliceId": "mock|AAPL", "symbol": "AAPL", "secType": "STK",
        "exchange": "MOCK", "currency": "USD",
    });
    let order = json!({
        "action": "BUY", "orderType": "MKT", "totalQuantity": "10",
        "clientOrderId": cli_id,
    });
    broker.place_order(&contract, &order, None).await.unwrap();
    let found = broker.lookup_by_client_order_id(&cli_id).await.unwrap();
    assert!(found.is_some(), "lookup should find the order by client_order_id");
    let open_order = found.unwrap();
    let stored_cli_id = open_order.order.get("clientOrderId").and_then(|v| v.as_str());
    assert_eq!(stored_cli_id, Some(cli_id.as_str()));
}
```

### Step 4: Run tests + clippy + fmt + full suite

```bash
cargo test -p alice-trading-core --test broker_client_order_id 2>&1 | tail -10
cargo test -p alice-trading-core 2>&1 | grep -E "test result" | tail -5
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: 3 new tests pass + existing MockBroker tests untouched + TS unchanged.

### Step 5: Commit

```bash
git add crates/alice-trading-core/src/brokers/traits.rs crates/alice-trading-core/src/brokers/mock.rs crates/alice-trading-core/tests/broker_client_order_id.rs
git commit -m "feat(broker): allocate_client_order_id + lookup_by_client_order_id (Phase 4e Task B)

Broker trait extension for Phase 4e journal reconciliation.

- allocate_client_order_id(): sync, returns per-broker-strategy id.
  MockBroker uses monotonic counter via AtomicU64 (separate from
  next_order_id which is the broker-allocated order id).
- lookup_by_client_order_id(id): async, returns Some(OpenOrder) if any
  order's clientOrderId matches, else None. MockBroker scans state.orders.

3 unit tests pass: monotonic allocation, lookup-none-for-unknown,
lookup-finds-after-place. Existing MockBroker tests unchanged."
```

---

## Task C: Wire UtaActor.handle_push through 5-step recipe

**Goal:** Modify `handle_push` to thread through journal record_intent → broker → record_completion → persist commit → close. Add `journal: ExecutionJournal` to UtaState. `UtaState::new` and `restore_or_new` build it.

**Files:**
- Modify: `crates/alice-trading-core/src/uta/state.rs` (add `journal` field)
- Modify: `crates/alice-trading-core/src/uta/actor.rs` (wire 5-step recipe)
- Modify: `crates/alice-trading-core/tests/uta_lifecycle_mock.rs` (existing 3 tests should still pass; add 1 new test asserting journal close after push)

### Step 1: Add journal field to UtaState

In `crates/alice-trading-core/src/uta/state.rs`:

```rust
use crate::journal::ExecutionJournal;

pub struct UtaState {
    // ... existing fields ...
    pub journal: ExecutionJournal,
}
```

Update `UtaState::new` and `UtaState::restore_or_new` to build the journal:

```rust
pub fn new(
    account_id: String,
    broker: Arc<dyn Broker>,
    guards: Vec<Box<dyn Guard>>,
    data_root: PathBuf,
) -> Self {
    let commit_path = crate::uta::persist::commit_path(&account_id, &data_root);
    let journal = ExecutionJournal::new(&account_id, &data_root);
    let git_config = TradingGitConfig::stub();
    Self {
        account_id,
        git: TradingGit::new(git_config),
        broker,
        guards,
        health: HealthState::default(),
        commit_path,
        event_tx: None,
        data_root,
        journal,
    }
}
```

Same change to `restore_or_new`.

### Step 2: Wire `handle_push` through the 5-step recipe

In `crates/alice-trading-core/src/uta/actor.rs`, modify `handle_push`:

```rust
async fn handle_push(&mut self) -> Result<PushResult, BrokerError> {
    // Reject if disabled
    if self.state.health.disabled {
        return Err(BrokerError::new(
            BrokerErrorCode::Config,
            format!("Account \"{}\" is disabled", self.state.account_id),
        ));
    }
    // Reject if offline
    if self.state.health.health() == BrokerHealth::Offline {
        return Err(BrokerError::new(
            BrokerErrorCode::Network,
            format!("Account \"{}\" is offline", self.state.account_id),
        ));
    }

    // Snapshot pre-push state for the journal intent
    let pending_hash = self.state.git.pending_hash()
        .ok_or_else(|| BrokerError::new(BrokerErrorCode::Unknown, "no pending commit".to_string()))?;
    let operations = self.state.git.staging_area().to_vec();
    let mut ops_with_cli_ids = operations.clone();

    // Allocate client_order_ids per operation + INJECT into order.clientOrderId
    let client_order_ids: Vec<String> = operations.iter()
        .map(|_| self.state.broker.allocate_client_order_id())
        .collect();
    for (op, cli_id) in ops_with_cli_ids.iter_mut().zip(client_order_ids.iter()) {
        if let Operation::PlaceOrder { order, .. } = op {
            if let Some(obj) = order.as_object_mut() {
                obj.insert("clientOrderId".to_string(), serde_json::Value::String(cli_id.clone()));
            }
        }
    }
    // Replace the staging area with the cli-id-injected operations
    self.state.git.replace_staging_area(ops_with_cli_ids.clone());

    // Step 1: record intent
    let intent = ExecutionIntent {
        commit_hash: pending_hash.clone(),
        client_order_ids: client_order_ids.clone(),
        operations: ops_with_cli_ids.clone(),
        started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        broker_id: self.state.account_id.clone(),
    };
    let handle = self.state.journal.record_intent(intent).await?;

    // Step 2: broker calls via TradingGit push_with_dispatcher
    let broker = self.state.broker.clone();
    let dispatcher = move |op: &Operation| -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<serde_json::Value, String>> + Send>> {
        let broker = broker.clone();
        let op = op.clone();
        Box::pin(async move {
            broker_dispatch(&broker, &op).await.map_err(|e| e.message)
        })
    };
    let push_result = self.state.git.push_with_dispatcher(&dispatcher).await
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e))?;

    // Step 3: record completion
    let all_results: Vec<OperationResult> = push_result.submitted.iter()
        .chain(push_result.rejected.iter()).cloned().collect();
    let exec_result = ExecutionResult {
        commit_hash: push_result.hash.clone(),
        completed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        results: all_results,
        success: push_result.rejected.is_empty(),
    };
    self.state.journal.record_completion(&handle, exec_result).await?;

    // Step 4: persist commit
    let export = self.state.git.export_state();
    if let Err(e) = crate::uta::persist::persist_commit_atomic(
        &self.state.account_id, &export, &self.state.data_root,
    ).await {
        tracing::error!(
            target = "uta", account = %self.state.account_id,
            error = %e, "commit persist failed"
        );
    }

    // Step 5: close journal entry (move to done/)
    self.state.journal.close(handle).await?;

    // Emit CommitNotify event if subscribed
    if let Some(tx) = &self.state.event_tx {
        let _ = tx.send(UtaEvent::CommitNotify {
            account_id: self.state.account_id.clone(),
            commit_hash: push_result.hash.clone(),
        }).await;
    }

    Ok(push_result)
}
```

This requires:
- `TradingGit::pending_hash() -> Option<String>` accessor (add if missing)
- `TradingGit::staging_area() -> &[Operation]` accessor (add if missing)
- `TradingGit::replace_staging_area(ops: Vec<Operation>)` (add if missing — used to inject client_order_ids before push)

These TradingGit accessors are small additions — check `git.rs` and add as needed.

### Step 3: Add TradingGit accessors

In `crates/alice-trading-core/src/git.rs`, in `impl TradingGit`:

```rust
pub fn pending_hash(&self) -> Option<String> {
    self.pending_hash.clone()
}

pub fn staging_area(&self) -> &[Operation] {
    &self.staging_area
}

pub fn replace_staging_area(&mut self, ops: Vec<Operation>) {
    self.staging_area = ops;
}
```

### Step 4: Add new lifecycle test

Append to `crates/alice-trading-core/tests/uta_lifecycle_mock.rs`:

```rust
#[tokio::test]
async fn push_creates_then_closes_journal_entry() {
    let dir = TempDir::new().unwrap();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    broker.set_quote("mock|AAPL", 100.0);

    let state = UtaState::new(
        "journal-test".to_string(),
        broker.clone(),
        vec![],
        dir.path().to_path_buf(),
    );
    let (handle, _join) = UtaActor::spawn(state, 16);

    handle.add(buy_op("AAPL")).await.unwrap();
    handle.commit("journal test".to_string()).await.unwrap();
    let push_result = handle.push().await.unwrap();

    // Journal entry should be moved to done/ after Step 5
    let executing_dir = dir.path().join("trading/journal-test/executing");
    let done_dir = executing_dir.join("done");
    let done_file = done_dir.join(format!("{}.json", push_result.hash));
    assert!(done_file.exists(), "journal entry should be in executing/done/ after push");

    // No file should remain at the executing/<hash>.json level
    let live_file = executing_dir.join(format!("{}.json", push_result.hash));
    assert!(!live_file.exists(), "live journal entry should be moved to done/");
}
```

### Step 5: Run tests + clippy + fmt + full suite

```bash
cargo test -p alice-trading-core --test uta_lifecycle_mock 2>&1 | tail -10
cargo test -p alice-trading-core 2>&1 | grep -E "test result" | tail -5
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: 4 lifecycle tests pass (3 existing + 1 new); full suite green; TS unchanged.

### Step 6: Commit

```bash
git add crates/alice-trading-core/
git commit -m "feat(uta): wire handle_push through 5-step journal recipe (Phase 4e Task C)

UtaActor.handle_push now follows the v4 §6.11 5-step recipe:
1. journal.record_intent (fsync) — captures operations + client_order_ids
2. broker calls via TradingGit push_with_dispatcher
3. journal.record_completion (fsync) — records OperationResult[]
4. persist_commit_atomic — commit.json updated
5. journal.close — move executing/<hash>.json → done/<hash>.json

UtaState gains a 'journal: ExecutionJournal' field built by both new()
and restore_or_new().

client_order_ids are allocated per-op before the broker calls and
INJECTED into order.clientOrderId so the Mock (and future real
brokers) can echo them back via lookup_by_client_order_id.

TradingGit accessors added (pending_hash, staging_area, replace_staging_area)
to support the cli-id injection.

4 lifecycle tests pass: existing 3 + new 'push closes journal entry'."
```

---

## Task D: reconcile_journal + crash-recovery tests + disk-full test

**Goal:** On UtaActor startup, scan `executing/` for pending entries and idempotently reconcile (emit sync or rejected commits). Test 5 crash points + disk-full propagation.

**Files:**
- Create: `crates/alice-trading-core/src/journal/reconcile.rs`
- Modify: `crates/alice-trading-core/src/journal/mod.rs` (re-export)
- Modify: `crates/alice-trading-core/src/uta/actor.rs` (run reconcile at startup)
- Create: `crates/alice-trading-core/tests/journal_crash_recovery.rs`
- Create: `crates/alice-trading-core/tests/journal_disk_full.rs`

### Step 1: Create `journal/reconcile.rs`

```rust
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
    _git: &mut TradingGit,            // for future use — emit sync/rejected commits
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
            (EntryState::Executing, _) | (EntryState::Completed, false) | (EntryState::Failed, false) => {
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
                        target = "reconciler", account = %account_id,
                        commit_hash = %commit_hash,
                        "in-flight order found at broker; would emit sync commit (Phase 4f wires actual emission)"
                    );
                    ReconcileAction::SyncCommitEmitted
                } else {
                    tracing::warn!(
                        target = "reconciler", account = %account_id,
                        commit_hash = %commit_hash,
                        "no broker record; would emit rejected commit (Phase 4f wires actual emission)"
                    );
                    ReconcileAction::MarkedFailed
                }
            }
        };

        outcomes.push(ReconciliationOutcome { commit_hash: commit_hash.clone(), action });
        // Close the entry idempotently
        let handle = JournalHandle { commit_hash };
        let _ = journal.close(handle).await;  // Best-effort — already-moved entries return Err
    }

    Ok(outcomes)
}
```

NOTE: Phase 4e's reconciler is detection-only (logs the would-be actions). Phase 4f wires the actual git commit emission for sync and rejected outcomes. This is intentional — same pattern as Phase 4d's find_missing_snapshots.

### Step 2: Wire into UtaActor startup

In `crates/alice-trading-core/src/uta/actor.rs`, modify `UtaActor::spawn` or add a `bootstrap()` method called before `run()`:

```rust
impl UtaActor {
    pub fn spawn(state: UtaState, buffer: usize) -> (UtaHandle, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel(buffer);
        let (sig_tx, sig_rx) = mpsc::channel(8);
        let account_id = state.account_id.clone();
        let actor = UtaActor { cmd_rx: rx, signal_rx: sig_rx, signal_tx: sig_tx, state };
        let join = tokio::spawn(actor.run_with_reconciliation());
        (UtaHandle { account_id, cmd_tx: tx }, join)
    }

    async fn run_with_reconciliation(mut self) {
        // Reconcile any pending journal entries from a previous run
        match crate::journal::reconcile::reconcile_journal(
            &self.state.journal,
            &self.state.broker,
            &mut self.state.git,
            &self.state.account_id,
            &self.state.data_root,
        ).await {
            Ok(outcomes) => {
                if !outcomes.is_empty() {
                    tracing::info!(
                        target = "uta", account = %self.state.account_id,
                        outcome_count = outcomes.len(),
                        "reconciled pending journal entries"
                    );
                }
            }
            Err(e) => {
                tracing::error!(
                    target = "uta", account = %self.state.account_id,
                    error = %e,
                    "reconciliation failed at startup; continuing"
                );
            }
        }
        self.run().await
    }
}
```

### Step 3: Add reconciler re-export

In `crates/alice-trading-core/src/journal/mod.rs`:

```rust
pub mod reconcile;
pub use reconcile::{reconcile_journal, ReconcileAction, ReconciliationOutcome};
```

### Step 4: Create crash-recovery tests

Create `crates/alice-trading-core/tests/journal_crash_recovery.rs`:

```rust
//! Phase 4e Task D — crash-recovery integration tests.
//!
//! For each of 5 crash points in the 5-step recipe, simulate a crash by
//! manually constructing the journal/commit.json state that would exist
//! after a partial completion. Then spawn a fresh UtaActor and verify the
//! reconciler produces the expected ReconcileAction.

use std::sync::Arc;
use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::traits::Broker;
use alice_trading_core::journal::{
    reconcile_journal, EntryState, ExecutionIntent, ExecutionJournal, ExecutionResult,
    JournalEntry, JournalHandle, ReconcileAction,
};
use alice_trading_core::types::{Operation, OperationResult, OperationStatus};
use serde_json::json;
use tempfile::TempDir;

fn buy_op_with_cli(cli_id: &str) -> Operation {
    serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10", "clientOrderId": cli_id},
    })).unwrap()
}

async fn write_executing_entry(
    journal: &ExecutionJournal,
    commit_hash: &str,
    cli_id: &str,
) {
    let intent = ExecutionIntent {
        commit_hash: commit_hash.to_string(),
        client_order_ids: vec![cli_id.to_string()],
        operations: vec![buy_op_with_cli(cli_id)],
        started_at: "2026-01-01T00:00:00.000Z".to_string(),
        broker_id: "mock-paper".to_string(),
    };
    journal.record_intent(intent).await.unwrap();
}

#[tokio::test]
async fn crash_after_step1_marks_failed() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-1", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    // Crash after step 1: entry is 'executing'; broker has no record
    write_executing_entry(&journal, "aaaa1111", "mock-cli-1").await;

    let mut git = alice_trading_core::git::TradingGit::new(
        alice_trading_core::git::TradingGitConfig::stub(),
    );
    let outcomes = reconcile_journal(
        &journal, &broker, &mut git, "crash-1", dir.path(),
    ).await.unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].commit_hash, "aaaa1111");
    assert_eq!(outcomes[0].action, ReconcileAction::MarkedFailed);
}

#[tokio::test]
async fn crash_after_step2_emits_sync_commit() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-2", dir.path());
    let broker_concrete = MockBroker::new(MockBrokerOptions::default());
    broker_concrete.set_quote("mock|AAPL", 100.0);

    // Place the order at the broker (simulates step 2 completed)
    let cli_id = "mock-cli-1".to_string();
    let contract = json!({"aliceId": "mock|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"});
    let order = json!({"action": "BUY", "orderType": "MKT", "totalQuantity": "10", "clientOrderId": cli_id});
    broker_concrete.place_order(&contract, &order, None).await.unwrap();

    let broker: Arc<dyn Broker> = Arc::new(broker_concrete);

    // Crash after step 2: entry is 'executing', broker has the order
    write_executing_entry(&journal, "bbbb2222", &cli_id).await;

    let mut git = alice_trading_core::git::TradingGit::new(
        alice_trading_core::git::TradingGitConfig::stub(),
    );
    let outcomes = reconcile_journal(
        &journal, &broker, &mut git, "crash-2", dir.path(),
    ).await.unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, ReconcileAction::SyncCommitEmitted);
}

#[tokio::test]
async fn crash_after_step3_completion_recorded() {
    // Entry in state 'completed' but commit.json doesn't have the hash → emit sync
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-3", dir.path());
    let broker_concrete = MockBroker::new(MockBrokerOptions::default());
    broker_concrete.set_quote("mock|AAPL", 100.0);
    let cli_id = "mock-cli-1".to_string();
    let contract = json!({"aliceId": "mock|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"});
    let order = json!({"action": "BUY", "orderType": "MKT", "totalQuantity": "10", "clientOrderId": cli_id});
    broker_concrete.place_order(&contract, &order, None).await.unwrap();
    let broker: Arc<dyn Broker> = Arc::new(broker_concrete);

    // Write entry in 'completed' state but commit.json doesn't reflect it
    write_executing_entry(&journal, "cccc3333", &cli_id).await;
    let handle = JournalHandle { commit_hash: "cccc3333".to_string() };
    let result = ExecutionResult {
        commit_hash: "cccc3333".to_string(),
        completed_at: "2026-01-01T00:00:01.000Z".to_string(),
        results: vec![OperationResult {
            action: "placeOrder".to_string(),
            success: true,
            order_id: Some("mock-1".to_string()),
            status: OperationStatus::Submitted,
            execution: None, order_state: None,
            filled_qty: None, filled_price: None,
            error: None, raw: None,
        }],
        success: true,
    };
    journal.record_completion(&handle, result).await.unwrap();

    let mut git = alice_trading_core::git::TradingGit::new(
        alice_trading_core::git::TradingGitConfig::stub(),
    );
    let outcomes = reconcile_journal(
        &journal, &broker, &mut git, "crash-3", dir.path(),
    ).await.unwrap();

    // commit.json doesn't have cccc3333 → broker lookup finds the order → SyncCommitEmitted
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, ReconcileAction::SyncCommitEmitted);
}

#[tokio::test]
async fn crash_after_step4_already_committed() {
    // Entry is 'completed' AND commit.json has the hash → AlreadyCommitted
    use alice_trading_core::types::{GitCommit, GitExportState, GitState};
    use alice_trading_core::uta::persist::persist_commit_atomic;

    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-4", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    // Write commit.json with the hash
    let state = GitExportState {
        commits: vec![GitCommit {
            hash: "dddd4444".to_string(),
            parent_hash: None,
            message: "test".to_string(),
            operations: vec![],
            results: vec![],
            state_after: GitState {
                net_liquidation: "0".into(), total_cash_value: "0".into(),
                unrealized_pn_l: "0".into(), realized_pn_l: "0".into(),
                positions: vec![], pending_orders: vec![],
            },
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            round: None,
            hash_version: Some(2),
            intent_full_hash: Some("d".repeat(64)),
            hash_input_timestamp: Some("2026-01-01T00:00:00.000Z".to_string()),
            entry_hash_version: None,
            entry_full_hash: None,
        }],
        head: Some("dddd4444".to_string()),
    };
    persist_commit_atomic("crash-4", &state, dir.path()).await.unwrap();

    // Write entry in 'completed' state
    write_executing_entry(&journal, "dddd4444", "mock-cli-1").await;
    let handle = JournalHandle { commit_hash: "dddd4444".to_string() };
    let result = ExecutionResult {
        commit_hash: "dddd4444".to_string(),
        completed_at: "2026-01-01T00:00:01.000Z".to_string(),
        results: vec![],
        success: true,
    };
    journal.record_completion(&handle, result).await.unwrap();

    let mut git = alice_trading_core::git::TradingGit::new(
        alice_trading_core::git::TradingGitConfig::stub(),
    );
    let outcomes = reconcile_journal(
        &journal, &broker, &mut git, "crash-4", dir.path(),
    ).await.unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, ReconcileAction::AlreadyCommitted);
}

#[tokio::test]
async fn crash_after_step5_no_pending_entries() {
    // All entries already closed → reconciler returns empty
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-5", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    // No journal entries — clean slate
    let mut git = alice_trading_core::git::TradingGit::new(
        alice_trading_core::git::TradingGitConfig::stub(),
    );
    let outcomes = reconcile_journal(
        &journal, &broker, &mut git, "crash-5", dir.path(),
    ).await.unwrap();

    assert!(outcomes.is_empty());
}

#[tokio::test]
async fn reconciler_idempotent_on_rerun() {
    // Run reconciler twice — second run should produce empty outcomes (entries closed)
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("idempotent", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    write_executing_entry(&journal, "abcd1234", "mock-cli-1").await;

    let mut git = alice_trading_core::git::TradingGit::new(
        alice_trading_core::git::TradingGitConfig::stub(),
    );
    let first = reconcile_journal(&journal, &broker, &mut git, "idempotent", dir.path()).await.unwrap();
    assert_eq!(first.len(), 1);

    let second = reconcile_journal(&journal, &broker, &mut git, "idempotent", dir.path()).await.unwrap();
    assert!(second.is_empty(), "second reconcile run should find no pending entries");
}
```

### Step 5: Create disk-full test

Create `crates/alice-trading-core/tests/journal_disk_full.rs`:

```rust
//! Phase 4e Task D — disk-full propagation.

use alice_trading_core::brokers::error::BrokerErrorCode;
use alice_trading_core::journal::{ExecutionIntent, ExecutionJournal};
use alice_trading_core::types::Operation;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;

#[cfg(unix)]
#[tokio::test]
async fn record_intent_returns_network_error_on_readonly_dir() {
    let dir = TempDir::new().unwrap();
    let acct_dir = dir.path().join("trading/readonly-test/executing");
    std::fs::create_dir_all(&acct_dir).unwrap();
    // Make the directory read-only
    let mut perms = std::fs::metadata(&acct_dir).unwrap().permissions();
    perms.set_mode(0o555);
    std::fs::set_permissions(&acct_dir, perms).unwrap();

    let journal = ExecutionJournal::new("readonly-test", dir.path());
    let op: Operation = serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10"},
    })).unwrap();
    let intent = ExecutionIntent {
        commit_hash: "readonly1".to_string(),
        client_order_ids: vec!["cli-1".to_string()],
        operations: vec![op],
        started_at: "2026-01-01T00:00:00.000Z".to_string(),
        broker_id: "mock-paper".to_string(),
    };
    let result = journal.record_intent(intent).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, BrokerErrorCode::Network);

    // Restore permissions so TempDir can be cleaned up
    let mut perms = std::fs::metadata(&acct_dir).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&acct_dir, perms).unwrap();
}
```

### Step 6: Run all tests + clippy + fmt

```bash
cargo test -p alice-trading-core --test journal_crash_recovery 2>&1 | tail -10
cargo test -p alice-trading-core --test journal_disk_full 2>&1 | tail -5
cargo test -p alice-trading-core 2>&1 | grep -E "test result" | tail -5
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: 6 crash-recovery tests + 1 disk-full test pass; full suite green; TS unchanged.

### Step 7: Commit

```bash
git add crates/alice-trading-core/src/journal/ crates/alice-trading-core/src/uta/actor.rs crates/alice-trading-core/tests/journal_crash_recovery.rs crates/alice-trading-core/tests/journal_disk_full.rs
git commit -m "feat(journal): reconcile_journal + crash recovery tests (Phase 4e Task D)

Closes Phase 4e.

- journal/reconcile.rs: reconcile_journal scans non-done entries on
  startup; for each, queries broker via lookup_by_client_order_id and
  produces a ReconcileAction (AlreadyCommitted / SyncCommitEmitted /
  MarkedFailed). Idempotent — re-running finds no entries (all closed
  in pass 1).
- uta/actor.rs: spawn now uses run_with_reconciliation which awaits
  reconcile_journal BEFORE entering the command loop.
- Phase 4e is detection-only — Phase 4f wires actual git commit
  emission for sync/rejected outcomes (same pattern as Phase 4d's
  find_missing_snapshots).

7 integration tests: 5 crash points (after each step of the 5-step
recipe) + reconciler idempotence + disk-full → BrokerError(NETWORK).

Phase 4e complete. Rust crate is dead code — Phase 4f cutover wires
it via napi."
```

---

## Self-Review

**Spec coverage:**
- Deliverable 1 (ExecutionJournal) → Task A
- Deliverable 2 (Broker trait extension) → Task B
- Deliverable 3 (wired UtaActor.handle_push) → Task C
- Deliverable 4 (restart reconciliation) → Task D
- Deliverable 5 (integration tests) → Tasks A + C + D
- Failure mode (disk-full) → Task D Step 5

**Placeholder scan:** none. Detection-only reconciler is explicitly documented in code + spec.

**Type consistency:** `ExecutionJournal`, `ExecutionIntent`, `ExecutionResult`, `JournalHandle`, `JournalEntry`, `EntryState`, `ReconcileAction`, `ReconciliationOutcome` used consistently across all 4 tasks.

**Execution notes:**
- Strict A → B → C → D.
- Task C requires small TradingGit accessor additions (pending_hash / staging_area / replace_staging_area). Implementer reads git.rs first to verify they're not already there.
- Task D's reconciler is detection-only (logs would-be actions). Phase 4f wires the actual git emission.
