# OpenAlice — Rust Trading-Core Migration Plan (v4 outline)

**Version:** 4.0-outline
**Base:** [RUST_MIGRATION_PLAN.v3.md](../../RUST_MIGRATION_PLAN.v3.md) — v3 stays canonical
**Status:** Outline only. Each section below is one of `(carry-v3)`, `(amend)`, or `(new)`.
- `(carry-v3)` — unchanged from v3, listed by name only.
- `(amend)` — modified — change is written inline with v3 § / line citations.
- `(new)` — net-new section, written inline.

A maintainer folds the amendments into v3 to produce v4. Until that happens, read v4 outline alongside v3.

---

## Changelog from v3

This section mirrors v3's §13 "Changelog from v2" format. Each row records one diff applied from a stress-test review of v3.

| # | v3 claim | v4 correction | Verified against |
|---|----------|---------------|------------------|
| 1 | Phase 4c §5 line 855: `GuardPipeline.wrap` "pre-fetches `[positions, account]` outside the loop." | Function is `createGuardPipeline` (no class). Pre-fetch is **per op**, not per push (the wrapper is invoked once per op by `TradingGit.push`'s loop). Rust port matches per-op timing. | `src/domain/trading/guards/guard-pipeline.ts:13-37`, `src/domain/trading/git/TradingGit.ts:100-112` |
| 2 | Phase 2 §5 line 493: timestamp desync fix targets `commit()` and `push()`. | Same bug also in `reject()` and `sync()`. Fix all four sites. `hashInputTimestamp` captured at intent site, reused by every downstream write. | `TradingGit.ts:69, 124, 172, 386, 404` |
| 3 | §3.4 release gate: `curl -sf http://localhost:3002/api/status`. | `/api/status` does not exist. v4 ships it as Phase 0 deliverable; release gate calls it. | `src/connectors/web/web-plugin.ts:93-114` |
| 4 | §6.4 / §1 / §7 / §8 / §11: `commit.notify` event referenced as if it exists. | Net-new event. v4 Phase 4f registers schema in `AgentEventMap` with TypeBox. Per-UTA monotonic seq is separate from EventLog global seq — both emitted. | `src/core/agent-event.ts:91-103, 275`; grep for "commit.notify" returns zero |
| 5 | §6.10 line 1343: `ccxt: 'ts'` "literal-pinned at the Zod schema level." | `tradingCore` namespace is net-new. Zod literal-pin is on the new schema. `accounts.json` `brokerImpl` field is also new. | `src/core/config.ts` (no `tradingCore`/`defaultBrokerImpl` references) |
| 6 | Phase 1a §5 line 326: "purely mechanical refactor." | Decoder constructs DTO classes via `new` and mutates fields imperatively (`decoder/execution.ts:43,89,140,157`, etc.). `ibkr-client` takes a value-level dep on `ibkr-types`. `order-decoder.ts` lives at `packages/ibkr/src/` root, must move into `packages/ibkr-client/src/decoder/order.ts`. Classes stay classes. | `packages/ibkr/src/decoder/{execution,account,contract}.ts`; `packages/ibkr/src/order-decoder.ts` |
| 7 | §6.4 / Phase 4d: snapshot trigger described as event-based. | Currently inline callback (`UnifiedTradingAccount.ts:429`: `Promise.resolve(this._onPostPush?.(this.id))`). The `commit.notify` actor→TS hop is net-new structural change, not a wiring swap. | `src/main.ts:115-119`, `src/domain/trading/UnifiedTradingAccount.ts:429` |
| 8 | §4.3 / Phase 3: `TradingGit.ts` ports cleanly. | `TradingGitConfig` carries three callbacks (`executeOperation`, `getGitState`, `onCommit`) that tunnel the broker surface + persistence across the FFI. `Order` rehydration (`TradingGit.ts:312-371`) is broker-shape-aware (Decimal field-by-field rewrap). | `src/domain/trading/git/interfaces.ts:55-59`, `src/domain/trading/git/TradingGit.ts:312-371` |
| 9 | §6.2: v1 hashes are "opaque." | Make explicit: v1 hashes are change-detection tokens, not content addresses. They depend on JS class iteration order + decimal.js stringification. Rust will not try to reproduce them. | `TradingGit.ts:33-38, 70-75` |
| 10 | Phase 4b: `BrokerError` shape `{code, message, permanent}`. | `BrokerError` is `class extends Error` with a non-trivial regex-based `classifyMessage()` pipeline. Rust port must replicate verbatim (recommendation) or surface a new contract. Also: `push()` offline-rejection throws plain `Error`, not `BrokerError` — rationalize at port time. | `src/domain/trading/brokers/types.ts:16, 45-59`; `src/domain/trading/UnifiedTradingAccount.ts:421-431` |
| 11 | §4.2: UTAManager wires {EventLog, ToolCenter, FxService, snapshot hooks, CCXT tools}. | Surface is broader. Add `getAggregatedEquity` (cross-account FX math), `searchContracts`/`getContractDetails` (broker-agnostic IBKR-typed routing), `createGitPersister(cfg.id)` (current persistence side-channel that the actor model replaces), broker.factory/getBrokerPreset coupling. | `src/domain/trading/uta-manager.ts:71-330` |
| 12 | §4 / §5: brokers covered are CCXT, Alpaca, IBKR, Mock. | LeverUp broker is being actively developed (`TODO.md:232-257`) with shape-distinct quirks (whole-position close, no limit orders, EIP-712 signing). Phase 4b `Broker` trait must accommodate or introduce `BrokerCapabilities`. v4 adds §4.4 placement; recommendation: stay TS until LeverUp's TS impl stabilizes. | `TODO.md:232-257` |
| 13 | (Not addressed.) Runtime UTA add/remove via HTTP. | UTAManager exposes `initUTA`/`reconnectUTA`/`removeUTA`/`add`/`remove`, driven from `PUT /uta/:id` / `DELETE /uta/:id` / `POST /uta/:id/reconnect`. Per-UTA actors must support runtime spawn/teardown via HTTP, not just boot fan-out. | `src/domain/trading/uta-manager.ts:93,111,154,172,179`; `src/connectors/web/routes/trading-config.ts:74,104,107,119,129`; `src/connectors/web/routes/trading.ts:204` |
| 14 | (Not addressed.) Reconnect ownership across the FFI. | Reconnect lives in two places today (UTA `_scheduleRecoveryAttempt` 5s→60s + `UTAManager.reconnectUTA` full recreate). After migration, TS owns CCXT, Rust owns IBKR/Alpaca recovery. Divergence risk; new §6.5.1 specifies the matrix. | `src/domain/trading/UnifiedTradingAccount.ts:296-328`; `src/domain/trading/uta-manager.ts:111-151` |
| 15 | (Not addressed.) Rust panic policy. | New §6.12.1 + new principle P13. `catch_unwind` boundary at every napi-exported method; panics surface as typed JS errors; `RustUtaProxy` marks UTA offline + schedules recovery; no process abort. Phase 4f panic injection test. | `napi-rs` docs |
| 16 | (Not addressed.) Snapshot durability asymmetry. | Rust commit durability uses fsync'd atomic write; TS-side snapshot writer (`snapshot/store.ts`) does non-atomic `appendFile` chunk writes, no fsync, index-vs-chunk write inconsistency window. New §6.4.1 enumerates gaps; explicitly out of scope to fix here. | `src/domain/trading/snapshot/store.ts:51-56, 83-84, 109-111` |
| 17 | (Not addressed.) Tool-surface contract. | `src/tool/trading.ts` exposes 16 tools that call UTA methods directly (no abstraction layer). New §6.14 enumerates contract; flags `getPortfolio` interleaving hazard between back-to-back `getPositions`+`getAccount` calls; sets `RustUtaProxy` round-trip latency budget. | `src/tool/trading.ts:121-512` |
| 18 | (Not addressed.) Cross-UTA atomicity. | `tradingCommit` with no source is best-effort sequential, no rollback. New §6.15 documents this is intentional carry-over. | `src/tool/trading.ts:457-465` |
| 19 | (Not addressed.) Connector consumer matrix. | New principle P14 + new §6.16. Telegram observes/mutates trading state directly via `uta.push()`/`uta.reject()`. Phase 4f gets a Telegram smoke test. | `src/connectors/telegram/telegram-plugin.ts:111-194`, `src/connectors/mcp-ask/mcp-ask-connector.ts:15` |
| 20 | (Not addressed.) Pre-existing TODO.md items overlap migration. | New §6.13 triages: trading-git staging-area-lost-on-restart and cooldown-state-lost-on-restart port-as-is (preserve parity); snapshot/FX bug + OKX item out-of-scope; LeverUp into §4.4. | `TODO.md:60-69, 71-78, 80-86, 88-93, 95-102, 232-257` |
| 21 | §8.4: Phases 0, 1a-c, 2, 2.5, 4a, 4b, 4c, 4f, 5(spike), 7 "fit a single agent context window." | Optimistic for Phase 3(c), 4d(a), 4d(c), 4f. Replace with tiered table marking which sub-PRs need a fresh-agent context (no carryover). | `src/domain/trading/{TradingGit.ts,UnifiedTradingAccount.ts}` (657L + 586L) |
| 22 | (Not addressed.) `UNSET_LONG = BigInt(2 ** 63) - 1n` JS precision bug. | `2 ** 63` doesn't fit in a JS Number. If any IBKR field maps to Rust `i64`, ensure correct sentinel reconstruction. Add to §6.1 caveats. | `packages/ibkr/src/const.ts:12` |

---

## 1. Executive Summary `(amend)`

Carry v3 §1 unchanged except:

- **Deliverable shape (state 1)** — add a row to the file tree under `crates/alice-trading-core/src/`:
  ```
  ├── panic.rs            # catch_unwind boundary helpers (§6.12.1)
  ```
- **Acceptable terminal states** — clarify after row 2: "State 2 *also* delivers the new commit.notify event surface, runtime UTA actor lifecycle, panic-safe FFI boundary, and reconnect-ownership matrix — these land regardless of broker porting."

## 2. Migration Principles `(amend)`

Add two invariants to the v3 P1–P12 table:

- **P13 — Panic safety at the FFI boundary.** All Rust napi-exported methods are wrapped in `std::panic::catch_unwind`. Rust panics surface as typed JS errors, not process aborts. The Node host treats them like a transient broker error: log + mark UTA offline + schedule recovery. **Enforcement:** §6.12.1; Phase 4f `parity/check-rust-panic.ts`.

- **P14 — Connector consumer matrix.** Every Rust→TS event flow has a documented consumer list. New consumers declare against the matrix before adoption. **Enforcement:** §6.16; Phase 4f Telegram smoke test.

## 3. Integration choice: napi-rs `(amend §3.4 only)`

§3.1, §3.2, §3.3 unchanged.

**§3.4 amendment.** Replace the release-gate's `curl -sf http://localhost:3002/api/status` with the same call against an endpoint that actually exists. v4 ships `GET /api/status` as a Phase 0 deliverable returning `{ ok, version, uptimeSeconds, ffiLoaded }`. The release gate then becomes:

```bash
for i in $(seq 1 30); do
  if curl -sf http://localhost:3002/api/status > /dev/null; then
    curl -sf http://localhost:3002/api/status   # logs the body so the gate captures version + ffiLoaded
    kill $DEV_PID
    exit 0
  fi
  sleep 1
done
```

`ffiLoaded: false` is the correct value pre-Phase-4f and flips to `true` once `RustUtaProxy` is wired. The gate logs both states.

## 4. Target architecture

### 4.1 Boundary `(carry-v3)`

### 4.2 What stays in TypeScript `(amend)`

Replace v3's `UTAManager` line with a broader enumeration. Verified against `src/domain/trading/uta-manager.ts:71-330`:

- **Wired into UTAManager (5 from v3, plus):**
  - `EventLog` (`uta-manager.ts:101` — `account.health` emission)
  - `ToolCenter` (`:133-139, :162-168` — CCXT-specific provider tools register on init/reconnect)
  - `FxService` (`:82-88` setter; cross-account math at `:260-293`)
  - Snapshot hooks (`:103-104` — `setSnapshotHooks`; will be removed in Phase 4d, replaced by EventLog subscription)
  - **`getAggregatedEquity`** (`:260-293`) — cross-account FX math, real surface area to keep on TS
  - **`searchContracts` / `getContractDetails`** (`:297-330`) — broker-agnostic, IBKR-typed contract search routed across all UTAs; FFI boundary must ship `ContractDescription` and `ContractDetails`
  - **`createGitPersister(cfg.id)`** (`:99`) — current persistence side-channel that the actor model replaces in Phase 4d
  - **`broker.factory` / `getBrokerPreset`** (`:94, :134`) — broker preset coupling

### 4.3 What moves to Rust `(carry-v3)`

### 4.4 LeverUp broker placement `(new)`

LeverUp is currently developed in TODO.md (lines 232-257) and absent from v3. It has shape-distinct quirks the Phase 4b `Broker` trait must accommodate:

1. **Whole-position close** (no partial close)
2. **No limit orders** (market-only)
3. **EIP-712 signing** for order intent

Three sub-questions to resolve **before** Phase 4b lands:

1. Does LeverUp implement the same `Broker` trait, or does v4 introduce a separate `BrokerCapabilities` enum (`closeMode: { partial | wholePosition }`, `orderTypes: { market | limit | stop | bracket }`, `signingScheme: { none | eip712 | ... }`)?
2. Where does LeverUp slot into §6.10's `tradingCore.defaultBrokerImpl` config? Default `'ts'` until LeverUp's TS impl stabilizes.
3. Is LeverUp in scope for the Phase 5 spike or does it stay TS like CCXT? Recommendation: stay TS until its TS impl stabilizes; revisit post-Phase-7.

Locked at §11 (open decisions).

---

## 5. Phased migration

### Phase 0 — Inventory + fixtures `(amend)`

Carry v3 deliverables 1-7. Add:

- **Deliverable 8** — `parity/context-worksheets/` — one file per sub-PR identified in §8.4. Each lists the exact files an agent must load to do that sub-PR well. Template lives in `parity/context-worksheets/_template.md`.
- **Deliverable 9** — `src/connectors/web/routes/status.ts` — `GET /api/status` returning `{ ok, version, uptimeSeconds, ffiLoaded: false }`. Wire into `web-plugin.ts` route mount. Smoke test asserts the §3.4 release gate passes against the current TS-only build.
- **Deliverable 10** — `TODO.md` entries with `[snapshot-durability]` tag for each gap in §6.4.1; `[migration-deferred]` tag for each TODO row in §6.13 that ports as-is.

### Phase 1 — Canonical TS data model

#### Phase 1a — `ibkr-types` / `ibkr-client` package split `(amend)`

Reframe v3 line 326 ("purely mechanical refactor"). Verified at `packages/ibkr/src/decoder/{execution,account,contract}.ts`: decoders `new`-construct DTO classes and mutate fields imperatively. Add to deliverables:

- **Acknowledge decoder→DTO coupling.** `decoder/execution.ts:43,89,140,157`, `decoder/account.ts:47,103,220,325`, `decoder/contract.ts:116,181` all do `new Contract()` / `new Execution()` / `new ContractDetails()`. So `ibkr-client` takes a **value-level** dep on `ibkr-types` (not type-only). Document explicitly in the package READMEs.
- **Move `order-decoder.ts`** from `packages/ibkr/src/order-decoder.ts` into `packages/ibkr-client/src/decoder/order.ts`. v3's "mechanical" framing missed this file.
- **Decision to record:** `Order` / `Contract` / `ContractDetails` / `ContractDescription` stay as classes (not interfaces) — the decoder constructs and mutates them imperatively, refactoring to interfaces would be its own non-mechanical change. Out of scope for Phase 1a.

#### Phase 1b — Wire types + adapters `(amend)`

Carry v3 deliverables. Add to §6.1 caveats reference:

- `UNSET_LONG = BigInt(2 ** 63) - 1n` (`packages/ibkr/src/const.ts:12`) has a JS precision bug — `2 ** 63` exceeds `Number.MAX_SAFE_INTEGER`, so the `BigInt(...)` argument is lossy. If any IBKR field is mapped to Rust `i64` in the wire-type design, ensure the correct sentinel value `i64::MAX` is reconstructed regardless of the lossy TS source. Add a fixture.

#### Phase 1c — Canonical JSON utility `(carry-v3)`

### Phase 2 — Hash v2 (intent only) `(amend)`

Carry v3 deliverables 1, 2, 4, 5. Amend deliverable 3:

> **Original v3 deliverable 3** says `TradingGit.commit()` writes both, fixes "the latent bug where TradingGit.ts:69 and TradingGit.ts:124 used different timestamps."
>
> **v4 amendment:** the same desync exists in `reject()` (`TradingGit.ts:172`) and `sync()` (`TradingGit.ts:386, 404`). Fix all four sites. `hashInputTimestamp` is captured at the **intent site** (commit, reject, sync) and reused by every downstream write of the same commit. Add fixtures for reject and sync timestamp consistency.

### Phase 2.5 — Optional full-entry audit hash `(carry-v3)`

### Phase 3 — Rust workspace + Rust `TradingGit` `(amend)`

Carry v3 deliverables 1-8. Two clarifications:

- **TradingGitConfig FFI contract.** Add to deliverable 6 (typed napi surface): the three callbacks `TradingGitConfig` carries (`executeOperation: (op) => Promise<unknown>`, `getGitState: () => Promise<GitState>`, `onCommit?: (state) => Promise<void>`) define the FFI surface for the actor in Phase 4d. Either:
  - **Option A (recommended):** orchestrate push/commit in Rust; the three callbacks become typed napi method signatures (`broker_execute_operation`, `broker_get_state`, `commit_persisted_notify`). Rust calls TS only via these.
  - **Option B:** orchestrate in TS; Rust holds only data structures and the hash algorithm. Higher chatter across FFI; rejected.
- **Rehydration belongs in TS.** `Order` rehydration in `_rehydrateOperation` (`TradingGit.ts:312-371`) is broker-shape-aware (Decimal field-by-field rewrap of IBKR `Order`). Add to deliverable spec: rehydration logic ports as `WireOrder → WireOrder` round-trip; broker-class rehydration (`new Order()` + `Decimal(...)` field rewrap) belongs in the TS proxy layer (Phase 4f), not in Rust.
- **§6.2 framing update** (cross-reference): make explicit v1 hashes are change-detection tokens, not content addresses. Rust will not reproduce them.

### Phase 4 — Guards + per-UTA actor + Mock broker

#### Phase 4a — TS UTA actor retrofit `(carry-v3)`

#### Phase 4b — Rust `Broker` trait + `BrokerError` + `MockBroker` `(amend)`

Carry v3 deliverables 1-4. Add three:

- **Deliverable 5 — Port `BrokerError.classifyMessage()`** (`brokers/types.ts:45-59`). Regex-based error-message classifier (network-timeout, auth-rejected, etc.) called by today's broker impls to populate `code`. Replicate verbatim in Rust with fixture coverage; revisit cleanup post-Phase-7.
- **Deliverable 6 — Rationalize offline-push error shape.** `UnifiedTradingAccount.push()` (`:421-431`) throws plain `Error`, not `BrokerError`, when `_disabled` or `health === 'offline'`. Rust port throws `BrokerError(CONFIG, "account disabled", permanent: true)` and `BrokerError(NETWORK, "account offline", permanent: false)` respectively. Mirror the change in TS in the same PR.
- **Deliverable 7 — MockBroker port preserves five behaviors as explicit parity assertions** (not "behavioral parity" hand-wave): deterministic order ID counter; exact avg-cost recalc semantics including the "flipped position simplification" at `MockBroker.ts:527-529`; fail-injection machinery (`setFailMode`); call-log shape (`_callLog` / `calls()` / `callCount()` / `lastCall()`); failure-mode triggering of health transitions.
- **Deliverable 8 — `BrokerCapabilities` extension point on the `Broker` trait** (forward-compat for §4.4). Trait carries a `fn capabilities(&self) -> BrokerCapabilities` returning `{ closeMode: { partial | wholePosition }, orderTypes: bitflags, signingScheme: { none | eip712 | ... } }`. Default impl returns `{ partial, market | limit | stop | bracket, none }` — current brokers (IBKR, Alpaca, Mock) satisfy this default and don't override. Future brokers (LeverUp, if §11 flips) override. The point is: if §11 keeps LeverUp out of scope, this is a one-method addition; if §11 flips later, no trait-shape rework. No behavior change in Phase 4b.

#### Phase 4c — Rust guards + parity `(amend)`

Verified at `src/domain/trading/guards/guard-pipeline.ts:13-37`: function is `createGuardPipeline` (no class). Pre-fetch is **per op**, not per push.

- **Rename in v3 references:** `GuardPipeline::wrap` → `create_guard_pipeline`.
- **Pre-fetch timing:** per-op (matches TS). Do **NOT** optimize to per-push during the port — would silently change guard semantics if a guard depends on positions changing between ops.
- **New parity test:** 5-op push verifies `[positions, account]` is fetched 5 times (not 1).

#### Phase 4d — Rust UTA actor + TradingGit persistence `(amend)`

Carry v3 deliverables 1-4. Add three:

- **Deliverable 5 — Snapshot trigger swap.** `UnifiedTradingAccount.ts:429` calls `Promise.resolve(this._onPostPush?.(this.id)).catch(() => {})` directly after `git.push()`. v4 deliverable: remove `setSnapshotHooks` from `UTAManager` (`uta-manager.ts:103-104`); snapshot service subscribes to `commit.notify` from EventLog instead. Cross-reference §6.4.1 for the durability-asymmetry note. Atomicity test: assert no missed snapshot during the swap window (Phase 4d migration).
- **Deliverable 6 — Runtime UTA add/remove via HTTP.** Per-UTA actor lifecycle handlers: `spawn(account_config) -> UtaHandle`; `teardown(uta_id) -> ()` drains the mpsc, joins the tokio task, releases tsfn. Round-trip integration test: 100 cycles of spawn → command → teardown without resource leak (file descriptors, tasks, tsfn handles). Driven from `PUT /uta/:id`, `DELETE /uta/:id`, `POST /uta/:id/reconnect`.
- **Deliverable 7 — Reconnect ownership matrix wiring** (cross-reference §6.5.1). For Rust-backed UTAs, recovery loop runs in the actor; emits `account.health` via the bounded mpsc channel. tsfn re-registration on `reconnectUTA` recreate.

#### Phase 4e — Broker-execution journal + restart reconciliation `(carry-v3)`

#### Phase 4f — `RustUtaProxy` + bounded FFI event stream `(amend)`

Carry v3 deliverables 1-5. Add three:

- **Deliverable 6 — `commit.notify` schema registration.** Register `commit.notify` and any other Rust-emitted trading event in `AgentEventMap` (`src/core/agent-event.ts:91-103`) with TypeBox schemas. Reconcile per-UTA monotonic Rust seq with EventLog's global seq (`event-log.ts:136-138`) — separate counters; the proxy emits both.
- **Deliverable 7 — Telegram smoke test.** `telegram-plugin.ts:111-194` calls `uta.push()` (line 163) and `uta.reject()` (line 166). Phase 4f DoD: Telegram `/trading` flow round-trips through `RustUtaProxy` end-to-end within ≤10s (Telegram callback timeout).
- **Deliverable 8 — Rust panic injection test** (`parity/check-rust-panic.ts`). Inject a panic into the Mock broker's place_order; verify TS-side error shape (`code === 'RUST_PANIC'`), recovery (UTA marked offline → respawn), and that other UTAs are unaffected.

### Phase 5 — Real broker decision point `(carry-v3, with note)`

Carry v3 deliverables. Note: LeverUp is explicitly **NOT** in scope for Phase 5 unless §11 flips. Decision document records this.

### Phase 6 — Gradual broker migration `(carry-v3)`

### Phase 7 — Cutover with TS fallback retained `(carry-v3)`

### Phase 8 — Cleanup `(carry-v3)`

---

## 6. Cross-cutting concerns

### 6.1 Decimal correctness `(amend)`

Carry v3. Add caveat:

> **`UNSET_LONG` JS precision.** `packages/ibkr/src/const.ts:12` defines `UNSET_LONG = BigInt(2 ** 63) - 1n`. The `2 ** 63` is computed as a JS Number, which exceeds `Number.MAX_SAFE_INTEGER` and rounds. The `BigInt(...)` then wraps the rounded value, so `UNSET_LONG` is **not** exactly `i64::MAX`. If any IBKR field maps to Rust `i64` in the wire-type design, the Rust side must reconstruct `i64::MAX` from the canonical wire form, not from the lossy TS source. Phase 1b adds a fixture asserting exact `i64::MAX` round-trip.

### 6.2 Hash stability `(amend)`

Carry v3. Add to v1 description:

> **v1 hash provenance.** Verified at `TradingGit.ts:33-38, 70-75`: v1 commit hash is `sha256(JSON.stringify({ message, operations, timestamp, parentHash })).slice(0, 8)`. The `JSON.stringify` output depends on JS class iteration order (e.g., `Order`, `Contract`) and decimal.js `.toString()` choices. There is no key-sort, no normalization, no stable encoding. v1 hashes are **change-detection tokens**, not content addresses. A Rust impl cannot reproduce them and will not try. Loaders preserve v1 verbatim (PersistedCommit::V1Opaque); display them; never re-hash.

### 6.3 On-disk state paths `(carry-v3)`

### 6.4 Commit durability `(amend)`

Carry v3 atomic-write recipe + missing-snapshot reconciler. Add this paragraph after the recipe, before the reconciler subsection:

> **Asymmetry note.** The atomic-write recipe applies to Rust-owned `commit.json` only. The TS-side snapshot writer (`src/domain/trading/snapshot/store.ts`) is **not** upgraded as part of this migration. Snapshot writes use `appendFile` for chunks (non-atomic) and lack `fsync` on file or parent dir. The missing-snapshot reconciler closes one gap; §6.4.1 enumerates the gaps it leaves. The asymmetry is acknowledged, not unintentional — fixing it is out of scope, tracked separately.

### 6.4.1 Snapshot durability gaps `(new)`

Three gaps the missing-snapshot reconciler does **not** close, all in `src/domain/trading/snapshot/store.ts`:

1. **Non-atomic chunk append** (`store.ts:83`). Raw `appendFile` for snapshot chunks. A crash mid-write produces a chunk file with a partial last line. The reconciler scans index entries and counts on `chunk.count` — corrupted last lines are invisible until `readRange` parses and throws.
2. **No `fsync`** (`store.ts:51-56`). Snapshot writes do `rename(tmp, indexPath)` without fsync of the file or parent dir. The atomic-write hardening landing on Rust commits explicitly does not extend here.
3. **Index/chunk write inconsistency** (`store.ts:83-84`). `doAppend` writes the chunk first then updates the index. A crash between them: chunk has the snapshot, index doesn't. Reconciler thinks the snapshot is missing and triggers a **second** snapshot for the same commit hash → chunk now has duplicate entries.

**Mitigations not adopted in this migration** (logged in `TODO.md` with `[snapshot-durability]` during Phase 0):

- Chunk append over fsync'd write+rename pairs
- Transactional `index+chunk` write via two-phase rename
- Reconciler duplicate-detection step

The migration ships the missing-snapshot reconciler (Phase 4d) and accepts the three gaps above.

### 6.5 Per-UTA serialization `(carry-v3)`

### 6.5.1 Reconnect ownership matrix `(new)`

Today, reconnect lives in two places:

- **UTA-level auto-recovery** (`src/domain/trading/UnifiedTradingAccount.ts:296-328`). Exponential backoff 5s → 60s, broker-agnostic. Calls `broker.init()` + `broker.getAccount()` to test.
- **`UTAManager.reconnectUTA`** (`src/domain/trading/uta-manager.ts:111-151`). Reads fresh config and **recreates** the UTA — full re-instantiation, not just reconnection. Re-registers CCXT provider tools.

Brokers (`CcxtBroker`, `AlpacaBroker`, `IbkrBroker`) have no reconnect logic of their own — they expose only `init()` / `close()`.

**After migration:**

| Broker | Recovery loop owner | Triggered by | Health emitter |
|---|---|---|---|
| CCXT | TS UTA actor (Phase 4a retrofit) | `_scheduleRecoveryAttempt` | TS `eventLog.append('account.health', …)` |
| IBKR (Rust path, post-Phase 6.ibkr) | Rust UTA actor (Phase 4d) | Same algorithm, ported | Rust mpsc → TS `EventLog` via `commit.notify`-channel |
| IBKR (TS fallback path) | TS UTA actor (Phase 4a retrofit) | Same | TS |
| Alpaca (Rust path, post-Phase 6.alpaca) | Rust UTA actor | Same | Rust mpsc |
| Alpaca (TS fallback path) | TS UTA actor | Same | TS |
| Mock | Same as broker family running it | | |

**Risk:** divergence between TS and Rust recovery-loop semantics (back-off intervals, jitter, `_disabled` semantics for permanent errors). **Mitigation:** Phase 4d parity test (when both TS and Rust UTAs coexist via the proxy) asserts TS-CCXT and Rust-Mock produce equivalent `account.health` event sequences for an identical disconnect scenario. Phase 4f extends the comparison once `RustUtaProxy` is live with real-broker Mock paths.

**Actor lifecycle on reconnect.** `UTAManager.reconnectUTA` recreates the UTA. For Rust-backed UTAs, this means: drain the old actor's mpsc → join the tokio task → unregister tsfn → spawn new actor → register new tsfn. **Phase 4d** integration test covers the lifecycle (spawn/teardown 100 cycles); **Phase 4f** integration test covers reconnect via the proxy (tsfn re-registration + EventLog re-subscription).

### 6.6 Typed FFI surface `(carry-v3)`

### 6.7 Test gates `(carry-v3)`

### 6.8 Guard config strictness `(carry-v3)`

### 6.9 Logging / tracing `(carry-v3)`

### 6.10 Feature-flag config `(amend)`

Carry v3. Insert one paragraph at the start of the section:

> **`tradingCore` is a new config namespace.** v3 implies (line 1343) `ccxt: 'ts'` is "literal-pinned at the Zod schema level," which reads as if an existing flag is being constrained. Verified at `src/core/config.ts`: there is **no** existing `tradingCore` namespace; zero references to `defaultBrokerImpl`. The Phase 4f deliverable introduces this namespace; Zod literal-pinning is on the **new** schema. Account-level `brokerImpl` override is also new; `accounts.json` schema needs the field added in Phase 4f. The `panicDisableThreshold` setting (§6.12.1) lives here too.

### 6.11 Broker-execution durability `(carry-v3)`

### 6.12 FFI event-stream contract `(carry-v3)`

### 6.12.1 Rust panic policy `(new — P13 enforcement)`

- **Boundary.** Every `#[napi]`-exported method body is wrapped in `std::panic::catch_unwind`. The wrapper converts panic payloads to typed `napi::Error` with `code = "RUST_PANIC"` and `message = <panic message + backtrace>`.
- **`ThreadsafeFunction` callbacks.** `tsfn.call` itself does not unwind into the Node thread. Panics inside the Rust task that **produces** events go through the same `catch_unwind` wrapper; on panic, the actor emits a synthetic `account.health` event with `state: 'offline'`, `reason: 'rust_panic'`, then exits cleanly.
- **TS handling.** `RustUtaProxy` catches `code === 'RUST_PANIC'` errors and (a) logs a structured event, (b) marks the UTA offline via the same path as `BrokerError(NETWORK)`, (c) schedules a recovery attempt that respawns the actor. **No process abort.**
- **Test.** Phase 4f DoD adds `parity/check-rust-panic.ts` — inject a panic into the Mock broker, verify TS-side error shape, recovery, and that other UTAs are unaffected.
- **Panic dedup.** After N consecutive `RUST_PANIC` errors on the same UTA, mark it `disabled` and require manual `reconnectUTA`. Default `N = 5`; configurable via `tradingCore.panicDisableThreshold`. Open decision in §11.

### 6.13 Pre-existing TODO.md triage `(new)`

Each `TODO.md` item below overlaps with the Rust migration. Per-item fate:

| TODO entry (line) | Migration touches | Decision |
|---|---|---|
| Trading git staging area lost on restart (88-93) | Phase 3, Phase 4d | **Port-as-is.** Preserves parity. Fix in a separate post-migration PR. Document in Phase 3 PR body with `[migration-deferred]` tag. |
| Cooldown guard state lost on restart (80-86) | Phase 4c | **Port-as-is.** Same rationale. `[migration-deferred]` tag. |
| Snapshot/FX numbers wildly wrong (60-69) | Snapshot stays TS | **Out of scope.** Migration does not fix; TODO entry stays open. |
| OKX UTA spot-holding fix needs live confirmation (95-102) | CCXT stays TS | **Out of scope.** Note in Phase 5 spike: CCXT is not exercised by parity work. |
| Heartbeat dedup window lost on restart (71-78) | Out of trading scope | **Out of scope.** Listed for completeness. |
| LeverUp items (232-257) | Phase 4b Broker trait, §4.4 | **In scope.** See §4.4. |

**Principle:** the migration preserves existing behavior including known bugs; fixes ride in separate PRs after Phase 7. P4 ("one concept per phase") would be violated by fix-during-port.

### 6.14 Tool-surface contract `(new)`

`src/tool/trading.ts` exposes 16 tools that call UTA methods directly via `manager.resolve()` / `manager.resolveOne()` — no abstraction layer. v4 enumerates the contract `RustUtaProxy` must honor:

| Tool | UTA method(s) | Sync requirement | Notes |
|---|---|---|---|
| `searchContracts` (`:121-130`) | `uta.searchContracts` | async OK | UTAManager-level today |
| `getAccount` (`:165-173`) | `uta.getAccount` | async OK | |
| `getPortfolio` (`:184-235`) | `uta.getPositions` + `uta.getAccount` (back-to-back) | **interleaving hazard** | P7 protects within one mpsc round-trip, not between two |
| `getOrders` (`:249-271`) | `uta.getOrders` (`Promise.all` across UTAs) | latency-sensitive | FFI overhead × N accounts |
| `getQuote` (`:282-291`) | `uta.getQuote` | async OK | |
| `tradingLog` (`:319-327`) | `uta.gitLog` | async OK | |
| `tradingShow` (`:333-339`) | `uta.show(hash)` on every UTA | sync-style scan | Async-message proxy can satisfy if `show` is keyed by hash and returns immediately |
| `tradingStatus` (`:346-349`) | `uta.status` | async OK | Telegram also calls this |
| `simulatePriceChange` (`:362-367`) | `uta.simulatePriceChange` | async OK | |
| `tradingStagePlaceOrder` (`:410`) | `uta.stagePlaceOrder` | async OK | |
| `tradingStageCancelOrder` (`:427`) | `uta.stageCancelOrder` | async OK | |
| `tradingStageReplaceOrder` (`:438`) | `uta.stageReplaceOrder` | async OK | |
| `tradingStageClosePosition` (`:447`) | `uta.stageClosePosition` | async OK | |
| `tradingCommit` (`:457-465`) | `uta.commit` per UTA, no source = all UTAs | best-effort sequential | See §6.15 |
| `tradingPush` (`:473-493`) | `uta.push` per UTA | latency-sensitive | Telegram also calls this |
| `tradingSync` (`:503-512`) | `uta.sync` | async OK | |

**Latency budget.** `RustUtaProxy` round-trip target: ≤5 ms per call on Mock. Phase 4f parity test asserts `Promise.all([5 UTAs].map(u => u.getOrders()))` completes in ≤50 ms.

**Interleaving hazard.** `getPortfolio` does back-to-back `uta.getPositions()` + `uta.getAccount()` (`:190-191`) expecting consistent state. Under the actor model, a `commit` from another tool call can interleave between the two `await`s. Two options:

- **(a) Accept inconsistency** (current TS behavior — no lock today either). Recommended for parity.
- **(b) Introduce a `getPortfolioSnapshot` actor command** that returns both atomically. Lands as a post-migration improvement, not Phase 4f.

v4 recommends (a). Open decision in §11.

### 6.15 Cross-UTA semantics `(new)`

Operations spanning multiple UTAs (`tradingCommit` with no source, `getPortfolio`, `getOrders`, `simulatePriceChange`) are **best-effort sequential, not transactional**. If UTA A commits successfully and UTA B fails, the result is a partial-commit state with no rollback.

This is current TS behavior; the migration preserves it. The actor model does **not** change this contract — per-UTA serialization is the only atomicity guarantee. Any future cross-UTA atomicity feature would need a new coordinator above the actors (out of scope).

Document explicitly so post-migration debugging doesn't blame the actor model.

### 6.16 Connector consumer matrix `(new — P14 enforcement)`

| Consumer | Source | UTA touchpoints | Latency budget | Migration test |
|---|---|---|---|---|
| Web UI (REST) | `src/connectors/web/routes/trading.ts` | direct UTA method calls | UI: ≤200 ms p95 | Phase 4f Mock e2e |
| Web UI (SSE / EventLog) | `src/connectors/web/routes/events.ts:124` | EventLog subscribe | streaming | Phase 4f event-stream parity |
| Telegram (REST-style) | `src/connectors/telegram/telegram-plugin.ts:111-194` | `uta.push` (`:163`), `uta.reject` (`:166`), `uta.status` | ≤10 s (Telegram callback timeout) | **Phase 4f smoke test (new)** |
| MCP-ask | `src/connectors/mcp-ask/mcp-ask-connector.ts:15` | none (`capabilities.push: false`) | n/a | n/a |
| Diary | `src/connectors/web/routes/diary.ts:137` | EventLog read of `account.health` | n/a | event schema parity |

**Rule:** any future consumer added to this list specifies (1) which UTA methods it calls, (2) latency budget, (3) behavior under FFI backpressure (queue full, panic, timeout). The matrix is the load-bearing artifact for §6.12 / P14.

### 6.17 Mixed-version commit log loader `(carry-v3 — was §6.13)`

Carry v3 unchanged.

---

## 7. Risk register `(amend — 6 new rows)`

Carry v3 rows. Append:

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `commit.notify` event surface invented but not registered in `AgentEventMap` | Medium | Medium | Phase 4f Deliverable 6 registers schema; CI test asserts every Rust-emitted event has a TypeBox schema entry |
| Snapshot trigger pipeline change drops snapshots in the swap window | Medium | Medium | Phase 4d Deliverable 5 cuts over inline-callback → event-subscription atomically; integration test asserts no missed snapshot during the swap |
| Runtime UTA add/remove leaks tokio tasks / tsfn handles / file descriptors | Medium | High | Phase 4d Deliverable 6: 100-cycle round-trip integration test (§6.5.1); resource leak check in CI |
| Reconnect semantics diverge between TS-CCXT and Rust-IBKR/Alpaca recovery loops | Medium | Medium | §6.5.1 parity test asserts equivalent `account.health` event sequence on identical disconnect scenario |
| Rust panic in single UTA actor JS-throws into unrelated tool's await chain | Low | High | §6.12.1 `catch_unwind` boundary; Phase 4f Deliverable 8 panic injection test |
| LeverUp broker added to `Broker` trait late, breaks Phase 4b assumptions | Medium | Medium | §4.4 surfaces upfront; Phase 4b trait + `BrokerCapabilities` shape validates against LeverUp's whole-position-close + market-only + EIP-712 quirks |
| TODO.md "trading-git staging area lost on restart" ports as a known bug; an operator misreads the migration as fixing it | Low | Medium | §6.13 explicitly lists as-is ports; PR body for Phase 3 + 4c calls them out |

---

## 8. AI agent operating manual

### 8.1 Picking up a phase `(carry-v3)`

### 8.2 Definition of Done checklist `(carry-v3)`

### 8.3 When to escalate `(carry-v3)`

### 8.4 Per-phase context budget `(amend — replace the v3 list with a tiered table)`

v3's three-line claim is optimistic for Phase 3(c), 4d(a), 4d(c), 4f. Replace with:

| Phase | Single-agent context fits? | Files an agent must load |
|---|---|---|
| 0 | Yes | `docs/event-system.md`, `CLAUDE.md`, `TODO.md`, `src/domain/trading/*` (read-only inventory) |
| 1a | Yes | `packages/ibkr/src/*` (DTO classes + decoder) |
| 1b | Yes | Phase 1a output + `parity/fixtures/orders-on-wire/`, `parity/decimal-inventory.md` |
| 1c | Yes | Phase 1b adapters + decimal.js docs subset |
| 2 | Yes | `TradingGit.ts` (657 L), `git-persistence.ts` (48 L), Phase 1 deliverables |
| 2.5 | Yes | Phase 2 deliverables + 1 new file |
| 3 (a) decimal + canonical | Yes | decimal.js + bigdecimal docs, canonical formatter spec, Phase 1c source |
| 3 (b) PersistedCommit | Yes | Phase 2 PersistedCommit decoder + V1Opaque shape spec |
| 3 (c) TradingGit state machine | **TIGHT — fresh agent** | `TradingGit.ts` (657 L), `types.ts`, `interfaces.ts`, GitState rehydration logic, parity fixtures |
| 3 (d) napi typed surface | Yes | napi-rs docs subset, Phase 3(c) Rust source |
| 4a | Yes | `UnifiedTradingAccount.ts` (586 L), AsyncQueue ref impl |
| 4b | Yes | `brokers/types.ts`, `MockBroker.ts` (548 L), `brokers/types.ts:45-59` classifyMessage |
| 4c | Yes | `guards/*` (~10 files), `TradingGit.ts:90-130` (push loop context) |
| 4d (a) UtaActor core | **TIGHT — fresh agent** | `UnifiedTradingAccount.ts` (586 L) + Phase 3 + Phase 4a + actor pattern docs |
| 4d (b) health + recovery | Yes | `UnifiedTradingAccount.ts:193-328` (health), Phase 4d(a) source |
| 4d (c) commit persistence + reconciler | **TIGHT — fresh agent** | `git-persistence.ts`, `snapshot/store.ts`, snapshot reconciler logic |
| 4e (a) ExecutionJournal + atomic write | Yes | journal protocol spec + Phase 4d output |
| 4e (b) per-broker client-order-ID | Yes | per-broker client-order-ID specs (IBKR `nextValidId`, Alpaca, etc.) |
| 4e (c) restart reconciler + crash test | Yes | restart reconciler logic + crash test harness |
| 4f | **TIGHT — fresh agent** | EVERYTHING above + napi-rs typed export + `telegram-plugin.ts:111-194` + `AgentEventMap` |
| 5 (each spike) | Yes | broker crate + IBKR/Alpaca proto + journal protocol summary |
| 6.alpaca / 6.ibkr | Multi-agent | sub-PR (a) port, (b) record/replay, (c) live test — separate agents |
| 7 | Yes | rollback script + dogfood checklist |

The "TIGHT — fresh agent" rows mean: a **fresh agent**, not the same agent that did the prior sub-PR. Each phase deliverable PR explicitly states "fresh-agent context required" in the PR body so the orchestrator knows to spawn a new agent.

Phase 0 Deliverable 8 creates the per-sub-PR context worksheet template (`parity/context-worksheets/_template.md`).

---

## 9. Timeline summary `(carry-v3 with note)`

Carry v3. Note in a footer:

> **v4 scope additions are not separately budgeted** in the timeline. Most are deliverable-list extensions to existing phases (Phase 0, 1a, 2, 3, 4b, 4c, 4d, 4f); incremental effort estimated at 3–5 eng-days per affected phase. New cross-phase work (panic policy test harness, runtime UTA lifecycle test, reconnect ownership parity test, LeverUp `BrokerCapabilities` spec) adds ~5–7 eng-days total. Total v4 delta over v3: **~20–30 eng-days**, distributed across phases. State-2 timeline becomes ~12–17 weeks; state-1 becomes ~18–24 weeks.

## 10. References `(carry-v3)`

## 11. Open decisions `(amend — 4 new decisions)`

Carry v3's existing 4 decisions. Append:

- [ ] **§4.4 LeverUp scope.** Does LeverUp join the Rust port path, or stay TS-only like CCXT? Recommendation: stay TS until LeverUp's TS impl stabilizes; revisit post-Phase-7.
- [ ] **§6.13 TODO.md as-is items.** Confirm port-as-is for: trading-git staging area lost on restart, cooldown guard state lost on restart. Recommendation: as-is for parity. If different stance: note in PR body for Phase 3 / Phase 4c.
- [ ] **§6.14 interleaving stance.** `getPortfolio` back-to-back `getPositions`/`getAccount` — accept inconsistency (parity, recommended) vs. introduce `getPortfolioSnapshot` actor command (Phase 4f). Decision lives on `RustUtaProxy`.
- [ ] **§6.12.1 panic dedup threshold.** N consecutive `RUST_PANIC` errors → mark UTA `disabled`. Default `N = 5`; configurable via `tradingCore.panicDisableThreshold`.

## 12. Approval staging `(amend)`

Reflect new sub-phase items + new gates:

```
Approve now (mechanical, low-risk):
  Phase 0   — fixtures & inventory + /api/status route + context worksheets [v4 amend]
  Phase 1a  — ibkr-types / ibkr-client split + order-decoder.ts move [v4 amend]
  Phase 1b  — wire types + adapters [unchanged]
  Phase 1c  — canonical JSON utility [unchanged]
  Phase 2   — hash v2 intent only — fix all FOUR timestamp sites (commit/push/reject/sync) [v4 amend]
  Phase 2.5 — entry hash, default-accepted [unchanged]
  Phase 3   — Rust TradingGit (sub-PRs a/b/c/d), each fresh-agent context where marked [v4 amend]

Require evidence before approval:
  Phase 4a  — TS UTA actor retrofit [unchanged]
  Phase 4b  — Rust Broker trait + Mock + classifyMessage + offline-error rationalization [v4 amend]
  Phase 4c  — Rust guards + per-op pre-fetch parity test [v4 amend]
  Phase 4d  — Rust UTA actor + persistence + snapshot trigger swap + runtime lifecycle [v4 amend]
  Phase 4e  — Execution journal + crash-recovery test [unchanged]
  Phase 4f  — RustUtaProxy + bounded event-stream + commit.notify schema + Telegram smoke test + panic test [v4 amend]
  Phase 5   — broker decision point — LeverUp explicitly NOT in scope unless §11 flips [v4 amend]
  Phase 6   — broker-by-broker, only after spike report endorsement [unchanged]
  Phase 7   — TS fallback retained, real dogfood + rollback test [unchanged]
  Phase 8   — deferred ≥1 minor release after Phase 7 [unchanged]

New gates introduced by v4 (apply across phases):
  - Reconnect-ownership parity test (§6.5.1) — required for Phase 4d sign-off
  - Rust panic policy test (§6.12.1) — required for Phase 4f sign-off
  - Snapshot durability gap log (§6.4.1) — TODO.md entries created by end of Phase 0
  - Connector consumer matrix (§6.16) — current state documented in Phase 0; updated on every connector change
```

## 13. Changelog from v2 `(carry-v3)`

## 14. Changelog from v3 `(new — see top of this document)`

The v3→v4 changelog table is at the top of this document (under "Changelog from v3"), to make it the first thing a maintainer reads.
