# OpenAlice — Rust Trading-Core Migration Plan (v4)

**Version:** 4.0

**Predecessor:** [v3](RUST_MIGRATION_PLAN.v3.md) — frozen historical baseline. v3 §13 Changelog records v2→v3 diffs; v4 §14 (new) records v3→v4 diffs.

**Target repo:** [kingji001/OpenAlice-rust](https://github.com/kingji001/OpenAlice-rust) @ `master`
**Audience:** A coding agent (Claude Code / Cursor / Codex) executing this plan one phase at a time, plus a human reviewer who merges PRs.
**Companion doc:** [CLAUDE.md](../CLAUDE.md) (existing repo conventions). This plan is additive and does not contradict it.



---

## 1. Executive Summary

### Goal

Move OpenAlice's safety-critical trading core (`TradingGit`, guard pipeline, per-UTA execution, optionally IBKR and Alpaca clients) into a Rust crate (`alice-trading-core`) consumed by the existing TypeScript host via a [napi-rs](https://napi.rs/) native binding. **The TypeScript host retains `UTAManager`** and continues to own all cross-cutting concerns (EventLog wiring, ToolCenter registration, FX service, snapshots, config, UI).

### Non-goals

- Rewriting AI orchestration, connectors, or AI tool definitions.
- Replacing CCXT. CCXT-backed UTAs stay fully TS — the TS `UTAManager` routes them to TS UTAs unchanged.
- Moving `UTAManager` into Rust. The Rust core only owns *per-UTA execution*.
- Recomputing existing `v1` commit hashes. They are persisted as opaque values; the migration introduces `v2` hashing for new commits going forward, with an optional Phase 2.5 entry-level audit hash.
- Changing read compatibility for existing on-disk state. Any user with `data/trading/<accountId>/commit.json` (or the legacy paths handled by [git-persistence.ts:18‑22](../src/domain/trading/git-persistence.ts:18)) must continue to load.

### Acceptable terminal states

The migration has **two acceptable terminal states**, decided at Phase 5:

1. **Full Rust core + Rust brokers** — Rust owns `TradingGit`, guards, per-UTA execution, IBKR, and Alpaca. CCXT stays TS.
2. **Rust core only** — Rust owns `TradingGit`, guards, per-UTA execution. **All real brokers (IBKR, Alpaca, CCXT) stay TS.** This is the terminal state if Phase 5 spikes return "infeasible" or "not worth the cost" for both Alpaca and IBKR.

Both outcomes are first-class. State 2 still delivers: actor-pattern concurrency safety, hash-versioned audit trail, optional entry-level audit integrity, Rust-owned commit durability, broker-execution crash recovery, **and the new commit.notify event surface, runtime UTA actor lifecycle, panic-safe FFI boundary, and reconnect-ownership matrix — these land regardless of broker porting**. The plan does not assume state 1 is the goal.

### Deliverable shape (state 1)

```
OpenAlice-rust/
├── crates/
│   └── alice-trading-core/
│       ├── Cargo.toml
│       ├── src/
│       │   ├── lib.rs              # napi-rs entry, typed structs only
│       │   ├── canonical.rs        # canonical JSON
│       │   ├── decimal.rs          # WireDecimal / WireDouble / WireInteger
│       │   ├── persisted_commit.rs # PersistedCommit::{V1Opaque, V2}
│       │   ├── git.rs              # TradingGit (v2 hashing + optional 2.5 entry hash)
│       │   ├── uta.rs              # Per-UTA actor
│       │   ├── journal.rs          # Broker-execution journal
│       │   ├── panic.rs            # catch_unwind boundary helpers (§6.12.1)
│       │   ├── guards/
│       │   └── brokers/
│       │       ├── traits.rs
│       │       ├── mock.rs
│       │       ├── ibkr/           # Phase 6 (after spike)
│       │       └── alpaca.rs       # Phase 6 (after spike)
│       └── parity/
├── packages/
│   ├── ibkr-types/                 # Phase 1a — kept forever
│   ├── ibkr-client/                # Phase 1a — replaceable in Phase 6
│   ├── trading-core-bindings/      # generated .node + d.ts + prebuilt fallbacks
│   └── ibkr/                       # re-export shim, removed in Phase 8
└── src/domain/trading/             # SHRINKS gradually
    ├── uta-manager.ts              # STAYS — TS host of all UTAs
    ├── unified-trading-account-ts.ts    # TS UTA for CCXT (and TS-backed brokers if state 2)
    └── unified-trading-account-rust.ts  # RustUtaProxy
```

A user running `pnpm install && pnpm dev` on a fresh machine without Rust installed must succeed via prebuilt platform packages. See §3.4.

---

## 2. Migration Principles

These are **invariants** an AI agent must enforce on every phase:

| # | Principle | Enforcement |
|---|-----------|-------------|
| P1 | **Always green.** Each phase ends with the system bootable end-to-end. | `pnpm install && pnpm build && pnpm dev` works on a clean machine; `pnpm test` + deterministic e2e green. |
| P2 | **Parity before cutover.** A Rust component is wired into a live path only after a parity harness shows identical output to TS on a fixed corpus. | §5 phases, §6.13. |
| P3 | **Reversible at every step.** Every phase ends with a feature flag selecting TS or Rust; flag stays for ≥1 minor release after Rust default. | `data/config/trading-core.json` structured config (§6.10). |
| P4 | **One concept per phase.** No phase mixes "port logic" with "introduce new behavior." Bugs surfaced mid-port get a `[migration]` `TODO.md` entry; the port preserves existing buggy behavior to keep parity. | Scope discipline reviewed at PR time. The Phase 1/4 splits below enforce this. |
| P5 | **Hash stability is forward-looking, not retroactive.** Existing `v1` commits stay opaque. New commits ship with `hashVersion: 2`, `intentFullHash`, and `hashInputTimestamp`. Optional `entryHashVersion: 1` + `entryFullHash` per Phase 2.5. | §6.2. |
| P6 | **Decimal correctness via wire types, not numeric types.** `WireDecimal`, `WireDouble`, `WireInteger` cover the three IBKR sentinel-bearing field families. Wire form is canonical strings (decimal/double) or numbers (integer). Arithmetic uses `BigDecimal` only after parsing. **`rust_decimal` is forbidden** at the wire layer because `UNSET_DECIMAL = 2^127-1 ≈ 1.7e38` exceeds its representable range. | §6.1; verified at [packages/ibkr/src/const.ts:13](../packages/ibkr/src/const.ts:13). |
| P7 | **Per-UTA serialization.** Every UTA is a single-writer actor. All commands for a single UTA are serialized through one `mpsc` queue. Applies to TS UTAs too — Phase 4a retrofits the actor onto the existing TS implementation. | §6.5. |
| P8 | **Rust owns durability for what Rust executes.** Commit persistence is on Rust's side of the boundary. TS receives `commit.notify` post-write events for snapshot/UI but never gates push success on its own write. | §6.4. |
| P9 | **Broker-execution durability.** Every broker call is journaled before and after, keyed by a client order ID. On restart, an explicit reconciler scans pending journal entries and reconciles against broker state. The current TS implementation has a real crash window here; the migration is the moment to fix it. | §6.11; Phase 4e. |
| P10 | **Typed FFI surface.** `serde_json::Value` does not appear in any public napi-exported method signature. All boundary types are typed Rust structs that generate matching `.d.ts`. The generated `.d.ts` is checked into the repo and CI fails on drift. | §6.6. |
| P11 | **FFI event-stream is bounded and observable.** All Rust→TS event delivery uses bounded `tokio::sync::mpsc` channels with explicit lifecycle (`unref` on shutdown), per-UTA monotonic sequence numbers, and well-defined backpressure / error semantics. No unbounded queues. | §6.12. |
| P12 | **Live brokers are not a per-PR gate.** PR CI runs deterministic tests + parity + Mock broker e2e + recorded broker replays. Live broker e2e (TWS paper, Alpaca paper, exchange testnet) is nightly/manual. | §6.7. |
| P13 | **Panic safety at the FFI boundary.** All Rust napi-exported methods are wrapped in `std::panic::catch_unwind`. Rust panics surface as typed JS errors, not process aborts. The Node host treats them like a transient broker error: log + mark UTA offline + schedule recovery. | §6.12.1; Phase 4f `parity/check-rust-panic.ts`. |
| P14 | **Connector consumer matrix.** Every Rust→TS event flow has a documented consumer list. New consumers declare against the matrix before adoption. | §6.16; Phase 4f Telegram smoke test. |

---

## 3. Integration choice: napi-rs (single process)

### 3.1 Decision

Bind Rust into the existing Node process via [`napi-rs`](https://napi.rs/) producing a `.node` artifact loaded by `require()`.

### 3.2 Rationale

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **napi-rs (chosen)** | Zero-cost on hot paths; async functions look like normal Promises; same crash surface as Node host; established prebuilt-platform-package pattern (`swc`, `prisma-engines`, `@parcel/css`). | Native rebuild on Rust changes; cross-platform `.node` binaries to ship. | ✅ |
| Subprocess + Unix socket JSON-RPC | Crash isolation; language-agnostic. | Process supervision; serialization tax on every `getPositions()`; harder cross-boundary debugging. | Reject. |
| WASM | No native binaries. | No `tokio`-style I/O; protobuf + sockets awkward; large perf hit. | Reject. |

### 3.3 Build + workspace integration

Turbo runs **package scripts**, not bare `cargo` directories. Wire it explicitly:

1. Add `crates/*` to `pnpm-workspace.yaml`.
2. `packages/trading-core-bindings/package.json`:
   ```json
   {
     "scripts": {
       "build": "napi build --platform --release --output-dir dist",
       "build:debug": "napi build --platform --output-dir dist",
       "prepack": "node scripts/prepack-platforms.mjs"
     }
   }
   ```
3. Root `package.json` adds:
   ```json
   {
     "scripts": {
       "build:rust": "cargo build --release -p alice-trading-core",
       "build:napi": "pnpm --filter @traderalice/trading-core-bindings build"
     }
   }
   ```
4. Root `predev` (already builds `@traderalice/opentypebb` and `@traderalice/ibkr`) appends the napi build **only if a Rust toolchain is detected**. If not, fall through to the prebuilt binary path (§3.4).

### 3.4 Native-build fallback — two gates

Reflecting how prebuilt-native packages are actually consumed:

#### Developer PR gate (every Rust-touching PR)

```bash
# Rust toolchain assumed present.
cargo --version
cargo test -p alice-trading-core
cargo clippy -p alice-trading-core -- -D warnings
pnpm --filter @traderalice/trading-core-bindings build
pnpm test
```

#### Release / consumer gate (every release tag, in CI matrix)

```bash
# Container has Node + pnpm but NO Rust toolchain.
docker run --rm -v $PWD:/repo -w /repo node:22-slim bash -c '
  corepack enable
  pnpm install --frozen-lockfile
  pnpm build
  pnpm dev > /tmp/dev.log 2>&1 &
  DEV_PID=$!
  trap "kill $DEV_PID 2>/dev/null || true" EXIT

  # Real readiness check, not a sleep.
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3002/api/status > /dev/null; then
      echo "ready after ${i}s"
      curl -sf http://localhost:3002/api/status   # logs version + ffiLoaded for the gate audit trail
      kill $DEV_PID
      exit 0
    fi
    sleep 1
  done
  echo "FAILED to become ready"
  cat /tmp/dev.log
  exit 1
'
```

**Route prerequisite:** `GET /api/status` is shipped by Phase 0 Deliverable 9 (`src/connectors/web/routes/status.ts`). The route returns `{ ok, version, uptimeSeconds, ffiLoaded }`. `ffiLoaded` is `false` pre-Phase-4f; the gate logs the body so the audit trail captures both the build version and the FFI state at gate time.

The release gate runs on darwin-arm64, darwin-x64, linux-x64-gnu, win32-x64-msvc. If any platform fails, the release is blocked.

---

## 4. Target architecture

### 4.1 Boundary

```
┌──────────────────────────────────────────────────────────────────┐
│                        TypeScript host (Node)                     │
│                                                                   │
│  AgentCenter ── ToolCenter ── tradingTools                        │
│                                  │                                │
│                                  ▼                                │
│                        ┌─────────────────────┐                    │
│                        │     UTAManager      │  (TS, forever)     │
│                        │                     │                    │
│                        │  ┌─────────────┐    │                    │
│                        │  │ TS UTA      │◄───┼── CCXT (always)   │
│                        │  │ (actor)     │◄───┼── Alpaca/IBKR      │
│                        │  └─────────────┘    │   (if state 2)     │
│                        │                     │                    │
│                        │  ┌─────────────┐    │                    │
│                        │  │ RustUtaProxy│◄───┼── Alpaca/IBKR      │
│                        │  └──────┬──────┘    │   (if state 1)     │
│                        └─────────┼───────────┘                    │
│  Brain  News  ConnectorCenter    │                                │
│  Market data  Snapshots  FX      │                                │
│  EventLog                        │                                │
└──────────────────────────────────┼────────────────────────────────┘
                                   │ napi-rs FFI (typed structs)
┌──────────────────────────────────┼────────────────────────────────┐
│                                  ▼                                │
│                  alice-trading-core (Rust)                        │
│                                                                   │
│   Per Rust-backed UTA:                                            │
│   ┌────────────────────────────────────────────────┐              │
│   │  UtaActor (single tokio task, mpsc-fed)        │              │
│   │   ├── TradingGit  (owns commit.json)           │              │
│   │   ├── ExecutionJournal (owns executing/*.json) │              │
│   │   ├── GuardPipeline                            │              │
│   │   └── Broker (IBKR / Alpaca / Mock)            │              │
│   └────────────────────────────────────────────────┘              │
│                                                                   │
│   Cross-UTA infrastructure:                                       │
│   - canonical_json::serialize (shared with TS Phase 1c lib)       │
│   - WireDecimal / WireDouble / WireInteger                        │
│   - PersistedCommit::{V1Opaque, V2}                               │
│   - BrokerError (CONFIG/AUTH/NETWORK/EXCHANGE/MARKET_CLOSED/      │
│                  UNKNOWN, with permanent flag)                    │
│   - Bounded mpsc → ThreadsafeFunction event stream                │
└───────────────────────────────────────────────────────────────────┘
```

### 4.2 What stays in TypeScript (and why)

- **`UTAManager`** — wires the following ([uta-manager.ts:71‑330](../src/domain/trading/uta-manager.ts:71)). Moving these across FFI grows the boundary.
  - `EventLog` (`uta-manager.ts:101` — `account.health` emission)
  - `ToolCenter` (`:133-139, :162-168` — CCXT-specific provider tools register on init/reconnect)
  - `FxService` (`:82-88` setter; cross-account math at `:260-293`)
  - Snapshot hooks (`:103-104` — `setSnapshotHooks`; **removed in Phase 4d**, replaced by EventLog subscription)
  - `getAggregatedEquity` (`:260-293`) — cross-account FX math, real surface area
  - `searchContracts` / `getContractDetails` (`:297-330`) — broker-agnostic, IBKR-typed contract search routed across all UTAs; FFI boundary must ship `ContractDescription` and `ContractDetails`
  - `createGitPersister(cfg.id)` (`:99`) — current persistence side-channel that the actor model replaces in Phase 4d
  - `broker.factory` / `getBrokerPreset` (`:94, :134`) — broker preset coupling
- **CCXT broker** — JS-native. Subprocess-shimming it through Rust was rejected in v2 review.
- **`fx-service.ts`, `snapshot/*`** — depend on TS market-data + EventLog.
- **`ibkr-types`** (Phase 1a output) — `Order`, `Contract`, `Execution`, `OrderState`, `UNSET_*` constants, IBKR enums. Imported throughout the codebase; kept forever.
- AI providers, connectors, Brain, news, market-data, analysis, thinking, openclaw — outside scope.

### 4.3 What moves to Rust

| Source (current) | Destination | Phase |
|---|---|---|
| `src/domain/trading/git/TradingGit.ts` | `crates/alice-trading-core/src/git.rs` | 3 |
| `src/domain/trading/git/types.ts` | `crates/alice-trading-core/src/types.rs` | 3 |
| `src/domain/trading/guards/*` | `crates/alice-trading-core/src/guards/` | 4c |
| `src/domain/trading/UnifiedTradingAccount.ts` (per-UTA actor for Rust-backed accounts) | `crates/alice-trading-core/src/uta.rs` | 4d |
| `src/domain/trading/brokers/types.ts` | `crates/alice-trading-core/src/brokers/traits.rs` | 4b |
| `src/domain/trading/brokers/mock/MockBroker.ts` | `crates/alice-trading-core/src/brokers/mock.rs` | 4b |
| `src/domain/trading/brokers/alpaca/*` | `crates/alice-trading-core/src/brokers/alpaca.rs` | 6 (after spike) |
| `src/domain/trading/brokers/ibkr/*` + `packages/ibkr-client/` | `crates/alice-trading-core/src/brokers/ibkr/` | 6 (after spike) |
| **Stays in TS forever:** `uta-manager.ts`, `brokers/ccxt/*`, `snapshot/*`, `fx-service.ts` | — | — |

### 4.4 LeverUp broker placement

LeverUp is being actively developed (`TODO.md:232-257`) and was absent from v3. It has shape-distinct quirks the Phase 4b `Broker` trait must accommodate:

1. **Whole-position close** (no partial close)
2. **No limit orders** (market-only)
3. **EIP-712 signing** for order intent

**Decision (locked in [v4 open decisions](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-1)):** LeverUp stays TS-only until its TS impl stabilizes. Revisit post-Phase-7. The Phase 4b `Broker` trait still includes a `BrokerCapabilities` extension point (Phase 4b Deliverable 8) so the trait shape doesn't need rework if this decision later flips.

`tradingCore.defaultBrokerImpl.leverup` defaults to `'ts'` and is literal-pinned in the Zod schema (§6.10) until the LeverUp Rust port lands.

---

## 5. Phased migration

Each phase is a contract an AI agent can pick up cold:

```
Phase N — <name>
  Inputs:           which files to read first
  Deliverable:      what the working tree must contain at the end
  DoD (commands):   exact shell commands that must succeed
  Cutover gate:     parity / flag conditions
  Rollback:         how to revert if a downstream phase fails
  Estimated effort: human-equivalent days (an agent will be faster)
```

### Phase 0 — Inventory + fixtures (no behavior change)

**Inputs:** all of `src/domain/trading/` and `packages/ibkr/` (read-only).

**Deliverable:**

1. `parity/fixtures/operations/` — ≥200 staged operation cases. Numeric fields captured via `toCanonicalDecimalString` (defined in §6.1), **not** raw `Decimal.toString()`. Cases cover BUY/SELL × every order type × every TIF × with/without TP-SL × adversarial decimals (8/12/18 decimals, very large, very small, negative, zero).
2. `parity/fixtures/sentinels/` — explicit cases for `UNSET_DECIMAL` (`2^127-1`), `UNSET_DOUBLE` (`Number.MAX_VALUE`), `UNSET_INTEGER` (`2^31-1`) in every position they can occupy on `Order`/`Contract`/`Execution`/`OrderState`.
3. `parity/fixtures/git-states/` — 10 saved `GitExportState` files captured from real e2e runs.
4. `parity/fixtures/legacy-paths/` — saved states at the legacy paths (`data/crypto-trading/commit.json`, `data/securities-trading/commit.json`) verified by [git-persistence.ts:18‑22](../src/domain/trading/git-persistence.ts:18). Loader test confirms identical load.
5. `parity/fixtures/orders-on-wire/` — JSON snapshots of `Order` / `Contract` after `JSON.stringify`. Phase 1b's adapters must round-trip these.
6. `parity/run-ts.ts` — CLI driving a real `TradingGit` through `add → commit → push (mock dispatcher) → log → exportState`.
7. `parity/decimal-inventory.md` — written audit of every `Decimal` / number-with-sentinel field in the codebase, classifying each as: (a) value-only, (b) value-or-unset, (c) computed-only. Drives the wire-type design in Phase 1b.
8. `parity/context-worksheets/` — one file per sub-PR identified in §8.4. Each lists exact files an agent must load. Template at `parity/context-worksheets/_template.md`; conventions in the directory README.
9. `src/connectors/web/routes/status.ts` — `GET /api/status` returning `{ ok, version, uptimeSeconds, ffiLoaded }`. Wire into `web-plugin.ts` route mount. Smoke test asserts the §3.4 release gate passes against the current TS-only build. `ffiLoaded` is `false` until Phase 4f.
10. `TODO.md` entries with `[snapshot-durability]` tag for each gap in §6.4.1; `[migration-deferred]` tag for each TODO row in §6.13 that ports as-is; `[v4-revisit]` tag for LeverUp; `[migration-known]` tag for `UNSET_LONG` precision caveat.

**DoD:**

```bash
pnpm tsx parity/run-ts.ts parity/fixtures/operations/case-001.json > /tmp/ts.json
test -s /tmp/ts.json
pnpm tsx parity/load-legacy.ts          # both legacy fixtures load
npx tsc --noEmit
pnpm test
```

**Cutover gate:** none (preparation only).

**Rollback:** revert. Trivial — no production code changes.

**Estimated effort:** 4–5 days.

---

### Phase 1 — Canonical TS data model

Phase 1 ships in three sub-PRs to keep concept boundaries clean:

#### Phase 1a — `ibkr-types` / `ibkr-client` package split (mechanical)

**Inputs:** `packages/ibkr/`.

**Deliverable:**

1. `packages/ibkr-types/` — `Order`, `Contract`, `Execution`, `OrderState`, `ContractDescription`, `ContractDetails`, `UNSET_DECIMAL`, `UNSET_DOUBLE`, `UNSET_INTEGER`, all enums. **No I/O.**
2. `packages/ibkr-client/` — connection, reader, decoder, request bridge, protobuf wrappers.
3. `packages/ibkr/` becomes a re-export shim that re-exports from both new packages, kept for one minor release for back-compat.
4. **No callers change.** Existing `import { Order } from '@traderalice/ibkr'` continues to work via the shim.
5. **Acknowledge decoder→DTO coupling.** `decoder/execution.ts:43,89,140,157`, `decoder/account.ts:47,103,220,325`, `decoder/contract.ts:116,181` all do `new Contract()` / `new Execution()` / `new ContractDetails()`. So `ibkr-client` takes a **value-level** dep on `ibkr-types` (not type-only). Document explicitly in the package READMEs.
6. **Move `order-decoder.ts`** from `packages/ibkr/src/order-decoder.ts` into `packages/ibkr-client/src/decoder/order.ts`. v3's "mechanical" framing missed this file.
7. **Decision recorded:** `Order` / `Contract` / `ContractDetails` / `ContractDescription` stay as classes (not interfaces) — the decoder constructs and mutates them imperatively. Refactor to interfaces is a separate non-mechanical change, out of scope for Phase 1a.

**DoD:**

```bash
pnpm test                                    # all current tests pass via shim
npx tsc --noEmit
pnpm dev                                     # boots, smoke check
git ls-files packages/ibkr/src                                # only re-exports
```

**Cutover gate:** none. **Note:** the refactor is *conceptually* a split but not *mechanically* clean — see Deliverable 5 for the decoder coupling acknowledgement.

**Rollback:** revert. Trivial.

**Estimated effort:** 3–4 days.

#### Phase 1b — Wire types + adapters

**Inputs:** Phase 1a deliverables, `parity/fixtures/orders-on-wire/`, `parity/decimal-inventory.md`.

**Deliverable:**

1. `src/domain/trading/wire-types.ts`:
   ```typescript
   export type DecimalString = string  // validated, no exponent, canonical zero "0"

   export type WireDecimal =
     | { kind: 'unset' }
     | { kind: 'value'; value: DecimalString }

   export type WireDouble =
     | { kind: 'unset' }
     | { kind: 'value'; value: DecimalString }  // strings to avoid IEEE-754 drift across FFI

   export type WireInteger =
     | { kind: 'unset' }
     | { kind: 'value'; value: number }   // safe-integer range, sentinel-free

   export interface WireOrder { /* every field, in canonical wire form */ }
   export interface WireContract { /* ... */ }
   export interface WireExecution { /* ... */ }
   export interface WireOrderState { /* ... */ }
   ```

2. `src/domain/trading/wire-adapters.ts`:
   - `ibkrOrderToWire(order: Order): WireOrder` — strips class identity, converts `Decimal` to `DecimalString` via `toCanonicalDecimalString` (§6.1), recognizes each of the three `UNSET_*` sentinels and emits `{ kind: 'unset' }`.
   - Inverse adapters for round-trip.
   - Same for `Contract`, `Execution`, `OrderState`.

3. Round-trip test: every fixture in `parity/fixtures/orders-on-wire/` and `parity/fixtures/sentinels/` round-trips.

4. **`TradingGit` continues to use the legacy hashing path on the live route.** Wire types are added but unused on the live path until Phase 2.
5. **`UNSET_LONG` precision fixture.** `packages/ibkr/src/const.ts:12` defines `UNSET_LONG = BigInt(2 ** 63) - 1n`. The `2 ** 63` is computed as a JS Number, exceeding `Number.MAX_SAFE_INTEGER` and rounding. If any IBKR field maps to Rust `i64`, the wire-type design must reconstruct `i64::MAX` canonically (not from the lossy TS source). Phase 1b adds a fixture asserting exact `i64::MAX` round-trip for any such field. See §6.1 caveats.

**DoD:**

```bash
pnpm test
pnpm tsx parity/check-wire-roundtrip.ts        # every fixture round-trips
pnpm tsx parity/check-sentinels.ts             # all three sentinels detected and emitted as { kind: 'unset' }
npx tsc --noEmit
pnpm dev
```

**Cutover gate:** wire round-trip 100% on fixtures.

**Rollback:** revert.

**Estimated effort:** 4–5 days.

#### Phase 1c — Canonical JSON utility (dead code)

**Inputs:** Phase 1b deliverables.

**Deliverable:**

1. `src/domain/trading/canonical-json.ts`:
   - Sorted-key recursive serializer.
   - No whitespace.
   - `WireDecimal` / `WireDouble` serialize as `{"kind":"unset"}` or `{"kind":"value","value":"<DecimalString>"}` — sorted keys at every nesting level.
   - Round-trip test: `JSON.parse(canonical(x))` deep-equals `x` for every wire fixture.

2. `src/domain/trading/canonical-decimal.ts` — the explicit formatter:
   ```typescript
   /**
    * Canonical decimal-string formatter. Replaces Decimal.toString() at every
    * boundary that crosses persistence, hashing, or FFI.
    *
    * Rules:
    *   - No exponent / scientific notation.
    *   - No leading '+'.
    *   - No trailing decimal point.
    *   - Canonical zero = "0" (not "0.0", not "-0").
    *   - Negative sign only on nonzero values.
    *   - Reject NaN / Infinity / -0 with a thrown error.
    *   - Trailing zeros after decimal point are stripped.
    */
   export function toCanonicalDecimalString(d: Decimal): string { /* ... */ }
   ```

3. **Not wired into `TradingGit` yet.** Phase 2 is when it goes live.

**DoD:**

```bash
pnpm test
pnpm tsx parity/check-canonical-json.ts
pnpm tsx parity/check-canonical-decimal.ts     # adversarial cases (1e30, 1e-30, -0, NaN-throw)
npx tsc --noEmit
```

**Cutover gate:** canonical formatter rules enforced on every fixture; rejection cases throw.

**Rollback:** revert.

**Estimated effort:** 2–3 days.

---

### Phase 2 — Hash v2 (intent only)

**Goal:** introduce a forward-compatible intent hash for new commits. Existing v1 commits stay opaque. `entryFullHash` is **not** part of this phase; it lands in Phase 2.5.

**Inputs:** Phase 0–1 deliverables, [TradingGit.ts](../src/domain/trading/git/TradingGit.ts).

**Deliverable:**

1. **`GitCommit` schema extension:**
   ```typescript
   interface GitCommit {
     /**
      * Back-compatible 8-char display hash.
      * For v2 commits, this is the short form of intentFullHash.
      */
     hash: CommitHash

     /** Absent or 1 = legacy opaque v1 hash. 2 = canonical intent hash. */
     hashVersion?: 1 | 2

     /**
      * Full 64-char SHA-256 over the canonical intent input.
      * Present iff hashVersion === 2.
      *
      * Renamed from "fullHash" to leave room for entryFullHash (Phase 2.5).
      */
     intentFullHash?: string

     /** Exact timestamp used in the v2 intent hash input. Present iff hashVersion === 2. */
     hashInputTimestamp?: string

     parentHash: CommitHash | null
     message: string
     operations: WireOperation[]
     results: OperationResult[]
     stateAfter: WireGitState
     timestamp: string
     round?: number

     // Reserved for Phase 2.5 — do not populate in Phase 2.
     // entryHashVersion?: 1
     // entryFullHash?: string
   }
   ```

2. **Hash v2 algorithm** in `src/domain/trading/git/hash-v2.ts`:
   ```typescript
   export function generateIntentHashV2(input: {
     parentHash: CommitHash | null
     message: string
     operations: WireOperation[]
     hashInputTimestamp: string
   }): { intentFullHash: string; shortHash: string } {
     const canonical = canonicalJson({ ...input, hashVersion: 2 })
     const intentFullHash = sha256(canonical)
     return { intentFullHash, shortHash: intentFullHash.slice(0, 8) }
   }
   ```

3. **`hashInputTimestamp` captured at intent site, reused by every downstream write of the same commit.** v3 said "fix at commit/push"; the desync also exists at `reject()` ([TradingGit.ts:172](../src/domain/trading/git/TradingGit.ts:172)) and `sync()` ([TradingGit.ts:386, :404](../src/domain/trading/git/TradingGit.ts:386)). v4 fixes **all four** sites:
   - `commit()` ([TradingGit.ts:69](../src/domain/trading/git/TradingGit.ts:69)) — picks `hashInputTimestamp = new Date().toISOString()`, computes v2 hash, **persists `hashInputTimestamp` on the resulting commit**, sets `hashVersion: 2`.
   - `push()` ([TradingGit.ts:124](../src/domain/trading/git/TradingGit.ts:124)) — uses the timestamp captured at `commit()`, not a new one.
   - `reject()` ([TradingGit.ts:172](../src/domain/trading/git/TradingGit.ts:172)) — captures its own `hashInputTimestamp` at the rejection-intent moment; downstream persistence reuses it.
   - `sync()` ([TradingGit.ts:386, :404](../src/domain/trading/git/TradingGit.ts:386)) — same pattern.
   Fixtures cover all four sites for timestamp consistency.

4. **Mixed-version log loader** in `src/domain/trading/git/persisted-commit.ts`:
   ```typescript
   export type PersistedCommit =
     | { kind: 'v1-opaque'; raw: GitCommitV1 }    // hashVersion absent
     | { kind: 'v2'; commit: GitCommitV2 }        // hashVersion === 2

   export function classifyCommit(raw: unknown): PersistedCommit { /* ... */ }
   ```
   - v1 commits load verbatim, never recomputed, never re-canonicalized.
   - v2 commits validate `intentFullHash` matches recomputed canonical hash on load (warn, do not error, by default).
   - Export round-trips both forms. Mixed logs are first-class.

5. `scripts/verify-v2-hashes.ts` — startup-optional verifier.

**DoD:**

```bash
pnpm test
pnpm tsx parity/hash-v2-roundtrip.ts                    # commit → recompute → match
pnpm tsx parity/check-mixed-log.ts                      # v1+v2 log loads + exports
pnpm tsx scripts/verify-v2-hashes.ts                    # all v2 commits in data/trading/ verify
pnpm tsx parity/legacy-v1-untouched.ts                  # v1 commits unchanged
npx tsc --noEmit
pnpm dev
```

**Cutover gate:** new commits carry `hashVersion: 2` and `intentFullHash`; recomputing locally produces persisted value byte-for-byte. All v1 commits load and display unchanged.

**Rollback:** revert. Existing v1 commits are untouched; any v2 commits made during rollout become opaque under the rolled-back code (readable, not verifiable — acceptable).

**Estimated effort:** 4–5 days.

---

### Phase 2.5 — Optional full-entry audit hash (decision gate)

**Status:** **default-accepted.** Phase 2.5 ships unless explicitly declined. The migration is the natural moment to add this property; the rollback is genuinely safe (`entryFullHash` is optional, older code ignores it). Decline only if there's a specific reason to defer; record the reason in `docs/migration-broker-decision.md`.

**Goal:** add an optional integrity hash over the fully persisted `GitCommit` entry, including execution results, state-after, and broker IDs. Verifies that nothing in the persisted commit was modified after write.

**Inputs:** Phase 2 deliverables.

**Deliverable:**

1. **`GitCommit` schema extension:**
   ```typescript
   interface GitCommit {
     // ... Phase 2 fields ...

     /** Absent = no entry-level hash; 1 = current entry-hash schema. */
     entryHashVersion?: 1

     /** SHA-256 over the full persisted commit body, computed pre-write. */
     entryFullHash?: string
   }
   ```

2. **Entry hash algorithm** in `src/domain/trading/git/entry-hash.ts`:
   ```typescript
   export function generateEntryFullHash(commit: GitCommit): string {
     const input = {
       entryHashVersion: 1,

       // Intent identity (forward-references intent hash if present)
       hash: commit.hash,
       hashVersion: commit.hashVersion,
       intentFullHash: commit.intentFullHash,
       hashInputTimestamp: commit.hashInputTimestamp,

       // Commit body
       parentHash: commit.parentHash,
       message: commit.message,
       operations: commit.operations,
       results: commit.results,
       stateAfter: commit.stateAfter,
       timestamp: commit.timestamp,
       round: commit.round,
     }
     // entryFullHash is intentionally NOT in the input.
     return sha256(canonicalJson(input))
   }
   ```

3. **Computed at three sites:**
   - End of `push()` — after results + stateAfter assembled, before persistence.
   - End of `reject()` — same.
   - End of `sync()` — same.

4. **Verification rules:**
   - v1 commits: no `entryFullHash` expected; skip.
   - v2 intent-only commits (no `entryHashVersion`): verify `intentFullHash`; ignore entry hash.
   - v2 + entry-hash commits: verify both.
   - Default verification mode: warn on mismatch, log structured event. Strict-fail mode behind `--strict-audit-verification` flag.

5. `scripts/verify-entry-hashes.ts` — independent CLI verifier.

6. `parity/fixtures/entry-hash/` — push, reject, sync fixtures.

**DoD:**

```bash
pnpm test
pnpm tsx parity/check-entry-hash.ts                    # every fixture verifies
pnpm tsx scripts/verify-entry-hashes.ts                # all entry-hashed commits in data/trading/
pnpm tsx parity/check-mixed-entry-hash.ts              # v1 + v2-no-entry + v2-with-entry coexist
npx tsc --noEmit
pnpm dev
```

**Cutover gate:** new commits made post-Phase-2.5 carry `entryHashVersion: 1` and `entryFullHash`. All three coexistence cases load.

**Rollback:** revert. `entryFullHash` is optional; older code ignores it. Commits made during the rolled-out window remain valid under rolled-back code (entry hash not verified, but no error).

**Estimated effort:** 3–4 days.

**If declined:** Phase 3 proceeds against the Phase 2 schema. Document the decline reason.

---

### Phase 3 — Rust workspace + Rust `TradingGit` only

**Goal:** prove Rust↔TS parity on `TradingGit` against the **finalized schema** from Phase 2 (or 2.5 if endorsed). Rust is dead code at the end of this phase.

**Inputs:** all prior phases.

**Deliverable:**

1. `crates/alice-trading-core/Cargo.toml` with: `napi`, `napi-derive`, `tokio`, `serde`, `serde_json`, `bigdecimal`, `sha2`, `thiserror`, `tracing`. **No `rust_decimal`** (P6).

2. `crates/alice-trading-core/src/decimal.rs`:
   ```rust
   #[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
   pub struct DecimalString(String);

   impl DecimalString {
       pub fn new(s: String) -> Result<Self, DecimalParseError> { /* validate canonical form */ }
       pub fn as_str(&self) -> &str { &self.0 }
       pub fn to_bigdecimal(&self) -> Result<BigDecimal, ParseError> { /* ... */ }
   }

   #[derive(Clone, Serialize, Deserialize)]
   #[serde(tag = "kind", rename_all = "lowercase")]
   pub enum WireDecimal { Unset, Value { value: DecimalString } }

   #[derive(Clone, Serialize, Deserialize)]
   #[serde(tag = "kind", rename_all = "lowercase")]
   pub enum WireDouble { Unset, Value { value: DecimalString } }

   #[derive(Clone, Serialize, Deserialize)]
   #[serde(tag = "kind", rename_all = "lowercase")]
   pub enum WireInteger { Unset, Value { value: i64 } }

   /// Mirror of TS toCanonicalDecimalString.
   /// Does NOT use BigDecimal::normalize().to_string() — that's not guaranteed
   /// to match the TS rules. Implemented explicitly.
   pub fn to_canonical_decimal_string(d: &BigDecimal) -> Result<String, CanonicalError> {
       // reject NaN/Infinity (BigDecimal can't represent these — they shouldn't reach this fn)
       // canonical zero = "0"
       // strip trailing zeros after decimal point
       // strip trailing decimal point
       // negative sign only for nonzero
       // ...
   }
   ```

3. `crates/alice-trading-core/src/canonical.rs` — sorted-key canonical JSON serializer matching Phase 1c byte-for-byte.

4. `crates/alice-trading-core/src/persisted_commit.rs`:
   ```rust
   #[derive(Serialize, Deserialize)]
   #[serde(untagged)]
   pub enum PersistedCommit {
       V2(GitCommitV2),
       V1Opaque(serde_json::Value),  // raw, never re-canonicalized
   }

   impl PersistedCommit {
       pub fn classify(raw: serde_json::Value) -> Self { /* hashVersion === 2 → V2; else → V1Opaque */ }
   }
   ```
   - `V1Opaque` is the **only** place a `serde_json::Value` appears in the Rust codebase. v1 commits are never normalized, never re-hashed.

5. `crates/alice-trading-core/src/git.rs` — full port of `TradingGit`:
   - Hash v2 only for new commits. Phase 2.5 entry hash if endorsed.
   - `Operation`, `OperationResult`, `GitCommitV2`, `GitExportState` mirror wire types.
   - All decimals are `WireDecimal`/`WireDouble`/`WireInteger`. Arithmetic uses `BigDecimal`.
   - `executeOperation` is `Box<dyn Fn(Operation) -> BoxFuture<'_, Result<OperationResult>>>` — broker plugged in at Phase 4d.

6. **Typed napi surface** in `lib.rs` — every method takes typed structs. **Zero `serde_json::Value` in public signatures** (P10):
   ```rust
   #[napi(object)] pub struct AddResult { pub staged: bool, pub index: u32 }
   #[napi(object)] pub struct CommitPrepareResult { /* ... */ }

   #[napi]
   pub struct TradingGit { /* ... */ }

   #[napi]
   impl TradingGit {
       #[napi(factory)] pub fn new() -> Self { /* ... */ }
       #[napi] pub fn add(&mut self, op: Operation) -> AddResult { /* ... */ }
       #[napi] pub fn commit(&mut self, message: String) -> Result<CommitPrepareResult> { /* ... */ }
       // ...
   }
   ```
   Generated `index.d.ts` checked into repo; CI fails on drift.

   **FFI callback contract.** `TradingGitConfig` carries three callbacks the constructor accepts ([interfaces.ts:55-59](../src/domain/trading/git/interfaces.ts:55)): `executeOperation: (op) => Promise<unknown>` (broker dispatcher), `getGitState: () => Promise<GitState>` (broker state pull), `onCommit?: (state) => Promise<void>` (persistence hook). v4 chooses **Option A**: orchestrate push/commit in Rust; the three callbacks become typed napi method signatures (`broker_execute_operation`, `broker_get_state`, `commit_persisted_notify`). Rust calls TS only via these three. (Option B — orchestrate in TS, Rust holds only data — was rejected for FFI chatter.)

7. `parity/run-rust` — Rust-side fixture runner.

8. CI: `.github/workflows/parity.yml` diffs `parity/run-ts` and `parity/run-rust` outputs.
9. **Rehydration belongs in TS.** `Order` rehydration in `_rehydrateOperation` ([TradingGit.ts:312-371](../src/domain/trading/git/TradingGit.ts:312)) is broker-shape-aware (Decimal field-by-field rewrap of IBKR `Order`). Rust ports the rehydration logic as `WireOrder → WireOrder` round-trip; broker-class rehydration (`new Order()` + `Decimal(...)` field rewrap) belongs in the TS proxy layer (Phase 4f), not in Rust.

**DoD:**

```bash
cargo test -p alice-trading-core
cargo clippy -p alice-trading-core -- -D warnings
pnpm --filter @traderalice/trading-core-bindings build
pnpm tsx parity/check-git.ts                            # all fixtures pass
pnpm tsx parity/check-canonical-decimal-rust.ts         # Rust formatter matches TS rules byte-for-byte
node -e "console.log(require('@traderalice/trading-core-bindings').ping())"
# Developer gate (§3.4):
cargo --version                                         # required for this PR
# Release gate (§3.4) runs in CI on release-tag pipeline only.
npx tsc --noEmit
pnpm test
```

**Cutover gate:** Rust `TradingGit` produces byte-identical canonical JSON, byte-identical SHA-256, and (if 2.5 endorsed) byte-identical entry hash to TS for every fixture. Rust crate is **not wired into any live path** yet.

**Rollback:** Rust crate is dead code. `git revert`.

**Estimated effort:** 7–9 days.

---

### Phase 4 — Guards + per-UTA actor + Mock broker (split into 4a–4f)

Phase 4 in v2 mixed too many concepts. v3 splits into six sub-PRs. Each ships independently; later sub-phases depend on earlier ones.

#### Phase 4a — TS UTA actor retrofit (independently valuable)

**Goal:** fix the latent concurrency hole in the existing TS implementation. Two parallel AI tool calls can interleave `stage / commit / push` on the same UTA today; there's no lock. This sub-phase ships the actor pattern in TS *before any Rust UTA work*, so the fix lands regardless of whether Rust ever reaches Phase 4d.

**Inputs:** [src/domain/trading/UnifiedTradingAccount.ts](../src/domain/trading/UnifiedTradingAccount.ts).

**Deliverable:**

1. `src/domain/trading/uta-actor.ts` — TS implementation of the actor pattern:
   ```typescript
   export class TsUtaActor {
     private readonly queue: AsyncQueue<UtaCommand>
     async send<R>(cmd: UtaCommand<R>): Promise<R> { /* ... */ }
   }
   ```
   - All public UTA methods become `cmd → enqueue → await reply`.
   - The actor is the single mutator of `TradingGit`, broker connection state, health counters.

2. `UnifiedTradingAccount` refactored to delegate to the actor. Public surface unchanged.

3. Concurrency test: 100 parallel `stage/commit/push/sync` calls on one UTA produce a coherent serialized log.

**DoD:**

```bash
pnpm test
pnpm tsx parity/check-uta-concurrency.ts        # 100 parallel ops, coherent log
pnpm test:e2e                                    # existing tests still pass through the actor
```

**Cutover gate:** concurrency test green; existing TS UTA behavior unchanged for sequential cases.

**Rollback:** revert.

**Estimated effort:** 3–4 days.

#### Phase 4b — Rust `Broker` trait + `BrokerError` + `MockBroker`

**Goal:** establish the Rust-side broker abstraction with **exact error-shape parity** to TS.

**Inputs:** [src/domain/trading/brokers/types.ts](../src/domain/trading/brokers/types.ts), [src/domain/trading/brokers/mock/MockBroker.ts](../src/domain/trading/brokers/mock/MockBroker.ts).

**Deliverable:**

1. `crates/alice-trading-core/src/brokers/traits.rs` — `Broker` async trait with every method on `IBroker`.

2. **`BrokerError` exact mapping** (verified at [brokers/types.ts:16](../src/domain/trading/brokers/types.ts:16)):
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
   #[error("[{code:?}] {message}")]
   pub struct BrokerError {
       pub code: BrokerErrorCode,
       pub message: String,
       pub permanent: bool,
   }

   #[derive(Debug, Clone, Copy, Serialize, Deserialize)]
   #[serde(rename_all = "SCREAMING_SNAKE_CASE")]   // produces UPPERCASE_WITH_UNDERSCORES
   pub enum BrokerErrorCode {
       Config,         // → "CONFIG"
       Auth,           // → "AUTH"
       Network,        // → "NETWORK"
       Exchange,       // → "EXCHANGE"
       MarketClosed,   // → "MARKET_CLOSED"
       Unknown,        // → "UNKNOWN"
   }

   impl BrokerError {
       pub fn new(code: BrokerErrorCode, message: String) -> Self {
           let permanent = matches!(code, BrokerErrorCode::Config | BrokerErrorCode::Auth);
           Self { code, message, permanent }
       }
   }
   ```
   **Unit test** (mandatory, not optional):
   ```rust
   #[test] fn broker_error_codes_serialize_to_exact_ts_strings() {
       use BrokerErrorCode::*;
       assert_eq!(serde_json::to_string(&Config).unwrap(),       "\"CONFIG\"");
       assert_eq!(serde_json::to_string(&Auth).unwrap(),         "\"AUTH\"");
       assert_eq!(serde_json::to_string(&Network).unwrap(),      "\"NETWORK\"");
       assert_eq!(serde_json::to_string(&Exchange).unwrap(),     "\"EXCHANGE\"");
       assert_eq!(serde_json::to_string(&MarketClosed).unwrap(), "\"MARKET_CLOSED\"");
       assert_eq!(serde_json::to_string(&Unknown).unwrap(),      "\"UNKNOWN\"");
   }
   ```
   This guards against the v2 bug (`rename_all = "UPPERCASE"` would yield `"MARKETCLOSED"`).

3. `crates/alice-trading-core/src/brokers/mock.rs` — port of `MockBroker.ts`. Deterministic order ID allocation; in-memory state.

4. **TS-side `BrokerError` reconstruction** in the eventual `RustUtaProxy` (Phase 4f):
   ```typescript
   function toBrokerError(napiErr: unknown): BrokerError {
     const e = new BrokerError((napiErr as any).code, (napiErr as any).message)
     Object.setPrototypeOf(e, BrokerError.prototype)  // preserve instanceof
     if (e.permanent !== (napiErr as any).permanent) {
       throw new Error('BrokerError permanence mismatch — Rust/TS code mapping drift')
     }
     return e
   }
   ```
   Test asserts `err instanceof BrokerError === true` after FFI crossing.

5. **Port `BrokerError.classifyMessage()`** ([brokers/types.ts:45-59](../src/domain/trading/brokers/types.ts:45)). Regex-based error-message classifier (network-timeout, auth-rejected, etc.) called by today's broker impls to populate `code`. Replicate verbatim in Rust with fixture coverage; revisit cleanup post-Phase-7.

6. **Rationalize offline-push error shape.** `UnifiedTradingAccount.push()` ([:421-431](../src/domain/trading/UnifiedTradingAccount.ts:421)) throws plain `Error`, not `BrokerError`, when `_disabled` or `health === 'offline'`. Rust port throws `BrokerError(CONFIG, "account disabled", permanent: true)` and `BrokerError(NETWORK, "account offline", permanent: false)` respectively. Mirror the change in TS in the same PR.

7. **MockBroker port preserves five behaviors as explicit parity assertions** (not "behavioral parity" hand-wave): deterministic order ID counter; exact avg-cost recalc semantics including the "flipped position simplification" at [MockBroker.ts:527-529](../src/domain/trading/brokers/mock/MockBroker.ts:527); fail-injection machinery (`setFailMode`); call-log shape (`_callLog` / `calls()` / `callCount()` / `lastCall()`); failure-mode triggering of health transitions.

8. **`BrokerCapabilities` extension point on the `Broker` trait** (forward-compat for §4.4). Trait carries `fn capabilities(&self) -> BrokerCapabilities` returning `{ closeMode: { partial | wholePosition }, orderTypes: bitflags, signingScheme: { none | eip712 | ... } }`. Default impl returns `{ partial, market | limit | stop | bracket, none }` — current brokers (IBKR, Alpaca, Mock) satisfy the default and don't override. If §4.4 ever flips, LeverUp overrides; no trait-shape rework. No behavior change in Phase 4b.

**DoD:**

```bash
cargo test -p alice-trading-core::brokers
cargo test -p alice-trading-core --test broker_error_serialize    # exact-string test
pnpm tsx parity/check-mock-broker.ts             # Mock broker behavior parity
```

**Cutover gate:** all six error code strings match exactly. Mock broker fixtures pass.

**Estimated effort:** 3–4 days.

#### Phase 4c — Rust guards + parity

**Inputs:** [src/domain/trading/guards/](../src/domain/trading/guards/).

**Deliverable:**

1. `Guard` trait + `cooldown.rs`, `max_position_size.rs`, `symbol_whitelist.rs`. Configuration uses `#[serde(deny_unknown_fields)]` **but emits warnings instead of errors** during the warn-only window (§6.8).
2. `create_guard_pipeline(dispatcher, broker, guards)` matching TS factory at [guard-pipeline.ts:13-37](../src/domain/trading/guards/guard-pipeline.ts:13). The TS function is `createGuardPipeline` (no class). **Pre-fetch is per-op, not per-push** — `[positions, account]` is fetched inside the returned `async (op)` closure. Rust port matches per-op timing. **Do NOT optimize to per-push** during the port — it would silently change guard semantics if a guard depends on positions changing between ops.
3. Parity fixtures + checker.
4. **Per-op pre-fetch parity test.** A 5-op push verifies `[positions, account]` is fetched **5 times** (not 1). Asserts on the broker mock's call log.

**DoD:**

```bash
cargo test -p alice-trading-core::guards
pnpm tsx parity/check-guards.ts             # 50+ scenarios identical TS↔Rust
```

**Cutover gate:** guard parity 100%.

**Estimated effort:** 2–3 days.

#### Phase 4d — Rust UTA actor + TradingGit persistence

**Goal:** Rust-side per-UTA actor owning `TradingGit` and committing durably to disk. No journaling yet (Phase 4e), no FFI events yet (Phase 4f). Internally complete; not yet exposed to TS.

**Inputs:** [UnifiedTradingAccount.ts](../src/domain/trading/UnifiedTradingAccount.ts), Phase 4a–4c.

**Deliverable:**

1. `crates/alice-trading-core/src/uta.rs`:
   ```rust
   pub struct UtaActor {
       cmd_rx: mpsc::Receiver<UtaCommand>,
       state: UtaState,
   }

   pub struct UtaState {
       account_id: String,
       git: TradingGit,
       broker: Arc<dyn Broker>,
       guards: Vec<Box<dyn Guard>>,
       health: HealthState,
   }

   impl UtaActor {
       pub async fn run(mut self) {
           while let Some(cmd) = self.cmd_rx.recv().await {
               // ... handle each variant ...
           }
       }
   }
   ```
   - **One actor per UTA.**
   - **Health tracking** ported from `UnifiedTradingAccount.ts:193‑328`: degraded ≥3 failures, offline ≥6, exponential backoff 5s → 60s. Offline state rejects pushes.

2. **Rust owns commit persistence** (P8). On every commit, the actor writes to `data/trading/<accountId>/commit.json` using the durable atomic-write recipe in §6.4. **Note this is the existing path** ([git-persistence.ts:14](../src/domain/trading/git-persistence.ts:14)), not a new one. Legacy path fallbacks (§6.3) preserved.

3. **Missing-snapshot reconciler** at boot — closes the gap noted in §6.4. Scans `data/trading/<accountId>/commit.json` against `data/snapshots/<accountId>/` and triggers a snapshot for any commit without one.

4. Integration test: full Mock-backed UTA lifecycle via the actor.

5. **Snapshot trigger swap.** `UnifiedTradingAccount.ts:429` calls `Promise.resolve(this._onPostPush?.(this.id)).catch(() => {})` directly after `git.push()` — **inline callback, not event-based**. v4 deliverable: remove `setSnapshotHooks` from `UTAManager` ([uta-manager.ts:103-104](../src/domain/trading/uta-manager.ts:103)); snapshot service subscribes to `commit.notify` from EventLog instead. Cross-reference §6.4.1 for the durability-asymmetry note. Atomicity test: assert no missed snapshot during the swap window.

6. **Runtime UTA add/remove via HTTP.** Per-UTA actor lifecycle handlers: `spawn(account_config) -> UtaHandle`; `teardown(uta_id) -> ()` drains the mpsc, joins the tokio task, releases tsfn. **Round-trip integration test: 100 cycles of spawn → command → teardown without resource leak** (file descriptors, tokio tasks, tsfn handles). Driven from existing HTTP routes: `PUT /uta/:id` ([trading-config.ts:74](../src/connectors/web/routes/trading-config.ts:74)), `DELETE /uta/:id` ([:119](../src/connectors/web/routes/trading-config.ts:119)), `POST /uta/:id/reconnect` ([trading.ts:204](../src/connectors/web/routes/trading.ts:204)).

7. **Reconnect ownership matrix wiring** (cross-reference §6.5.1). For Rust-backed UTAs, recovery loop runs in the actor; emits `account.health` via the bounded mpsc channel. tsfn re-registration on `reconnectUTA` recreate. Phase 4d parity test: TS-CCXT and Rust-Mock produce equivalent `account.health` event sequences for an identical disconnect scenario.

**DoD:**

```bash
cargo test -p alice-trading-core::uta
cargo test -p alice-trading-core --test uta_lifecycle_mock
cargo test -p alice-trading-core --test reconciler           # missing-snapshot detection
pnpm tsx parity/check-uta-actor.ts                           # parity vs TS UTA from Phase 4a
```

**Cutover gate:** Rust UTA + Mock broker + git persistence + reconciler all green. **Not yet exposed to the TS host.**

**Estimated effort:** 5–7 days.

#### Phase 4e — Broker-execution journal + restart reconciliation

**Goal:** close the broker-execution crash window (§6.11). Every broker call is journaled before and after; restart reconciles pending entries against broker state. This addresses a real failure mode in the current TS code, exposed by — but not caused by — the migration.

**Inputs:** Phase 4d, [src/domain/trading/brokers/](../src/domain/trading/brokers/).

**Deliverable:**

1. `crates/alice-trading-core/src/journal.rs` — the journaling protocol:
   ```rust
   pub struct ExecutionJournal {
       dir: PathBuf,  // data/trading/<accountId>/executing/
   }

   impl ExecutionJournal {
       pub async fn record_intent(&self, intent: ExecutionIntent) -> Result<JournalHandle> {
           // Write executing/<commit-hash>.json with state: 'executing'
           // fsync. Return handle.
       }
       pub async fn record_completion(&self, h: JournalHandle, result: ExecutionResult) -> Result<()> {
           // Atomically rewrite executing/<commit-hash>.json with state: 'completed' | 'failed'
       }
       pub async fn close(&self, h: JournalHandle) -> Result<()> {
           // Move executing/<commit-hash>.json → executing/done/<commit-hash>.json
           // (Retained for audit; pruned by retention policy.)
       }
   }

   pub struct ExecutionIntent {
       pub commit_hash: String,        // intent hash from Phase 2
       pub client_order_id: String,    // per-broker strategy
       pub operations: Vec<Operation>,
       pub started_at: String,
       pub broker_id: String,
   }
   ```

2. **Per-broker client-order-ID strategy** (broker trait extension):
   ```rust
   #[async_trait]
   pub trait Broker {
       // ... existing methods ...
       fn allocate_client_order_id(&self) -> String;
       async fn lookup_by_client_order_id(&self, id: &str) -> Result<Option<OpenOrder>>;
   }
   ```
   - **IBKR:** `client_order_id` derived from `nextValidId` allocation (request once at connect; increment locally).
   - **Alpaca:** free-form string; `<commit-hash>-<op-index>`.
   - **CCXT:** exchange-dependent; the TS CCXT broker keeps its current logic since CCXT stays TS.
   - **Mock:** monotonic counter.

3. **Restart reconciliation** in `UtaActor::run` startup:
   ```rust
   async fn reconcile_journal(&mut self) -> Result<Vec<ReconciliationOutcome>> {
       for entry in self.journal.list_pending().await? {
           match entry.state {
               'executing' => {
                   // Did the broker accept it? Query by client_order_id.
                   match self.broker.lookup_by_client_order_id(&entry.client_order_id).await? {
                       Some(order) => /* append a sync commit reflecting current state */,
                       None       => /* order didn't land; mark failed */,
                   }
               }
               'completed' => /* idempotent: ensure commit landed in commit.json */,
               'failed'    => /* idempotent: ensure rejected commit landed */,
           }
       }
   }
   ```

4. **Wire `UtaActor.push()` to use the journal:**
   ```
   1. journal.record_intent(intent)         ← fsync'd
   2. broker.placeOrder(...)                 ← network call
   3. journal.record_completion(handle, result)
   4. trading_git.append_commit(commit)      ← persists commit.json (§6.4)
   5. journal.close(handle)                  ← move to done/
   ```

5. **Integration test:** simulated crash between steps 2 and 4 → restart → reconciler observes pending journal → queries broker → emits sync commit. Asserts no double-execution and no lost commits.

**DoD:**

```bash
cargo test -p alice-trading-core --test journal
cargo test -p alice-trading-core --test journal_crash_recovery     # process-kill test
cargo test -p alice-trading-core --test journal_restart_reconcile  # reconciler test
pnpm tsx parity/check-journal-mock.ts
```

**Cutover gate:** crash-recovery test green: 100 simulated crashes at random points produce a coherent commit log on restart, with no duplicate orders and no lost commits.

**Estimated effort:** 6–8 days.

**Failure modes:**

- **IBKR client order ID allocation.** TWS allocates `nextValidId` once per connection. Restart-time reconciliation must use the allocated IDs the broker still has open, not freshly allocated ones — otherwise reconciliation would miss in-flight orders.
- **Disk-full during journal write.** Must propagate as `BrokerError(NETWORK)` (transient), not silently swallow. Test it.

#### Phase 4f — `RustUtaProxy` + bounded FFI event stream

**Goal:** expose Rust UTAs to the TS host. Wire the Rust→TS event stream per §6.12.

**Inputs:** Phase 4a–4e.

**Deliverable:**

1. **napi-rs typed export surface** in `lib.rs`. **Zero `serde_json::Value` in any signature** (P10):
   ```rust
   #[napi]
   pub struct TradingCore { /* ... */ }

   #[napi]
   impl TradingCore {
       #[napi(factory)]
       pub async fn create(config: TradingCoreConfig) -> Result<Self> { /* ... */ }

       #[napi]
       pub async fn init_uta(&self, account_config: AccountConfig) -> Result<()> { /* ... */ }

       #[napi]
       pub async fn stage_place_order(&self, uta_id: String, params: StagePlaceOrderParams) -> Result<AddResult> { /* ... */ }

       #[napi]
       pub async fn commit(&self, uta_id: String, message: String) -> Result<CommitPrepareResult> { /* ... */ }

       // ... every method typed ...

       #[napi(ts_args_type = "callback: (event: TradingCoreEvent) => void")]
       pub fn subscribe_events(&self, callback: ThreadsafeFunction<TradingCoreEvent>) -> Result<()> { /* ... */ }
   }
   ```

2. **TS `RustUtaProxy`** in `src/domain/trading/unified-trading-account-rust.ts`:
   - Implements the same TS public shape as today's `UnifiedTradingAccount`.
   - Every method calls into the Rust actor via napi.
   - Reconstructs `BrokerError` via `setPrototypeOf` (Phase 4b).
   - Subscribes to `TradingCoreEvent` and fans events into the TS `EventLog`.

3. **`UTAManager` updated** to route based on `accounts.json` schema (§6.10):
   - CCXT accounts → existing TS UTA.
   - IBKR/Alpaca accounts with `brokerImpl: 'rust'` → `RustUtaProxy`.
   - IBKR/Alpaca accounts with `brokerImpl: 'ts'` (default until Phase 6) → existing TS UTA.

4. **FFI event-stream contract** (§6.12) implemented:
   - Bounded `mpsc::channel(1024)` per UTA.
   - `ThreadsafeFunction<T>` with explicit `tsfn.unref()` registered at startup.
   - Per-UTA monotonic sequence numbers on every event.
   - On TS callback throw: log + drop event, Rust continues.
   - On Rust enqueue full: backpressure with 1s timeout, then drop with structured warning.
   - On TS reconciliation gap detected: re-fetch missed events from `event_log_recent(after_seq)`.
   - On shutdown: drain channel, then unref.

5. Mock-broker e2e via the proxy, end-to-end through the Web UI.

6. **`commit.notify` schema registration.** `commit.notify` is a **net-new event** (zero hits in current `src/`). v4 registers `commit.notify` and any other Rust-emitted trading event in `AgentEventMap` ([src/core/agent-event.ts:91-103](../src/core/agent-event.ts:91)) with TypeBox schemas. Reconcile per-UTA monotonic Rust seq with EventLog's global seq ([event-log.ts:136-138](../src/core/event-log.ts:136)) — separate counters; the proxy emits both.

7. **Telegram smoke test.** [telegram-plugin.ts:111-194](../src/connectors/telegram/telegram-plugin.ts:111) calls `uta.push()` ([:163](../src/connectors/telegram/telegram-plugin.ts:163)) and `uta.reject()` ([:166](../src/connectors/telegram/telegram-plugin.ts:166)) on `bot.command('trading')` callbacks. Phase 4f DoD: a `/trading` command flow round-trips through `RustUtaProxy` end-to-end within ≤10s (Telegram callback timeout).

8. **Rust panic injection test** (`parity/check-rust-panic.ts`). Inject a panic into the Mock broker's place_order; verify TS-side error shape (`code === 'RUST_PANIC'`), recovery (UTA marked offline → respawn), and that other UTAs are unaffected.

**DoD:**

```bash
cargo test -p alice-trading-core
pnpm --filter @traderalice/trading-core-bindings build
pnpm tsx parity/check-rust-proxy-mock.ts
pnpm tsx parity/check-error-shapes.ts        # BrokerError instanceof + .code + .permanent identical TS↔Rust
pnpm tsx parity/check-event-stream.ts        # bounded queue, gap detection, shutdown drain
TRADING_CORE_IMPL=ts pnpm test               # CCXT path (TS) green
TRADING_CORE_IMPL=mock-rust pnpm test        # Mock via Rust proxy green
pnpm test:e2e                                # mock-broker e2e
# Developer + Release gates (§3.4).
npx tsc --noEmit
```

**Cutover gate:** Mock UTA via Rust proxy passes the same e2e suite as TS. `BrokerError` shape parity. Event-stream contract honored. Native-build release gate green on all four platforms.

**Rollback:** Set `tradingCore.defaultBrokerImpl.alpaca` and `.ibkr` to `'ts'` in `trading-core.json`. UTAManager routes everything to TS UTAs. Rust proxy is loaded but unused.

**Estimated effort:** 5–6 days.

---

### Phase 5 — Real broker decision point (spike, no cutover)

Unchanged from v2 in spirit; tightened to reflect §6.11 and the journal protocol.

**Goal:** before committing engineering time to porting brokers, prove the chosen Rust crates and protocols can express OpenAlice's needs **including the journal/client-order-ID protocol**.

**Deliverable:**

1. **Alpaca spike** — exercise `apca` (or alternative). Produce `spikes/alpaca/REPORT.md` covering: account/position/order reads, paper market/limit/bracket orders, cancel/replace, full `Order`-field coverage, **client_order_id flow for journal restart-reconciliation** (P9).

2. **IBKR spike** — minimal Rust client: TCP, version handshake, `nextValidId`, `accountSummary`, `MarketOrder`. `prost-build` against `packages/ibkr/ref/source/proto/`. Report covers: handshake byte parity, `WireDecimal` round-trip for `UNSET_DECIMAL`, **`nextValidId`-based client-order-ID strategy validated end-to-end including a restart**, full-port effort estimate.

3. **Record/replay harness** in `parity/replay/` — captured request/response byte sequences, deterministic playback to either TS or Rust client.

4. **Decision document** `docs/migration-broker-decision.md` — yes/no per broker. Plausible terminal states:
   - State 1: both endorsed → port both in Phase 6.
   - State 2: neither endorsed → migration ends at Phase 7. Rust core ships; brokers stay TS forever. **This is an acceptable, first-class outcome.**

   **LeverUp not in scope** for Phase 5 spike (per [v4 open decisions](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-1) — stay TS until LeverUp's TS impl stabilizes). The decision document records this; revisit post-Phase-7.

**DoD:**

```bash
cargo test -p alice-trading-core --features spike-alpaca
cargo test -p alice-trading-core --features spike-ibkr
cat crates/alice-trading-core/spikes/alpaca/REPORT.md
cat crates/alice-trading-core/spikes/ibkr/REPORT.md
cat docs/migration-broker-decision.md
```

**Cutover gate:** none — produces decisions, not code paths.

**Estimated effort:** 6–8 days.

---

### Phase 6 — Gradual broker migration (one broker per sub-phase)

Per-broker port behind a flag. **The TS implementation stays in the tree** until Phase 8.

**Phase 6.<broker>.a — Rust port behind a flag:**

1. `crates/alice-trading-core/src/brokers/<broker>.rs` — full `Broker` trait impl, including the journal/client-order-ID protocol from Phase 4e.
2. The TS implementation **stays** in `src/domain/trading/brokers/<broker>/`. UTAManager routes per `accounts.json[].brokerImpl`.
3. Deterministic record/replay tests in CI; live broker tests nightly.

**Phase 6.<broker>.b — Default `rust` for new accounts:** `accounts.json` schema default for `brokerImpl` flips to `rust` for `<broker>` after ≥3 nights of green live tests.

**Phase 6.<broker>.c — Cleanup deferred to Phase 8.**

**Estimated effort:**
- Alpaca: 5–7 days.
- IBKR: 18–25 days.

---

### Phase 7 — Cutover with TS fallback retained

1. `tradingCore.defaultBrokerImpl` for endorsed brokers flips to `rust`.
2. **The TS impl of `TradingGit`, guards, and ported brokers stays in the codebase** behind the flag for ≥1 minor release.
3. Dogfood window: ≥1 week of real paper trading on `rust` before merging the default flip.
4. `pnpm rollback-to-ts` script tested.

**Cutover gate:** dogfood green; rollback procedure tested; all v2 hashes (and 2.5 entry hashes if endorsed) verifiable.

**Rollback:** flip `tradingCore.defaultBrokerImpl.<broker>` to `ts`. Restart. TS implementation fully present.

**Estimated effort:** 4–5 days + dogfood window.

---

### Phase 8 — Cleanup (deferred ≥1 minor release)

After Rust default for one minor release with no production rollbacks:
- Remove `src/domain/trading/brokers/<endorsed>/` (TS broker impl).
- Collapse `unified-trading-account-ts.ts` to handle CCXT-only.
- Remove `packages/ibkr/` re-export shim. `ibkr-types` and `ibkr-client` are the canonical packages; `ibkr-client` is removed if its broker is endorsed for Rust.
- Remove `tradingCore.defaultBrokerImpl.<broker>: 'ts' | 'rust'` enum and pin to literal `'rust'`.

**Cutover gate:** zero rollback events in production telemetry over the prior release cycle.

---

## 6. Cross-cutting concerns

### 6.1 Decimal correctness — three wire types + canonical formatter

**Wire types:** `WireDecimal`, `WireDouble`, `WireInteger`. Each has `Unset` and `Value` variants. All persisted, hashed, and FFI-crossing values are wire types. **`rust_decimal` is forbidden at the wire layer** — its ~7.9e28 ceiling can't represent `UNSET_DECIMAL` (`2^127-1 ≈ 1.7e38`).

**Canonical decimal formatter** (`toCanonicalDecimalString` in TS, `to_canonical_decimal_string` in Rust):

- No exponent / scientific notation (Decimal.js `.toFixed()` gives this; Rust uses explicit formatting, **not** `BigDecimal::normalize().to_string()`).
- No leading `+`.
- No trailing decimal point.
- Canonical zero = `"0"` (not `"0.0"`, not `"-0"`).
- Negative sign only on nonzero values.
- Reject `NaN` / `Infinity` / `-0` (throw / `Err`).
- Trailing zeros after decimal point stripped.

Both implementations share fixtures: `parity/fixtures/canonical-decimal/`. Adversarial cases: `1e30`, `1e-30`, `-0`, `0.1 + 0.2`, sub-satoshi (8/12/18 decimals), negative, `NaN` (must throw), `Infinity` (must throw).

**`UNSET_LONG` JS precision caveat.** [packages/ibkr/src/const.ts:12](../packages/ibkr/src/const.ts:12) defines `UNSET_LONG = BigInt(2 ** 63) - 1n`. The `2 ** 63` is computed as a JS Number, exceeds `Number.MAX_SAFE_INTEGER`, and rounds. The `BigInt(...)` then wraps the rounded value, so `UNSET_LONG` is **not** exactly `i64::MAX`. If any IBKR field maps to Rust `i64` in the wire-type design, the Rust side reconstructs `i64::MAX` from the canonical wire form, not from the lossy TS source. Phase 1b adds a fixture asserting exact `i64::MAX` round-trip.

### 6.2 Hash stability — forward-only, two layers

- **v1 commits** (everything currently on disk): `hash` is opaque. Never recomputed. **v1 hash provenance:** verified at [TradingGit.ts:33-38, :70-75](../src/domain/trading/git/TradingGit.ts:33), the v1 commit hash is `sha256(JSON.stringify({ message, operations, timestamp, parentHash })).slice(0, 8)`. The `JSON.stringify` output depends on JS class iteration order (e.g., `Order`, `Contract`) and decimal.js `.toString()` choices. There is no key-sort, no normalization, no stable encoding. **v1 hashes are change-detection tokens, not content addresses.** A Rust impl cannot reproduce them and will not try. Loaders preserve v1 verbatim (`PersistedCommit::V1Opaque`); display them; never re-hash.
- **v2 commits** (post-Phase-2): `hashVersion: 2`, `intentFullHash` (64-char SHA-256 over canonical intent input), `hashInputTimestamp` (the exact timestamp fed into the hash). Verifies user/agent intent.
- **Phase 2.5 entry hash** (if endorsed): `entryHashVersion: 1`, `entryFullHash` (64-char SHA-256 over the full persisted commit, excluding `entryFullHash` itself). Verifies execution outcome and persisted state.

Mixed logs are first-class. The loader `PersistedCommit::classify` distinguishes the three cases and the export round-trips them.

### 6.3 On-disk state paths

Verified at [git-persistence.ts:14](../src/domain/trading/git-persistence.ts:14):

```
Primary: data/trading/<accountId>/commit.json
Legacy:  data/crypto-trading/commit.json     (loaded for accountId='bybit-main')
Legacy:  data/securities-trading/commit.json (loaded for accountId='alpaca-paper' or 'alpaca-live')
```

**Reframed invariant:** the migration does not introduce a breaking read incompatibility. Existing v1 commit files load unchanged. The schema is **expanded** (new optional fields per Phase 2 / 2.5) but never breaking.

Phase 0 fixtures include legacy-path examples. The Rust persistence layer respects the same legacy fallbacks via the `PersistedCommit` loader.

### 6.4 Commit durability — the full atomic-write recipe

Rust owns the write (P8). The `UtaActor` calls:

```rust
async fn persist_atomically(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().expect("path must have a parent");
    fs::create_dir_all(parent).await?;

    // Unique temp filename — pid + random — avoids stale-tmp collisions and multi-process races.
    let tmp = parent.join(format!(
        "{}.{}.{}.tmp",
        path.file_name().expect("filename").to_string_lossy(),
        std::process::id(),
        rand::random::<u32>(),
    ));

    let mut f = fs::File::create(&tmp).await?;
    f.write_all(contents).await?;
    f.sync_all().await?;        // fsync the file
    drop(f);

    fs::rename(&tmp, path).await?;

    // fsync the parent dir so the rename itself is durable across power loss.
    let dir = fs::File::open(parent).await?;
    dir.sync_all().await?;

    Ok(())
}
```

**Asymmetry note.** The atomic-write recipe applies to Rust-owned `commit.json` only. The TS-side snapshot writer ([src/domain/trading/snapshot/store.ts](../src/domain/trading/snapshot/store.ts)) is **not** upgraded as part of this migration. Snapshot writes use `appendFile` for chunks (non-atomic) and lack `fsync` on file or parent dir. The missing-snapshot reconciler closes one gap; §6.4.1 enumerates the gaps it leaves. The asymmetry is acknowledged, not unintentional — fixing it is out of scope, tracked separately.

**Missing-snapshot reconciler** (closes the gap noted by v2 review — there is no reconciler in the current code, so v3 ships one as a Phase 4d deliverable):

```rust
async fn reconcile_missing_snapshots(account_id: &str) -> Result<Vec<String>> {
    let commits = read_commits(account_id).await?;
    let snapshots = read_snapshots(account_id).await?;
    let snapshot_hashes: HashSet<_> = snapshots.iter().map(|s| s.commit_hash.clone()).collect();
    let missing: Vec<_> = commits.iter()
        .filter(|c| !snapshot_hashes.contains(&c.hash))
        .map(|c| c.hash.clone())
        .collect();
    for hash in &missing {
        snapshot_service.take_snapshot(account_id, hash, "post-startup-reconcile").await?;
    }
    Ok(missing)
}
```

After commit persistence succeeds, the actor emits `commit.notify` to TS for snapshot/UI consumption. **TS never gates push success on its own write.**

### 6.4.1 Snapshot durability gaps

Three gaps the missing-snapshot reconciler does **not** close, all in `src/domain/trading/snapshot/store.ts`:

1. **Non-atomic chunk append** ([store.ts:83](../src/domain/trading/snapshot/store.ts:83)). Raw `appendFile` for snapshot chunks. A crash mid-write produces a chunk file with a partial last line. The reconciler scans index entries and counts on `chunk.count` — corrupted last lines are invisible until `readRange` parses and throws.
2. **No `fsync`** ([store.ts:51-56](../src/domain/trading/snapshot/store.ts:51)). Snapshot writes do `rename(tmp, indexPath)` without fsync of the file or parent dir.
3. **Index/chunk write inconsistency** ([store.ts:83-84](../src/domain/trading/snapshot/store.ts:83)). `doAppend` writes the chunk first then updates the index. A crash between them: chunk has the snapshot, index doesn't. Reconciler thinks the snapshot is missing and triggers a **second** snapshot for the same commit hash — duplicate entries.

**Mitigations not adopted in this migration** (logged in `TODO.md` with `[snapshot-durability]` during Phase 0):

- Chunk append over fsync'd write+rename pairs
- Transactional `index+chunk` write via two-phase rename
- Reconciler duplicate-detection step

The migration ships the missing-snapshot reconciler (Phase 4d) and accepts the three gaps above.

### 6.5 Per-UTA serialization (P7)

Both Rust UTAs (Phase 4d) and TS UTAs (Phase 4a retrofit) implement the actor pattern:

- One `mpsc` channel per UTA.
- Public methods enqueue commands and await replies.
- The actor task is the single mutator of `TradingGit`, broker connection state, journal, and health counters.

This fixes a **latent race in the current TS implementation** — there's no lock today against parallel AI tool calls interleaving `stage / commit / push` on the same UTA. Phase 4a ships the fix to TS regardless of Rust progress.

### 6.5.1 Reconnect ownership matrix

Today, reconnect lives in two places:

- **UTA-level auto-recovery** ([UnifiedTradingAccount.ts:296-328](../src/domain/trading/UnifiedTradingAccount.ts:296)). Exponential backoff 5s → 60s, broker-agnostic. Calls `broker.init()` + `broker.getAccount()` to test.
- **`UTAManager.reconnectUTA`** ([uta-manager.ts:111-151](../src/domain/trading/uta-manager.ts:111)). Reads fresh config and **recreates** the UTA — full re-instantiation, not just reconnection. Re-registers CCXT provider tools.

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

**Risk:** divergence between TS and Rust recovery-loop semantics (back-off intervals, jitter, `_disabled` semantics for permanent errors). **Mitigation:** Phase 4d parity test asserts TS-CCXT and Rust-Mock produce equivalent `account.health` event sequences for an identical disconnect scenario. Phase 4f extends to real-broker Mock paths.

**Actor lifecycle on reconnect.** `UTAManager.reconnectUTA` recreates the UTA. For Rust-backed UTAs: drain the old actor's mpsc → join the tokio task → unregister tsfn → spawn new actor → register new tsfn. **Phase 4d** integration test covers the lifecycle (spawn/teardown 100 cycles); **Phase 4f** integration test covers reconnect via the proxy (tsfn re-registration + EventLog re-subscription).

### 6.6 Typed FFI surface (P10)

`serde_json::Value` is forbidden in any napi-exported method signature. The single exception is `PersistedCommit::V1Opaque`, which holds `serde_json::Value` internally because v1 commits are intentionally never normalized — but `V1Opaque` itself is a typed enum variant, not a `Value` parameter.

The generated `index.d.ts` is checked into `packages/trading-core-bindings/`. CI regenerates it and fails on diff. The plan does not let the boundary drift.

### 6.7 Test gates (P12)

PR CI:
- Unit tests (Rust + TS).
- All parity fixtures.
- Mock broker e2e.
- Recorded broker replays.
- Developer native-build gate (§3.4).

Nightly / manual:
- Live TWS paper.
- Live Alpaca paper.
- Live exchange testnet (CCXT).
- Release native-build gate (§3.4) on release tags.

### 6.8 Guard config strictness — phased

`serde(deny_unknown_fields)` lands in three steps:

1. **Warn-only window** (Phase 4c onward): unknown fields parse + log a structured warning + emit `config.deprecated_field` event. Web UI surfaces warnings.
2. **Web UI lint** (Phase 6): config screens highlight unknown fields with a "remove" button.
3. **Strict** (Phase 7+): error after one minor release in warn-only mode. Documented breaking change.

### 6.9 Logging / tracing

Rust uses `tracing` with `tracing-subscriber` writing JSON lines to a napi `ThreadsafeFunction` callback (subject to §6.12 lifecycle rules). TS receives each line and forwards to `pino`. Trace IDs propagate from AgentCenter through FFI to broker calls.

### 6.10 Feature-flag config (structured)

**`tradingCore` is a new config namespace.** v3 implies (line 1343) `ccxt: 'ts'` is "literal-pinned at the Zod schema level," which reads as if an existing flag is being constrained. Verified at [src/core/config.ts](../src/core/config.ts): there is **no** existing `tradingCore` namespace; zero references to `defaultBrokerImpl`. The Phase 4f deliverable introduces this namespace; Zod literal-pinning is on the **new** schema. Account-level `brokerImpl` override is also new; `accounts.json` schema needs the field added in Phase 4f. The `panicDisableThreshold` setting (§6.12.1) lives in this namespace too.

`data/config/trading-core.json`:
```json
{
  "tradingCore": {
    "defaultBrokerImpl": {
      "alpaca": "ts",
      "ibkr": "ts",
      "ccxt": "ts"
    }
  }
}
```

Per-account override in `accounts.json`:
```json
{
  "id": "alpaca-paper",
  "type": "alpaca",
  "brokerImpl": "ts",      // optional; falls back to defaultBrokerImpl
  "enabled": true,
  "guards": [...],
  "brokerConfig": {...}
}
```

**`ccxt` is pinned to `"ts"` at the Zod schema level** — the type is the literal `"ts"`, not the union `"ts" | "rust"`. A future flag flip cannot accidentally route CCXT through Rust.

The plan does **not** use `TRADING_CORE_IMPL` or `BROKER_IMPL_<BROKER>` env vars on the live path. Tests may override via env for matrix runs only.

### 6.11 Broker-execution durability — journal protocol

Closes the crash window between `broker.placeOrder` succeeding and the local commit persisting.

**Protocol (Rust-owned, see Phase 4e):**

1. **Pre-call:** `journal.record_intent({ commit_hash, client_order_id, operations, started_at, broker_id })` → `executing/<commit-hash>.json` written + fsync'd.
2. **Call:** `broker.placeOrder(...)`.
3. **Post-call:** `journal.record_completion(handle, result)` → atomic rewrite of the same file with `state: 'completed' | 'failed'` and result data.
4. **Commit persist:** `trading_git.append_commit(commit)` → `data/trading/<accountId>/commit.json` updated via §6.4 atomic write.
5. **Journal close:** `journal.close(handle)` → `executing/<commit-hash>.json` moved to `executing/done/<commit-hash>.json`.

**Per-broker client-order-ID strategy:**
- IBKR: `client_order_id` derived from `nextValidId` allocated at connect.
- Alpaca: `<commit-hash>-<op-index>`.
- CCXT: exchange-dependent; the TS CCXT broker keeps its current logic.
- Mock: monotonic counter.

**Restart reconciliation** at `UtaActor::run` startup:
- Scan `executing/` for entries not in `executing/done/`.
- For each pending entry, query `broker.lookup_by_client_order_id` and reconcile by appending a sync commit.
- Idempotent: re-running the reconciler is a no-op on a fully-reconciled state.

**This is genuinely additive scope** — the current TS code has the same crash window today. The migration is the moment to fix it because Rust ownership of execution gives a single point to enforce the protocol.

### 6.12 FFI event-stream contract (P11)

Rust→TS event delivery rules:

- **Channel:** bounded `tokio::sync::mpsc::channel(1024)` per UTA. Capacity configurable via `tradingCore.eventQueueCapacity`.
- **TSF lifecycle:** `ThreadsafeFunction<TradingCoreEvent>` with explicit `tsfn.unref()` registered at startup so the Node event loop can exit cleanly. On `TradingCore` shutdown: drain channel → `tsfn.abort()` → unregister.
- **Sequence numbers:** monotonic per UTA. Every event carries `seq: u64` set by the actor.
- **Backpressure:** Rust enqueue waits up to 1s when the channel is full; on timeout, drops the event with a structured warning event (`event.dropped` on the next-priority channel) and increments a metric.
- **TS-side throw in callback:** caught and logged; Rust continues delivering. The throwing event is not retried.
- **EventLog append failure:** retried with exponential backoff (3 attempts) within TS; on final failure, the event is logged and a `eventlog.append_failed` metric increments.
- **Gap detection:** TS observes `seq` per UTA. On gap, calls `trading_core.event_log_recent(uta_id, after_seq)` to backfill.

### 6.12.1 Rust panic policy (P13 enforcement)

- **Boundary.** Every `#[napi]`-exported method body is wrapped in `std::panic::catch_unwind`. The wrapper converts panic payloads to typed `napi::Error` with `code = "RUST_PANIC"` and `message = <panic message + backtrace>`.
- **`ThreadsafeFunction` callbacks.** `tsfn.call` itself does not unwind into the Node thread. Panics inside the Rust task that **produces** events go through the same `catch_unwind` wrapper; on panic, the actor emits a synthetic `account.health` event with `state: 'offline'`, `reason: 'rust_panic'`, then exits cleanly.
- **TS handling.** `RustUtaProxy` catches `code === 'RUST_PANIC'` errors and (a) logs a structured event, (b) marks the UTA offline via the same path as `BrokerError(NETWORK)`, (c) schedules a recovery attempt that respawns the actor. **No process abort.**
- **Test.** Phase 4f DoD adds `parity/check-rust-panic.ts` — inject a panic into the Mock broker, verify TS-side error shape, recovery, and that other UTAs are unaffected.
- **Panic dedup.** After N consecutive `RUST_PANIC` errors on the same UTA, mark it `disabled` and require manual `reconnectUTA`. Default `N = 5`; configurable via `tradingCore.panicDisableThreshold`. Locked in [v4 open decisions](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-4).

### 6.13 Pre-existing TODO.md triage

Each `TODO.md` item below overlaps with the Rust migration. Per-item fate:

| TODO entry (line) | Migration touches | Decision |
|---|---|---|
| Trading git staging area lost on restart (88-93) | Phase 3, Phase 4d | **Port-as-is.** Preserves parity. Fix in a separate post-migration PR. Document in Phase 3 PR body with `[migration-deferred]` tag. (Decision locked in [v4 open decisions](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-2).) |
| Cooldown guard state lost on restart (80-86) | Phase 4c | **Port-as-is.** Same rationale. `[migration-deferred]` tag. |
| Snapshot/FX numbers wildly wrong (60-69) | Snapshot stays TS | **Out of scope.** Migration does not fix; TODO entry stays open. |
| OKX UTA spot-holding fix needs live confirmation (95-102) | CCXT stays TS | **Out of scope.** Note in Phase 5 spike: CCXT is not exercised by parity work. |
| Heartbeat dedup window lost on restart (71-78) | Out of trading scope | **Out of scope.** Listed for completeness. |
| LeverUp items (232-257) | Phase 4b Broker trait, §4.4 | **Stay TS** (decision 1). Phase 4b adds `BrokerCapabilities` extension point so a future Rust port doesn't require trait-shape rework. |

**Principle:** the migration preserves existing behavior including known bugs; fixes ride in separate PRs after Phase 7. P4 ("one concept per phase") would be violated by fix-during-port.

### 6.14 Tool-surface contract

`src/tool/trading.ts` exposes 16 tools that call UTA methods directly via `manager.resolve()` / `manager.resolveOne()` — no abstraction layer. v4 enumerates the contract `RustUtaProxy` must honor:

| Tool | UTA method(s) | Sync requirement | Notes |
|---|---|---|---|
| `searchContracts` ([:121-130](../src/tool/trading.ts:121)) | `uta.searchContracts` | async OK | UTAManager-level today |
| `getAccount` ([:165-173](../src/tool/trading.ts:165)) | `uta.getAccount` | async OK | |
| `getPortfolio` ([:184-235](../src/tool/trading.ts:184)) | `uta.getPositions` + `uta.getAccount` (back-to-back) | **interleaving hazard** | P7 protects within one mpsc round-trip, not between two |
| `getOrders` ([:249-271](../src/tool/trading.ts:249)) | `uta.getOrders` (`Promise.all` across UTAs) | latency-sensitive | FFI overhead × N accounts |
| `getQuote` ([:282-291](../src/tool/trading.ts:282)) | `uta.getQuote` | async OK | |
| `tradingLog` ([:319-327](../src/tool/trading.ts:319)) | `uta.gitLog` | async OK | |
| `tradingShow` ([:333-339](../src/tool/trading.ts:333)) | `uta.show(hash)` on every UTA | sync-style scan | Async-message proxy can satisfy if `show` is keyed by hash and returns immediately |
| `tradingStatus` ([:346-349](../src/tool/trading.ts:346)) | `uta.status` | async OK | Telegram also calls this |
| `simulatePriceChange` ([:362-367](../src/tool/trading.ts:362)) | `uta.simulatePriceChange` | async OK | |
| `tradingStagePlaceOrder` ([:410](../src/tool/trading.ts:410)) | `uta.stagePlaceOrder` | async OK | |
| `tradingStageCancelOrder` ([:427](../src/tool/trading.ts:427)) | `uta.stageCancelOrder` | async OK | |
| `tradingStageReplaceOrder` ([:438](../src/tool/trading.ts:438)) | `uta.stageReplaceOrder` | async OK | |
| `tradingStageClosePosition` ([:447](../src/tool/trading.ts:447)) | `uta.stageClosePosition` | async OK | |
| `tradingCommit` ([:457-465](../src/tool/trading.ts:457)) | `uta.commit` per UTA, no source = all UTAs | best-effort sequential | See §6.15 |
| `tradingPush` ([:473-493](../src/tool/trading.ts:473)) | `uta.push` per UTA | latency-sensitive | Telegram also calls this |
| `tradingSync` ([:503-512](../src/tool/trading.ts:503)) | `uta.sync` | async OK | |

**Latency budget.** `RustUtaProxy` round-trip target: ≤5 ms per call on Mock. Phase 4f parity test asserts `Promise.all([5 UTAs].map(u => u.getOrders()))` completes in ≤50 ms.

**Interleaving hazard.** `getPortfolio` does back-to-back `uta.getPositions()` + `uta.getAccount()` ([:190-191](../src/tool/trading.ts:190)) expecting consistent state. Under the actor model, a `commit` from another tool call can interleave between the two `await`s. **v4 accepts current inconsistency** for parity (locked in [v4 open decisions](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-3)). A `getPortfolioSnapshot` actor command for atomic reads is reserved for post-migration improvement.

### 6.15 Cross-UTA semantics

Operations spanning multiple UTAs (`tradingCommit` with no source, `getPortfolio`, `getOrders`, `simulatePriceChange`) are **best-effort sequential, not transactional**. If UTA A commits successfully and UTA B fails, the result is a partial-commit state with no rollback.

This is current TS behavior; the migration preserves it. The actor model does **not** change this contract — per-UTA serialization is the only atomicity guarantee. Any future cross-UTA atomicity feature would need a new coordinator above the actors (out of scope).

Documented explicitly so post-migration debugging doesn't blame the actor model.

### 6.16 Connector consumer matrix (P14 enforcement)

| Consumer | Source | UTA touchpoints | Latency budget | Migration test |
|---|---|---|---|---|
| Web UI (REST) | [src/connectors/web/routes/trading.ts](../src/connectors/web/routes/trading.ts) | direct UTA method calls | UI: ≤200 ms p95 | Phase 4f Mock e2e |
| Web UI (SSE / EventLog) | [src/connectors/web/routes/events.ts:124](../src/connectors/web/routes/events.ts:124) | EventLog subscribe | streaming | Phase 4f event-stream parity |
| Telegram (REST-style) | [src/connectors/telegram/telegram-plugin.ts:111-194](../src/connectors/telegram/telegram-plugin.ts:111) | `uta.push` ([:163](../src/connectors/telegram/telegram-plugin.ts:163)), `uta.reject` ([:166](../src/connectors/telegram/telegram-plugin.ts:166)), `uta.status` | ≤10 s (Telegram callback timeout) | **Phase 4f smoke test** |
| MCP-ask | [src/connectors/mcp-ask/mcp-ask-connector.ts:15](../src/connectors/mcp-ask/mcp-ask-connector.ts:15) | none (`capabilities.push: false`) | n/a | n/a |
| Diary | [src/connectors/web/routes/diary.ts:137](../src/connectors/web/routes/diary.ts:137) | EventLog read of `account.health` | n/a | event schema parity |

**Rule:** any future consumer added to this list specifies (1) which UTA methods it calls, (2) latency budget, (3) behavior under FFI backpressure (queue full, panic, timeout). The matrix is the load-bearing artifact for §6.12 / P14.

### 6.17 Mixed-version commit log loader

> **Renumber note:** Was §6.13 in v3; renumbered to §6.17 in v4 to make room for new §6.13–§6.16. Content unchanged.

Both TS and Rust must load logs containing v1 + v2-intent-only + v2-with-entry-hash commits in any order. The decoder model:

```typescript
// TS
type PersistedCommit =
  | { kind: 'v1-opaque'; raw: GitCommitV1 }
  | { kind: 'v2-intent'; commit: GitCommitV2 }      // hashVersion: 2, no entryHashVersion
  | { kind: 'v2-entry'; commit: GitCommitV2 }       // hashVersion: 2, entryHashVersion: 1
```

```rust
// Rust
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum PersistedCommit {
    V2(GitCommitV2),
    V1Opaque(serde_json::Value),
}
```

Validation rules:
- V1: never recomputed.
- V2 intent-only: verify `intentFullHash` if requested; warn on mismatch (default), error in strict mode.
- V2 with entry hash: verify both intent and entry hashes if requested; same warn/error semantics.

Export round-trips all three forms.

---

## 7. Risk register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Serde rename emitting wrong wire form | — (mitigated) | — (mitigated) | `SCREAMING_SNAKE_CASE` + mandatory unit test on every code (Phase 4b). |
| `BigDecimal`/`decimal.js` arithmetic divergence in `simulate_price_change` | Medium | Medium | Phase 0 fixtures + canonical formatter; Rust gated on diff. |
| Native binary missing for a user's platform | Medium | High | Prebuilt sub-packages for darwin-arm64/x64, linux-x64-gnu, win32-x64-msvc; Release native-build gate (§3.4) per release. |
| napi-rs platform-package distribution drift | Medium | Medium | Generated `.d.ts` checked in; CI regenerate-and-diff; pin napi-rs version. |
| IBKR proto schema upstream changes mid-port | Low | High | Pin `prost-build` against a tagged `.proto` snapshot; quarterly review in `TODO.md`. |
| Phase 5 spike rejects both brokers | Low | Low | **Intended failure mode** — terminal state 2 is first-class; Rust core ships, brokers stay TS. |
| `BrokerError instanceof` regressing across FFI | Medium | Medium | `Object.setPrototypeOf` reconstruction + dedicated CI test. |
| Concurrency bug in actor pattern | Low | High | `parity/check-uta-concurrency.ts` runs 100 parallel commands; weekly fuzz. |
| `commit.notify` events dropped or reordered | Low | Medium | Per-UTA monotonic seq; gap-detection backfill (§6.12); bounded channel. |
| Strict guard config breaks user files | Medium | Medium | Warn-only window → Web UI lint → strict (§6.8). |
| Live broker tests gated per-PR | — (mitigated) | — (mitigated) | §6.7 splits dev vs. nightly. |
| Phase 7 cutover regresses in production | Medium | Medium | Dogfood window; TS impl retained ≥1 minor release; `pnpm rollback-to-ts`. |
| Crash between broker.place and commit persist | — (mitigated) | — (mitigated) | Journal protocol + restart reconciler (Phase 4e, §6.11). |
| Disk-full during journal/commit write | Low | High | Propagate as `BrokerError(NETWORK)` (transient); explicit test. |
| `entryFullHash` inclusion increases v2.5 fixture work | Medium | Low | Phase 2.5 explicitly default-accepted; fixtures live alongside Phase 2 fixtures. |
| Mixed-version commit log loader bug | Medium | Medium | `parity/check-mixed-log.ts` fuzzes randomly-ordered v1/v2-intent/v2-entry sequences. |
| `commit.notify` event surface invented but not registered in `AgentEventMap` | Medium | Medium | Phase 4f Deliverable 6 registers schema; CI test asserts every Rust-emitted event has a TypeBox schema entry. |
| Snapshot trigger pipeline change drops snapshots in the swap window | Medium | Medium | Phase 4d Deliverable 5 cuts over inline-callback → event-subscription atomically; integration test asserts no missed snapshot during the swap. |
| Runtime UTA add/remove leaks tokio tasks / tsfn handles / file descriptors | Medium | High | Phase 4d Deliverable 6: 100-cycle round-trip integration test (§6.5.1); resource leak check in CI. |
| Reconnect semantics diverge between TS-CCXT and Rust-IBKR/Alpaca recovery loops | Medium | Medium | §6.5.1 parity test asserts equivalent `account.health` event sequence on identical disconnect scenario. |
| Rust panic in single UTA actor JS-throws into unrelated tool's await chain | Low | High | §6.12.1 `catch_unwind` boundary; Phase 4f Deliverable 8 panic injection test. |
| LeverUp broker added to `Broker` trait late, breaks Phase 4b assumptions | Medium | Medium | §4.4 surfaces upfront; Phase 4b Deliverable 8 `BrokerCapabilities` extension point validates against LeverUp's whole-position-close + market-only + EIP-712 quirks. |
| TODO.md "trading-git staging area lost on restart" ports as a known bug; an operator misreads the migration as fixing it | Low | Medium | §6.13 explicitly lists as-is ports; PR body for Phase 3 + 4c calls them out. |

---

## 8. AI agent operating manual

### 8.1 Picking up a phase

Before writing any code, an agent MUST:

1. Read this entire plan (esp. §2 Principles, §6 Cross-cutting).
2. Read [CLAUDE.md](../CLAUDE.md), [docs/event-system.md](event-system.md), `TODO.md`.
3. Read the phase's "Inputs" files in full.
4. Open a draft PR titled `[migration phase N(.x)] <phase name>` linking back to this document.
5. Re-state the phase's DoD in the PR body verbatim before starting.

### 8.2 Definition of Done checklist

A phase is **not** done until **every** item is checked:

- [ ] All "Deliverable" items present.
- [ ] All "DoD" commands run green locally and in CI.
- [ ] "Cutover gate" criteria documented as evidence in the PR body (parity diffs, replay logs, dogfood notes).
- [ ] **Developer native-build gate (§3.4) green** for any Rust-touching phase.
- [ ] **Release native-build gate (§3.4) green on release-tag pipelines** (not gated on PR; gated on release).
- [ ] No new `TODO.md` entries without explicit `[migration]` tag and explanation.
- [ ] If touching public TS types, existing callers compile under `npx tsc --noEmit` without `any` casts.
- [ ] **`BrokerError` shape parity test green** (any FFI-crossing phase).
- [ ] **Concurrency parity test green** (any phase touching the actor).
- [ ] **Journal crash-recovery test green** (Phase 4e onward).
- [ ] **Mixed commit-log fuzz green** (Phase 2 onward).
- [ ] PR reviewed by the human maintainer.

### 8.3 When to escalate

Escalate (do not improvise) when:

- A parity gate fails after >2 hours of debugging.
- A required Rust crate has an unresolved bug blocking the port.
- A fixture surfaces a pre-existing TS bug. **Do not "fix and continue."** Capture in `TODO.md` with `[migration]` tag, replicate the bug in Rust to keep parity, surface for triage.
- Phase 5 spike returns "infeasible" — that's a **decision point**, not a debugging exercise. Update the decision document, accept terminal state 2.
- A `commit.notify` ordering bug surfaces — durability-adjacent, not a routine fix.
- A `journal` crash-recovery test fails — order-of-operations correctness, must be solved before merge.

### 8.4 Per-phase context budget

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

Phase 0 Deliverable 8 creates the per-sub-PR context worksheet template (`parity/context-worksheets/_template.md`). Sub-PR splits for Phase 3 and Phase 4d follow the rows above; Phase 4e splits per the original v3 sub-PR list (4e (a)/(b)/(c)).

---

## 9. Timeline summary

| Phase | Effort (eng-days) | Depends on | Cumulative |
|---|---|---|---|
| 0 — Inventory + fixtures | 4–5 | — | 5 |
| 1a — `ibkr` package split | 3–4 | 0 | 9 |
| 1b — Wire types + adapters | 4–5 | 1a | 14 |
| 1c — Canonical JSON + decimal formatter | 2–3 | 1b | 17 |
| 2 — Hash v2 (intent only) | 4–5 | 1 | 22 |
| 2.5 — Entry hash (default-accepted) | 3–4 | 2 | 26 |
| 3 — Rust workspace + Rust TradingGit | 7–9 | 2 (or 2.5) | 35 |
| 4a — TS UTA actor retrofit | 3–4 | 3 (parallel-capable) | 39 |
| 4b — Rust Broker trait + Mock | 3–4 | 3 | 43 |
| 4c — Rust guards | 2–3 | 4b | 46 |
| 4d — Rust UTA actor + persistence | 5–7 | 4c | 53 |
| 4e — Execution journal + reconciler | 6–8 | 4d | 61 |
| 4f — RustUtaProxy + event stream | 5–6 | 4e | 67 |
| 5 — Broker spikes (decision point) | 6–8 | 4 | 75 |
| 6.alpaca — port + flag (if endorsed) | 5–7 | 5 | 82 |
| 6.ibkr — port + flag (if endorsed) | 18–25 | 5 | ~107 |
| 7 — Cutover + dogfood | 4–5 + 1 week soak | 6 | ~112 + soak |
| 8 — Cleanup | (deferred ≥1 minor release) | 7 | — |

**Total:**
- **State 1 (both brokers Rust)**: ~16–22 weeks.
- **State 2 (Rust core only, brokers stay TS)**: ~10–14 weeks (skips 6.alpaca and 6.ibkr; Phase 7 still happens for the Rust core itself).

Phase 5's job is to choose between these. Both are acceptable.

---

## 10. References

- Repo: [kingji001/OpenAlice-rust](https://github.com/kingji001/OpenAlice-rust)
- Repo conventions: [CLAUDE.md](../CLAUDE.md)
- Event system: [docs/event-system.md](event-system.md)
- napi-rs: https://napi.rs/
- napi-rs ThreadsafeFunction: https://napi.rs/docs/concepts/threadsafe-function
- prost: https://github.com/tokio-rs/prost
- bigdecimal-rs: https://docs.rs/bigdecimal/
- tokio mpsc: https://docs.rs/tokio/latest/tokio/sync/mpsc/fn.channel.html
- apca (Alpaca client): https://crates.io/crates/apca

---

## 11. Open decisions (lock at execution time)

These are explicit calls the maintainer (or executing agent) must record in the PR or `docs/migration-broker-decision.md`. **v4 decisions** (1–4) are pre-locked in [docs/superpowers/decisions/2026-05-05-v4-open-decisions.md](superpowers/decisions/2026-05-05-v4-open-decisions.md):

- [ ] **Phase 2.5 entry hash:** default-accepted. Decline only if there's a specific reason; record the reason.
- [ ] **Phase 5 verdict per broker:** Rust port endorsed / not endorsed. Independent decisions for Alpaca and IBKR.
- [ ] **Phase 4e journal retention policy:** how long to keep `executing/done/<commit-hash>.json`. Default: 30 days. Configurable.
- [ ] **Phase 6 default broker impl:** the per-broker default in `tradingCore.defaultBrokerImpl` flips from `'ts'` to `'rust'` at Phase 6.<broker>.b. Confirm green-night threshold (default 3 consecutive nights of live tests).
- [x] **§4.4 LeverUp scope.** Stay TS until LeverUp's TS impl stabilizes. Revisit post-Phase-7. (See [decision 1](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-1).)
- [x] **§6.13 TODO.md as-is items.** Trading-git staging area + cooldown guard state: port-as-is. (See [decision 2](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-2).)
- [x] **§6.14 interleaving stance.** Accept current `getPortfolio` inconsistency. No `getPortfolioSnapshot` in Phase 4f. (See [decision 3](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-3).)
- [x] **§6.12.1 panic dedup threshold.** N=5 default for `tradingCore.panicDisableThreshold`. (See [decision 4](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-4).)

---

## 12. Approval staging

Following the v2 review's recommendation:

```
Approve now (mechanical, low-risk):
  Phase 0   — fixtures & inventory + /api/status route + context worksheets [v4 amend]
  Phase 1a  — ibkr-types / ibkr-client split + order-decoder.ts move [v4 amend]
  Phase 1b  — wire types + adapters + UNSET_LONG fixture [v4 amend]
  Phase 1c  — canonical JSON utility [unchanged]
  Phase 2   — hash v2 intent only — fix all FOUR timestamp sites (commit/push/reject/sync) [v4 amend]
  Phase 2.5 — entry hash, default-accepted [unchanged]
  Phase 3   — Rust TradingGit (sub-PRs a/b/c/d), each fresh-agent context where marked [v4 amend]

Require evidence before approval:
  Phase 4a  — TS UTA actor retrofit [unchanged]
  Phase 4b  — Rust Broker trait + Mock + classifyMessage + offline-error rationalization + BrokerCapabilities [v4 amend]
  Phase 4c  — Rust guards + per-op pre-fetch parity test [v4 amend]
  Phase 4d  — Rust UTA actor + persistence + snapshot trigger swap + runtime lifecycle + reconnect parity [v4 amend]
  Phase 4e  — Execution journal + crash-recovery test [unchanged]
  Phase 4f  — RustUtaProxy + bounded event-stream + commit.notify schema + Telegram smoke test + panic test [v4 amend]
  Phase 5   — broker decision point — LeverUp explicitly NOT in scope (decision 1) [v4 amend]
  Phase 6   — broker-by-broker, only after spike report endorsement [unchanged]
  Phase 7   — TS fallback retained, real dogfood + rollback test [unchanged]
  Phase 8   — deferred ≥1 minor release after Phase 7 [unchanged]

New gates introduced by v4 (apply across phases):
  - Reconnect-ownership parity test (§6.5.1) — required for Phase 4d sign-off
  - Rust panic policy test (§6.12.1) — required for Phase 4f sign-off
  - Snapshot durability gap log (§6.4.1) — TODO.md entries created by end of Phase 0
  - Connector consumer matrix (§6.16) — current state documented in Phase 0; updated on every connector change
```

---

## 13. Changelog from v2

This section records every concrete edit applied from the v2 review. Fourteen issues + the Phase 2.5 decision = fifteen diffs.

| # | v2 claim | v3 correction | Verified against |
|---|----------|---------------|------------------|
| 1 | `#[serde(rename_all = "UPPERCASE")]` on `BrokerErrorCode`, with `MarketClosed → "MARKET_CLOSED"`. | `SCREAMING_SNAKE_CASE` + mandatory unit test asserting exact string for every code. | Serde docs: `UPPERCASE` does not insert separators. v3 Phase 4b. |
| 2 | "No on-disk format changes." | Reframed: "no breaking read incompatibility; v1 commits load unchanged; v2 introduces explicit `hashVersion` schema; mixed logs are first-class." | v3 §6.3, §6.13. |
| 3 | Rust generates v2 only — implicit handling of v1. | Explicit `PersistedCommit::{V1Opaque, V2}` decoder in TS and Rust. v1 commits never recomputed; round-trip preserved. | v3 §6.13, Phase 2 deliverable 4, Phase 3 deliverable 4. |
| 4 | `entryFullHash` deferred or folded into Phase 2. | **Phase 2.5 default-accepted**, sits between Phase 2 and Phase 3. `fullHash` renamed to `intentFullHash`. Schema reservation in Phase 2. | v3 Phase 2 + Phase 2.5 + §6.2. |
| 5 | Broker-execution crash window noted but unaddressed. | Dedicated Phase 4e: pre/post-call journal + per-broker client-order-ID + restart reconciler + crash-recovery test. | v3 P9, §6.11, Phase 4e. |
| 6 | `path.tmp` rename + `commit.notify` reconciler. | Full atomic-write recipe (`<path>.<pid>.<rand>.tmp` + fsync file + fsync parent dir). Missing-snapshot reconciler shipped as a Phase 4d deliverable, not assumed. | v3 §6.4. |
| 7 | Phase 4 mixed too many concepts. | Split into 4a (TS retrofit) / 4b (Broker trait + Mock + error test) / 4c (guards) / 4d (UTA actor + persistence) / 4e (journal) / 4f (proxy + events). | v3 §5 Phase 4. |
| 8 | Phase 0 fixtures used `Decimal.toString()`; Phase 1 said "no scientific notation." | Explicit `toCanonicalDecimalString` formatter (TS + Rust), defined in Phase 1c, used everywhere from Phase 0 forward. Rules listed in §6.1. | v3 §6.1, Phase 1c. |
| 9 | Only `WireDecimal`. | `WireDecimal` + `WireDouble` (string-encoded to avoid IEEE-754 drift) + `WireInteger`. Each `Order`/`Contract`/`Execution` field audited and assigned a wire type. | v3 P6, §6.1, Phase 1b. |
| 10 | NAPI event streaming handwaved. | Full §6.12 contract: bounded `mpsc(1024)`, `tsfn.unref()`, sequence numbers, throw/full/EventLog-failure semantics, gap-detection backfill, shutdown drain. P11 invariant. | v3 §6.12, Phase 4f. |
| 11 | Native-build gate per PR with `pnpm dev &` Docker shim. | Two gates: developer (per PR, Rust required) and release (per release tag, no Rust, real HTTP health check). | v3 §3.4. |
| 12 | Global `impl: 'ts' \| 'rust'` flag. | Structured `tradingCore.defaultBrokerImpl` per broker, with `ccxt: 'ts'` literal-pinned in Zod schema. Per-account `brokerImpl` override. No env vars on live path. | v3 §6.10. |
| 13 | Phase 1 was a single phase. | Split into 1a (package split) / 1b (wire adapters) / 1c (canonical JSON + decimal formatter). | v3 §5 Phase 1. |
| 14 | Timelines optimistic; "Rust core only" buried. | Padded estimates; "Rust core only" elevated to first-class terminal state in §1 and §5 Phase 5. | v3 §1, §9. |
| Decision | (this turn) | Phase 2.5 default-accepted, between Phase 2 and Phase 3. Broker-execution journal as Phase 4e (not folded into 4d). | v3 Phase 2.5, Phase 4e. |

---

## 14. Changelog from v3

This section mirrors §13's format. Each row records one diff applied from a stress-test review of v3 (commit `c60de33` of the v4 outline).

| # | v3 claim | v4 correction | Verified against |
|---|----------|---------------|------------------|
| 1 | Phase 4c: `GuardPipeline.wrap` "pre-fetches `[positions, account]` outside the loop." | Function is `createGuardPipeline` (no class). Pre-fetch is **per op**, not per push. Rust matches per-op. | `guards/guard-pipeline.ts:13-37`, `TradingGit.ts:100-112` |
| 2 | Phase 2: timestamp desync at `commit()` and `push()`. | Same bug at `reject()` and `sync()`. Fix all four sites. | `TradingGit.ts:69, 124, 172, 386, 404` |
| 3 | §3.4 release gate: `curl -sf http://localhost:3002/api/status`. | `/api/status` did not exist in v3-tree. v4 ships it as Phase 0 Deliverable 9. | `web-plugin.ts:93-114` |
| 4 | `commit.notify` referenced in v3 §6.4 / §1 / §7 / §8 / §11 as if it exists. | Net-new event. v4 Phase 4f Deliverable 6 registers schema in `AgentEventMap` with TypeBox. | `agent-event.ts:91-103, 275`; grep returns zero |
| 5 | §6.10: `ccxt: 'ts'` "literal-pinned at the Zod schema level." | `tradingCore` namespace is net-new. v4 Phase 4f introduces it. | `src/core/config.ts` (no references) |
| 6 | Phase 1a: "purely mechanical refactor." | Decoder constructs DTO classes via `new` and mutates fields. `order-decoder.ts` lives at wrong layer. | `decoder/{execution,account,contract}.ts`; `order-decoder.ts` |
| 7 | §6.4 / Phase 4d: snapshot trigger described as event-based. | Inline callback today (`UnifiedTradingAccount.ts:429`). Actor→TS hop is net-new structural change. | `main.ts:115-119`, `UnifiedTradingAccount.ts:429` |
| 8 | §4.3 / Phase 3: `TradingGit` "ports cleanly." | `TradingGitConfig` carries 3 callbacks tunneling broker surface across FFI. `Order` rehydration is broker-shape-aware. | `interfaces.ts:55-59`, `TradingGit.ts:312-371` |
| 9 | §6.2: v1 hashes are "opaque." | Make explicit: change-detection tokens, not content addresses. Depend on JS class iteration order + decimal.js. | `TradingGit.ts:33-38, 70-75` |
| 10 | Phase 4b: `BrokerError` shape `{code, message, permanent}`. | `class extends Error` with non-trivial `classifyMessage()` regex pipeline. `push()` offline-rejection throws plain `Error`, not `BrokerError`. | `brokers/types.ts:16, 45-59`; `UnifiedTradingAccount.ts:421-431` |
| 11 | §4.2: UTAManager wires {EventLog, ToolCenter, FxService, snapshot hooks, CCXT tools}. | Surface is broader: `getAggregatedEquity`, `searchContracts`/`getContractDetails`, `createGitPersister`, `broker.factory`/`getBrokerPreset`. | `uta-manager.ts:71-330` |
| 12 | §4 / §5: brokers covered are CCXT, Alpaca, IBKR, Mock. | LeverUp absent. v4 §4.4 adds placement; decision: stay TS. Phase 4b Deliverable 8 adds `BrokerCapabilities` for forward-compat. | `TODO.md:232-257` |
| 13 | (Not addressed.) Runtime UTA add/remove via HTTP. | `UTAManager.{initUTA,reconnectUTA,removeUTA,add,remove}` driven from HTTP. v4 Phase 4d Deliverable 6 ships actor lifecycle handlers + 100-cycle test. | `uta-manager.ts:93,111,154,172,179`; HTTP routes |
| 14 | (Not addressed.) Reconnect ownership across the FFI. | New §6.5.1 matrix. TS owns CCXT recovery, Rust owns IBKR/Alpaca recovery post-port. Parity test in Phase 4d. | `UnifiedTradingAccount.ts:296-328`; `uta-manager.ts:111-151` |
| 15 | (Not addressed.) Rust panic policy. | New §6.12.1 + P13. `catch_unwind` boundary; panics → typed JS errors; no process abort. Phase 4f Deliverable 8 panic injection test. Default panic dedup `N=5` (decision 4). | `napi-rs` docs |
| 16 | (Not addressed.) Snapshot durability asymmetry. | New §6.4.1 enumerates 3 gaps the reconciler doesn't close. Out of scope; logged with `[snapshot-durability]` tag. | `snapshot/store.ts:51-56, 83-84, 109-111` |
| 17 | (Not addressed.) Tool-surface contract. | New §6.14 enumerates 16 tools + UTA touchpoints. `getPortfolio` interleaving hazard documented. Latency budget set. | `src/tool/trading.ts:121-512` |
| 18 | (Not addressed.) Cross-UTA atomicity. | New §6.15 documents best-effort sequential as intentional carry-over. | `src/tool/trading.ts:457-465` |
| 19 | (Not addressed.) Connector consumer matrix. | New P14 + §6.16. Telegram observes/mutates trading state directly. Phase 4f Deliverable 7 Telegram smoke test. | `telegram-plugin.ts:111-194` |
| 20 | (Not addressed.) Pre-existing TODO.md items overlap migration. | New §6.13 triages: staging-area + cooldown port-as-is; snapshot/FX out-of-scope; LeverUp into §4.4. | `TODO.md:60-69, 71-78, 80-86, 88-93, 95-102, 232-257` |
| 21 | §8.4: Phases 0–2.5, 4a/4b/4c/4f, 5(spike), 7 "fit a single agent context window." | Optimistic for 3(c), 4d(a), 4d(c), 4f. v4 §8.4 replaces with tiered table marking which sub-PRs need fresh-agent context. | `TradingGit.ts` (657L) + `UnifiedTradingAccount.ts` (586L) |
| 22 | (Not addressed.) `UNSET_LONG = BigInt(2 ** 63) - 1n` JS precision bug. | v4 §6.1 caveats + Phase 1b Deliverable 5 fixture for canonical `i64::MAX` reconstruction. | `packages/ibkr/src/const.ts:12` |
