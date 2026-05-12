# Phase 4d — Rust UtaActor + TradingGit persistence

**Status:** approved 2026-05-12.
**Source:** [`docs/RUST_MIGRATION_PLAN.v4.md:920-978`](../../RUST_MIGRATION_PLAN.v4.md) Phase 4d, scope narrowed to deliverables 1-5 per the decisions below.

## Resolved decisions

| # | Decision |
|---|----------|
| 1 | **Scope deliverables 1-5 only** (chose A). Deliverables 6 (HTTP UTA lifecycle) and 7 (reconnect ownership matrix with tsfn) deferred to Phase 4f — both require napi binding work, contradicting the cutover gate's "not yet exposed to TS host" mandate. |
| 2 | **`tokio::sync::mpsc::channel`** for the command bus (per v4 spec). One actor per UTA; commands dispatched via `oneshot::channel` reply pattern. |
| 3 | **Health state machine ported verbatim** from `UnifiedTradingAccount.ts:193-328`. Same field names, same thresholds (degraded ≥3, offline ≥6), same backoff (5s base → 60s cap, exponential `min(5000 * 2^attempt, 60000)`). |
| 4 | **Atomic-write persistence** via `std::fs` in `tokio::task::spawn_blocking`. Write-to-tmp + `sync_all()` + atomic rename. Stronger than TS today (`writeFile` is non-atomic, no fsync). |
| 5 | **Reconciler is detection-only** in Phase 4d. Exposes `find_missing_snapshots(account_id) -> Vec<CommitHash>` + `tracing::warn!` per gap. Actual triggering deferred to Phase 4f when FFI exists. |
| 6 | **Snapshot trigger swap** (TS-side deliverable 5): emit `commit.notify` from inside `_doPush()` after persist; snapshot service subscribes to EventLog directly. `UTAManager.setSnapshotHooks` removed. |

## Goal

Stand up a complete internal Rust per-UTA actor that:
- Owns `TradingGit` and the broker connection
- Drives broker calls through the guard pipeline (Phase 4c)
- Tracks health with degrade/offline transitions + exponential-backoff recovery
- Durably persists every commit to `data/trading/<accountId>/commit.json` with the atomic-write recipe
- Exposes a `find_missing_snapshots` detection function for the boot-time reconciler

Plus a TS-side snapshot-trigger swap so both TS production (today) and Rust production (Phase 4f) emit/consume snapshots through the same EventLog pathway.

Phase 4d's Rust crate stays **dead code** — no live consumer. Phase 4f wires it into TS via napi.

## Architecture

New module tree under `crates/alice-trading-core/src/uta/`. Pure Rust — no napi exposure in this phase.

```
crates/alice-trading-core/src/uta/
├── mod.rs                # re-exports + module docs
├── actor.rs              # UtaActor, run loop, command dispatch, UtaHandle
├── state.rs              # UtaState struct
├── command.rs            # UtaCommand + UtaEvent enums
├── health.rs             # HealthState + transitions + recovery task
├── persist.rs            # atomic-write commit.json + load + legacy fallback
└── reconciler.rs         # find_missing_snapshots (detection-only)
```

**Tech stack additions** in `crates/alice-trading-core/Cargo.toml`:
- `tempfile = "3"` (dev-dep only) — for integration test fixture filesystems

All other deps (`tokio`, `async_trait`, `serde`, `serde_json`, `chrono`, `tracing`, `thiserror`, `bigdecimal`) already in scope from Phases 3+4a+4b+4c.

## Deliverable 1: UtaCommand + UtaActor + UtaHandle

```rust
// crates/alice-trading-core/src/uta/command.rs

use tokio::sync::oneshot;
use crate::brokers::error::BrokerError;
use crate::brokers::types::BrokerHealthInfo;
use crate::types::{AddResult, CommitPrepareResult, GitExportState, Operation, PushResult, RejectResult, SyncResult};

pub enum UtaCommand {
    Add { op: Operation, reply: oneshot::Sender<Result<AddResult, String>> },
    Commit { message: String, reply: oneshot::Sender<Result<CommitPrepareResult, String>> },
    Push { reply: oneshot::Sender<Result<PushResult, BrokerError>> },
    Reject { reason: Option<String>, reply: oneshot::Sender<Result<RejectResult, String>> },
    Sync { reply: oneshot::Sender<Result<SyncResult, BrokerError>> },
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

```rust
// crates/alice-trading-core/src/uta/actor.rs

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub struct UtaActor {
    cmd_rx: mpsc::Receiver<UtaCommand>,
    state: UtaState,
}

pub struct UtaHandle {
    pub account_id: String,
    cmd_tx: mpsc::Sender<UtaCommand>,
}

impl UtaActor {
    /// Build and spawn the actor on a tokio task. Returns the public
    /// handle + the JoinHandle for graceful shutdown.
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
                UtaCommand::Add { op, reply }            => { let _ = reply.send(self.handle_add(op)); }
                UtaCommand::Commit { message, reply }    => { let _ = reply.send(self.handle_commit(message)); }
                UtaCommand::Push { reply }               => { let _ = reply.send(self.handle_push().await); }
                UtaCommand::Reject { reason, reply }     => { let _ = reply.send(self.handle_reject(reason).await); }
                UtaCommand::Sync { reply }               => { let _ = reply.send(self.handle_sync().await); }
                UtaCommand::GetHealth { reply }          => { let _ = reply.send(self.state.health.info()); }
                UtaCommand::NudgeRecovery                => { self.state.health.nudge_recovery(); }
                UtaCommand::ExportState { reply }        => { let _ = reply.send(self.state.git.export_state()); }
                UtaCommand::Shutdown { reply }           => { let _ = reply.send(()); return; }
            }
        }
    }

    async fn handle_push(&mut self) -> Result<PushResult, BrokerError> {
        // 1. Reject if disabled or offline
        if self.state.health.disabled {
            return Err(BrokerError::new(BrokerErrorCode::Config, format!("Account \"{}\" is disabled", self.state.account_id)));
        }
        if self.state.health.health() == BrokerHealth::Offline {
            return Err(BrokerError::new(BrokerErrorCode::Network, format!("Account \"{}\" is offline", self.state.account_id)));
        }
        // 2. Build guard-pipeline + dispatcher (broker.place_order/modify/etc per op.action)
        // 3. Execute push via TradingGit
        // 4. On success: persist commit atomically
        // 5. Emit UtaEvent::CommitNotify if event_tx is Some
        // 6. health.on_success() on success, health.on_failure(err) on broker error
        // ...
    }
}

impl UtaHandle {
    pub async fn push(&self) -> Result<PushResult, BrokerError> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(UtaCommand::Push { reply: tx }).await
            .map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor stopped".to_string()))?;
        rx.await.map_err(|_| BrokerError::new(BrokerErrorCode::Unknown, "actor reply dropped".to_string()))?
    }
    // ... one method per UtaCommand variant ...
}
```

`UtaHandle` is `Clone`-able (`Sender` is `Clone`). Multiple consumers can hold handles. The actor task lives until `Shutdown` is processed or all senders drop.

## Deliverable 2: UtaState

```rust
// crates/alice-trading-core/src/uta/state.rs

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use crate::brokers::traits::Broker;
use crate::git::TradingGit;
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
}

impl UtaState {
    pub async fn restore_or_new(
        account_id: String,
        broker: Arc<dyn Broker>,
        guards: Vec<Box<dyn Guard>>,
        data_root: &Path,
    ) -> Result<Self, std::io::Error> {
        let commit_path = data_root.join(format!("trading/{}/commit.json", account_id));
        let git = match crate::uta::persist::load_git_state(&account_id, data_root).await {
            Some(state) => TradingGit::restore(state),
            None => TradingGit::new(),
        };
        Ok(Self {
            account_id,
            git,
            broker,
            guards,
            health: HealthState::default(),
            commit_path,
            event_tx: None,
        })
    }
}
```

`event_tx` is `None` for the Phase 4d integration test; Phase 4f passes a real `mpsc::Sender<UtaEvent>` bridged to TS via tsfn.

## Deliverable 3: HealthState (verbatim port)

```rust
// crates/alice-trading-core/src/uta/health.rs

use chrono::{DateTime, Utc};
use tokio::task::JoinHandle;
use crate::brokers::error::BrokerError;
use crate::brokers::types::{BrokerHealth, BrokerHealthInfo};

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
        if self.disabled { return BrokerHealth::Offline; }
        if self.consecutive_failures >= Self::OFFLINE_THRESHOLD { return BrokerHealth::Offline; }
        if self.consecutive_failures >= Self::DEGRADED_THRESHOLD { return BrokerHealth::Unhealthy; }
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

    pub fn on_success(&mut self) {
        self.consecutive_failures = 0;
        self.last_success_at = Some(Utc::now());
        if let Some(task) = self.recovery_task.take() {
            task.abort();
            self.recovering = false;
        }
    }

    pub fn on_failure(&mut self, err: &BrokerError) {
        self.consecutive_failures += 1;
        self.last_error = Some(err.message.clone());
        self.last_failure_at = Some(Utc::now());
        if err.code == BrokerErrorCode::Config || err.code == BrokerErrorCode::Auth {
            // Permanent — disable the account
            self.disabled = true;
        }
        if self.health() == BrokerHealth::Offline && !self.recovering {
            // start_recovery requires &Arc<dyn Broker> — actor calls this via separate method
        }
    }

    /// Called by the actor when health transitions to offline.
    pub fn start_recovery(&mut self, broker: Arc<dyn Broker>) {
        if self.recovering { return; }
        self.recovering = true;
        let task = tokio::spawn(async move {
            // Recovery loop: attempt = 0, 1, 2, ... with exp backoff
            // On success: caller (actor) will see broker.init() succeeded, calls on_success
        });
        self.recovery_task = Some(task);
    }

    /// Cancel and re-spawn recovery with attempt=0.
    pub fn nudge_recovery(&mut self) {
        if !self.recovering || self.disabled { return; }
        if let Some(task) = self.recovery_task.take() {
            task.abort();
        }
        // Re-spawn (caller must invoke start_recovery again with broker)
        // Phase 4d simplification: nudge cancels; actor re-arms next failure
    }
}

impl Default for HealthState { /* all defaults */ }

impl Drop for HealthState {
    fn drop(&mut self) {
        if let Some(task) = self.recovery_task.take() {
            task.abort();
        }
    }
}
```

The recovery task's exact loop body needs access to `broker` (to call `init` + `get_account`) AND a way to signal back to the actor on success/failure. In Phase 4d's design, the actor's `handle_push` and similar methods check `health.health() == Offline` and reject; the recovery task lives separately and notifies via a small channel back to the actor. The plan will lock the exact mechanism.

## Deliverable 4: Atomic-write persistence

```rust
// crates/alice-trading-core/src/uta/persist.rs

use std::path::{Path, PathBuf};
use crate::types::GitExportState;

pub fn commit_path(account_id: &str, data_root: &Path) -> PathBuf {
    data_root.join(format!("trading/{}/commit.json", account_id))
}

/// Legacy path fallbacks — mirrors TS git-persistence.ts:18-22.
pub fn legacy_commit_path(account_id: &str, data_root: &Path) -> Option<PathBuf> {
    match account_id {
        "bybit-main" => Some(data_root.join("crypto-trading/commit.json")),
        "alpaca-paper" | "alpaca-live" => Some(data_root.join("securities-trading/commit.json")),
        _ => None,
    }
}

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

/// Atomic-write recipe — durable across crashes:
///   1. Write JSON to a sibling tmp file (`commit.json.tmp.<pid>`)
///   2. fsync the tmp file
///   3. Atomic rename(tmp, primary) — POSIX-guaranteed on same filesystem
///   4. Best-effort fsync the parent directory entry
///
/// This is stronger than TS today (writeFile is non-atomic, no fsync).
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
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
}
```

## Deliverable 5: TS-side snapshot trigger swap

Three TS files change:

### `src/domain/trading/UnifiedTradingAccount.ts`

In `_doPush()`, AFTER `await this.git.push(...)` (around line 429), replace:

```typescript
// BEFORE:
Promise.resolve(this._onPostPush?.(this.id)).catch(() => {})

// AFTER:
this._eventLog?.emit('commit.notify', {
  accountId: this.id,
  commitHash: pushResult.hash,
})
```

`_eventLog` is a new optional constructor option (`{ eventLog?: EventLog }`). Existing callers don't pass it (default undefined); production wiring passes the real `EventLog` instance from `src/core/event-log.ts`.

### `src/domain/trading/uta-manager.ts`

Remove `setSnapshotHooks` method (around line 103-104). The snapshot wiring moves to app startup (see next file).

### Snapshot service location

Find the file that currently consumes `_onPostPush` via `setSnapshotHooks`. Replace its inline hook installation with:

```typescript
eventLog.subscribe('commit.notify', async (event) => {
  await this.handleCommit(event.accountId, event.commitHash)
})
```

The exact file path needs discovery during implementation — likely `src/domain/trading/snapshot/snapshot-service.ts` or wired via `src/main.ts`.

### Atomicity test

New file `src/domain/trading/__test__/snapshot-trigger-parity.spec.ts`:

```typescript
it('100 rapid commits produce 100 commit.notify events with no loss', async () => {
  const events: Array<{accountId: string; commitHash: string}> = []
  const eventLog = createEventLog()
  eventLog.subscribe('commit.notify', (e) => events.push(e))
  const uta = makeUta({ eventLog })

  // Stage + commit + push 100 times concurrently
  const promises: Promise<unknown>[] = []
  for (let i = 0; i < 100; i++) {
    promises.push((async () => {
      await uta.stagePlaceOrder({...})
      await uta.commit(`commit-${i}`)
      await uta.push()
    })())
  }
  await Promise.all(promises)

  expect(events).toHaveLength(100)
  // Each commit hash unique
  expect(new Set(events.map(e => e.commitHash)).size).toBe(100)
})
```

The actor pattern from Phase 4a already serializes the 100 push calls, so this test is deterministic.

## Deliverable 6: Missing-snapshot reconciler (detection-only)

```rust
// crates/alice-trading-core/src/uta/reconciler.rs

use std::collections::HashSet;
use std::path::Path;
use crate::uta::persist::load_git_state;

#[derive(Debug, Clone)]
pub struct MissingSnapshotReport {
    pub account_id: String,
    pub missing_commit_hashes: Vec<String>,
}

/// Scans commit.json + the snapshots directory for an account; returns
/// the set of commit hashes that lack a corresponding snapshot file.
///
/// Phase 4d: DETECTION ONLY. Logs each gap via `tracing::warn!`.
/// Phase 4f wires the actual trigger (emit `commit.notify` via tsfn to
/// the TS snapshot service).
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
                // Snapshot filenames are <hash>.json — extract the hash prefix
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

Unit test (in `tests/reconciler.rs`):
- Build a `tempdir` filesystem with `commit.json` containing 5 commits + `snapshots/<id>/<h1>.json` + `<h3>.json` + `<h5>.json`
- Assert `find_missing_snapshots` returns `[h2, h4]`

## Files

**New Rust:**
- `crates/alice-trading-core/src/uta/mod.rs` (~30 lines)
- `crates/alice-trading-core/src/uta/actor.rs` (~250 lines)
- `crates/alice-trading-core/src/uta/state.rs` (~60 lines)
- `crates/alice-trading-core/src/uta/command.rs` (~80 lines)
- `crates/alice-trading-core/src/uta/health.rs` (~250 lines)
- `crates/alice-trading-core/src/uta/persist.rs` (~120 lines)
- `crates/alice-trading-core/src/uta/reconciler.rs` (~100 lines)
- `crates/alice-trading-core/tests/uta_lifecycle_mock.rs` (~250 lines)
- `crates/alice-trading-core/tests/uta_health_transitions.rs` (~200 lines)
- `crates/alice-trading-core/tests/reconciler.rs` (~120 lines)

**Modify Rust:**
- `crates/alice-trading-core/src/lib.rs` (add `pub mod uta;`)
- `crates/alice-trading-core/Cargo.toml` (add `tempfile = "3"` to `[dev-dependencies]`)

**Modify TS** (deliverable 5 — snapshot trigger swap):
- `src/domain/trading/UnifiedTradingAccount.ts` — replace `_onPostPush` inline call in `_doPush()` with `_eventLog?.emit('commit.notify', ...)`; add `eventLog?` constructor option
- `src/domain/trading/uta-manager.ts` — remove `setSnapshotHooks` method (lines 103-104)
- Snapshot service file (path discovered during implementation) — replace inline hook with `eventLog.subscribe('commit.notify', ...)`
- Wiring in `src/main.ts` or app-startup file — subscribe snapshot service to EventLog at boot

**New TS test:**
- `src/domain/trading/__test__/snapshot-trigger-parity.spec.ts` — 100-commit atomicity assertion

## DoD

```bash
cargo test -p alice-trading-core uta::
cargo test -p alice-trading-core --test uta_lifecycle_mock
cargo test -p alice-trading-core --test uta_health_transitions
cargo test -p alice-trading-core --test reconciler
cargo clippy -p alice-trading-core --all-targets -- -D warnings
cargo fmt -p alice-trading-core --check
npx tsc --noEmit
pnpm test                                          # 2241+ tests, including snapshot-trigger-parity
```

## Cutover gate

- All Rust integration tests green (lifecycle + health + reconciler)
- TS snapshot trigger swap: 100-commit atomicity test green; all existing snapshot tests still pass
- Existing 2241+ TS tests unchanged in count (snapshot-trigger-parity adds 1+ tests)
- Rust crate is **dead code** — no live consumer until Phase 4f
- Reconciler logs detected gaps via `tracing::warn!` but does NOT trigger actual snapshots (Phase 4f wires that)

## Rollback

`git revert` the Phase 4d commits. Rust UTA module is dead code (no live consumer). TS changes (deliverable 5) are isolated to the snapshot trigger pathway — reverting restores the inline `_onPostPush` callback.

## Estimated effort

4-5 eng-days:
- Day 1: command.rs + actor.rs scaffold (Add/Commit/ExportState/Shutdown variants — simple synchronous handlers)
- Day 2: persist.rs (atomic-write recipe + load + legacy fallbacks) + state.rs + restore_or_new
- Day 3: health.rs (state machine + recovery task) + handle_push + handle_reject + handle_sync (broker calls + guard pipeline integration)
- Day 4: reconciler.rs + 3 integration tests
- Day 5: TS snapshot trigger swap + atomicity test + edge cases + clippy/fmt polish

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Recovery task `JoinHandle` leak on shutdown | Medium | Medium | `Drop` impl on `HealthState` aborts task |
| `tokio::task::spawn_blocking` panic on filesystem error | Medium | High | Wrap all fs ops in Result; integration test simulates `EACCES` via read-only tempdir |
| TS snapshot service path unknown — risk of missing a call site | Medium | High | Grep for `setSnapshotHooks` AND `_onPostPush` AND `commit.notify` exhaustively before swap; document discovered files in PR |
| 100-commit atomicity test flaky due to vitest scheduling | Low | Medium | Use Promise.all + actor serialization from Phase 4a — deterministic |
| Reconciler false positives (commit exists, snapshot filename format unknown) | Low | Low | Match `<hash>.json` exactly; integration test verifies against fixture |
| Legacy path fallback paths drift from TS source-of-truth | Low | Medium | Mirror `git-persistence.ts:18-22` literally; unit test asserts identity |
| Recovery task's broker reference creates Arc cycle | Medium | High | Recovery task captures `Weak<dyn Broker>` (upgrade on each attempt); release Arc on success |
| The "recovery loop signals success back to actor" path adds coupling | Medium | Medium | Use a small `mpsc::Sender<RecoverySignal>` from health → actor; actor processes signals via the main run loop |

## Out of scope

- **Deliverable 6: HTTP UTA lifecycle (`spawn(config) -> UtaHandle`, `teardown`, 100-cycle leak test).** Phase 4f — requires napi binding.
- **Deliverable 7: reconnect ownership matrix + tsfn re-registration.** Phase 4f.
- **Actual snapshot generation triggered by reconciler.** Phase 4f — Phase 4d is detection-only.
- **UTAManager-equivalent in Rust** (managing multiple actors). Phase 4f.
- **napi exposure of UtaActor / UtaHandle.** Phase 4f.
- **Broker execution journal** (pre-call/post-call logging). Phase 4e.
- **Real broker ports** beyond MockBroker. Later phases or via FFI proxy.
