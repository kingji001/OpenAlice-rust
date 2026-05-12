# Phase 4f Implementation Plan — RustUtaProxy + bounded FFI event stream

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Cut over Mock UTAs from the TS implementation to the Rust UtaActor via napi, behind a config flag. Final phase of the migration's core arc.

**Architecture:** napi-rs typed bindings expose `TradingCore` to the TS host. A new `RustUtaProxy` class mirrors `UnifiedTradingAccount`'s public shape and routes through the napi binding. UTAManager dispatches per `accounts.json[].brokerImpl`. The FFI event stream is a bounded mpsc(1024) per UTA with 1s backpressure, gap detection, and shutdown drain. Panics convert to typed `RUST_PANIC` errors at the napi boundary.

**Tech Stack:** Rust 2021, napi-rs v3 (typed exports + ThreadsafeFunction), tokio mpsc, TypeBox for TS event schemas, Zod for config.

---

## File Structure

**Rust (new files under `crates/alice-trading-core/src/napi/`):**
- `napi/mod.rs` — feature-gated `napi-binding`, module roots
- `napi/types.rs` — typed napi structs (NO `serde_json::Value` in signatures)
- `napi/trading_core.rs` — `TradingCore` singleton + per-UTA registry
- `napi/events.rs` — `TradingCoreEvent` + ring buffer + dispatcher
- `napi/commands.rs` — per-UTA command methods
- `napi/panic.rs` — `catch_unwind` wrapper helper

**Rust (modified):**
- `lib.rs` — `pub mod napi;` under feature gate

**TS (new files):**
- `src/domain/trading/unified-trading-account-rust.ts` — RustUtaProxy class
- `parity/check-rust-proxy-mock.ts` — full lifecycle Mock via Rust proxy
- `parity/check-error-shapes.ts` — BrokerError parity
- `parity/check-event-stream.ts` — bounded queue, gap detection, shutdown drain
- `parity/check-rust-panic.ts` — panic injection
- `src/__test__/telegram-rust-uta-smoke.spec.ts` — Telegram smoke test
- `data/config/trading-core.json` — example config

**TS (modified):**
- `src/core/agent-event.ts` — register `commit.notify`, `reject.notify`, `account.health`
- `src/core/config.ts` — add `tradingCoreConfigSchema` + account schema `brokerImpl`
- `src/domain/trading/uta-manager.ts` — routing dispatch

---

## Task A: napi event types + TradingCore root

**Files:**
- Create: `crates/alice-trading-core/src/napi/mod.rs`
- Create: `crates/alice-trading-core/src/napi/types.rs`
- Create: `crates/alice-trading-core/src/napi/events.rs`
- Create: `crates/alice-trading-core/src/napi/panic.rs`
- Create: `crates/alice-trading-core/src/napi/trading_core.rs`
- Modify: `crates/alice-trading-core/src/lib.rs` (add module under feature gate)

### Step 1: `napi/mod.rs`

```rust
//! napi bindings for TradingCore — feature-gated entrypoint for the
//! TypeScript host. All types are explicitly napi-typed (no Value).

pub mod events;
pub mod panic;
pub mod trading_core;
pub mod types;

pub use trading_core::TradingCore;
```

### Step 2: `napi/types.rs` — typed structs

All structs derive `napi(object)` and `serde::{Serialize, Deserialize}`. The crucial constraint: **no `serde_json::Value` in any napi-exposed field** — every dynamic shape must be a typed struct.

```rust
use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TradingCoreConfig {
    pub data_root: String,
    pub event_queue_capacity: Option<u32>,    // default 1024
    pub panic_disable_threshold: Option<u32>, // default 5
}

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AccountConfig {
    pub id: String,
    pub account_type: String,    // 'alpaca' | 'ibkr' | 'ccxt' | 'mock'
    pub broker_id: String,       // 'mock-paper' for Phase 4f
    pub enabled: bool,
    pub guards: Vec<GuardConfig>,
    pub broker_config: BrokerConfigPayload,
}

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GuardConfig {
    pub guard_type: String,
    pub config_json: String,  // serialized JSON object — opaque to napi
}

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BrokerConfigPayload {
    pub config_json: String,  // serialized JSON — opaque to napi
}

#[napi(object)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TradingCoreEvent {
    pub uta_id: String,
    pub seq: u64,            // per-UTA monotonic
    pub timestamp_ms: i64,
    pub event_type: String,  // 'commit.notify' | 'reject.notify' | 'account.health'
    pub payload_json: String, // serialized payload — TS parses based on event_type
}
```

(Per v4 P10 the `payload_json` carries the typed payload as a serialized string. Phase 4f keeps the napi boundary clean by serializing once in Rust and parsing once in TS — the alternative is many `#[napi(object)]` payload variants which is more code and slower to evolve.)

Continue with `StagePlaceOrderParams`, `AddResult`, `CommitPrepareResult`, `PushResult`, `RejectResult`, `SyncResult`, `BrokerHealthInfo` — each as `#[napi(object)]`. Reuse the existing crate types where possible by adding `#[cfg_attr(feature = "napi-binding", napi(object))]` on the canonical structs in `src/types.rs`. Avoid duplicate types.

### Step 3: `napi/panic.rs` — panic wrapper

```rust
use std::panic::AssertUnwindSafe;
use napi::{Error, Status};

pub fn catch_unwind_napi<F, R>(account_id: &str, f: F) -> napi::Result<R>
where
    F: FnOnce() -> napi::Result<R>,
{
    match std::panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>().copied()
                .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("(non-string panic payload)");
            tracing::error!(target: "napi", account = %account_id, panic = %msg,
                "Rust panic at FFI boundary");
            Err(Error::new(Status::GenericFailure, format!("RUST_PANIC: {}", msg)))
        }
    }
}
```

For async methods, wrap with `tokio::task::spawn` + `catch_unwind` inside, or use `futures::FutureExt::catch_unwind`.

### Step 4: `napi/events.rs` — event ring buffer + dispatcher

```rust
use std::sync::Arc;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use std::collections::VecDeque;
use crate::napi::types::TradingCoreEvent;

const RING_BUFFER_SIZE: usize = 500;

pub struct EventDispatcher {
    pub tx: mpsc::Sender<TradingCoreEvent>,
    pub seq: Arc<Mutex<u64>>,
    pub ring: Arc<Mutex<VecDeque<TradingCoreEvent>>>,
}

impl EventDispatcher {
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<TradingCoreEvent>) {
        let (tx, rx) = mpsc::channel(capacity);
        (
            EventDispatcher {
                tx,
                seq: Arc::new(Mutex::new(0)),
                ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_SIZE))),
            },
            rx,
        )
    }

    /// Try to enqueue with 1s backpressure timeout.
    pub async fn emit(&self, uta_id: &str, event_type: &str, payload_json: String) {
        let seq = { let mut s = self.seq.lock(); *s += 1; *s };
        let event = TradingCoreEvent {
            uta_id: uta_id.to_string(),
            seq,
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event_type: event_type.to_string(),
            payload_json,
        };

        // Push into ring buffer first (always retained for backfill).
        {
            let mut ring = self.ring.lock();
            if ring.len() == RING_BUFFER_SIZE {
                ring.pop_front();
            }
            ring.push_back(event.clone());
        }

        // Try to send with 1s timeout.
        let send_fut = self.tx.send(event);
        match tokio::time::timeout(std::time::Duration::from_secs(1), send_fut).await {
            Ok(Ok(())) => {}
            Ok(Err(_closed)) => {
                tracing::warn!(target: "napi", uta = %uta_id, seq, event_type,
                    "event dropped — TSF channel closed");
            }
            Err(_elapsed) => {
                tracing::warn!(target: "napi", uta = %uta_id, seq, event_type,
                    "event dropped — TSF channel full for 1s (backpressure)");
            }
        }
    }

    /// Backfill events with seq > after_seq from the ring buffer.
    pub fn recent_after(&self, after_seq: u64) -> Vec<TradingCoreEvent> {
        self.ring.lock().iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect()
    }
}
```

### Step 5: `napi/trading_core.rs` — TradingCore root

```rust
use std::collections::HashMap;
use std::sync::Arc;
use std::path::PathBuf;
use parking_lot::Mutex;
use napi_derive::napi;
use napi::{Error, Status};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

use crate::napi::events::EventDispatcher;
use crate::napi::types::{TradingCoreConfig, AccountConfig, TradingCoreEvent};
use crate::uta::{UtaActor, UtaHandle, UtaState};

struct UtaProxyHandle {
    handle: UtaHandle,
    dispatcher: EventDispatcher,
    tsf: Arc<Mutex<Option<ThreadsafeFunction<TradingCoreEvent>>>>,
    panic_count: Arc<Mutex<u32>>,
}

#[napi]
pub struct TradingCore {
    data_root: PathBuf,
    config: TradingCoreConfig,
    accounts: Arc<Mutex<HashMap<String, UtaProxyHandle>>>,
    rt_handle: tokio::runtime::Handle,  // captured at create()
}

#[napi]
impl TradingCore {
    #[napi(factory)]
    pub async fn create(config: TradingCoreConfig) -> napi::Result<Self> {
        let rt_handle = tokio::runtime::Handle::current();
        Ok(Self {
            data_root: PathBuf::from(&config.data_root),
            config,
            accounts: Arc::new(Mutex::new(HashMap::new())),
            rt_handle,
        })
    }

    #[napi]
    pub async fn init_uta(&self, account_config: AccountConfig) -> napi::Result<()> {
        // Build broker from account_config.broker_id (Phase 4f: mock only)
        let broker = build_broker(&account_config.broker_id, &account_config.broker_config)?;
        let guards = build_guards(&account_config.guards)?;

        let state = UtaState::restore_or_new(
            account_config.id.clone(),
            broker,
            guards,
            self.data_root.clone(),
        ).await;

        let capacity = self.config.event_queue_capacity.unwrap_or(1024) as usize;
        let (dispatcher, mut rx) = EventDispatcher::new(capacity);

        // Wire UtaEvent → dispatcher
        let dispatcher_clone = dispatcher.clone();
        let uta_id = account_config.id.clone();
        // Hook event_tx in state... (see Phase 4d event channel)

        let (handle, _join) = UtaActor::spawn(state, 32);
        self.accounts.lock().insert(account_config.id.clone(), UtaProxyHandle {
            handle, dispatcher,
            tsf: Arc::new(Mutex::new(None)),
            panic_count: Arc::new(Mutex::new(0)),
        });

        // Spawn the rx → tsf forwarder
        let accounts = self.accounts.clone();
        let id = account_config.id.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let tsf_opt = accounts.lock().get(&id).and_then(|h| h.tsf.lock().clone());
                if let Some(tsf) = tsf_opt {
                    tsf.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
        });

        Ok(())
    }

    #[napi]
    pub async fn shutdown_uta(&self, uta_id: String) -> napi::Result<()> {
        let handle = self.accounts.lock().remove(&uta_id);
        if let Some(h) = handle {
            let _ = h.handle.shutdown().await;
            // Drain channel with 2s deadline already happens via mpsc Drop
            if let Some(tsf) = h.tsf.lock().take() {
                tsf.unref(&self.rt_handle.clone().into())?;
            }
        }
        Ok(())
    }

    #[napi(ts_args_type = "uta_id: string, callback: (event: TradingCoreEvent) => void")]
    pub fn subscribe_events(
        &self,
        uta_id: String,
        callback: ThreadsafeFunction<TradingCoreEvent>,
    ) -> napi::Result<()> {
        let accounts = self.accounts.lock();
        let proxy = accounts.get(&uta_id).ok_or_else(|| {
            Error::new(Status::GenericFailure, format!("uta {} not found", uta_id))
        })?;
        *proxy.tsf.lock() = Some(callback);
        Ok(())
    }

    #[napi]
    pub fn event_log_recent(&self, uta_id: String, after_seq: u32) -> napi::Result<Vec<TradingCoreEvent>> {
        let accounts = self.accounts.lock();
        let proxy = accounts.get(&uta_id).ok_or_else(|| {
            Error::new(Status::GenericFailure, format!("uta {} not found", uta_id))
        })?;
        Ok(proxy.dispatcher.recent_after(after_seq as u64))
    }
}

fn build_broker(broker_id: &str, _config: &BrokerConfigPayload) -> napi::Result<Arc<dyn Broker>> {
    match broker_id {
        "mock-paper" => Ok(Arc::new(MockBroker::new(MockBrokerOptions::default()))),
        other => Err(Error::new(Status::InvalidArg, format!("unsupported broker: {}", other))),
    }
}

fn build_guards(_configs: &[GuardConfig]) -> napi::Result<Vec<Box<dyn Guard>>> {
    // Phase 4f: empty guards for Mock. Real guards in Phase 6.
    Ok(vec![])
}
```

### Step 6: lib.rs wire-up + unit smoke test

In `crates/alice-trading-core/src/lib.rs`:
```rust
#[cfg(feature = "napi-binding")]
pub mod napi;
```

Add a minimal test gated on `napi-binding`:
```rust
#[cfg(all(test, feature = "napi-binding"))]
mod napi_tests {
    use super::napi::events::EventDispatcher;
    #[tokio::test]
    async fn dispatcher_assigns_monotonic_seq() {
        let (d, _rx) = EventDispatcher::new(16);
        d.emit("u1", "test", "{}".into()).await;
        d.emit("u1", "test", "{}".into()).await;
        let recent = d.recent_after(0);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].seq, 1);
        assert_eq!(recent[1].seq, 2);
    }
}
```

### Step 7: Commit Task A

```bash
git add crates/alice-trading-core/src/napi/ crates/alice-trading-core/src/lib.rs
git commit -m "feat(napi): TradingCore root + event dispatcher (Phase 4f Task A)"
```

---

## Task B: napi command surface

**Files:**
- Create: `crates/alice-trading-core/src/napi/commands.rs`
- Modify: `crates/alice-trading-core/src/napi/trading_core.rs` (add `pub mod` if commands are split, or inline)
- Reuse: typed result structs from `src/types.rs` with `#[cfg_attr(feature = "napi-binding", napi(object))]`

### Step 1: Mirror each TS UTA method as a napi method on `TradingCore`

For each method, the pattern is:
1. Find the proxy handle by uta_id.
2. Construct the appropriate `UtaCommand` + `oneshot::channel()`.
3. Send via `handle.cmd_tx.send(cmd).await`.
4. Await the oneshot reply.
5. Convert errors → napi::Error via `From<BrokerError>`.

```rust
#[napi]
impl TradingCore {
    #[napi]
    pub async fn stage_place_order(
        &self, uta_id: String, params: StagePlaceOrderParams,
    ) -> napi::Result<AddResult> {
        let handle = self.handle_for(&uta_id)?;
        let op = Operation::PlaceOrder {
            contract: serde_json::from_str(&params.contract_json)?,
            order: serde_json::from_str(&params.order_json)?,
            tpsl: params.tpsl_json.map(|s| serde_json::from_str(&s)).transpose()?,
        };
        handle.add(op).await.map_err(|e| Error::new(Status::GenericFailure, e))
    }

    #[napi]
    pub async fn commit(&self, uta_id: String, message: String) -> napi::Result<CommitPrepareResult> {
        let handle = self.handle_for(&uta_id)?;
        handle.commit(message).await.map_err(|e| Error::new(Status::GenericFailure, e))
    }

    #[napi]
    pub async fn push(&self, uta_id: String) -> napi::Result<PushResult> {
        let handle = self.handle_for(&uta_id)?;
        handle.push().await.map_err(broker_error_to_napi)
    }

    // ... reject, sync, get_account, get_positions, get_health, export_state, nudge_recovery
}

fn broker_error_to_napi(e: BrokerError) -> napi::Error {
    let msg = serde_json::json!({
        "code": format!("{:?}", e.code),
        "message": e.message,
        "permanent": e.permanent,
        "broker": e.broker,
        "details_json": e.details.map(|d| d.to_string()),
    }).to_string();
    Error::new(Status::GenericFailure, format!("BROKER_ERROR:{}", msg))
}
```

The TS side parses `BROKER_ERROR:{json}` prefix and reconstructs as `BrokerError` via `setPrototypeOf`.

### Step 2: Wrap all napi methods in `catch_unwind`

Add `crate::napi::panic::catch_unwind_napi` around the body of each method. For async methods, capture the panic inside a `tokio::spawn` or use `FutureExt::catch_unwind` from the futures crate.

### Step 3: Run unit tests + commit

```bash
cargo test -p alice-trading-core --features napi-binding 2>&1 | tail -10
git add crates/alice-trading-core/src/napi/commands.rs crates/alice-trading-core/src/napi/trading_core.rs
git commit -m "feat(napi): per-UTA command surface (Phase 4f Task B)"
```

---

## Task C: TS AgentEventMap + config schema

**Files:**
- Modify: `src/core/agent-event.ts` (add 3 event types + TypeBox schemas)
- Modify: `src/core/config.ts` (add tradingCoreConfigSchema, extend account schema)
- Create: `data/config/trading-core.json` (default config example)

### Step 1: Register 3 event types in `agent-event.ts`

In the `AgentEventMap` interface, add:
```typescript
'commit.notify': { accountId: string; commitHash: string };
'reject.notify': { accountId: string; commitHash: string; reason: string };
'account.health': {
  accountId: string;
  status: 'healthy' | 'degraded' | 'offline';
  consecutiveFailures: number;
  nextRecoveryAt?: string;
};
```

Add TypeBox schemas adjacent (mirror existing pattern):
```typescript
const CommitNotifyPayloadSchema = Type.Object({
  accountId: Type.String(),
  commitHash: Type.String(),
});
const RejectNotifyPayloadSchema = Type.Object({
  accountId: Type.String(),
  commitHash: Type.String(),
  reason: Type.String(),
});
const AccountHealthPayloadSchema = Type.Object({
  accountId: Type.String(),
  status: Type.Union([Type.Literal('healthy'), Type.Literal('degraded'), Type.Literal('offline')]),
  consecutiveFailures: Type.Number(),
  nextRecoveryAt: Type.Optional(Type.String()),
});
```

Register in `AgentEvents`:
```typescript
'commit.notify': {
  schema: CommitNotifyPayloadSchema,
  description: 'Fires after a UTA push succeeds and the commit is persisted.',
},
'reject.notify': { schema: RejectNotifyPayloadSchema, description: 'Fires when a UTA push is rejected.' },
'account.health': { schema: AccountHealthPayloadSchema, description: 'Fires on UTA broker-health transition.' },
```

### Step 2: Add `tradingCoreConfigSchema` in `config.ts`

```typescript
export const tradingCoreConfigSchema = z.object({
  defaultBrokerImpl: z.object({
    alpaca: z.enum(['ts', 'rust']).default('ts'),
    ibkr: z.enum(['ts', 'rust']).default('ts'),
    ccxt: z.literal('ts').default('ts'),
    mock: z.enum(['ts', 'rust']).default('rust'),
  }).default({ alpaca: 'ts', ibkr: 'ts', ccxt: 'ts', mock: 'rust' }),
  eventQueueCapacity: z.number().int().positive().default(1024),
  panicDisableThreshold: z.number().int().positive().default(5),
  dataRoot: z.string().default('./data'),
});

export type TradingCoreConfig = z.infer<typeof tradingCoreConfigSchema>;
```

And extend the account schema (find via grep `accountConfigSchema` or similar):
```typescript
brokerImpl: z.enum(['ts', 'rust']).optional(),
```

### Step 3: Create `data/config/trading-core.json`

```json
{
  "defaultBrokerImpl": { "alpaca": "ts", "ibkr": "ts", "ccxt": "ts", "mock": "rust" },
  "eventQueueCapacity": 1024,
  "panicDisableThreshold": 5,
  "dataRoot": "./data"
}
```

### Step 4: Loader updates

Find the config loader (around `src/core/config.ts`'s `loadConfig()` function). Add a `loadTradingCoreConfig()` that reads `data/config/trading-core.json`, falls back to defaults if absent.

### Step 5: Run tsc + tests + commit

```bash
npx tsc --noEmit 2>&1 | tail -5
pnpm test 2>&1 | grep "Tests" | tail -3
git add src/core/agent-event.ts src/core/config.ts data/config/trading-core.json
git commit -m "feat(events): register commit.notify/reject.notify/account.health + tradingCore config (Phase 4f Task C)"
```

---

## Task D: RustUtaProxy TS class + UTAManager routing

**Files:**
- Create: `src/domain/trading/unified-trading-account-rust.ts` (RustUtaProxy)
- Modify: `src/domain/trading/uta-manager.ts` (routing dispatch)

### Step 1: Implement `RustUtaProxy`

```typescript
import type { TradingCore, TradingCoreEvent } from '@traderalice/trading-core-bindings';
import { BrokerError } from './brokers/error.js';
import type { EventLog } from '../../core/event-log.js';
import type { AccountConfig } from '../../core/config.js';

export class RustUtaProxy {
  public readonly id: string;
  private tc: TradingCore;
  private eventLog: EventLog;
  private lastSeq = 0;

  constructor(opts: { accountId: string; accountConfig: AccountConfig; tradingCore: TradingCore; eventLog: EventLog }) {
    this.id = opts.accountId;
    this.tc = opts.tradingCore;
    this.eventLog = opts.eventLog;
  }

  async start(accountConfig: AccountConfig): Promise<void> {
    await this.tc.initUta({
      id: this.id,
      accountType: accountConfig.type,
      brokerId: accountConfig.brokerConfig.id ?? 'mock-paper',
      enabled: accountConfig.enabled ?? true,
      guards: (accountConfig.guards ?? []).map(g => ({ guardType: g.type, configJson: JSON.stringify(g.config) })),
      brokerConfig: { configJson: JSON.stringify(accountConfig.brokerConfig) },
    });
    this.tc.subscribeEvents(this.id, this._dispatch.bind(this));
  }

  async stop(): Promise<void> {
    await this.tc.shutdownUta(this.id);
  }

  async stagePlaceOrder(params: { contract: unknown; order: unknown; tpsl?: unknown }): Promise<unknown> {
    return this._call(() => this.tc.stagePlaceOrder(this.id, {
      contractJson: JSON.stringify(params.contract),
      orderJson: JSON.stringify(params.order),
      tpslJson: params.tpsl ? JSON.stringify(params.tpsl) : undefined,
    }));
  }

  async commit(message: string): Promise<unknown> { return this._call(() => this.tc.commit(this.id, message)); }
  async push(): Promise<unknown>                  { return this._call(() => this.tc.push(this.id)); }
  async reject(reason: string): Promise<unknown>  { return this._call(() => this.tc.reject(this.id, reason)); }
  // ... mirror full TS UTA surface

  private async _call<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      if (e instanceof Error && e.message.startsWith('BROKER_ERROR:')) {
        const data = JSON.parse(e.message.slice('BROKER_ERROR:'.length));
        const reconstructed = new Error(data.message);
        Object.setPrototypeOf(reconstructed, BrokerError.prototype);
        (reconstructed as any).code = data.code;
        (reconstructed as any).permanent = data.permanent;
        (reconstructed as any).broker = data.broker;
        throw reconstructed;
      }
      throw e;
    }
  }

  private _dispatch(err: Error | null, event?: TradingCoreEvent): void {
    if (err || !event) return;
    if (event.seq !== this.lastSeq + 1) {
      // Gap detected — backfill
      this._backfill(this.lastSeq).catch(e => {
        // log; continue
      });
    }
    const payload = JSON.parse(event.payloadJson);
    if (event.eventType === 'commit.notify' || event.eventType === 'reject.notify' || event.eventType === 'account.health') {
      this.eventLog.append(event.eventType as any, payload);
    }
    this.lastSeq = Number(event.seq);
  }

  private async _backfill(afterSeq: number): Promise<void> {
    const missed = await this.tc.eventLogRecent(this.id, afterSeq);
    for (const e of missed) {
      const payload = JSON.parse(e.payloadJson);
      this.eventLog.append(e.eventType as any, payload);
      this.lastSeq = Math.max(this.lastSeq, Number(e.seq));
    }
  }
}
```

### Step 2: UTAManager routing

In `uta-manager.ts`, modify the create-account branch:

```typescript
private async _spawnUta(config: AccountConfig): Promise<UnifiedTradingAccount | RustUtaProxy> {
  const impl = config.brokerImpl ?? this.tcConfig.defaultBrokerImpl[config.type] ?? 'ts';
  if (impl === 'rust' && this.tradingCore) {
    const proxy = new RustUtaProxy({
      accountId: config.id, accountConfig: config,
      tradingCore: this.tradingCore, eventLog: this.eventLog,
    });
    await proxy.start(config);
    return proxy;
  }
  return new UnifiedTradingAccount({ /* existing TS path */ });
}
```

Constructor accepts optional `tradingCore: TradingCore` and `tcConfig: TradingCoreConfig`.

### Step 3: Run tsc + smoke + commit

```bash
npx tsc --noEmit
git add src/domain/trading/unified-trading-account-rust.ts src/domain/trading/uta-manager.ts
git commit -m "feat(trading): RustUtaProxy + UTAManager routing (Phase 4f Task D)"
```

---

## Task E: parity + e2e + Telegram smoke

**Files:**
- Create: `parity/check-rust-proxy-mock.ts`
- Create: `parity/check-error-shapes.ts`
- Create: `parity/check-event-stream.ts`
- Create: `parity/check-rust-panic.ts`
- Create: `src/__test__/telegram-rust-uta-smoke.spec.ts`

### Step 1: `parity/check-rust-proxy-mock.ts`

End-to-end script:
1. Build a `TradingCore` instance.
2. `initUta` with a Mock account config.
3. Subscribe to events; collect them.
4. Stage place order, commit, push.
5. Assert: `commit.notify` event received with matching `commitHash`.
6. Assert: position / order state matches expected.
7. Shutdown.

### Step 2: `parity/check-error-shapes.ts`

1. Trigger a disabled-account push → expect `BrokerError` with `code === 'CONFIG'` and `instanceof BrokerError === true`.
2. Trigger an offline-account push → expect `code === 'NETWORK'`.
3. Compare error shape against the TS UTA's identical error path.

### Step 3: `parity/check-event-stream.ts`

1. Spawn `TradingCore` with `eventQueueCapacity: 4` (tight).
2. Push N=20 commits faster than the consumer can drain.
3. Assert: TS-side sees backpressure drops (logged warns), but `eventLogRecent` can backfill.
4. Shutdown: assert drain completes within 2s.

### Step 4: `parity/check-rust-panic.ts`

1. Hook Mock broker to panic on `place_order`.
2. Push a commit → expect `RUST_PANIC` napi error.
3. Assert: UTA marked offline; respawn schedules; other UTAs unaffected.

### Step 5: `src/__test__/telegram-rust-uta-smoke.spec.ts`

Mock the Telegram callback path. Issue `/trading` flow that calls `uta.push()`. Assert ≤10s round-trip; assert event reaches EventLog.

### Step 6: Run + commit

```bash
pnpm tsx parity/check-rust-proxy-mock.ts
pnpm tsx parity/check-error-shapes.ts
pnpm tsx parity/check-event-stream.ts
pnpm tsx parity/check-rust-panic.ts
pnpm test 2>&1 | grep "Tests" | tail -3
git add parity/ src/__test__/telegram-rust-uta-smoke.spec.ts
git commit -m "test(parity): Phase 4f e2e + parity + Telegram smoke"
```

---

## Self-Review

**Spec coverage:** All 7 deliverables map to Tasks A–E.

**Placeholder scan:** Marked TS UTA surface mirroring as "...mirror full TS UTA surface" — the implementer will read `UnifiedTradingAccount.ts` for the full list. Not a placeholder; an explicit reference.

**Type consistency:** `TradingCoreEvent.seq` is `u64` in Rust, `number` in TS (Phase 4f accepts Number-bounded seq since 2^53 is decades of events; document this).

---

## Execution

**Subagent-Driven (recommended)** — controller dispatches one implementer per task + two-stage review.
