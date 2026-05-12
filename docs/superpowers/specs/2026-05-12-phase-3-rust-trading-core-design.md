# Phase 3 — Rust workspace + Rust `TradingGit` (dead code)

**Status:** approved 2026-05-12.
**Source:** [`docs/RUST_MIGRATION_PLAN.v4.md:653-767`](../../RUST_MIGRATION_PLAN.v4.md), narrowed to a single design with the binary decisions below resolved.

## Resolved decisions

| # | Decision |
|---|----------|
| 1 | **Scope:** full v4 Phase 3 (all 9 deliverables, including the complete `TradingGit` port + typed napi surface). Not the narrower "core algorithms only" reading. |
| 2 | **Phase 2.5 entry hash: declined.** Phase 3 ports v2 intent hash only. `entryHashVersion` / `entryFullHash` schema fields stay reserved (set in Phase 2 Task A) but unpopulated. Decline reason: keep parity story simple — verify one hash byte-identical across TS/Rust, not two. |
| 3 | **Single PR, sequential commits on master** following the established Phase 0–2 pattern. The 4 sub-tasks below map to 4+ commits, not 4 separate PRs. |

## Goal

Prove Rust↔TS byte-parity on canonical JSON + v2 hash + full `TradingGit` state machine, against the 23 v2 fixtures captured in Phase 2 (`parity/fixtures/git-states/*.json`) plus the golden-byte test in `hash-v2.spec.ts` (`intentFullHash 2a98a2d0…23c97d` for the empty-ops fixed input).

Rust crate is dead code at the end of Phase 3 — no live path consumes it. Phase 4d wires it up via the actor pattern.

## Architecture

Single Rust crate at `crates/alice-trading-core/` exposed to TS via `napi-rs`. The crate compiles to a native `.node` binary loaded by a thin pnpm workspace package `@traderalice/trading-core-bindings` at `packages/trading-core-bindings/`. All v2 hash logic is duplicated in Rust — TS keeps the existing implementation unchanged. A parity test runs both implementations against every fixture and asserts byte-identical canonical JSON + SHA-256 outputs.

### Tech stack

`napi`, `napi-derive`, `tokio`, `serde`, `serde_json`, `bigdecimal`, `sha2`, `thiserror`, `tracing`. **Explicitly NOT `rust_decimal`** — `decimal.js` semantics differ from `rust_decimal`'s default rounding/precision; `BigDecimal` matches when paired with the explicit canonical formatter.

### Crate layout

```
crates/alice-trading-core/
├── Cargo.toml                       # napi-rs binary crate
├── build.rs                         # napi-rs build script (generates index.d.ts)
├── src/
│   ├── lib.rs                       # napi #[napi] surface — TradingGit class + AddResult/CommitPrepareResult/...
│   ├── decimal.rs                   # DecimalString newtype + to_canonical_decimal_string + WireDecimal/Double/Integer
│   ├── canonical.rs                 # Sorted-key recursive canonical JSON serializer
│   ├── operation_wire.rs            # operation_to_wire walker
│   ├── hash_v2.rs                   # generate_intent_hash_v2
│   ├── persisted_commit.rs          # PersistedCommit (untagged enum) + classify + verify + serialize
│   ├── git.rs                       # TradingGit state machine
│   └── types.rs                     # GitCommit, GitState, Operation, OperationResult, etc.
└── tests/                           # cargo test integration suite
```

```
packages/trading-core-bindings/
├── package.json                     # name=@traderalice/trading-core-bindings
├── index.js                         # napi-rs runtime loader
├── index.d.ts                       # generated, checked in, CI fails on drift
└── *.node                           # native binary, build artifact
```

## Sub-task breakdown

Strict A → B → C → D order.

### 3(a) — Decimal + canonical JSON

**Files:**
- Create: `crates/alice-trading-core/Cargo.toml`, `build.rs`
- Create: `crates/alice-trading-core/src/decimal.rs`, `canonical.rs`, `lib.rs` (stub with `ping()` only)

**Decimal contract** (mirrors TS `src/domain/trading/canonical-decimal.ts`):
- `DecimalString(String)` — newtype wrapping a canonical decimal string. Validated on construction.
- `WireDecimal/WireDouble/WireInteger` — serde-tagged enums:
  ```rust
  #[derive(Clone, Serialize, Deserialize)]
  #[serde(tag = "kind", rename_all = "lowercase")]
  pub enum WireDecimal { Unset, Value { value: DecimalString } }
  ```
- `to_canonical_decimal_string(d: &BigDecimal) -> Result<String, CanonicalError>` — explicit implementation, NOT `BigDecimal::normalize().to_string()`. Rules:
  - reject NaN/Infinity (BigDecimal can't represent these — defensive guard)
  - canonical zero = `"0"` (never `"-0"`, `"0.0"`, `"0e0"`)
  - strip trailing zeros after the decimal point
  - strip the decimal point itself if no fractional part remains
  - negative sign only for nonzero
  - no exponent notation, no leading `+`

**Canonical JSON contract** (mirrors TS `src/domain/trading/canonical-json.ts`):
- Sorted-key recursive serializer
- Arrays preserve order (semantic)
- ASCII-only key sort (matches TS — non-ASCII keys not yet exercised)
- No pretty-printing in default output (compact)
- Optional `pretty: bool` flag for human-readable fixture output

**Tests:**
- All canonical-decimal cases from `parity/fixtures/canonical-decimal/` round-trip identically
- Sentinel detection (UNSET_DECIMAL = 2^127-1 → `WireDecimal::Unset`) verified via fixture
- Canonical JSON output matches `parity/fixtures/canonical-json/` byte-for-byte
- Property-based test: `to_canonical_decimal_string ∘ from_canonical` is identity over a 1000-element fuzz corpus

**DoD:**
- `cargo test -p alice-trading-core` green
- `cargo clippy -p alice-trading-core -- -D warnings` clean
- `parity/check-canonical-decimal-rust.ts` (TS-side parity script, see 3(d)) passes against the entire canonical-decimal fixture corpus

### 3(b) — PersistedCommit + hash-v2 + operation-wire

**Files:**
- Create: `crates/alice-trading-core/src/persisted_commit.rs`, `operation_wire.rs`, `hash_v2.rs`, `types.rs`

**PersistedCommit:**
```rust
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum PersistedCommit {
    V2(GitCommitV2),
    V1Opaque(serde_json::Value),
}

impl PersistedCommit {
    pub fn classify(raw: serde_json::Value) -> Self {
        // hash_version === 2 → V2; else → V1Opaque
    }

    pub fn verify(&self) -> VerifyResult { /* ... */ }
}
```

`V1Opaque(serde_json::Value)` is the **only** place a `serde_json::Value` appears in the Rust codebase. v1 commits are never normalized, never re-hashed (decision P10).

**Operation enum** (mirrors TS `Operation` discriminated union):
```rust
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Operation {
    PlaceOrder { order: WireOrder, contract: WireContract, tpsl: Option<TpSlParams> },
    ModifyOrder { order_id: String, changes: PartialWireOrder },
    ClosePosition { contract: WireContract, quantity: Option<DecimalString> },
    CancelOrder { order_id: String, order_cancel: Option<serde_json::Value> },
    SyncOrders,
}
```

**operation_to_wire** — walks Operation variants, emits canonical JSON values:

The TS implementation runs `ibkr*ToWire` to convert IBKR class instances to wire form. In Rust, the wire form IS the input — no conversion needed. `operation_to_wire(op) -> serde_json::Value` is therefore mostly serde serialization with the canonical-JSON serializer applied.

**generate_intent_hash_v2:**
```rust
pub fn generate_intent_hash_v2(input: HashV2Input) -> (String, String) {
    let canonical = canonical_json(json!({
        "hashVersion": 2,
        "parentHash": input.parent_hash,
        "message": input.message,
        "operations": input.operations.iter().map(operation_to_wire).collect::<Vec<_>>(),
        "hashInputTimestamp": input.hash_input_timestamp,
    }));
    let intent_full_hash = hex::encode(Sha256::digest(canonical.as_bytes()));
    let short_hash = intent_full_hash[..8].to_string();
    (intent_full_hash, short_hash)
}
```

**Tests:**
- Golden-byte: hash for the same fixed input as TS `hash-v2.spec.ts` MUST equal `2a98a2d0ae18fa1bd6a744d5281b641a38296018aad9f73d7df9b209be23c97d`
- Determinism: same input → same hash within a single `cargo test` run
- Uniqueness: timestamp/parentHash/message changes produce different hashes
- PersistedCommit classify: `hashVersion: 2` → V2, missing → V1Opaque, `hashVersion: 1` → V1Opaque
- PersistedCommit verify: v1-opaque returns Skipped; v2 with valid hash returns Verified; corrupted hash returns Mismatch

**DoD:**
- `cargo test -p alice-trading-core` includes the golden-byte assertion and passes

### 3(c) — TradingGit state machine — TIGHT, fresh agent

**Files:**
- Create: `crates/alice-trading-core/src/git.rs`

This sub-task is the only one with non-trivial logic. v4 marks it "TIGHT — fresh agent" — implementer dispatched with limited context (no carry-over from 3(a)/(b) implementation chatter), seeded with `TradingGit.ts`, `types.ts`, `interfaces.ts`, GitState rehydration, and the parity fixtures.

**TradingGit struct:**
```rust
pub struct TradingGit {
    staging_area: Vec<Operation>,
    pending_message: Option<String>,
    pending_hash: Option<String>,
    pending_v2: Option<PendingV2>,
    commits: Vec<GitCommit>,
    head: Option<String>,
    current_round: Option<u32>,
    config: TradingGitConfig,
}

pub struct PendingV2 {
    pub hash_input_timestamp: String,
    pub intent_full_hash: String,
}
```

**Methods** (mirror TS interface, no async at this layer — async is added at the napi boundary in 3(d)):
- `add(op: Operation) -> AddResult`
- `commit(message: String) -> CommitPrepareResult` — captures `hash_input_timestamp` once, branches on `hashVersion`, sets `pending_v2`
- `push(...) -> PushResult` — synchronous on the state machine; broker calls happen at the napi layer
- `reject(reason: Option<String>) -> RejectResult` — recompute v2 hash with `[rejected]` message (Phase 2 dividend)
- `sync(updates: Vec<OrderStatusUpdate>, current_state: GitState) -> SyncResult` — captures own timestamp, no `pending_v2`
- `log(opts: LogOptions) -> Vec<CommitLogEntry>`
- `show(hash: &str) -> Option<&GitCommit>`
- `status() -> GitStatus`
- `export_state() -> GitExportState`
- `restore(state: GitExportState, config: TradingGitConfig) -> Self`

**Critical invariants** (must hold byte-identical to TS):
1. v1 commits emitted by the v1 fallback path have NO `hashVersion` field at all (verified in Phase 2 Task F test #2)
2. For v2 commits: `commit.timestamp == commit.hash_input_timestamp`
3. `pending_v2` cleared at end of push/reject
4. `sync()` does NOT touch `pending_v2`
5. `reject()` recomputes v2 hash with `[rejected] ${original_message}${reason ? " — ${reason}" : ""}` message (NOT `pending_v2.intent_full_hash` from `commit()`)

**Rehydration belongs in TS**, not Rust (decision §6.2 of v4). `Order` rehydration in TS `_rehydrate.ts` is broker-shape-aware (Decimal field-by-field rewrap of IBKR `Order`). Rust ports the rehydration logic as `WireOrder → WireOrder` round-trip; broker-class rehydration belongs in the TS proxy layer (Phase 4f).

**Tests:**
- Each TradingGit method tested in isolation (state-machine unit tests)
- Lifecycle test: `add → commit → push → log` produces a coherent commit
- v1 fallback path produces commits byte-identical to TS v1 commits (when `hashVersion: 1` config is set)
- All 23 v2 fixtures load via `restore`, re-export via `export_state`, and round-trip byte-identical

### 3(d) — Typed napi surface + parity harness

**Files:**
- Modify: `crates/alice-trading-core/src/lib.rs` (full napi surface)
- Create: `packages/trading-core-bindings/package.json`, `index.js`, `index.d.ts`
- Create: `parity/run-rust.ts`
- Create: `parity/check-git.ts`
- Create: `parity/check-canonical-decimal-rust.ts`
- Create: `.github/workflows/parity.yml`
- Modify: root `package.json` (add `@traderalice/trading-core-bindings` to workspaces)

**napi surface — typed structs only, zero `serde_json::Value` in public signatures** (decision P10):

```rust
#[napi(object)] pub struct AddResult { pub staged: bool, pub index: u32 }
#[napi(object)] pub struct CommitPrepareResult { pub prepared: bool, pub hash: String, pub message: String, pub operation_count: u32 }
#[napi(object)] pub struct PushResult { pub hash: String, pub message: String, pub operation_count: u32, pub submitted: Vec<OperationResult>, pub rejected: Vec<OperationResult> }
// ... one #[napi(object)] per TS result type ...

#[napi]
pub struct TradingGit { /* private state */ }

#[napi]
impl TradingGit {
    #[napi(factory)] pub fn new(config: TradingGitConfig) -> Self { /* ... */ }
    #[napi] pub fn add(&mut self, op: Operation) -> AddResult { /* ... */ }
    #[napi] pub fn commit(&mut self, message: String) -> Result<CommitPrepareResult> { /* ... */ }
    #[napi] pub async fn push(&mut self) -> Result<PushResult> { /* ... */ }
    #[napi] pub async fn reject(&mut self, reason: Option<String>) -> Result<RejectResult> { /* ... */ }
    #[napi] pub async fn sync(&mut self, updates: Vec<OrderStatusUpdate>, current_state: GitState) -> Result<SyncResult> { /* ... */ }
    #[napi] pub fn log(&self, opts: Option<LogOptions>) -> Vec<CommitLogEntry> { /* ... */ }
    #[napi] pub fn show(&self, hash: String) -> Option<GitCommit> { /* ... */ }
    #[napi] pub fn status(&self) -> GitStatus { /* ... */ }
    #[napi] pub fn export_state(&self) -> GitExportState { /* ... */ }
    #[napi(factory)] pub fn restore(state: GitExportState, config: TradingGitConfig) -> Self { /* ... */ }
}
```

**FFI callback contract** (decision: Option A — orchestrate in Rust). The 3 `TradingGitConfig` callbacks become `ThreadsafeFunction` typed napi parameters:

```rust
#[napi(object)]
pub struct TradingGitConfig {
    pub broker_execute_operation: ThreadsafeFunction<Operation, OperationResult>,
    pub broker_get_state: ThreadsafeFunction<(), GitState>,
    pub commit_persisted_notify: Option<ThreadsafeFunction<GitExportState, ()>>,
    pub hash_version: Option<u32>,
}
```

Phase 3 stubs these (parity test provides synthetic stubs); Phase 4d wires real brokers.

**Generated `index.d.ts`** is committed to repo. CI step `pnpm --filter @traderalice/trading-core-bindings run check-types` fails on drift (regenerate locally and commit).

**Parity harness:**
- `parity/run-rust.ts` — TS wrapper that loads `@traderalice/trading-core-bindings` and drives the same scenarios as `parity/run-ts.ts`. Outputs canonical JSON of full lifecycle.
- `parity/check-git.ts` — runs both runners on all 10 scenarios, diffs outputs, fails on byte mismatch.
- `parity/check-canonical-decimal-rust.ts` — runs `to_canonical_decimal_string` on every input in `parity/fixtures/canonical-decimal/` (via a small helper exposed by the binding), compares against TS output.
- `.github/workflows/parity.yml` — runs `cargo test`, builds the napi binary, runs `parity/check-git.ts` + `parity/check-canonical-decimal-rust.ts`. Fails on any diff.

**Tests in this sub-task:**
- napi binding loads (`require('@traderalice/trading-core-bindings').ping()` returns expected string)
- All 10 scenarios produce byte-identical run-ts vs run-rust output
- All 23 v2 commits in fixtures verify via Rust `PersistedCommit::verify`

## DoD (overall)

```bash
cargo test -p alice-trading-core
cargo clippy -p alice-trading-core -- -D warnings
pnpm --filter @traderalice/trading-core-bindings build
pnpm tsx parity/check-git.ts                        # all 10 scenarios byte-identical
pnpm tsx parity/check-canonical-decimal-rust.ts     # Rust formatter byte-matches TS
node -e "console.log(require('@traderalice/trading-core-bindings').ping())"
npx tsc --noEmit
pnpm test                                            # ~2228+ TS tests
# CI workflow .github/workflows/parity.yml runs all of above on PR
```

Generated `index.d.ts` checked into repo; CI fails on drift.

## Cutover gate

Rust `TradingGit` produces byte-identical canonical JSON, byte-identical SHA-256 short + full hashes, and byte-identical commit-log JSON to TS for every fixture. Rust crate is **not wired into any live path** at the end of Phase 3 — `src/main.ts`, `UnifiedTradingAccount`, and all production code paths use TS `TradingGit` unchanged.

## Rollback

Rust crate is dead code. `git revert` the 4+ Phase 3 commits. TS implementation is untouched. No data migration, no schema change, no live behavior change.

## Estimated effort

7-9 eng-days (per v4):
- 3(a) decimal + canonical: ~2 days (canonical-decimal rules are subtle; getting byte parity is the main risk)
- 3(b) PersistedCommit + hash-v2 + operation-wire: ~1 day (mostly serde + a hash function)
- 3(c) TradingGit state machine: ~3 days (state machine has 9 methods; v4 flags it as TIGHT)
- 3(d) napi surface + parity harness: ~2 days (napi-rs setup + ThreadsafeFunction wiring + CI)

Phase 3(c) is the risk concentration. The other 3 sub-tasks are mostly mechanical translation.

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| `BigDecimal` rounding differs from `decimal.js` on edge cases | Medium | High | Explicit `to_canonical_decimal_string` (no `normalize()`); fuzz test against TS output on 1000+ random decimals |
| napi-rs `ThreadsafeFunction` semantics break on concurrent calls | Low | High | Phase 3 only stubs callbacks (no real brokers); Phase 4d hits this for real |
| Generated `index.d.ts` drifts silently between local and CI | Medium | Medium | CI step `pnpm --filter @traderalice/trading-core-bindings run check-types` fails on diff; regenerate + commit |
| Cargo workspace setup breaks pnpm install on machines without Rust toolchain | Medium | Medium | `pnpm install` should NOT trigger cargo build; only `pnpm --filter @traderalice/trading-core-bindings build` does. CI installs Rust separately |
| Operation enum's `#[serde(tag = "action")]` produces different bytes than TS | Low | High | Golden-byte test in 3(b) catches this; TS uses literal `action: 'placeOrder'` keys, Rust uses `rename_all = "camelCase"` to match |
| Phase 2.5 entry hash gets demanded mid-Phase-3 | Low | Medium | Spec records explicit decline; if reversed, schema fields exist (Task A) — re-design needed |

## Out of scope

- **Live wiring.** Rust crate is dead code. Phase 4d wires it.
- **Phase 2.5 entry hash.** Declined for this phase; schema fields stay reserved.
- **Broker port.** Phase 4b ports brokers (Mock, Alpaca, IBKR, CCXT) to Rust.
- **Guards port.** Phase 4c ports the guard pipeline to Rust.
- **Actor pattern in TS.** Phase 4a (TS UTA actor retrofit) is a prerequisite for Phase 4d but independent of Phase 3.
- **`UnifiedTradingAccount` port.** Phase 4d.
- **Rehydration of broker-shape classes** (e.g., IBKR `Order` instances) — stays in TS proxy layer (Phase 4f).
