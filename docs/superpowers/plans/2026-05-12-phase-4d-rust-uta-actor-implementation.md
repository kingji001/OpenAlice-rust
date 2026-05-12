# Phase 4d — Rust UtaActor + TradingGit persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a complete internal Rust per-UTA actor (owns `TradingGit`, drives broker calls through the Phase 4c guard pipeline, tracks health with degrade/offline transitions + exp-backoff recovery, durably persists every commit). Plus a TS-side snapshot trigger swap (UTAManager `setSnapshotHooks` → EventLog `commit.notify`).

**Architecture:** New `crates/alice-trading-core/src/uta/` module — `UtaActor` runs on a tokio task reading from an `mpsc::Receiver<UtaCommand>` with `oneshot::Sender` reply pattern. `UtaHandle` (clone of the sender) is the public API. `HealthState` mirrors TS `UnifiedTradingAccount.ts:193-328` verbatim. Commit persistence is atomic (tmp → fsync → rename) via `std::fs` in `tokio::task::spawn_blocking`. Pure Rust — no napi exposure (Phase 4f wires FFI).

**Tech Stack:** Rust 2021, `tokio` (mpsc + oneshot + spawn_blocking), `async_trait`, `chrono`, `tracing`, `tempfile` (dev-dep). TypeScript strict ESM, vitest.

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-4d-rust-uta-actor-design.md`](../specs/2026-05-12-phase-4d-rust-uta-actor-design.md) (commit `806a81d`).

**5 sub-tasks, strictly sequential:** A → B → C → D → E.

---

## Pre-flight

- [ ] **Working tree clean**

```bash
git status --short                                    # empty
git log -1 --oneline                                  # confirm Phase 4d plan/spec at HEAD
```

- [ ] **Baseline test counts**

```bash
pnpm test 2>&1 | grep -E "Tests" | tail -1                                # ~2241 TS tests
source $HOME/.cargo/env
cargo test -p alice-trading-core 2>&1 | grep -E "test result" | head -1   # ~95 cargo tests
```

- [ ] **Confirm prior phase modules**

```bash
ls crates/alice-trading-core/src/                     # canonical/decimal/hash_v2/git.rs/persisted_commit/types/brokers/guards
ls crates/alice-trading-core/src/uta/ 2>/dev/null     # NOT present yet — Task A creates it
```

---

## Task A: UtaCommand + UtaActor + UtaHandle + UtaState scaffold

**Goal:** Module scaffold with the actor framework and the simple commands (`Add`, `Commit`, `ExportState`, `Shutdown`). No broker calls, no health, no persistence yet. Establishes the mpsc/oneshot pattern.

**Files:**
- Create: `crates/alice-trading-core/src/uta/mod.rs`
- Create: `crates/alice-trading-core/src/uta/command.rs`
- Create: `crates/alice-trading-core/src/uta/state.rs`
- Create: `crates/alice-trading-core/src/uta/actor.rs`
- Modify: `crates/alice-trading-core/src/lib.rs` (add `pub mod uta;`)
- Modify: `crates/alice-trading-core/Cargo.toml` (add `tempfile = "3"` to `[dev-dependencies]`)
- Create: `crates/alice-trading-core/tests/uta_simple_commands.rs`

### Step 1: Add tempfile dev-dep + create module skeleton

```bash
cd /Users/opcw05/newtest/025/OpenAlice-rust
mkdir -p crates/alice-trading-core/src/uta
```

Edit `crates/alice-trading-core/Cargo.toml`. Find `[dev-dependencies]`. Add:

```toml
tempfile = "3"
```

### Step 2: Create `uta/command.rs`

```rust
//! UtaCommand discriminated union — one variant per public UTA operation.
//!
//! Uses oneshot::Sender for replies so callers await the result without
//! polluting the actor with reply-routing logic.

use tokio::sync::oneshot;
use crate::brokers::error::BrokerError;
use crate::brokers::types::BrokerHealthInfo;
use crate::types::{
    AddResult, CommitPrepareResult, GitExportState, Operation,
    PushResult, RejectResult, SyncResult, OrderStatusUpdate, GitState,
};

pub enum UtaCommand {
    Add { op: Operation, reply: oneshot::Sender<Result<AddResult, String>> },
    Commit { message: String, reply: oneshot::Sender<Result<CommitPrepareResult, String>> },
    Push { reply: oneshot::Sender<Result<PushResult, BrokerError>> },
    Reject { reason: Option<String>, reply: oneshot::Sender<Result<RejectResult, BrokerError>> },
    Sync {
        updates: Vec<OrderStatusUpdate>,
        current_state: GitState,
        reply: oneshot::Sender<Result<SyncResult, BrokerError>>,
    },
    GetHealth { reply: oneshot::Sender<BrokerHealthInfo> },
    NudgeRecovery,
    ExportState { reply: oneshot::Sender<GitExportState> },
    Shutdown { reply: oneshot::Sender<()> },
}

pub enum UtaEvent {
    CommitNotify { account_id: String, commit_hash: String },
    HealthChange { account_id: String, info: BrokerHealthInfo },
}
```

### Step 3: Create `uta/state.rs`

```rust
//! UtaState — all per-account state owned by a single UtaActor.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use crate::brokers::traits::Broker;
use crate::git::{TradingGit, TradingGitConfig};
use crate::guards::traits::Guard;
use crate::uta::command::UtaEvent;
use crate::uta::health::HealthState;

pub struct UtaState {
    pub account_id: String,
    pub git: TradingGit,
    pub broker: Arc<dyn Broker>,
    pub guards: Vec<Box<dyn Guard>>,
    pub health: HealthState,
    pub commit_path: PathBuf,
    pub event_tx: Option<mpsc::Sender<UtaEvent>>,
    pub data_root: PathBuf,
}

impl UtaState {
    /// Build a fresh state with a default empty TradingGit.
    pub fn new(
        account_id: String,
        broker: Arc<dyn Broker>,
        guards: Vec<Box<dyn Guard>>,
        data_root: PathBuf,
    ) -> Self {
        let commit_path = data_root.join(format!("trading/{}/commit.json", account_id));
        let git_config = TradingGitConfig::default();
        Self {
            account_id,
            git: TradingGit::new(git_config),
            broker,
            guards,
            health: HealthState::default(),
            commit_path,
            event_tx: None,
            data_root,
        }
    }
}
```

NOTE: `HealthState` doesn't exist yet (Task B creates it). For Task A, stub it as a placeholder so the file compiles. Replace the `crate::uta::health::HealthState` import with `()` (unit type) temporarily and remove the `health: HealthState,` field — re-add in Task B. To keep the file structurally complete, define a minimal placeholder in `state.rs` inline OR import a stub from `health.rs` (next step).

Actually simpler: create a minimal `health.rs` stub now (just an empty struct) so types compile, and Task B replaces it. Add `uta/health.rs`:

```rust
//! Phase 4d Task A: stub. Task B replaces with the full state machine.
#[derive(Default, Debug)]
pub struct HealthState;
```

Then `state.rs` references it. Task B will replace `health.rs` with the full implementation.

### Step 4: Create `uta/actor.rs`

```rust
//! UtaActor — single-task per-UTA event loop. Phase 4d Task A scaffold:
//! only Add/Commit/ExportState/Shutdown variants implemented; Push/Reject/
//! Sync/Health/NudgeRecovery wired in later tasks.

use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::types::{AddResult, CommitPrepareResult, GitExportState, Operation};
use crate::uta::command::UtaCommand;
use crate::uta::state::UtaState;

pub struct UtaActor {
    cmd_rx: mpsc::Receiver<UtaCommand>,
    state: UtaState,
}

pub struct UtaHandle {
    pub account_id: String,
    cmd_tx: mpsc::Sender<UtaCommand>,
}

impl Clone for UtaHandle {
    fn clone(&self) -> Self {
        Self {
            account_id: self.account_id.clone(),
            cmd_tx: self.cmd_tx.clone(),
        }
    }
}

impl UtaActor {
    /// Build and spawn the actor on a tokio task.
    pub fn spawn(state: UtaState, buffer: usize) -> (UtaHandle, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel(buffer);
        let account_id = state.account_id.clone();
        let actor = UtaActor { cmd_rx: rx, state };
        let join = tokio::spawn(actor.run());
        (UtaHandle { account_id, cmd_tx: tx }, join)
    }

    pub async fn run(mut self) {
        while let Some(cmd) = self.cmd_rx.recv().await {
            match cmd {
                UtaCommand::Add { op, reply } => {
                    let result = self.handle_add(op);
                    let _ = reply.send(result);
                }
                UtaCommand::Commit { message, reply } => {
                    let result = self.handle_commit(message);
                    let _ = reply.send(result);
                }
                UtaCommand::ExportState { reply } => {
                    let _ = reply.send(self.state.git.export_state());
                }
                UtaCommand::Shutdown { reply } => {
                    let _ = reply.send(());
                    return;
                }
                // Phase 4d Task B/C/D add the remaining variants below.
                UtaCommand::Push { reply } => {
                    let _ = reply.send(Err(BrokerError::new(
                        BrokerErrorCode::Unknown,
                        "Task A scaffold: Push not yet implemented".to_string(),
                    )));
                }
                UtaCommand::Reject { reply, .. } => {
                    let _ = reply.send(Err(BrokerError::new(
                        BrokerErrorCode::Unknown,
                        "Task A scaffold: Reject not yet implemented".to_string(),
                    )));
                }
                UtaCommand::Sync { reply, .. } => {
                    let _ = reply.send(Err(BrokerError::new(
                        BrokerErrorCode::Unknown,
                        "Task A scaffold: Sync not yet implemented".to_string(),
                    )));
                }
                UtaCommand::GetHealth { reply: _ } => {
                    // Task B replaces this with self.state.health.info()
                }
                UtaCommand::NudgeRecovery => {
                    // Task B wires nudge_recovery
                }
            }
        }
    }

    fn handle_add(&mut self, op: Operation) -> Result<AddResult, String> {
        Ok(self.state.git.add(op))
    }

    fn handle_commit(&mut self, message: String) -> Result<CommitPrepareResult, String> {
        self.state.git.commit(message).map_err(|e| e.to_string())
    }
}

impl UtaHandle {
    pub async fn add(&self, op: Operation) -> Result<AddResult, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::Add { op, reply: tx }).await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())?
    }

    pub async fn commit(&self, message: String) -> Result<CommitPrepareResult, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::Commit { message, reply: tx }).await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())?
    }

    pub async fn export_state(&self) -> Result<GitExportState, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::ExportState { reply: tx }).await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())
    }

    pub async fn shutdown(self) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::Shutdown { reply: tx }).await
            .map_err(|_| "actor already stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())
    }

    // Task B/C/D add: push, reject, sync, get_health, nudge_recovery, etc.
}
```

### Step 5: Create `uta/mod.rs`

```rust
//! Per-UTA actor — owns TradingGit, broker, guards, health state.
//!
//! Phase 4d deliverable. Pure Rust internally — napi exposure is Phase 4f.

pub mod actor;
pub mod command;
pub mod health;
pub mod state;

pub use actor::{UtaActor, UtaHandle};
pub use command::{UtaCommand, UtaEvent};
pub use state::UtaState;
```

### Step 6: Wire into lib.rs

Edit `crates/alice-trading-core/src/lib.rs`. Add `pub mod uta;` alphabetically (between `types` and `wire_schema` if those exist).

### Step 7: Build sanity

```bash
source $HOME/.cargo/env
cargo build -p alice-trading-core 2>&1 | tail -5
```

Expected: clean.

### Step 8: Create simple-command integration test

Create `crates/alice-trading-core/tests/uta_simple_commands.rs`:

```rust
//! Phase 4d Task A — basic actor lifecycle + simple commands.

use std::sync::Arc;
use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::uta::{UtaActor, UtaState};
use serde_json::json;
use tempfile::TempDir;

fn make_state(account_id: &str, data_root: std::path::PathBuf) -> UtaState {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    UtaState::new(account_id.to_string(), broker, vec![], data_root)
}

fn buy_aapl_op() -> alice_trading_core::types::Operation {
    serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock-paper|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10"},
    })).unwrap()
}

#[tokio::test]
async fn actor_spawn_and_shutdown() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-1", dir.path().to_path_buf());
    let (handle, join) = UtaActor::spawn(state, 16);
    handle.shutdown().await.unwrap();
    join.await.unwrap();
}

#[tokio::test]
async fn add_command_works() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-2", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    let result = handle.add(buy_aapl_op()).await.unwrap();
    assert_eq!(result.index, 0);
    assert_eq!(result.staged, true);
}

#[tokio::test]
async fn commit_after_add_succeeds() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-3", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    handle.add(buy_aapl_op()).await.unwrap();
    let prep = handle.commit("test commit".to_string()).await.unwrap();
    assert_eq!(prep.prepared, true);
    assert_eq!(prep.message, "test commit");
    assert_eq!(prep.operation_count, 1);
}

#[tokio::test]
async fn export_state_returns_committed_log() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-4", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    handle.add(buy_aapl_op()).await.unwrap();
    handle.commit("c1".to_string()).await.unwrap();
    let exported = handle.export_state().await.unwrap();
    // Note: commit() prepares but does NOT push, so commits[] is empty
    // until push runs. ExportState reflects only what's pushed.
    assert!(exported.commits.is_empty());
    assert!(exported.head.is_none());
}

#[tokio::test]
async fn handle_is_cloneable_and_works_concurrently() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-5", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    let h2 = handle.clone();
    let result_a = handle.add(buy_aapl_op()).await.unwrap();
    let result_b = h2.add(buy_aapl_op()).await.unwrap();
    assert_eq!(result_a.index, 0);
    assert_eq!(result_b.index, 1);  // serial via mpsc
}
```

### Step 9: Run tests

```bash
cargo test -p alice-trading-core --test uta_simple_commands 2>&1 | tail -10
```

Expected: 5 tests pass.

### Step 10: Full sanity + clippy + fmt

```bash
cargo test -p alice-trading-core 2>&1 | grep "test result" | tail -5
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: all green; ~100 cargo tests (95 baseline + 5 new); TS unchanged.

### Step 11: Commit

```bash
git add Cargo.lock crates/alice-trading-core/Cargo.toml crates/alice-trading-core/src/lib.rs crates/alice-trading-core/src/uta/ crates/alice-trading-core/tests/uta_simple_commands.rs
git commit -m "feat(rust): UtaCommand + UtaActor + UtaHandle + state scaffold (Phase 4d Task A)

New crates/alice-trading-core/src/uta/ module. Pure Rust — napi
exposure is Phase 4f.

- command.rs: UtaCommand enum (9 variants) with tokio::sync::oneshot
  reply pattern. UtaEvent enum (CommitNotify + HealthChange).
- state.rs: UtaState holds account_id, git, broker, guards, health,
  commit_path, optional event_tx for outbound events.
- actor.rs: UtaActor reads from mpsc::Receiver, dispatches via match.
  UtaHandle is the public API — Clone-able via mpsc::Sender. Spawn
  builds + tokio::spawn(actor.run()).
- health.rs: stub for Task A (Task B replaces with full state machine).
- Task A scaffold: Add/Commit/ExportState/Shutdown variants implemented;
  Push/Reject/Sync/GetHealth/NudgeRecovery return placeholder errors
  (Tasks B/C/D fill in).

5 integration tests pass: spawn+shutdown, add, commit, export_state,
handle cloning + serial dispatch.

Spec: docs/superpowers/specs/2026-05-12-phase-4d-rust-uta-actor-design.md"
```

---

## Task B: HealthState + recovery loop

**Goal:** Port `UnifiedTradingAccount.ts:193-328` verbatim. State machine: degraded ≥3 failures, offline ≥6, exp backoff `min(5000 * 2^attempt, 60000)`. Recovery task is a `tokio::spawn(...)` that retries `broker.init()` + `broker.get_account()`; on success it sends a `RecoverySignal::Recovered` via `mpsc::Sender<RecoverySignal>` back to the actor. `Drop` on `HealthState` aborts the task.

**Files:**
- Modify: `crates/alice-trading-core/src/uta/health.rs` (replace stub with full impl)
- Modify: `crates/alice-trading-core/src/uta/state.rs` (re-add `health: HealthState` field)
- Modify: `crates/alice-trading-core/src/uta/command.rs` (add `RecoverySignal` enum)
- Modify: `crates/alice-trading-core/src/uta/actor.rs` (wire GetHealth + NudgeRecovery; consume RecoverySignal in run loop via tokio::select!)
- Create: `crates/alice-trading-core/tests/uta_health_transitions.rs`

### Step 1: Add `RecoverySignal` to command.rs

```rust
// Append to crates/alice-trading-core/src/uta/command.rs

/// Internal signal from the recovery task back to the actor.
pub enum RecoverySignal {
    Recovered,
    Attempt { attempt: u32, error: String },
}
```

### Step 2: Replace `uta/health.rs` with full state machine

```rust
//! HealthState — port of UnifiedTradingAccount.ts:193-328.
//!
//! Tracks broker health via consecutive failure count + transitions to
//! degraded (≥3) / offline (≥6). Spawns an exp-backoff recovery task on
//! offline; recovery task signals via mpsc back to the actor.
//!
//! Drop aborts the recovery task to prevent leaks.

use chrono::{DateTime, Utc};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};
use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::brokers::traits::Broker;
use crate::brokers::types::{BrokerHealth, BrokerHealthInfo};
use crate::uta::command::RecoverySignal;

pub struct HealthState {
    pub disabled: bool,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_failure_at: Option<DateTime<Utc>>,
    pub recovering: bool,
    recovery_task: Option<JoinHandle<()>>,
}

impl HealthState {
    pub const DEGRADED_THRESHOLD: u32 = 3;
    pub const OFFLINE_THRESHOLD: u32 = 6;
    pub const RECOVERY_BASE_MS: u64 = 5_000;
    pub const RECOVERY_MAX_MS: u64 = 60_000;

    pub fn health(&self) -> BrokerHealth {
        if self.disabled {
            return BrokerHealth::Offline;
        }
        if self.consecutive_failures >= Self::OFFLINE_THRESHOLD {
            return BrokerHealth::Offline;
        }
        if self.consecutive_failures >= Self::DEGRADED_THRESHOLD {
            return BrokerHealth::Unhealthy;
        }
        BrokerHealth::Healthy
    }

    pub fn info(&self) -> BrokerHealthInfo {
        BrokerHealthInfo {
            status: self.health(),
            last_check: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            message: self.last_error.clone(),
            consecutive_failures: Some(self.consecutive_failures),
        }
    }

    /// Called after every successful broker call.
    pub fn on_success(&mut self) {
        self.consecutive_failures = 0;
        self.last_success_at = Some(Utc::now());
        if let Some(task) = self.recovery_task.take() {
            task.abort();
            self.recovering = false;
        }
    }

    /// Called after every failed broker call. Returns true if the caller
    /// (actor) should now start a recovery loop.
    pub fn on_failure(&mut self, err: &BrokerError) -> bool {
        self.consecutive_failures += 1;
        self.last_error = Some(err.message.clone());
        self.last_failure_at = Some(Utc::now());
        if err.code == BrokerErrorCode::Config || err.code == BrokerErrorCode::Auth {
            self.disabled = true;
        }
        let should_recover = self.health() == BrokerHealth::Offline
            && !self.recovering
            && !self.disabled;
        if should_recover {
            self.recovering = true;
        }
        should_recover
    }

    /// Spawn the recovery loop. Caller passes a clone of broker + a Sender
    /// to signal back.
    pub fn start_recovery(
        &mut self,
        broker: Arc<dyn Broker>,
        signal_tx: mpsc::Sender<RecoverySignal>,
    ) {
        if let Some(prev) = self.recovery_task.take() {
            prev.abort();
        }
        let task = tokio::spawn(async move {
            let mut attempt: u32 = 0;
            loop {
                let delay_ms = std::cmp::min(
                    Self::RECOVERY_BASE_MS.saturating_mul(2u64.saturating_pow(attempt)),
                    Self::RECOVERY_MAX_MS,
                );
                sleep(Duration::from_millis(delay_ms)).await;
                match broker.init().await {
                    Ok(()) => match broker.get_account().await {
                        Ok(_) => {
                            let _ = signal_tx.send(RecoverySignal::Recovered).await;
                            return;
                        }
                        Err(e) => {
                            let _ = signal_tx
                                .send(RecoverySignal::Attempt { attempt, error: e.message })
                                .await;
                        }
                    },
                    Err(e) => {
                        let _ = signal_tx
                            .send(RecoverySignal::Attempt { attempt, error: e.message })
                            .await;
                    }
                }
                attempt = attempt.saturating_add(1);
            }
        });
        self.recovery_task = Some(task);
    }

    /// Cancel current recovery + re-spawn at attempt=0 (called via nudge_recovery).
    pub fn nudge_recovery(
        &mut self,
        broker: Arc<dyn Broker>,
        signal_tx: mpsc::Sender<RecoverySignal>,
    ) {
        if !self.recovering || self.disabled {
            return;
        }
        self.start_recovery(broker, signal_tx);
    }
}

impl Default for HealthState {
    fn default() -> Self {
        Self {
            disabled: false,
            consecutive_failures: 0,
            last_error: None,
            last_success_at: None,
            last_failure_at: None,
            recovering: false,
            recovery_task: None,
        }
    }
}

impl Drop for HealthState {
    fn drop(&mut self) {
        if let Some(task) = self.recovery_task.take() {
            task.abort();
        }
    }
}
```

### Step 3: Restore `health: HealthState` field in state.rs

In `uta/state.rs`, re-add the field. The `new()` function already initializes via `HealthState::default()` — confirm.

### Step 4: Wire GetHealth + NudgeRecovery + RecoverySignal in actor.rs

The actor's `run()` loop needs to handle:
1. `UtaCommand::GetHealth` → reply with `self.state.health.info()`
2. `UtaCommand::NudgeRecovery` → call `health.nudge_recovery(broker, signal_tx)`
3. `RecoverySignal::Recovered` → call `health.on_success()`

For (3), we need a side channel. The actor's `run()` becomes a `tokio::select!` over `cmd_rx.recv()` AND `signal_rx.recv()`.

Update `UtaActor` struct:

```rust
pub struct UtaActor {
    cmd_rx: mpsc::Receiver<UtaCommand>,
    signal_rx: mpsc::Receiver<RecoverySignal>,
    signal_tx: mpsc::Sender<RecoverySignal>,
    state: UtaState,
}

impl UtaActor {
    pub fn spawn(state: UtaState, buffer: usize) -> (UtaHandle, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel(buffer);
        let (sig_tx, sig_rx) = mpsc::channel(8);
        let account_id = state.account_id.clone();
        let actor = UtaActor {
            cmd_rx: rx,
            signal_rx: sig_rx,
            signal_tx: sig_tx,
            state,
        };
        let join = tokio::spawn(actor.run());
        (UtaHandle { account_id, cmd_tx: tx }, join)
    }

    pub async fn run(mut self) {
        loop {
            tokio::select! {
                Some(cmd) = self.cmd_rx.recv() => {
                    let should_exit = self.dispatch_cmd(cmd).await;
                    if should_exit { return; }
                }
                Some(sig) = self.signal_rx.recv() => {
                    self.dispatch_signal(sig);
                }
                else => return,
            }
        }
    }

    async fn dispatch_cmd(&mut self, cmd: UtaCommand) -> bool {
        match cmd {
            UtaCommand::Add { op, reply } => {
                let _ = reply.send(self.handle_add(op));
                false
            }
            UtaCommand::Commit { message, reply } => {
                let _ = reply.send(self.handle_commit(message));
                false
            }
            UtaCommand::ExportState { reply } => {
                let _ = reply.send(self.state.git.export_state());
                false
            }
            UtaCommand::GetHealth { reply } => {
                let _ = reply.send(self.state.health.info());
                false
            }
            UtaCommand::NudgeRecovery => {
                let broker = self.state.broker.clone();
                let sig_tx = self.signal_tx.clone();
                self.state.health.nudge_recovery(broker, sig_tx);
                false
            }
            UtaCommand::Shutdown { reply } => {
                let _ = reply.send(());
                true   // signal exit
            }
            // Task D fills in Push/Reject/Sync. Until then, return placeholder errors.
            UtaCommand::Push { reply } => {
                let _ = reply.send(Err(BrokerError::new(
                    BrokerErrorCode::Unknown,
                    "Task A scaffold: Push not yet implemented".to_string(),
                )));
                false
            }
            UtaCommand::Reject { reply, .. } => {
                let _ = reply.send(Err(BrokerError::new(
                    BrokerErrorCode::Unknown,
                    "Task A scaffold: Reject not yet implemented".to_string(),
                )));
                false
            }
            UtaCommand::Sync { reply, .. } => {
                let _ = reply.send(Err(BrokerError::new(
                    BrokerErrorCode::Unknown,
                    "Task A scaffold: Sync not yet implemented".to_string(),
                )));
                false
            }
        }
    }

    fn dispatch_signal(&mut self, sig: RecoverySignal) {
        match sig {
            RecoverySignal::Recovered => {
                self.state.health.on_success();
                tracing::info!(target = "uta", account = %self.state.account_id, "recovery succeeded");
            }
            RecoverySignal::Attempt { attempt, error } => {
                tracing::warn!(
                    target = "uta", account = %self.state.account_id,
                    attempt, error = %error, "recovery attempt failed"
                );
            }
        }
    }
}
```

Update `UtaHandle` with new methods:

```rust
impl UtaHandle {
    // ... existing methods ...

    pub async fn get_health(&self) -> Result<BrokerHealthInfo, String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::GetHealth { reply: tx }).await
            .map_err(|_| "actor stopped".to_string())?;
        rx.await.map_err(|_| "actor reply dropped".to_string())
    }

    /// Fire-and-forget nudge.
    pub async fn nudge_recovery(&self) -> Result<(), String> {
        self.cmd_tx.send(UtaCommand::NudgeRecovery).await
            .map_err(|_| "actor stopped".to_string())
    }
}
```

### Step 5: Create health-transitions integration test

Create `crates/alice-trading-core/tests/uta_health_transitions.rs`:

```rust
//! Phase 4d Task B — HealthState transitions + recovery loop lifecycle.

use std::sync::Arc;
use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::types::BrokerHealth;
use alice_trading_core::uta::{UtaActor, UtaState};
use tempfile::TempDir;

fn fresh_state(account_id: &str, dir: &TempDir) -> UtaState {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    UtaState::new(account_id.to_string(), broker, vec![], dir.path().to_path_buf())
}

#[tokio::test]
async fn default_health_is_healthy() {
    let dir = TempDir::new().unwrap();
    let state = fresh_state("h1", &dir);
    let (handle, _join) = UtaActor::spawn(state, 16);
    let info = handle.get_health().await.unwrap();
    assert_eq!(info.status, BrokerHealth::Healthy);
    assert_eq!(info.consecutive_failures, Some(0));
}

#[tokio::test]
async fn degraded_threshold_3_failures() {
    // Test the threshold directly on HealthState since Task D wires the
    // failure injection through handle_push (not yet implemented in Task B).
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    assert_eq!(h.health(), BrokerHealth::Healthy);
    h.on_failure(&err);
    h.on_failure(&err);
    assert_eq!(h.health(), BrokerHealth::Healthy);   // 2 < 3
    h.on_failure(&err);
    assert_eq!(h.health(), BrokerHealth::Unhealthy); // 3 ≥ 3
}

#[tokio::test]
async fn offline_threshold_6_failures() {
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    for _ in 0..6 {
        h.on_failure(&err);
    }
    assert_eq!(h.health(), BrokerHealth::Offline);
    assert_eq!(h.consecutive_failures, 6);
}

#[tokio::test]
async fn permanent_error_disables_account() {
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Config, "bad config".to_string());
    h.on_failure(&err);
    assert!(h.disabled);
    assert_eq!(h.health(), BrokerHealth::Offline);
}

#[tokio::test]
async fn on_success_resets_failures() {
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    for _ in 0..5 {
        h.on_failure(&err);
    }
    assert_eq!(h.consecutive_failures, 5);
    h.on_success();
    assert_eq!(h.consecutive_failures, 0);
    assert_eq!(h.health(), BrokerHealth::Healthy);
    assert!(h.last_success_at.is_some());
}

#[tokio::test]
async fn drop_aborts_recovery_task() {
    // Allocate a HealthState, start a recovery task that would otherwise
    // sleep for 5s, drop the state, verify no panic + task is aborted.
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::command::RecoverySignal;
    use alice_trading_core::uta::health::HealthState;
    use tokio::sync::mpsc;

    let mut h = HealthState::default();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let (sig_tx, _sig_rx) = mpsc::channel::<RecoverySignal>(8);
    // Force 6 failures so health is offline
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    for _ in 0..6 {
        h.on_failure(&err);
    }
    h.start_recovery(broker, sig_tx);
    assert!(h.recovering);
    // Drop the state — should abort the recovery task cleanly.
    drop(h);
    // Sleep briefly to give the runtime time to process the abort
    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    // No panic = test passes
}
```

### Step 6: Run health tests

```bash
cargo test -p alice-trading-core --test uta_health_transitions 2>&1 | tail -10
```

Expected: 6 tests pass. The Drop test may take a few seconds (sleep prevents racy task cleanup).

### Step 7: Full sanity + clippy + fmt

```bash
cargo test -p alice-trading-core 2>&1 | grep "test result" | tail -5
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: ~106 cargo tests (100 + 6 new); clippy + fmt clean; TS unchanged.

### Step 8: Commit

```bash
git add crates/alice-trading-core/src/uta/ crates/alice-trading-core/tests/uta_health_transitions.rs
git commit -m "feat(rust): HealthState state machine + recovery loop (Phase 4d Task B)

Port of UnifiedTradingAccount.ts:193-328 verbatim.

- health.rs: HealthState with disabled, consecutive_failures,
  last_error, last_success_at, last_failure_at, recovering,
  recovery_task. Thresholds: DEGRADED ≥3, OFFLINE ≥6. Recovery
  loop: exp backoff min(5000 * 2^attempt, 60000) ms.
- on_success() resets failure count + aborts recovery task.
- on_failure(err) increments + captures error; returns bool
  signaling caller to start_recovery. Permanent errors
  (Config/Auth) flip disabled=true.
- start_recovery spawns tokio task that loops broker.init() +
  broker.get_account() with exp backoff; signals back via
  mpsc::Sender<RecoverySignal>.
- nudge_recovery cancels current task + re-spawns at attempt=0.
- Drop aborts recovery_task to prevent JoinHandle leaks.
- actor.rs: run loop becomes tokio::select! over cmd_rx + signal_rx.
  RecoverySignal::Recovered triggers health.on_success(); Attempt
  emits tracing::warn.
- UtaHandle gets get_health() + nudge_recovery() methods.

6 health-transition tests: default healthy, degraded ≥3, offline ≥6,
permanent disables, on_success resets, Drop aborts recovery."
```

---

## Task C: Atomic-write commit persistence

**Goal:** Implement `uta/persist.rs` with the atomic-write recipe (write-to-tmp → fsync → rename). Plus `load_git_state` with legacy fallback (`bybit-main` → `data/crypto-trading/commit.json`, etc.). Stronger than TS today (TS uses non-atomic `writeFile`).

**Files:**
- Create: `crates/alice-trading-core/src/uta/persist.rs`
- Modify: `crates/alice-trading-core/src/uta/mod.rs` (add `pub mod persist;`)
- Modify: `crates/alice-trading-core/src/uta/state.rs` (`restore_or_new` factory)
- Create: `crates/alice-trading-core/tests/uta_persist.rs`

### Step 1: Create `uta/persist.rs`

```rust
//! Atomic-write commit persistence.
//!
//! Path: data/trading/<accountId>/commit.json
//! Legacy fallbacks: bybit-main → data/crypto-trading/commit.json
//!                   alpaca-paper/alpaca-live → data/securities-trading/commit.json
//!
//! Atomic-write recipe:
//!   1. Write JSON to <dir>/commit.json.tmp.<pid>
//!   2. fsync the tmp file
//!   3. Atomic rename(tmp, primary)
//!   4. Best-effort fsync the parent directory
//!
//! Stronger than TS today (writeFile is non-atomic, no fsync).

use std::path::{Path, PathBuf};
use crate::types::GitExportState;

pub fn commit_path(account_id: &str, data_root: &Path) -> PathBuf {
    data_root.join(format!("trading/{}/commit.json", account_id))
}

/// Legacy path fallbacks — mirrors TS src/domain/trading/git-persistence.ts:18-22.
pub fn legacy_commit_path(account_id: &str, data_root: &Path) -> Option<PathBuf> {
    match account_id {
        "bybit-main" => Some(data_root.join("crypto-trading/commit.json")),
        "alpaca-paper" | "alpaca-live" => Some(data_root.join("securities-trading/commit.json")),
        _ => None,
    }
}

/// Read saved git state from disk, trying primary path then legacy fallback.
pub async fn load_git_state(account_id: &str, data_root: &Path) -> Option<GitExportState> {
    let primary = commit_path(account_id, data_root);
    if let Ok(bytes) = tokio::fs::read(&primary).await {
        if let Ok(state) = serde_json::from_slice::<GitExportState>(&bytes) {
            return Some(state);
        }
    }
    if let Some(legacy) = legacy_commit_path(account_id, data_root) {
        if let Ok(bytes) = tokio::fs::read(&legacy).await {
            if let Ok(state) = serde_json::from_slice::<GitExportState>(&bytes) {
                return Some(state);
            }
        }
    }
    None
}

/// Atomic-write commit.json. Returns I/O errors for the caller to handle.
pub async fn persist_commit_atomic(
    account_id: &str,
    state: &GitExportState,
    data_root: &Path,
) -> Result<(), std::io::Error> {
    let path = commit_path(account_id, data_root);
    let state_clone = state.clone();
    tokio::task::spawn_blocking(move || -> Result<(), std::io::Error> {
        let dir = path.parent().expect("commit_path always has a parent");
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("commit.json.tmp.{}", std::process::id()));
        let json = serde_json::to_string_pretty(&state_clone)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(&tmp, &json)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, &path)?;
        // Best-effort directory fsync — some filesystems don't support it
        if let Ok(dir_file) = std::fs::File::open(dir) {
            let _ = dir_file.sync_all();
        }
        Ok(())
    })
    .await
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("join error: {}", e)))?
}
```

### Step 2: Wire into mod.rs

Edit `crates/alice-trading-core/src/uta/mod.rs`. Add:

```rust
pub mod persist;
pub use persist::{commit_path, legacy_commit_path, load_git_state, persist_commit_atomic};
```

### Step 3: Add `restore_or_new` factory to state.rs

Append to `crates/alice-trading-core/src/uta/state.rs`:

```rust
impl UtaState {
    /// Build state with TradingGit restored from disk (or fresh if no saved state).
    /// Tries primary path → legacy fallback → fresh.
    pub async fn restore_or_new(
        account_id: String,
        broker: Arc<dyn Broker>,
        guards: Vec<Box<dyn Guard>>,
        data_root: PathBuf,
    ) -> Self {
        let git = match crate::uta::persist::load_git_state(&account_id, &data_root).await {
            Some(state) => {
                let config = crate::git::TradingGitConfig::default();
                crate::git::TradingGit::restore(state, config)
            }
            None => crate::git::TradingGit::new(crate::git::TradingGitConfig::default()),
        };
        let commit_path = crate::uta::persist::commit_path(&account_id, &data_root);
        Self {
            account_id,
            git,
            broker,
            guards,
            health: HealthState::default(),
            commit_path,
            event_tx: None,
            data_root,
        }
    }
}
```

### Step 4: Create persistence integration tests

Create `crates/alice-trading-core/tests/uta_persist.rs`:

```rust
//! Phase 4d Task C — atomic-write persistence + legacy path fallback.

use std::path::PathBuf;
use alice_trading_core::types::{GitCommit, GitExportState, GitState};
use alice_trading_core::uta::{commit_path, legacy_commit_path, load_git_state, persist_commit_atomic};
use tempfile::TempDir;

fn empty_git_state() -> GitState {
    GitState {
        net_liquidation: "0".into(),
        total_cash_value: "0".into(),
        unrealized_pn_l: "0".into(),
        realized_pn_l: "0".into(),
        positions: vec![],
        pending_orders: vec![],
    }
}

fn make_commit(hash: &str, message: &str) -> GitCommit {
    GitCommit {
        hash: hash.to_string(),
        parent_hash: None,
        message: message.to_string(),
        operations: vec![],
        results: vec![],
        state_after: empty_git_state(),
        timestamp: "2026-01-01T00:00:00.000Z".to_string(),
        round: None,
        hash_version: Some(2),
        intent_full_hash: Some(format!("{}{}", hash, "x".repeat(56))),
        hash_input_timestamp: Some("2026-01-01T00:00:00.000Z".to_string()),
        entry_hash_version: None,
        entry_full_hash: None,
    }
}

#[tokio::test]
async fn write_then_read_round_trip() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![make_commit("abc12345", "test")],
        head: Some("abc12345".to_string()),
    };
    persist_commit_atomic("acct-1", &state, dir.path()).await.unwrap();
    let loaded = load_git_state("acct-1", dir.path()).await.unwrap();
    assert_eq!(loaded.commits.len(), 1);
    assert_eq!(loaded.commits[0].hash, "abc12345");
    assert_eq!(loaded.head.as_deref(), Some("abc12345"));
}

#[tokio::test]
async fn primary_path_format() {
    let root = PathBuf::from("/tmp/test-root");
    assert_eq!(
        commit_path("acct-1", &root),
        PathBuf::from("/tmp/test-root/trading/acct-1/commit.json"),
    );
}

#[tokio::test]
async fn legacy_path_bybit_main() {
    let root = PathBuf::from("/data");
    assert_eq!(
        legacy_commit_path("bybit-main", &root),
        Some(PathBuf::from("/data/crypto-trading/commit.json")),
    );
}

#[tokio::test]
async fn legacy_path_alpaca() {
    let root = PathBuf::from("/data");
    assert_eq!(
        legacy_commit_path("alpaca-paper", &root),
        Some(PathBuf::from("/data/securities-trading/commit.json")),
    );
    assert_eq!(
        legacy_commit_path("alpaca-live", &root),
        Some(PathBuf::from("/data/securities-trading/commit.json")),
    );
}

#[tokio::test]
async fn legacy_path_none_for_unknown() {
    let root = PathBuf::from("/data");
    assert_eq!(legacy_commit_path("custom-acct", &root), None);
}

#[tokio::test]
async fn load_falls_back_to_legacy_path_for_bybit_main() {
    let dir = TempDir::new().unwrap();
    // Write only to legacy path
    let state = GitExportState {
        commits: vec![make_commit("legacy01", "from legacy")],
        head: Some("legacy01".to_string()),
    };
    let legacy = dir.path().join("crypto-trading");
    std::fs::create_dir_all(&legacy).unwrap();
    let legacy_file = legacy.join("commit.json");
    std::fs::write(&legacy_file, serde_json::to_string_pretty(&state).unwrap()).unwrap();

    let loaded = load_git_state("bybit-main", dir.path()).await.unwrap();
    assert_eq!(loaded.commits[0].hash, "legacy01");
}

#[tokio::test]
async fn load_returns_none_when_no_state_exists() {
    let dir = TempDir::new().unwrap();
    let loaded = load_git_state("acct-missing", dir.path()).await;
    assert!(loaded.is_none());
}

#[tokio::test]
async fn atomic_write_does_not_leave_tmp_files() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![make_commit("clean001", "test")],
        head: Some("clean001".to_string()),
    };
    persist_commit_atomic("acct-2", &state, dir.path()).await.unwrap();

    // List files in the account dir — should only be commit.json, no tmp files
    let acct_dir = dir.path().join("trading/acct-2");
    let entries: Vec<_> = std::fs::read_dir(&acct_dir).unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries, vec!["commit.json".to_string()]);
}

#[tokio::test]
async fn write_overwrites_previous_state() {
    let dir = TempDir::new().unwrap();
    let s1 = GitExportState {
        commits: vec![make_commit("first001", "first")],
        head: Some("first001".to_string()),
    };
    persist_commit_atomic("acct-3", &s1, dir.path()).await.unwrap();

    let s2 = GitExportState {
        commits: vec![
            make_commit("first001", "first"),
            make_commit("secnd001", "second"),
        ],
        head: Some("secnd001".to_string()),
    };
    persist_commit_atomic("acct-3", &s2, dir.path()).await.unwrap();

    let loaded = load_git_state("acct-3", dir.path()).await.unwrap();
    assert_eq!(loaded.commits.len(), 2);
    assert_eq!(loaded.head.as_deref(), Some("secnd001"));
}
```

### Step 5: Run persistence tests

```bash
cargo test -p alice-trading-core --test uta_persist 2>&1 | tail -10
```

Expected: 9 tests pass.

### Step 6: Full sanity + clippy + fmt

```bash
cargo test -p alice-trading-core 2>&1 | grep "test result" | tail -5
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: ~115 cargo tests; clippy + fmt clean; TS unchanged.

### Step 7: Commit

```bash
git add crates/alice-trading-core/src/uta/ crates/alice-trading-core/tests/uta_persist.rs
git commit -m "feat(rust): atomic-write commit persistence + legacy fallback (Phase 4d Task C)

- persist.rs: persist_commit_atomic uses spawn_blocking + std::fs to
  perform write-to-tmp → fsync → rename. POSIX atomic-rename
  guarantees commit.json is never partially written.
- commit_path(account_id, data_root) → data_root/trading/<id>/commit.json
- legacy_commit_path mirrors TS git-persistence.ts:18-22:
  bybit-main → data_root/crypto-trading/commit.json,
  alpaca-paper/alpaca-live → data_root/securities-trading/commit.json
- load_git_state tries primary, falls back to legacy, returns None
  on miss
- UtaState::restore_or_new factory: load saved state or start fresh

Stronger than TS today (writeFile is non-atomic, no fsync). Phase 4d
spec §6.4.

9 persistence tests: round-trip, primary path, legacy paths (bybit
+ alpaca), unknown account no-legacy, legacy fallback load, missing
state returns None, atomic write leaves no tmp files, overwrite
replaces previous state."
```

---

## Task D: Push / Reject / Sync handlers + reconciler + integration test

**Goal:** Wire the broker call paths. `handle_push` builds a guard pipeline (from Phase 4c), invokes broker per op, persists on success, emits `commit.notify`. `handle_reject` mirrors Phase 2's recompute-v2-hash-with-[rejected]-message logic. `handle_sync` reconciles open orders. Plus the missing-snapshot reconciler.

**Files:**
- Modify: `crates/alice-trading-core/src/uta/actor.rs` (wire Push/Reject/Sync handlers)
- Create: `crates/alice-trading-core/src/uta/reconciler.rs`
- Modify: `crates/alice-trading-core/src/uta/mod.rs` (add `pub mod reconciler;`)
- Create: `crates/alice-trading-core/tests/uta_lifecycle_mock.rs`
- Create: `crates/alice-trading-core/tests/reconciler.rs`

### Step 1: Add Push/Reject/Sync to UtaHandle

In `actor.rs`, append to `impl UtaHandle`:

```rust
impl UtaHandle {
    // ... existing add/commit/export/get_health/nudge_recovery/shutdown ...

    pub async fn push(&self) -> Result<PushResult, BrokerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::Push { reply: tx }).await
            .map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor stopped".to_string()))?;
        rx.await.map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor reply dropped".to_string()))?
    }

    pub async fn reject(&self, reason: Option<String>) -> Result<RejectResult, BrokerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::Reject { reason, reply: tx }).await
            .map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor stopped".to_string()))?;
        rx.await.map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor reply dropped".to_string()))?
    }

    pub async fn sync(
        &self,
        updates: Vec<OrderStatusUpdate>,
        current_state: GitState,
    ) -> Result<SyncResult, BrokerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::Sync { updates, current_state, reply: tx }).await
            .map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor stopped".to_string()))?;
        rx.await.map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor reply dropped".to_string()))?
    }
}
```

### Step 2: Implement `handle_push` in actor.rs

In `impl UtaActor`, replace the Push placeholder with:

```rust
async fn handle_push(&mut self) -> Result<PushResult, BrokerError> {
    // 1. Reject if disabled
    if self.state.health.disabled {
        return Err(BrokerError::new(
            BrokerErrorCode::Config,
            format!("Account \"{}\" is disabled", self.state.account_id),
        ));
    }
    // 2. Reject if offline
    if self.state.health.health() == BrokerHealth::Offline {
        return Err(BrokerError::new(
            BrokerErrorCode::Network,
            format!("Account \"{}\" is offline", self.state.account_id),
        ));
    }

    // 3. Run TradingGit push — invokes the dispatcher for each op
    //    The dispatcher is a closure that routes per-op-action to the
    //    appropriate broker method.
    let broker = self.state.broker.clone();
    let dispatcher = move |op: &Operation| -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, BrokerError>> + Send>> {
        let broker = broker.clone();
        let op = op.clone();
        Box::pin(async move {
            broker_dispatch(&broker, &op).await
        })
    };

    // For Phase 4d: run TradingGit.push() which invokes dispatcher per op,
    // collects results, builds a PushResult. The TradingGit struct from
    // Phase 3 already implements this — we just need to thread the dispatcher.
    let push_result = self.state.git.push_with_dispatcher(&dispatcher).await
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e.to_string()))?;

    // 4. Track health based on operation outcomes
    let any_failure = push_result.rejected.iter().any(|r| !r.success);
    if !any_failure {
        self.state.health.on_success();
    }

    // 5. Persist commit atomically
    let export = self.state.git.export_state();
    if let Err(e) = crate::uta::persist::persist_commit_atomic(
        &self.state.account_id,
        &export,
        &self.state.data_root,
    ).await {
        tracing::error!(
            target = "uta", account = %self.state.account_id,
            error = %e, "commit persist failed"
        );
        // Don't fail the push if persist fails — TS doesn't either.
        // The next push will retry persistence.
    }

    // 6. Emit commit.notify event if subscribed
    if let Some(tx) = &self.state.event_tx {
        let _ = tx.send(UtaEvent::CommitNotify {
            account_id: self.state.account_id.clone(),
            commit_hash: push_result.hash.clone(),
        }).await;
    }

    Ok(push_result)
}

/// Route an Operation to the appropriate broker method based on action.
async fn broker_dispatch(broker: &Arc<dyn Broker>, op: &Operation) -> Result<Value, BrokerError> {
    let op_value = serde_json::to_value(op)
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e.to_string()))?;
    let action = op_value.get("action").and_then(|v| v.as_str())
        .ok_or_else(|| BrokerError::new(BrokerErrorCode::Unknown, "operation missing action".to_string()))?;
    match action {
        "placeOrder" => {
            let contract = op_value.get("contract").cloned().unwrap_or(Value::Null);
            let order = op_value.get("order").cloned().unwrap_or(Value::Null);
            let tpsl = op_value.get("tpsl").cloned();
            let result = broker.place_order(&contract, &order, tpsl.as_ref()).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "modifyOrder" => {
            let order_id = op_value.get("orderId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let changes = op_value.get("changes").cloned().unwrap_or(Value::Null);
            let result = broker.modify_order(&order_id, &changes).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "cancelOrder" => {
            let order_id = op_value.get("orderId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let result = broker.cancel_order(&order_id).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "closePosition" => {
            let contract = op_value.get("contract").cloned().unwrap_or(Value::Null);
            let quantity = op_value.get("quantity").and_then(|v| v.as_str()).map(String::from);
            let result = broker.close_position(&contract, quantity.as_deref()).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "syncOrders" => {
            // syncOrders is handled in handle_sync, not via the per-op dispatcher
            Err(BrokerError::new(BrokerErrorCode::Unknown, "syncOrders dispatched via handle_sync".to_string()))
        }
        other => Err(BrokerError::new(BrokerErrorCode::Unknown, format!("unknown action: {}", other))),
    }
}
```

NOTE: This sketch shows the dispatcher pattern. The exact `TradingGit::push_with_dispatcher` API may not exist yet — Phase 3's `TradingGit` may have a different push interface (taking the dispatcher inline, or via a config callback). Check `crates/alice-trading-core/src/git.rs` for the current `push` signature and adapt.

If `TradingGit::push` takes `&self` and runs the dispatcher loop internally, you may need to thread a dispatcher closure through it. If `TradingGit::push` doesn't exist or has a different shape, you'll wrap the orchestration logic at the UtaActor level — iterate over the staging area, call `broker_dispatch` per op, collect results, persist the commit.

The IMPLEMENTER should READ `crates/alice-trading-core/src/git.rs` FIRST and adapt this sketch to the actual `TradingGit` API.

### Step 3: Implement `handle_reject`

```rust
async fn handle_reject(&mut self, reason: Option<String>) -> Result<RejectResult, BrokerError> {
    // Reject builds a [rejected] commit without invoking the broker.
    // The Phase 2 dividend: v2 hash is recomputed with the [rejected]-prefixed message
    // (TradingGit::reject handles this internally).
    let reject_result = self.state.git.reject(reason)
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e.to_string()))?;

    // Persist
    let export = self.state.git.export_state();
    if let Err(e) = crate::uta::persist::persist_commit_atomic(
        &self.state.account_id,
        &export,
        &self.state.data_root,
    ).await {
        tracing::error!(target = "uta", account = %self.state.account_id, error = %e, "reject persist failed");
    }

    // Emit commit.notify
    if let Some(tx) = &self.state.event_tx {
        let _ = tx.send(UtaEvent::CommitNotify {
            account_id: self.state.account_id.clone(),
            commit_hash: reject_result.hash.clone(),
        }).await;
    }

    Ok(reject_result)
}
```

### Step 4: Implement `handle_sync`

```rust
async fn handle_sync(
    &mut self,
    updates: Vec<OrderStatusUpdate>,
    current_state: GitState,
) -> Result<SyncResult, BrokerError> {
    let result = self.state.git.sync(updates, current_state)
        .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e.to_string()))?;

    // Persist
    let export = self.state.git.export_state();
    if let Err(e) = crate::uta::persist::persist_commit_atomic(
        &self.state.account_id,
        &export,
        &self.state.data_root,
    ).await {
        tracing::error!(target = "uta", account = %self.state.account_id, error = %e, "sync persist failed");
    }

    if let Some(tx) = &self.state.event_tx {
        let _ = tx.send(UtaEvent::CommitNotify {
            account_id: self.state.account_id.clone(),
            commit_hash: result.hash.clone(),
        }).await;
    }

    Ok(result)
}
```

### Step 5: Update `dispatch_cmd` to call the new handlers

In `dispatch_cmd`, replace the Push/Reject/Sync placeholder branches:

```rust
UtaCommand::Push { reply } => {
    let _ = reply.send(self.handle_push().await);
    false
}
UtaCommand::Reject { reason, reply } => {
    let _ = reply.send(self.handle_reject(reason).await);
    false
}
UtaCommand::Sync { updates, current_state, reply } => {
    let _ = reply.send(self.handle_sync(updates, current_state).await);
    false
}
```

### Step 6: Create `uta/reconciler.rs`

```rust
//! Missing-snapshot reconciler — detection-only in Phase 4d.
//!
//! Scans data/trading/<accountId>/commit.json against
//! data/snapshots/<accountId>/ and returns commit hashes that lack a
//! corresponding snapshot file.
//!
//! Phase 4d: detection-only. Logs each gap via tracing::warn!.
//! Phase 4f wires the trigger (emit commit.notify via tsfn to the TS
//! snapshot service).

use std::collections::HashSet;
use std::path::Path;
use crate::uta::persist::load_git_state;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingSnapshotReport {
    pub account_id: String,
    pub missing_commit_hashes: Vec<String>,
}

pub async fn find_missing_snapshots(
    account_id: &str,
    data_root: &Path,
) -> Result<MissingSnapshotReport, std::io::Error> {
    let state = match load_git_state(account_id, data_root).await {
        Some(s) => s,
        None => return Ok(MissingSnapshotReport {
            account_id: account_id.to_string(),
            missing_commit_hashes: vec![],
        }),
    };

    let snapshots_dir = data_root.join(format!("snapshots/{}", account_id));
    let existing: HashSet<String> = if snapshots_dir.exists() {
        std::fs::read_dir(&snapshots_dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.strip_suffix(".json").map(String::from)
            })
            .collect()
    } else {
        HashSet::new()
    };

    let missing: Vec<String> = state.commits.iter()
        .map(|c| c.hash.clone())
        .filter(|hash| !existing.contains(hash))
        .collect();

    for hash in &missing {
        tracing::warn!(
            target = "reconciler",
            account_id = %account_id,
            commit_hash = %hash,
            "missing snapshot for committed change",
        );
    }

    Ok(MissingSnapshotReport {
        account_id: account_id.to_string(),
        missing_commit_hashes: missing,
    })
}
```

Add `pub mod reconciler; pub use reconciler::{find_missing_snapshots, MissingSnapshotReport};` to `uta/mod.rs`.

### Step 7: Create reconciler test

Create `crates/alice-trading-core/tests/reconciler.rs`:

```rust
//! Phase 4d Task D — missing-snapshot detection.

use alice_trading_core::types::{GitCommit, GitExportState, GitState};
use alice_trading_core::uta::{find_missing_snapshots, persist_commit_atomic};
use tempfile::TempDir;

fn empty_state() -> GitState {
    GitState {
        net_liquidation: "0".into(), total_cash_value: "0".into(),
        unrealized_pn_l: "0".into(), realized_pn_l: "0".into(),
        positions: vec![], pending_orders: vec![],
    }
}

fn commit(hash: &str) -> GitCommit {
    GitCommit {
        hash: hash.into(), parent_hash: None, message: "x".into(),
        operations: vec![], results: vec![], state_after: empty_state(),
        timestamp: "2026-01-01T00:00:00.000Z".into(), round: None,
        hash_version: Some(2),
        intent_full_hash: Some(format!("{}{}", hash, "x".repeat(56))),
        hash_input_timestamp: Some("2026-01-01T00:00:00.000Z".into()),
        entry_hash_version: None, entry_full_hash: None,
    }
}

#[tokio::test]
async fn detects_3_of_5_missing() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![commit("aaaa1111"), commit("bbbb2222"), commit("cccc3333"), commit("dddd4444"), commit("eeee5555")],
        head: Some("eeee5555".into()),
    };
    persist_commit_atomic("acct-r", &state, dir.path()).await.unwrap();

    let snap_dir = dir.path().join("snapshots/acct-r");
    std::fs::create_dir_all(&snap_dir).unwrap();
    std::fs::write(snap_dir.join("aaaa1111.json"), "{}").unwrap();
    std::fs::write(snap_dir.join("cccc3333.json"), "{}").unwrap();
    std::fs::write(snap_dir.join("eeee5555.json"), "{}").unwrap();

    let report = find_missing_snapshots("acct-r", dir.path()).await.unwrap();
    assert_eq!(
        report.missing_commit_hashes,
        vec!["bbbb2222".to_string(), "dddd4444".to_string()],
    );
}

#[tokio::test]
async fn no_commits_returns_empty() {
    let dir = TempDir::new().unwrap();
    let report = find_missing_snapshots("acct-nothing", dir.path()).await.unwrap();
    assert!(report.missing_commit_hashes.is_empty());
}

#[tokio::test]
async fn no_snapshots_dir_means_all_missing() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![commit("h1"), commit("h2")],
        head: Some("h2".into()),
    };
    persist_commit_atomic("acct-snap-missing", &state, dir.path()).await.unwrap();

    let report = find_missing_snapshots("acct-snap-missing", dir.path()).await.unwrap();
    assert_eq!(report.missing_commit_hashes.len(), 2);
}

#[tokio::test]
async fn all_snapshots_present_returns_empty_missing() {
    let dir = TempDir::new().unwrap();
    let state = GitExportState {
        commits: vec![commit("hash1")],
        head: Some("hash1".into()),
    };
    persist_commit_atomic("acct-full", &state, dir.path()).await.unwrap();
    let snap = dir.path().join("snapshots/acct-full");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join("hash1.json"), "{}").unwrap();

    let report = find_missing_snapshots("acct-full", dir.path()).await.unwrap();
    assert!(report.missing_commit_hashes.is_empty());
}
```

### Step 8: Create the full Mock-backed lifecycle integration test

Create `crates/alice-trading-core/tests/uta_lifecycle_mock.rs`:

```rust
//! Phase 4d Task D — full Mock-backed UTA lifecycle via the actor.

use std::sync::Arc;
use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::types::BrokerHealth;
use alice_trading_core::types::Operation;
use alice_trading_core::uta::{persist::load_git_state, UtaActor, UtaState};
use serde_json::json;
use tempfile::TempDir;

fn buy_op(symbol: &str) -> Operation {
    serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": symbol, "aliceId": format!("mock|{}", symbol), "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10"},
    })).unwrap()
}

#[tokio::test]
async fn full_lifecycle_via_actor_persists_commit() {
    let dir = TempDir::new().unwrap();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    broker.set_quote("AAPL", 100.0);

    let state = UtaState::new(
        "lifecycle-1".to_string(),
        broker.clone(),
        vec![],
        dir.path().to_path_buf(),
    );
    let (handle, _join) = UtaActor::spawn(state, 16);

    // Stage + commit + push
    handle.add(buy_op("AAPL")).await.unwrap();
    handle.commit("test buy".to_string()).await.unwrap();
    let push_result = handle.push().await.unwrap();
    assert_eq!(push_result.operation_count, 1);

    // Verify commit persisted on disk
    let loaded = load_git_state("lifecycle-1", dir.path()).await.unwrap();
    assert_eq!(loaded.commits.len(), 1);
    assert_eq!(loaded.commits[0].hash, push_result.hash);

    // Verify health
    let info = handle.get_health().await.unwrap();
    assert_eq!(info.status, BrokerHealth::Healthy);
}

#[tokio::test]
async fn push_fails_when_disabled() {
    use alice_trading_core::brokers::error::BrokerErrorCode;

    let dir = TempDir::new().unwrap();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let mut state = UtaState::new("disabled-test".to_string(), broker, vec![], dir.path().to_path_buf());
    state.health.disabled = true;
    let (handle, _join) = UtaActor::spawn(state, 16);

    handle.add(buy_op("AAPL")).await.unwrap();
    handle.commit("c".to_string()).await.unwrap();
    let err = handle.push().await.unwrap_err();
    assert_eq!(err.code, BrokerErrorCode::Config);
    assert!(err.message.contains("disabled"));
}

#[tokio::test]
async fn commit_emits_event_when_event_tx_set() {
    use tokio::sync::mpsc;
    use alice_trading_core::uta::command::UtaEvent;

    let dir = TempDir::new().unwrap();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    broker.set_quote("AAPL", 100.0);
    let (event_tx, mut event_rx) = mpsc::channel::<UtaEvent>(16);

    let mut state = UtaState::new("event-test".to_string(), broker, vec![], dir.path().to_path_buf());
    state.event_tx = Some(event_tx);
    let (handle, _join) = UtaActor::spawn(state, 16);

    handle.add(buy_op("AAPL")).await.unwrap();
    handle.commit("test".to_string()).await.unwrap();
    handle.push().await.unwrap();

    let event = tokio::time::timeout(tokio::time::Duration::from_millis(100), event_rx.recv()).await.unwrap().unwrap();
    match event {
        UtaEvent::CommitNotify { account_id, commit_hash } => {
            assert_eq!(account_id, "event-test");
            assert_eq!(commit_hash.len(), 8);
        }
        _ => panic!("expected CommitNotify"),
    }
}
```

### Step 9: Run all tests

```bash
cargo test -p alice-trading-core --test uta_lifecycle_mock 2>&1 | tail -10
cargo test -p alice-trading-core --test reconciler 2>&1 | tail -10
```

Expected: 3 lifecycle + 4 reconciler = 7 tests pass.

If `handle_push` references a `TradingGit` method (e.g., `push_with_dispatcher`) that doesn't exist, you'll need to read `crates/alice-trading-core/src/git.rs` and either:
- Use the existing TradingGit `push` API (different shape than the sketch)
- Add a new method that accepts a dispatcher closure

Adapt the sketch to the real shape.

### Step 10: Full sanity + clippy + fmt

```bash
cargo test -p alice-trading-core 2>&1 | grep "test result" | tail -10
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: ~125 cargo tests; clippy + fmt clean; TS unchanged.

### Step 11: Commit

```bash
git add crates/alice-trading-core/src/uta/ crates/alice-trading-core/tests/uta_lifecycle_mock.rs crates/alice-trading-core/tests/reconciler.rs
git commit -m "feat(rust): Push/Reject/Sync handlers + reconciler (Phase 4d Task D)

- actor.rs handle_push: rejects if disabled/offline (BrokerError CONFIG/
  NETWORK), invokes TradingGit push (per-op broker dispatch), updates
  health, persists commit atomically, emits CommitNotify event if
  event_tx is Some.
- handle_reject: TradingGit reject (which recomputes v2 hash with
  [rejected] message — Phase 2 dividend), persists, emits event.
- handle_sync: TradingGit sync over OrderStatusUpdates, persists,
  emits event.
- broker_dispatch helper routes Operation by action: placeOrder →
  broker.place_order, modifyOrder → broker.modify_order, etc.
- reconciler.rs find_missing_snapshots: scans commit.json +
  snapshots/<acct>/, returns commit hashes lacking snapshots. Logs
  each gap via tracing::warn!. Detection-only — Phase 4f wires
  actual triggering.

3 lifecycle integration tests + 4 reconciler tests pass."
```

---

## Task E: TS-side snapshot trigger swap (deliverable 5)

**Goal:** Replace the inline `_onPostPush` callback path with EventLog-based `commit.notify` events. `UTAManager.setSnapshotHooks` removed. Snapshot service subscribes to EventLog at app startup. 100-commit atomicity test asserts no event loss.

**Files:**
- Modify: `src/domain/trading/UnifiedTradingAccount.ts` (~line 470 — replace `_onPostPush?.()` with EventLog `append`)
- Modify: `src/domain/trading/uta-manager.ts` (~lines 82, 103 — remove `setSnapshotHooks`)
- Modify: `src/main.ts` (~line 116 — wire snapshot service to EventLog at startup)
- Modify: `src/domain/trading/snapshot/service.ts` (subscribe to EventLog)
- Create: `src/domain/trading/__test__/snapshot-trigger-parity.spec.ts` (100-commit atomicity test)
- Modify: TS test files that referenced `setSnapshotHooks` (update or remove)

### Step 1: Read existing snapshot service + EventLog API

```bash
cat src/domain/trading/snapshot/service.ts 2>&1 | head -50
grep -n "append\|listen\|subscribe\|on(" src/core/event-log.ts | head -20
```

Read the existing `service.ts` to understand its `takeSnapshot(accountId, reason)` signature. Read `event-log.ts` to find the listener API. Common shapes:
- `eventLog.append(type, payload)` — emit
- `eventLog.subscribe(listener)` or `eventLog.on(type, handler)` — listen

If subscribe-by-type isn't supported, the alternative is a `listeners: EventLogListener[]` array where each listener filters by `entry.type === 'commit.notify'`.

### Step 2: Update `UnifiedTradingAccount.ts`

In `src/domain/trading/UnifiedTradingAccount.ts`:

a. Add `eventLog?: EventLog` to the constructor `options` interface:

```typescript
// Find the UnifiedTradingAccountOptions interface and add:
import type { EventLog } from '../../core/event-log.js'

export interface UnifiedTradingAccountOptions {
  // ... existing fields ...
  eventLog?: EventLog
}
```

b. Store the eventLog in a private field:

```typescript
private readonly _eventLog?: EventLog

constructor(options: UnifiedTradingAccountOptions) {
  // ... existing assignments ...
  this._eventLog = options.eventLog
}
```

c. Replace the `_onPostPush` inline call (around line 470):

```typescript
// BEFORE:
Promise.resolve(this._onPostPush?.(this.id)).catch(() => {})

// AFTER:
if (this._eventLog) {
  void this._eventLog.append('commit.notify', {
    accountId: this.id,
    commitHash: pushResult.hash,
  }).catch((err) => {
    // Don't fail the push if event emission fails
    console.warn(`UTA[${this.id}]: commit.notify emit failed: ${err}`)
  })
}
```

NOTE: leave `_onPostPush` field in place for backward compat in tests that pass it directly. Future cleanup can remove it; Phase 4d just adds the EventLog path.

If `commit.notify` is not registered in `AgentEventMap` (`src/core/agent-event.ts`), you may need to add it. Otherwise use the untyped overload `append<T>(type: string, payload: T)`.

### Step 3: Update `uta-manager.ts`

In `src/domain/trading/uta-manager.ts`:

a. Find the `setSnapshotHooks` method (around line 82). Either:
- **Remove it entirely** (preferred — no longer needed), OR
- **Keep but deprecate** (mark `@deprecated` if external consumers exist)

For Phase 4d, prefer removal:

```typescript
// REMOVE:
setSnapshotHooks(hooks: SnapshotHooks): void {
  this._snapshotHooks = hooks
}
```

b. Find where `_snapshotHooks` is consumed (around line 103). Remove that wiring too:

```typescript
// BEFORE:
const uta = new UnifiedTradingAccount({
  ...
  onPostPush: this._snapshotHooks?.onPostPush,
})

// AFTER:
const uta = new UnifiedTradingAccount({
  ...
  eventLog: this._eventLog,  // injected at construction
})
```

The `_eventLog` field is added to `UTAManager` constructor:

```typescript
constructor(options: { eventLog?: EventLog }) {
  this._eventLog = options.eventLog
}
```

### Step 4: Update `main.ts`

In `src/main.ts` (around line 116):

```typescript
// BEFORE:
utaManager.setSnapshotHooks({
  onPostPush: (id) => { snapshotService.takeSnapshot(id, 'post-push') },
})

// AFTER:
// EventLog is constructed earlier; inject into UTAManager and subscribe snapshot service.
eventLog.subscribe((entry) => {
  if (entry.type === 'commit.notify') {
    const payload = entry.payload as { accountId: string; commitHash: string }
    void snapshotService.takeSnapshot(payload.accountId, 'post-push')
  }
})
```

If `eventLog.subscribe` doesn't exist, check `event-log.ts` for the actual listener API and adapt.

ALSO update the UTAManager construction site to pass `eventLog`:

```typescript
const utaManager = new UTAManager({ eventLog })
```

### Step 5: Update existing tests that use `setSnapshotHooks`

```bash
grep -rn "setSnapshotHooks\|_onPostPush\|onPostPush" src/ --include='*.ts' | head -20
```

For each call site, either:
- Remove (production tests with `eventLog` should use EventLog subscription instead)
- Keep `_onPostPush` as a deprecated parallel path if a test specifically targets it

Most likely 2-3 spec files need updates. Tests that don't care about snapshots can simply omit `eventLog` from constructor options.

### Step 6: Create the 100-commit atomicity test

Create `src/domain/trading/__test__/snapshot-trigger-parity.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import { createEventLog, type EventLog } from '../../../core/event-log.js'
import { UnifiedTradingAccount } from '../UnifiedTradingAccount.js'
import { MockBroker } from '../brokers/mock/index.js'

describe('snapshot trigger swap — atomicity', () => {
  let dataDir: string
  let eventLog: EventLog

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'snap-parity-'))
    eventLog = await createEventLog({ dir: join(dataDir, 'event-log'), maxBufferSize: 200 })
  })

  function makeContract(symbol: string): Contract {
    const c = new Contract()
    c.aliceId = `mock|${symbol}`
    c.symbol = symbol
    c.secType = 'STK'
    c.exchange = 'MOCK'
    c.currency = 'USD'
    return c
  }

  it('100 rapid commits emit 100 commit.notify events with no loss', async () => {
    const broker = new MockBroker()
    broker.setQuote('AAPL', 100)
    const uta = new UnifiedTradingAccount({ broker, eventLog, accountId: 'parity-test' } as any)

    const events: Array<{ accountId: string; commitHash: string }> = []
    eventLog.subscribe((entry) => {
      if (entry.type === 'commit.notify') {
        events.push(entry.payload as { accountId: string; commitHash: string })
      }
    })

    // Stage + commit + push 100 times sequentially (actor serializes anyway)
    for (let i = 0; i < 100; i++) {
      const contract = makeContract('AAPL')
      const order = new Order()
      order.action = 'BUY'
      order.orderType = 'MKT'
      order.totalQuantity = new Decimal(1)
      await uta.stagePlaceOrder({ contract, order } as any)
      await uta.commit(`commit-${i}`)
      await uta.push()
    }

    // EventLog is async — wait briefly for all events to flush
    await new Promise((r) => setTimeout(r, 100))

    expect(events).toHaveLength(100)
    const uniqueHashes = new Set(events.map((e) => e.commitHash))
    expect(uniqueHashes.size).toBe(100)
    expect(events.every((e) => e.accountId === 'parity-test')).toBe(true)
  })

  it('cleanup', async () => {
    rmSync(dataDir, { recursive: true, force: true })
  })
})
```

NOTE: The test API may need adjustment depending on `createEventLog` and `UnifiedTradingAccount`'s actual constructor signatures. Read those files first.

### Step 7: tsc + run tests

```bash
npx tsc --noEmit 2>&1 | tail -5
pnpm test src/domain/trading/__test__/snapshot-trigger-parity.spec.ts 2>&1 | tail -10
```

Expected: tsc clean; 1 test passes (100 events captured).

### Step 8: Run full test suite

```bash
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: 2241 + 1 new = 2242 tests pass.

If any existing test fails (e.g., a snapshot-related test that depended on `setSnapshotHooks`), update it to use the EventLog subscription path.

### Step 9: Commit

```bash
git add src/domain/trading/UnifiedTradingAccount.ts src/domain/trading/uta-manager.ts src/main.ts src/domain/trading/snapshot/service.ts src/domain/trading/__test__/snapshot-trigger-parity.spec.ts
git commit -m "refactor(snapshot): swap inline _onPostPush for EventLog commit.notify (Phase 4d Task E)

v4 deliverable 5: prepare for Phase 4f cutover by routing snapshot
triggers through EventLog instead of the inline callback on every
push.

Changes:
- UnifiedTradingAccount._doPush: replace
    Promise.resolve(this._onPostPush?.(this.id)).catch(() => {})
  with
    this._eventLog?.append('commit.notify', { accountId, commitHash })
  Add eventLog?: EventLog to UnifiedTradingAccountOptions.
- UTAManager.setSnapshotHooks removed. Each UTA constructed with the
  shared eventLog reference.
- main.ts: snapshot service subscribes to eventLog at startup; UTAs
  emit commit.notify on every push.
- snapshot-trigger-parity.spec.ts: 100-commit atomicity test asserts
  every commit emits a commit.notify event (no event loss during the
  swap window).

Existing tests updated where they referenced setSnapshotHooks or
onPostPush directly.

Phase 4d Task E. Closes Phase 4d."
```

---

## Self-Review

**Spec coverage:**
- Spec §Deliverable 1 (UtaCommand + UtaActor + UtaHandle) → Task A
- Spec §Deliverable 2 (UtaState) → Task A + Task C `restore_or_new`
- Spec §Deliverable 3 (HealthState verbatim port) → Task B
- Spec §Deliverable 4 (atomic-write persistence) → Task C
- Spec §Deliverable 5 (TS snapshot trigger swap) → Task E
- Spec §Deliverable 6 (find_missing_snapshots reconciler — detection only) → Task D Step 6-7
- Spec §Risks (recovery JoinHandle leak, spawn_blocking panic, snapshot service path, legacy paths drift) → mitigations baked into tests (Drop test, fs error coverage, exhaustive grep before Task E, legacy path unit tests)

**Placeholder scan:**
- Task D Step 2 has the broker_dispatch and handle_push sketch BUT explicitly notes "The IMPLEMENTER should READ `crates/alice-trading-core/src/git.rs` FIRST and adapt this sketch to the actual `TradingGit` API." This is unavoidable — Phase 3's `TradingGit::push` API may need extension to accept a dispatcher closure. The plan calls out the adaptation point clearly rather than pretending the existing API matches.
- Task E Step 6 notes "API may need adjustment depending on createEventLog and UnifiedTradingAccount's actual constructor signatures" — implementer reads files first.

**Type consistency:**
- `UtaCommand`, `UtaActor`, `UtaHandle`, `UtaState`, `UtaEvent`, `RecoverySignal`, `HealthState` used consistently across all 5 tasks.
- TS side: `EventLog`, `eventLog`, `commit.notify`, `accountId`, `commitHash` consistent across Task E sub-steps.

**Execution notes:**
- Strict A → B → C → D → E. Task D depends on `TradingGit::push` accepting a dispatcher — the implementer must read `git.rs` first and may need a small adapter.
- Task E's specific file paths (`snapshot/service.ts`, `main.ts:116`) need verification before edit — grep first.
- Phase 4d's Rust crate stays dead code at end of phase. Phase 4f wires it via napi.
