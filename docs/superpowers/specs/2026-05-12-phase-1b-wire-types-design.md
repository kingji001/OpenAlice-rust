# Phase 1b — Wire Types + Adapters Design

**Date:** 2026-05-12
**Migration phase:** v4 §5 Phase 1b (lines ~365-401). [v4 plan](../../RUST_MIGRATION_PLAN.v4.md).
**Status:** Spec — to be implemented.
**Estimated effort:** 4-5 eng-days (single PR, 6 sub-task commits).

## Goal

Land the wire-types layer for IBKR DTO classes (`Order`, `Contract`, `Execution`, `OrderState`) plus the adapters that round-trip them. Phase 1b is dead code on the live path — `TradingGit` continues to use legacy hashing until Phase 2 cuts over to canonical wire form.

The wire-types module gives Phase 3 (Rust port) a typed, sentinel-aware contract for what flows across the FFI. The Phase 0 fixture corpus (340 order snapshots, 1 contract snapshot, 86 sentinel fixtures) becomes the parity-test surface.

## Non-goals

- No production wiring. `TradingGit` keeps the legacy hashing path (per v4 §5 Phase 1b Deliverable 4).
- No canonical JSON serialization here. Wire objects are TS objects; their JSON serialization is Phase 1c's concern.
- No wire types for internal TS types (`Position`, `OpenOrder`, `GitState`, `OperationResult`) — those are already Decimal-as-string in their existing definitions. Phase 1b covers only the four IBKR DTO classes.
- No wire validator. Round-trip tests always produce well-formed wire; Phase 3 (Rust→TS event stream) adds a validator when there's a real boundary consumer.
- No migration of existing tests of `Order`/`Contract` to use wire types. Existing tests stay on the IBKR classes directly.

## Architecture

Four new files under `src/domain/trading/`:

```
src/domain/trading/
├── wire-types.ts                       # NEW: base wire types + per-class schemas + mapped types
├── wire-adapters.ts                    # NEW: toWire/fromWire dispatch + sentinel detection
├── wire-canonical-decimal.ts           # NEW: inline canonical-decimal helper (~25 lines; Phase 1c deletes)
└── __test__/
    ├── wire-roundtrip.spec.ts          # NEW: round-trip 340+1 orders-on-wire + 86 sentinel fixtures
    └── unset-long-precision.spec.ts    # NEW: UNSET_LONG ≠ i64::MAX + canonical i64-string round-trip
```

Three logical layers in `wire-types.ts`, single dispatch in `wire-adapters.ts`, fixture-driven tests in `__test__/`.

### Layer 1 — base wire-value types

The v3-locked discriminated unions:

```typescript
export type DecimalString = string  // canonical, no exponent, validated by wire-canonical-decimal

export type WireDecimal =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }

export type WireDouble =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }  // string-encoded to avoid IEEE-754 drift

export type WireInteger =
  | { kind: 'unset' }
  | { kind: 'value'; value: number }
```

### Layer 2 — per-class schemas

Each schema is an `as const` object mapping field names to wire-type literals (`'WireDecimal' | 'WireDouble' | 'WireInteger'`). Mirrors the inventory's Wire-type column 1:1.

```typescript
export const ORDER_SCHEMA = {
  totalQuantity: 'WireDecimal',
  lmtPrice:      'WireDecimal',
  auxPrice:      'WireDecimal',
  orderId:       'WireInteger',
  // ... 64 entries total ...
} as const

export const CONTRACT_SCHEMA = { ... } as const  // 14 entries
export const EXECUTION_SCHEMA = { ... } as const // 10 entries
export const ORDER_STATE_SCHEMA = { ... } as const // 13 entries
```

Total: ~101 schema entries hand-transcribed from `parity/decimal-inventory.md`.

Non-numeric fields (string, boolean, enum, nested object) are NOT in the schema — adapters pass them through verbatim.

### Layer 3 — mapped types

Derived `WireOrder` / `WireContract` / `WireExecution` / `WireOrderState` types via TypeScript mapped types:

```typescript
type WireMap = {
  WireDecimal: WireDecimal
  WireDouble: WireDouble
  WireInteger: WireInteger
}

type MakeWire<Schema extends Record<string, keyof WireMap>, Source> = {
  [K in keyof Source]: K extends keyof Schema
    ? WireMap[Schema[K]]
    : Source[K]
}

export type WireOrder = MakeWire<typeof ORDER_SCHEMA, Order>
export type WireContract = MakeWire<typeof CONTRACT_SCHEMA, Contract>
export type WireExecution = MakeWire<typeof EXECUTION_SCHEMA, Execution>
export type WireOrderState = MakeWire<typeof ORDER_STATE_SCHEMA, OrderState>
```

Drift between schema and field set becomes a TypeScript error at the import site. No hand-maintained interface duplicates the schema.

### `wire-adapters.ts`

Two generic dispatch functions + sentinel-detection helpers + four named entry points:

```typescript
function toWire<S extends Schema, T extends object>(source: T, schema: S): MakeWire<S, T> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const v = (source as Record<string, unknown>)[key]
    if (key in schema) {
      const wireType = schema[key as keyof S]
      out[key] = wrapValue(v, wireType)
    } else {
      out[key] = v  // passthrough
    }
  }
  return out as MakeWire<S, T>
}

function fromWire<S extends Schema, T extends object>(wire: MakeWire<S, T>, schema: S, ctor: new () => T): T {
  const out = new ctor()
  for (const key of Object.keys(wire)) {
    const v = (wire as Record<string, unknown>)[key]
    if (key in schema) {
      const wireType = schema[key as keyof S]
      ;(out as Record<string, unknown>)[key] = unwrapValue(v, wireType)
    } else {
      ;(out as Record<string, unknown>)[key] = v  // passthrough
    }
  }
  return out
}

// Per-wireType wrappers + unwrappers (file-private):

function wrapValue(v: unknown, wireType: keyof WireMap): WireDecimal | WireDouble | WireInteger {
  if (wireType === 'WireDecimal') {
    if (v instanceof Decimal && isUnsetDecimal(v)) return { kind: 'unset' }
    if (v instanceof Decimal) return { kind: 'value', value: toCanonicalDecimalString(v) }
    throw new Error(`WireDecimal expected Decimal instance, got ${typeof v}`)
  }
  if (wireType === 'WireDouble') {
    if (typeof v === 'number' && isUnsetDouble(v)) return { kind: 'unset' }
    if (typeof v === 'number') return { kind: 'value', value: toCanonicalDecimalString(new Decimal(v)) }
    throw new Error(`WireDouble expected number, got ${typeof v}`)
  }
  if (wireType === 'WireInteger') {
    if (typeof v === 'number' && isUnsetInteger(v)) return { kind: 'unset' }
    if (typeof v === 'number') return { kind: 'value', value: v }
    throw new Error(`WireInteger expected number, got ${typeof v}`)
  }
  throw new Error(`Unknown wire type: ${wireType}`)
}

function unwrapValue(v: unknown, wireType: keyof WireMap): Decimal | number {
  // Inverse of wrapValue.
  // 'unset' → reconstruct the appropriate UNSET_* constant.
  // 'value' → parse DecimalString back to Decimal (for WireDecimal/WireDouble) or pass number through.
}

// Sentinel helpers (file-private):
const isUnsetDecimal = (d: Decimal): boolean => d.equals(UNSET_DECIMAL)
const isUnsetDouble = (n: number): boolean => n === UNSET_DOUBLE         // Number.MAX_VALUE
const isUnsetInteger = (n: number): boolean => n === UNSET_INTEGER       // 2^31 - 1

// Named entry points:
export const ibkrOrderToWire = (o: Order): WireOrder => toWire(o, ORDER_SCHEMA)
export const ibkrContractToWire = (c: Contract): WireContract => toWire(c, CONTRACT_SCHEMA)
export const ibkrExecutionToWire = (e: Execution): WireExecution => toWire(e, EXECUTION_SCHEMA)
export const ibkrOrderStateToWire = (s: OrderState): WireOrderState => toWire(s, ORDER_STATE_SCHEMA)

export const wireToIbkrOrder = (w: WireOrder): Order => fromWire(w, ORDER_SCHEMA, Order)
export const wireToIbkrContract = (w: WireContract): Contract => fromWire(w, CONTRACT_SCHEMA, Contract)
export const wireToIbkrExecution = (w: WireExecution): Execution => fromWire(w, EXECUTION_SCHEMA, Execution)
export const wireToIbkrOrderState = (w: WireOrderState): OrderState => fromWire(w, ORDER_STATE_SCHEMA, OrderState)
```

### `wire-canonical-decimal.ts`

~25-line file, byte-identical to `parity/generators/_canonical-decimal.ts` except for placement under `src/`. Phase 1c will delete both this file and the Phase 0 private helper, replacing them with re-exports from a single canonical public module.

Rules (mirror v4 §6.1):
- No exponent / scientific notation
- No leading `+`
- No trailing decimal point
- Canonical zero = `"0"`
- Negative sign only on nonzero values
- Reject `NaN` / `Infinity` / `-0`
- Trailing zeros after decimal point stripped

## Schema construction

Each schema entry is one of `'WireDecimal' | 'WireDouble' | 'WireInteger'`. Determined per-field from the inventory's Wire-type column.

Per-class field counts (from `parity/decimal-inventory.md` Summary table):

| Class | Total numeric | Schema entries | Passthrough (non-numeric) |
|---|---|---|---|
| `Order` | 64 | 64 | ~25 |
| `Contract` | 14 | 14 | ~15 |
| `Execution` | 10 | 10 | ~10 |
| `OrderState` | 13 | 13 | ~10 |
| **Total** | **101** | **101** | **~60** |

Construction is hand-transcribed. Two safety nets caught by the schema-consistency tests in Sub-task C:

1. **Every numeric field on the class has a schema entry.** Catches "forgot to add a field" bugs.
2. **Every schema key maps to a real field on the class.** Catches typo'd field names.

### Treatment of value-only vs value-or-unset

The inventory distinguishes:
- `value-only` — field always holds a real value; sentinel never observed
- `value-or-unset` — field may hold the sentinel

Both use the same `Wire*` type with the `kind` discriminant. The schema doesn't distinguish — wire format is uniform; the semantic distinction is documented in the inventory.

A wire validator (Phase 3) could enforce "value-only fields must have `kind: 'value'`" but that's not Phase 1b's scope.

## Round-trip test harness

### `wire-roundtrip.spec.ts`

Loads three fixture corpora:

1. **`parity/fixtures/orders-on-wire/order/*.json`** (340 files) — order snapshots from Phase 0 Task H.
2. **`parity/fixtures/orders-on-wire/contract/*.json`** (1 file) — contract snapshot from Phase 0 Task H.
3. **`parity/fixtures/sentinels/{order,contract,execution,orderstate}-fields/case-*.json`** (86 files) — sentinel cases from Phase 0 Task D.

Path resolution helper:
```typescript
const FIXTURES = resolve(import.meta.dirname, '../../../../parity/fixtures')
```

Per orders-on-wire fixture (341 total):

1. **Rehydrate** to a class instance via a helper like:
   ```typescript
   function rehydrateOrderFromSnapshot(json: Record<string, unknown>): Order {
     const order = new Order()
     Object.assign(order, json)
     // For each Decimal field in ORDER_SCHEMA, rewrap the string back into Decimal:
     for (const key of Object.keys(ORDER_SCHEMA)) {
       const wireType = ORDER_SCHEMA[key as keyof typeof ORDER_SCHEMA]
       if (wireType === 'WireDecimal') {
         const v = (json as Record<string, unknown>)[key]
         if (typeof v === 'string') {
           (order as Record<string, unknown>)[key] = new Decimal(v)
         }
       }
     }
     return order
   }
   ```
   (`decimal.js` parses scientific notation losslessly, so `new Decimal("1e+30")` round-trips through `.toFixed()` to canonical form correctly.)

2. **`orderToWire(order)` → WireOrder**

3. **`wireToOrder(wireOrder)` → reconstructed Order**

4. **Assert semantic equality:**
   - For Decimal fields: `original[key].equals(reconstructed[key])` (Decimal.equals handles scientific-vs-canonical forms identically)
   - For number fields: `original[key] === reconstructed[key]`
   - For passthrough fields: `expect(reconstructed[key]).toEqual(original[key])`

Same procedure for the 1 contract snapshot.

Per sentinel fixture (86 total): each fixture's JSON specifies a `type` (Order/Contract/Execution/OrderState), `field`, and expected sentinel value. The test:

1. For per-field unset cases: construct a fresh instance of that type (which defaults the field to its sentinel via the IBKR class definitions). Run `xToWire(instance)`. Assert `wire[field]` deep-equals `{ kind: 'unset' }`.
2. For all-unset cases (5 per type): construct a fresh instance. Run `xToWire(instance)`. Assert EVERY schema field is `{ kind: 'unset' }` in the wire output.

**Expected assertion count:** 341 (orders-on-wire) + 86 (sentinels) = 427 fixture-driven, plus ~8 schema-consistency tests from Sub-task C.

### `unset-long-precision.spec.ts`

Per v4 §6.1 caveat: `UNSET_LONG = BigInt(2 ** 63) - 1n` is lossy because `2 ** 63` exceeds `Number.MAX_SAFE_INTEGER` and rounds before the `BigInt(...)` wrap.

```typescript
import { describe, it, expect } from 'vitest'
import Decimal from 'decimal.js'
import { UNSET_LONG } from '@traderalice/ibkr-types'

describe('UNSET_LONG vs canonical i64::MAX', () => {
  it('UNSET_LONG (lossy TS) differs from canonical i64::MAX', () => {
    const i64Max = BigInt('9223372036854775807')  // canonical 2^63 - 1
    expect(UNSET_LONG).not.toBe(i64Max)
    // Documents the lossy bug: BigInt(2 ** 63) = BigInt(9.223372036854776e18 rounded)
    // ≠ canonical 9223372036854775807. Any future Rust i64 field MUST reconstruct
    // i64::MAX from a canonical string, not from this TS constant.
  })

  it('canonical i64::MAX string round-trips exactly through Decimal', () => {
    const canonical = '9223372036854775807'
    const d = new Decimal(canonical)
    expect(d.toFixed()).toBe(canonical)
  })
})
```

This is the "fixture" v4 amend asked for, expressed as a TS test rather than a JSON file — no current IBKR field uses `UNSET_LONG`, so a JSON fixture would point at nothing.

## Sequencing within Phase 1b

Single PR, 6 sub-task commits:

| Sub-task | What lands | After this commit |
|---|---|---|
| A — base wire types | `wire-types.ts` layer 1 only (`DecimalString`, `WireDecimal`, `WireDouble`, `WireInteger`). | Types defined; nothing imports them yet. |
| B — schemas + mapped types | `wire-types.ts` layers 2-3. Hand-transcribed 101 schema entries. `WireMap`, `MakeWire<>`, four derived types. | Types compile; ready for adapters. |
| C — adapters + consistency tests | `wire-adapters.ts` with generic dispatch + sentinel helpers + four named entry points. `wire-canonical-decimal.ts` inline helper. Schema-consistency tests (4 forward + 4 inverse = 8 tests) co-located with the adapters. | Adapters work; schemas verified against the classes. |
| D — round-trip test | `wire-roundtrip.spec.ts` — 427 fixture-driven assertions. | All fixtures round-trip green. |
| E — UNSET_LONG precision | `unset-long-precision.spec.ts` — 2 assertions. | Documents the lossy constant + canonical round-trip. |
| F — DoD verification | No new code. Runs all DoD commands. | Phase 1b done. |

Sub-tasks A→B→C are strictly sequential. D depends on C. E is independent and can run in parallel (different file, no shared state). F depends on all.

## Definition of Done

- [ ] All 4 new files exist at expected paths
- [ ] `npx tsc --noEmit` clean (no NEW errors)
- [ ] `pnpm test` from repo root — `1299 + N` tests passing (N ≈ 436 new = ~1735 total). Exact count depends on how vitest reports `it.each` and parametrized assertions.
- [ ] Round-trip test passes for all 341 orders-on-wire fixtures + 86 sentinel fixtures = 427 fixture-driven assertions
- [ ] Schema-consistency tests pass: 4 "every numeric field on class has schema entry" + 4 "every schema entry maps to real field" = 8 tests
- [ ] UNSET_LONG precision test passes (2 assertions)
- [ ] `pnpm dev` boots and `/api/status` returns expected JSON
- [ ] Zero edits to `packages/` (no IBKR-package changes; this phase is `src/`-only)
- [ ] Zero edits to `pnpm-workspace.yaml`, `turbo.json`, root `package.json`
- [ ] Zero edits to `parity/decimal-inventory.md` (the inventory is the source; we don't write back to it)
- [ ] `TradingGit` and the live route are untouched (per v4 Phase 1b Deliverable 4 — wire types are added but unused on the live path until Phase 2)
- [ ] `git diff <base>..HEAD -- src/` shows only the 4 new files (no edits to existing `src/` code)

## Out of scope

Locked explicitly:

- Wire validator (Phase 3 will add it when there's a Rust-produced consumer)
- Wire types for internal-TS types (`Position`, `OpenOrder`, `GitState`, `OperationResult`) — already string-encoded
- `TradingGit` integration (Phase 2 picks up canonical-JSON-of-wire for hash inputs)
- Canonical JSON output (the Wire objects are TS objects, not JSON-serialized; serialization is Phase 1c's concern)
- Migrating existing tests of `Order`/`Contract` to use wire types — those tests still exercise the IBKR classes directly

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Schema misses a numeric field on `Order` | Medium | Medium | Schema-consistency tests (Sub-task C) catch at test time. Failure mode: test lists the missing field; add schema entry with correct Wire-type literal. |
| Schema lists a typo'd field name | Low | Low | Inverse consistency test catches typos at test time. |
| Snapshot rehydration loses Decimal precision | Low | Medium | `decimal.js` parses both scientific (`"1e+30"`) and decimal (`"1000…"`) notation losslessly. Round-trip test verifies via `Decimal.equals`. |
| Mapped-type `MakeWire<>` produces confusing tsc error messages when a consumer mis-shapes the wire | Medium | Low | Accept — tradeoff of mapped-type approach. If consumer experience matters in Phase 3, add a named `WireOrder` re-declaration that mirrors the mapped type. |
| `import.meta.dirname` path resolution fails in some vitest configurations | Low | Medium | Vitest 3.x supports it; fall back to `path.dirname(fileURLToPath(import.meta.url))` if needed. |
| Phase 1b code is dead until Phase 2 — easily forgotten / no consumer to verify it works | Medium | Low | Header comment in `wire-types.ts` documents: "Phase 1b dead code; Phase 2 wires into TradingGit hash inputs." Round-trip + sentinel tests exercise it; no live-path consumer needed. |
| Inline `wire-canonical-decimal.ts` drifts from Phase 0's private copy | Low | Low | Same source, same rules. Phase 1c lifts both into a single canonical module; until then the duplicate is intentional. |

## Acceptance signal

Phase 1b is "done" when:

- All DoD bullets pass
- The PR's diff is purely additive under `src/domain/trading/` (no edits to existing `src/` code, no edits to `packages/`, no edits to root config)
- A reviewer can read `wire-types.ts` (schemas + mapped types), then `wire-adapters.ts` (dispatch), then a single fixture-driven test, and understand the round-trip contract
- The 8 schema-consistency tests demonstrate the schemas are kept in sync with the four IBKR DTO classes
