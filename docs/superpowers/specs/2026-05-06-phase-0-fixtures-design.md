# Phase 0 — Fixtures + Inventory Design

**Date:** 2026-05-06
**Migration phase:** v4 §5 Phase 0 (lines ~297-326). [v4 plan](../../RUST_MIGRATION_PLAN.v4.md).
**Status:** Spec — to be implemented.
**Estimated effort:** 4-5 eng-days (single PR).

This spec covers Phase 0 deliverables 1-7. Deliverables 8-10 (`parity/context-worksheets/`, `/api/status`, TODO.md tags) shipped in a prior session (commits `8a085c7`, `f867ffa`, `523da08`, `a57ba4a` and the related anchor fix).

## Goal

Land the fixture corpus + tooling that all subsequent migration phases depend on. No production code changes. No behavior change. The PR is purely additive under `parity/` plus one new top-level audit file (`parity/decimal-inventory.md`).

The corpus must:

1. Cover the cross product BUY/SELL × order types × TIFs × TP-SL × adversarial decimals (deliverable 1).
2. Cover the three IBKR sentinels in every position they can occupy (deliverable 2).
3. Capture 10 multi-step lifecycle scenarios as `GitExportState` snapshots (deliverable 3).
4. Provide loadable legacy-path snapshots for `data/crypto-trading/` and `data/securities-trading/` (deliverable 4).
5. Capture today's `JSON.stringify(Order)` and `JSON.stringify(Contract)` shapes — what Phase 1b's wire adapters must round-trip (deliverable 5).
6. Provide `parity/run-ts.ts` — the CLI Phase 3 will diff against (deliverable 6).
7. Provide `parity/decimal-inventory.md` — the audit driving Phase 1b's wire-type design (deliverable 7).

## Non-goals

- No Rust crate (Phase 3).
- No wire types (Phase 1b).
- No canonical-JSON utility (Phase 1c) — Phase 0 inlines a private helper that Phase 1c will replace.
- No actor pattern (Phase 4a).
- No MockBroker reuse — `run-ts.ts` uses **stubbed callbacks**, not a real `MockBroker`. (MockBroker fixtures are Phase 4b's scope.)

## Architecture

All work lands under `parity/`. No edits to `src/`.

```
parity/
├── .gitkeep                                  # existing
├── README.md                                 # NEW: parity/ purpose + how to run
├── context-worksheets/                       # existing (prior session)
├── fixtures/
│   ├── operations/                           # NEW: deliverable 1
│   │   ├── placeOrder/case-*.json
│   │   ├── modifyOrder/case-*.json
│   │   ├── closePosition/case-*.json
│   │   ├── cancelOrder/case-*.json
│   │   └── syncOrders/case-001.json
│   ├── sentinels/                            # NEW: deliverable 2
│   │   ├── order-fields/case-*.json
│   │   ├── contract-fields/case-*.json
│   │   ├── execution-fields/case-*.json
│   │   └── orderState-fields/case-*.json
│   ├── git-states/                           # NEW: deliverable 3 (captured outputs)
│   │   ├── 01-single-commit.json
│   │   ├── 02-three-commits-with-rejection.json
│   │   └── ... 03-10
│   ├── scenarios/                            # NEW: inputs that produce git-states/
│   │   ├── 01-single-commit.scenario.json
│   │   └── ... 02-10
│   ├── legacy-paths/                         # NEW: deliverable 4
│   │   ├── crypto-trading-commit.json
│   │   ├── securities-trading-commit.json
│   │   └── README.md
│   └── orders-on-wire/                       # NEW: deliverable 5
│       ├── README.md
│       ├── order/<sha>.json
│       └── contract/<sha>.json
├── generators/                               # NEW: scripts producing fixtures
│   ├── _canonical-decimal.ts                 #   private helper, Phase 1c will replace
│   ├── _canonical-json.ts                    #   private helper, Phase 1c will replace
│   ├── operations.ts                         #   produces fixtures/operations/
│   ├── sentinels.ts                          #   produces fixtures/sentinels/
│   ├── orders-on-wire.ts                     #   reads operations/, emits orders-on-wire/
│   └── README.md
├── _construct.ts                             # NEW: shared TradingGit-with-stubs builder
├── run-ts.ts                                 # NEW: deliverable 6 — single/scenario/batch CLI
├── load-legacy.ts                            # NEW: DoD command — verifies legacy paths load
└── decimal-inventory.md                      # NEW: deliverable 7
```

Two layout decisions:

- **Operations split by `Operation.action` subdir** rather than flat. 250-400 files in one dir is unwieldy; per-action splitting makes Phase 3 parity diffs interpretable ("placeOrder failed, modifyOrder green").
- **Scenarios separate from captured outputs.** Scenario files in `fixtures/scenarios/` are the editable inputs; `fixtures/git-states/` holds the captured `GitExportState` outputs. Both committed; regenerable via `pnpm tsx parity/run-ts.ts --scenario=<file> --emit-git-state=<out>`.

## Deliverable 1 — Operations corpus

`parity/generators/operations.ts` enumerates the cross product, constructs real IBKR `Order`/`Contract` instances, and emits one canonical-JSON file per case. Naming convention: `case-<action>-<orderType>-<tif>-<tpsl?>-<dec-precision>-<NNN>.json`.

Expected breakdown:

| Action | Count | Source enumeration |
|---|---|---|
| `placeOrder` | ~250-300 | BUY/SELL × {MKT, LMT, STP, STP LMT} × {DAY, GTC, IOC, FOK, GTD, OPG} × {with TP-SL, without} × {default-precision, 8-dec, 12-dec, 18-dec, 1e30, 1e-30, negative, zero, sub-satoshi=1e-9}. Trim TIF×orderType combos that don't make sense in TWS (e.g., OPG+STP, FOK+MKT). |
| `modifyOrder` | ~40 | 2 × {MKT, LMT, STP, STP LMT} × 5 change-types (qty up, qty down, price up, price down, type-change) |
| `closePosition` | ~8 | 2 (with quantity, without) × 4 size-classes (whole, half, sub-satoshi, very-large) |
| `cancelOrder` | ~10 | 2 (with `OrderCancel`, without) × 5 reason variants |
| `syncOrders` | 1 | parameterless |
| **Total** | **~310-360** | comfortably above the ≥200 floor |

**Fixture file format** (per case):

```json
{
  "name": "case-placeOrder-buy-lmt-day-tpsl-008dec-042",
  "operation": {
    "action": "placeOrder",
    "contract": { "symbol": "AAPL", "secType": "STK", "exchange": "SMART", "currency": "USD", ... },
    "order": { "action": "BUY", "totalQuantity": "100", "orderType": "LMT", "lmtPrice": "150.12345678", "tif": "DAY", ... },
    "tpsl": { "takeProfit": "160.0", "stopLoss": "140.0" }
  }
}
```

Numeric fields are canonical decimal strings (e.g., `"150.12345678"`, never `1.5012345678e2`). `Order` and `Contract` field sets match what the IBKR class instances expose — including all the IBKR sentinel-bearing fields, with sentinels emitted as their canonical string (e.g., `UNSET_DECIMAL` becomes `"170141183460469231731687303715884105727"`).

The generator emits files via a wrapper around `JSON.stringify` that:
- Calls a private `toCanonicalDecimalString(Decimal)` for every `Decimal` field (lives in `parity/generators/_canonical-decimal.ts`)
- Sort-keys recursively (lives in `parity/generators/_canonical-json.ts`)
- Phase 1c's PR deletes these private files and re-routes imports to the canonical implementations

## Deliverable 2 — Sentinel corpus

`parity/generators/sentinels.ts` reads `parity/decimal-inventory.md` (deliverable 7 — so this generator is sequenced after the inventory lands) and emits, for each field flagged `value-or-unset`:

- One fixture where THAT field is set to its sentinel and all other numeric fields are at their non-sentinel default.
- Plus 5 "all sentinels at once" cases per type (Order, Contract, Execution, OrderState).

Expected count: **~80-120 fixtures** (depends on inventory final count).

## Deliverable 3 — git-states corpus + scenarios

10 named scenarios in `fixtures/scenarios/` exercise lifecycle shapes:

| # | Name | Shape exercised |
|---|---|---|
| 01 | single-commit | One stage, one commit, one push, one fill |
| 02 | three-commits-with-rejection | Three sequential commits; second push has one rejection |
| 03 | sync-after-fill | placeOrder, push, then `syncOrders` reflecting external state change |
| 04 | reject-then-recommit | Stage, commit, reject (user-rejected); stage different ops, commit, push |
| 05 | multi-op-commit | One commit with 5 staged operations (place + place + cancel + modify + close) |
| 06 | sub-satoshi-precision | Quantities and prices at 18-decimal precision |
| 07 | sentinel-roundtrip | Order with one UNSET_DECIMAL field flows through stage → commit → push → exportState |
| 08 | tpsl-bracket | placeOrder with TpSlParams; both child orders represented |
| 09 | sync-without-push | `syncOrders` as the only operation in a commit |
| 10 | long-chain | 10 sequential single-op commits to exercise commit log + parentHash chaining |

**Scenario file schema** (`*.scenario.json`):

```json
{
  "name": "01-single-commit",
  "description": "Simplest path: one stage, one commit, one push, one fill.",
  "steps": [
    { "op": "stagePlaceOrder", "fixture": "fixtures/operations/placeOrder/case-buy-mkt-day-001.json" },
    { "op": "commit", "message": "Initial buy" },
    { "op": "push", "stubResults": [
      { "action": "placeOrder", "success": true, "orderId": "mock-1", "status": "filled",
        "filledQty": "100", "filledPrice": "150.00" }
    ]}
  ]
}
```

**`stubResults` rules:**

- Explicit per-step. The stub `executeOperation` callback returns `stubResults[i]` for the i-th operation in the push.
- If a step omits `stubResults`, the default policy applies: `{ success: true, status: 'filled', filledQty: order.totalQuantity, filledPrice: order.lmtPrice ?? "100" }` for placeOrder, sensible defaults for other actions.

**Captured outputs** in `fixtures/git-states/<NN>-<name>.json` are full `GitExportState` JSON (sort-keyed). These are what Phase 3 Rust will diff against.

## Deliverable 4 — Legacy-path corpus

Two files matching `git-persistence.ts:18-22`:

| File | Would land at | For accountId |
|---|---|---|
| `fixtures/legacy-paths/crypto-trading-commit.json` | `data/crypto-trading/commit.json` | `bybit-main` |
| `fixtures/legacy-paths/securities-trading-commit.json` | `data/securities-trading/commit.json` | `alpaca-paper`, `alpaca-live` |

Generated by running scenario 01 with the relevant accountId and copying the resulting `commit.json`. `fixtures/legacy-paths/README.md` documents the legacy-path → accountId mapping (mirrors `git-persistence.ts:18-22`).

**`parity/load-legacy.ts`** — the DoD's `pnpm tsx parity/load-legacy.ts` command:

1. `mkdtemp` a temp dir
2. Copies fixture files to temp paths matching the legacy layout (e.g., `<tmp>/data/crypto-trading/commit.json`)
3. Constructs `gitPersister('bybit-main')` with the persister's path-resolution overridden to use `<tmp>` instead of CWD
4. Asserts the loaded `GitExportState` deep-equals the original fixture content
5. Same for `alpaca-paper` with the `securities-trading` path
6. Cleans up the temp dir
7. Exits 0 on success, non-zero on any mismatch

**Critical:** `load-legacy.ts` NEVER writes to the repo's `data/` directory. The path-resolution override is essential to avoid colliding with a developer's running instance.

## Deliverable 5 — Orders-on-wire corpus

`parity/generators/orders-on-wire.ts` reads every fixture in `fixtures/operations/` containing a `placeOrder` action. For each unique `Order` and `Contract` shape encountered, emits the result of plain `JSON.stringify(instance, null, 2)` to:

- `fixtures/orders-on-wire/order/<sha8>.json`
- `fixtures/orders-on-wire/contract/<sha8>.json`

Where `<sha8>` is the first 8 hex chars of `sha256(JSON.stringify(instance))`. Deduplication by content hash keeps the dir size manageable.

These snapshots capture **today's `JSON.stringify` output of IBKR class instances** — what Phase 1b's wire adapters must round-trip through `WireOrder`/`WireContract` and back without drift.

`fixtures/orders-on-wire/README.md` explains the dedup scheme and how Phase 1b's parity test will use these.

## Deliverable 6 — `parity/run-ts.ts`

Three modes:

```
pnpm tsx parity/run-ts.ts <fixture-path>
    Single-fixture: load Operation from fixture, drive add → commit → push →
    log → exportState. Emit canonical JSON of the full lifecycle to stdout:
    { addResult, commitResult, pushResult, logEntries, exportState }.
    Matches the v4 DoD example.

pnpm tsx parity/run-ts.ts --scenario=<file> [--emit-git-state=<out>]
    Scenario mode: walk the .scenario.json step list. Each step calls one
    TradingGit method; stubResults from the scenario drive the stub
    executeOperation callback. If --emit-git-state is given, write the
    final GitExportState there; otherwise print the full lifecycle to stdout.

pnpm tsx parity/run-ts.ts --all [--bail]
    Batch mode: walk every fixture in fixtures/operations/, run each as
    single-fixture, write outputs to /tmp/parity-out-<hash>.json, and
    print a one-line summary per fixture. --bail stops on first failure.
```

**Shared construction helper** (`parity/_construct.ts`):

```ts
import { TradingGit } from '../src/domain/trading/git/TradingGit.js'

export function buildTradingGit(stubPolicy: StubPolicy): TradingGit {
  return new TradingGit({
    accountId: 'parity-test',
    executeOperation: (op) => stubPolicy.resultFor(op),
    getGitState: () => stubPolicy.stateNow(),
    onCommit: () => Promise.resolve(),  // no-op; persistence isn't tested here
  })
}
```

**Determinism:**

- `Date.now()` calls inside TradingGit are intercepted via `vi.useFakeTimers({ now: '2026-01-01T00:00:00.000Z' })` at the top of run-ts.ts. Hash inputs reproducible across runs.
- All Operations in fixtures already use canonical decimal strings; round-trip to `Decimal` via `new Decimal(str)` is exact.
- File output uses sort-keyed canonical JSON (the private helper from `generators/_canonical-json.ts`).

## Deliverable 7 — `parity/decimal-inventory.md`

Markdown audit. Header explains scope (FFI-boundary types only, per design discussion).

Per-section structure (one section per type):

```markdown
## Order

Source: `packages/ibkr/src/order.ts`. Class with public mutable fields.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `totalQuantity` | `Decimal` | value-only | `WireDecimal::Value` | always set; never UNSET |
| `lmtPrice` | `Decimal` | value-or-unset | `WireDecimal` | UNSET_DECIMAL when not LMT/STP-LMT |
| `auxPrice` | `Decimal` | value-or-unset | `WireDecimal` | UNSET_DECIMAL except trail/stop |
| `displaySize` | `number` | value-or-unset | `WireInteger` | UNSET_INTEGER when not iceberg |
| ... | ... | ... | ... | ... |

**Field count:** N numeric fields. **Sentinel-bearing:** M (X Decimal, Y number-as-Long).
```

Sections in order: `Order`, `Contract`, `Execution`, `OrderState`, `Position`, `OpenOrder`, `GitState`, `OperationResult`. Footer with overall counts + a "**Wire-type recommendations for Phase 1b**" summary.

The Wire type column is *recommended assignment* — Phase 1b reviews and may revise. Marked as proposal, not binding.

## Determinism + DoD

The v4 DoD for Phase 0 is:

```bash
pnpm tsx parity/run-ts.ts parity/fixtures/operations/case-001.json > /tmp/ts.json
test -s /tmp/ts.json
pnpm tsx parity/load-legacy.ts          # both legacy fixtures load
npx tsc --noEmit
pnpm test
```

Per-line:
- Line 1: single-fixture mode of run-ts.ts works on at least one operation fixture.
- Line 2: that fixture produced non-empty output.
- Line 3: load-legacy.ts succeeds (both legacy fixtures load identically).
- Line 4: TS still compiles with strict mode.
- Line 5: existing tests still green.

Additional implicit DoD:
- All 4 generators (operations, sentinels, orders-on-wire, [no separate generator for git-states/scenarios — those are hand-authored + run-ts.ts emits]) are idempotent: re-running produces byte-identical output.
- `pnpm tsx parity/run-ts.ts --all` passes for every fixture in `fixtures/operations/`.

## Risk register (Phase 0-specific)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `toCanonicalDecimalString` private helper drifts from Phase 1c's canonical implementation | Medium | Medium | Phase 1c PR deletes the private helper and re-routes imports; CI test asserts re-emitting fixtures via Phase 1c yields byte-identical output. |
| Generator non-determinism (PRNG, time, JSON.stringify ordering) | Low | High | All randomness seeded; time stubbed; output sort-keyed. Re-running generators in CI must yield zero diff. |
| `decimal-inventory.md` misses a field, leading to wrong WireType in Phase 1b | Medium | Medium | Manual audit of every numeric field on each FFI-boundary type. Phase 1b's review revisits and corrects if needed. |
| `load-legacy.ts` accidentally writes to repo's `data/` | Low | High | Mandatory `mkdtemp` + path injection; integration test asserts no file at `data/crypto-trading/commit.json` after a run. |
| Sentinel fixture generator depends on inventory landing first | n/a | n/a | Sub-PR sequencing within Phase 0: inventory lands first, then sentinels generator uses it. |
| `Date.now()` stubbing leaks into other tests | Low | Medium | run-ts.ts stubs only inside its own process; vitest tests use their own `vi.useFakeTimers` setup. No global shim. |

## Sub-PR sequencing within Phase 0

The deliverables have a dependency order. To keep individual sub-tasks bite-sized:

1. **Sub-task A** — Inventory + scaffolding (`parity/decimal-inventory.md`, `parity/README.md`, `parity/generators/_canonical-decimal.ts`, `parity/generators/_canonical-json.ts`, `parity/_construct.ts`).
2. **Sub-task B** — Operations generator (`parity/generators/operations.ts`) → emit `fixtures/operations/`.
3. **Sub-task C** — Sentinels generator (`parity/generators/sentinels.ts`) → emit `fixtures/sentinels/`. Depends on inventory.
4. **Sub-task D** — Orders-on-wire generator (`parity/generators/orders-on-wire.ts`) → emit `fixtures/orders-on-wire/`. Depends on operations.
5. **Sub-task E** — `run-ts.ts` (single + scenario + batch modes).
6. **Sub-task F** — Scenarios + git-states (`fixtures/scenarios/01-…json` through `10`, captured via run-ts.ts to `fixtures/git-states/`).
7. **Sub-task G** — Legacy paths + load-legacy.ts (`fixtures/legacy-paths/`, `parity/load-legacy.ts`).
8. **Sub-task H** — DoD verification + commit.

All sub-tasks can land in a single PR (the natural unit for Phase 0). Each is independently committable for clean per-task review.

## Out of scope

Explicitly NOT in Phase 0:
- Wire types (Phase 1b).
- Canonical-JSON utility as a public module (Phase 1c — Phase 0 inlines a private helper).
- Hash v2 (Phase 2).
- Rust crate (Phase 3).
- Per-UTA actor (Phase 4a).
- MockBroker fixtures or behavior parity (Phase 4b).
- Snapshot durability fixes (`[snapshot-durability]` TODO entries).

## Acceptance signal

Phase 0 is "done" when:
- All DoD commands pass.
- The 7 deliverables from v4 §5 Phase 0 (1-7) are present in the working tree.
- The PR's diff is purely additive under `parity/` (no edits to `src/`, no edits to `package.json`, no edits to existing files).
- `pnpm tsx parity/run-ts.ts --all` passes for every fixture.
- The decimal-inventory.md gets a brief sanity-check from a reviewer (or this design's spec reviewer subagent) for completeness.
