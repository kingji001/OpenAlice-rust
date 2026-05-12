# Phase 4f — RustUtaProxy + bounded FFI event stream

## Goal

Cut over Mock UTAs from the TS implementation to the Rust UtaActor via napi, behind a config flag. After Phase 4f, the migration's "vertical slice" is complete: a Mock-broker UTA can round-trip through `/trading` on Telegram, the Web UI, and CCXT-shaped parity tests using the Rust core. CCXT-backed UTAs continue to use the TS path. Real brokers (Alpaca, IBKR) stay TS by default — they're Phase 5/6 territory.

This is the **final phase of the Rust migration's core arc**. Phase 5+ is the real-broker decision point and is gated on Phase 4f shipping cleanly.

## Inputs

Phases 4a–4e (Rust crate, complete and unexposed). Code-review polish + reconciler timeout in `eb3f81d`.

## Out of scope for Phase 4f

- Real-broker (Alpaca/IBKR) implementations — Phase 6.
- Removing the TS UTA — Phase 8.
- Phase 4e reconciler actually emitting sync/rejected git commits — Phase 4f wires this (currently detection-only).

## Resolved design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | napi struct named `TradingCore`, factory `TradingCore.create(config)` | Per v4 plan §Phase 4f literal. Single root object, simple to spawn from `main.ts`. |
| D2 | Actor spawn timing: **eager at `init_uta`** | Matches TS UTA lifecycle; predictable memory & startup latency. |
| D3 | Backpressure: 1s timeout → drop the event, log via `tracing::warn!` (NOT via event channel) | Avoids recursive overflow — a backpressure-warn event is logged, never enqueued. |
| D4 | Panic-disable threshold: `tradingCore.panicDisableThreshold` config (default 5) | Per-broker permanent-disable after N consecutive Rust panics. |
| D5 | Gap detection: TS observes seq jump → calls `trading_core.event_log_recent(uta_id, after_seq)` napi method | Mirrors the EventLog backfill API; bounded ring buffer (last 500 events) per UTA. |
| D6 | Shutdown drain: drain channel with 2s deadline, then `tsfn.unref()`, then `actor.join().await` | Bounds shutdown time; in-flight events are best-effort. |
| D7 | BrokerError reconstruction: `Object.setPrototypeOf(err, BrokerError.prototype)` + carry `code`, `permanent`, `broker` | Per Phase 4b design. Verified by `parity/check-error-shapes.ts`. |
| D8 | UTAManager routing: `accounts.json[].brokerImpl?: 'ts' \| 'rust'`, fallback to `tradingCore.defaultBrokerImpl[type]` | Per-account override + global default. CCXT pinned to `'ts'`. |
| D9 | Mock-broker only for Phase 4f e2e | Real brokers don't exist in Rust yet — Phase 5/6 work. |
| D10 | Per-UTA monotonic seq in Rust, separate from EventLog global seq | Plan §6.12 explicit. Proxy emits both — Rust seq for gap detection, EventLog seq for global ordering. |

## Architecture

```
TS host                                Rust napi binding
═══════                                ═════════════════
RustUtaProxy.commit()  ────napi────►   TradingCore::commit(uta_id, msg)
                                            │
                                            ▼
                                       UtaCommand::Commit → UtaActor → reply

                                       UtaActor emits UtaEvent
                                            │
                                            ▼
                                       per-UTA mpsc<EventEnvelope>(1024)
                                            │ (seq++)
                                            ▼ (1s backpressure → tracing::warn! drop)
TSF callback   ◄────napi────────────   ThreadsafeFunction<TradingCoreEvent>
     │
     ▼
RustUtaProxy._dispatch(event)
     │
     ├─► EventLog.append('commit.notify', ...)
     ├─► EventLog.append('reject.notify', ...)
     └─► EventLog.append('account.health', ...)
```

## Deliverables

### D1: napi event types + TradingCore root

Files:
- `crates/alice-trading-core/src/napi/mod.rs` (new) — feature-gated `napi-binding`
- `crates/alice-trading-core/src/napi/trading_core.rs` (new) — `TradingCore` struct
- `crates/alice-trading-core/src/napi/types.rs` (new) — typed napi structs (NO `serde_json::Value` in any signature, per P10)
- `crates/alice-trading-core/src/napi/events.rs` (new) — `TradingCoreEvent` + `EventEnvelope` + dispatcher
- `crates/alice-trading-core/src/napi/panic.rs` (new) — `catch_unwind` wrapper helper
- `crates/alice-trading-core/src/lib.rs` (modify) — add `pub mod napi;` under feature gate

`TradingCore` is a singleton owned by Node.js; it holds a `Mutex<HashMap<String, UtaProxyHandle>>` mapping `account_id → (UtaHandle, mpsc::Sender<EventEnvelope>, JoinHandle)`. Methods:

```rust
#[napi(factory)]
pub async fn create(config: TradingCoreConfig) -> Result<Self>;

#[napi]
pub async fn init_uta(&self, account_config: AccountConfig) -> Result<()>;

#[napi]
pub async fn shutdown_uta(&self, uta_id: String) -> Result<()>;

#[napi(ts_args_type = "callback: (event: TradingCoreEvent) => void")]
pub fn subscribe_events(&self, uta_id: String, callback: ThreadsafeFunction<TradingCoreEvent>) -> Result<()>;

#[napi]
pub fn event_log_recent(&self, uta_id: String, after_seq: u64) -> Result<Vec<TradingCoreEvent>>;
```

### D2: napi command surface (stage_*, commit, push, reject, sync, getters)

Files:
- `crates/alice-trading-core/src/napi/commands.rs` (new) — all per-UTA command methods on `TradingCore`

Each method takes `uta_id: String` and typed params, routes to the actor via `UtaCommand`, awaits the oneshot reply, converts to a typed napi result. Methods (mirroring TS UnifiedTradingAccount public interface):

- `stage_place_order(uta_id, params: StagePlaceOrderParams) -> Result<AddResult>`
- `stage_modify_order(uta_id, params: StageModifyOrderParams) -> Result<AddResult>`
- `stage_close_position(uta_id, params: StageClosePositionParams) -> Result<AddResult>`
- `commit(uta_id, message: String) -> Result<CommitPrepareResult>`
- `push(uta_id) -> Result<PushResult>`
- `reject(uta_id, reason: String) -> Result<RejectResult>`
- `sync(uta_id, updates: Vec<OrderStatusUpdate>, current_state: GitState) -> Result<SyncResult>`
- `get_account(uta_id) -> Result<AccountSnapshot>`
- `get_positions(uta_id) -> Result<Vec<PositionSnapshot>>`
- `get_health(uta_id) -> Result<BrokerHealthInfo>`
- `export_state(uta_id) -> Result<GitExportState>`
- `nudge_recovery(uta_id) -> Result<()>`

Each method wrapped in `catch_unwind`. Panics convert to `Error::new(Status::GenericFailure, format!("RUST_PANIC: {}", info))`.

### D3: AgentEventMap schema registration

Files:
- `src/core/agent-event.ts` (modify) — add three event types

```typescript
// Add to AgentEventMap interface (around line 91):
'commit.notify': { accountId: string; commitHash: string };
'reject.notify': { accountId: string; commitHash: string; reason: string };
'account.health': { accountId: string; status: 'healthy' | 'degraded' | 'offline'; consecutiveFailures: number; nextRecoveryAt?: string };

// TypeBox schemas + AgentEvents entries adjacent.
```

### D4: trading-core config schema

Files:
- `src/core/config.ts` (modify) — add `tradingCore` namespace, extend account schema
- `data/config/trading-core.json` (new — example/default)

```typescript
// In config.ts:
const tradingCoreConfigSchema = z.object({
  defaultBrokerImpl: z.object({
    alpaca: z.enum(['ts', 'rust']).default('ts'),
    ibkr: z.enum(['ts', 'rust']).default('ts'),
    ccxt: z.literal('ts').default('ts'),    // pinned to TS
    mock: z.enum(['ts', 'rust']).default('rust'),  // Phase 4f cutover gate
  }),
  eventQueueCapacity: z.number().int().positive().default(1024),
  panicDisableThreshold: z.number().int().positive().default(5),
});

// account schema gets:
brokerImpl: z.enum(['ts', 'rust']).optional(),  // overrides tradingCore.defaultBrokerImpl
```

### D5: RustUtaProxy TS class

Files:
- `src/domain/trading/unified-trading-account-rust.ts` (new) — implements the same public shape as `UnifiedTradingAccount`

Constructor:

```typescript
class RustUtaProxy {
  constructor(opts: {
    accountId: string;
    accountConfig: AccountConfig;
    tradingCore: TradingCore;
    eventLog: EventLog;
  });
}
```

On construction:
1. Calls `tradingCore.init_uta(accountConfig)`.
2. Registers ThreadsafeFunction via `tradingCore.subscribe_events(accountId, this._dispatch.bind(this))`.
3. Initializes `_lastSeq = 0` for gap detection.

Method delegation: every public method awaits the corresponding `tradingCore.*(this.accountId, ...)` call. On `BrokerError` thrown by napi, reconstruct via `setPrototypeOf` per Phase 4b.

Event dispatch (`_dispatch(event)`):
- Detect gap: `if (event.seq !== this._lastSeq + 1) { await this._backfill(this._lastSeq) }`
- Map napi event → TS event type → `eventLog.append(type, payload, { causedBy })`
- Update `_lastSeq = event.seq`

### D6: UTAManager routing

Files:
- `src/domain/trading/uta-manager.ts` (modify) — read `brokerImpl`, dispatch

```typescript
private _create(config: AccountConfig): UnifiedTradingAccount | RustUtaProxy {
  const impl = config.brokerImpl ?? this.tradingCoreConfig.defaultBrokerImpl[config.type] ?? 'ts';
  if (impl === 'rust') {
    return new RustUtaProxy({
      accountId: config.id,
      accountConfig: config,
      tradingCore: this.tradingCore,
      eventLog: this.eventLog,
    });
  }
  return new UnifiedTradingAccount({ /* existing TS path */ });
}
```

Constructor accepts new optional `tradingCore: TradingCore` and `tradingCoreConfig: TradingCoreConfig`. Falls back to TS path when omitted.

### D7: e2e + parity tests

Files:
- `parity/check-rust-proxy-mock.ts` (new) — full lifecycle Mock via Rust proxy
- `parity/check-error-shapes.ts` (new) — BrokerError parity
- `parity/check-event-stream.ts` (new) — bounded queue, gap detection, shutdown drain
- `parity/check-rust-panic.ts` (new) — panic injection → RUST_PANIC → UTA offline → respawn
- `src/__test__/telegram-rust-uta-smoke.spec.ts` (new) — `/trading` command round-trip ≤10s

## DoD

```bash
cargo test -p alice-trading-core --features napi-binding
pnpm --filter @traderalice/trading-core-bindings build
pnpm tsx parity/check-rust-proxy-mock.ts
pnpm tsx parity/check-error-shapes.ts
pnpm tsx parity/check-event-stream.ts
pnpm tsx parity/check-rust-panic.ts
TRADING_CORE_IMPL=ts pnpm test                # all green
TRADING_CORE_IMPL=mock-rust pnpm test         # all green via Rust proxy
npx tsc --noEmit                              # type check clean
```

## Cutover gate

- Mock UTA via Rust proxy passes the same e2e suite as TS Mock UTA.
- `BrokerError` shape parity verified.
- Event-stream contract honored (bounded, gap-detect, drain on shutdown).
- TS suite unchanged at 2244 tests (the Rust path is opt-in).

## Rollback

Set `tradingCore.defaultBrokerImpl.mock = 'ts'` in `data/config/trading-core.json`. Restart. UTAManager routes everything to TS. Rust proxy is loaded but unused.

## Estimated effort

5–6 eng-days. Highest-risk surface is the FFI event stream — bounded backpressure + gap detection + panic boundary must be airtight, since failure here destabilizes the whole UTA.
