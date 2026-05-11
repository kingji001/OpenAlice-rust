# Phase 1b — Wire Types + Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the wire-types layer (`WireDecimal` / `WireDouble` / `WireInteger`) plus schema-driven adapters that round-trip IBKR `Order` / `Contract` / `Execution` / `OrderState` instances through canonical wire form. Dead code on the live path — `TradingGit` keeps legacy hashing until Phase 2.

**Architecture:** Three-layer `wire-types.ts` (base discriminated unions → per-class `as const` schemas mirroring `parity/decimal-inventory.md` → `MakeWire<>` mapped types deriving `WireOrder`/`WireContract`/etc.). Single-dispatch `toWire`/`fromWire` in `wire-adapters.ts`. Fixture-driven round-trip tests over the 427 Phase 0 fixtures (340 order snapshots + 1 contract snapshot + 86 sentinel cases). One inline canonical-decimal helper (Phase 1c will lift it).

**Tech Stack:** TypeScript, `decimal.js`, `vitest`, no new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-1b-wire-types-design.md`](../specs/2026-05-12-phase-1b-wire-types-design.md) (commit `0778f83`).

**Pre-flight checks before starting:**

- [ ] Working tree clean: `git status --short` empty.
- [ ] On master at expected commit: `git log --oneline -1` shows `0778f83` or later.
- [ ] Baseline test count: `pnpm test 2>&1 | grep -E "^\s+Tests" | tail -1` — record for later comparison (~1299 passing).
- [ ] Phase 0 fixture corpus present: `find parity/fixtures/orders-on-wire parity/fixtures/sentinels -name '*.json' | wc -l` returns 427 (341 + 86).
- [ ] `parity/decimal-inventory.md` present: `wc -l parity/decimal-inventory.md` returns ~260.

---

## Task A: Base wire types

Lay down the base discriminated unions. No schemas, no adapters yet.

**Files:**
- Create: `src/domain/trading/wire-types.ts`

- [ ] **Step 1: Create `src/domain/trading/wire-types.ts`**

```typescript
/**
 * Wire-format types for IBKR DTO classes — Phase 1b.
 *
 * Wire types are the FFI-crossing form: canonical, sentinel-aware,
 * IEEE-754-safe. Phase 1b ships these types + adapters as dead code.
 * Phase 2 wires them into TradingGit's hash inputs.
 *
 * See docs/superpowers/specs/2026-05-12-phase-1b-wire-types-design.md
 * for the design rationale.
 */

/** Canonical decimal-string form: no exponent, no leading +, no trailing
 *  decimal point, "0" for zero (never "-0"). Validated by wire-canonical-decimal.ts. */
export type DecimalString = string

/** Decimal field on the wire. Sentinels (UNSET_DECIMAL = 2^127-1) become
 *  { kind: 'unset' }; real values become { kind: 'value', value: <DecimalString> }. */
export type WireDecimal =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }

/** Floating-point field on the wire. Sentinels (UNSET_DOUBLE = Number.MAX_VALUE)
 *  become { kind: 'unset' }. Real values are string-encoded as DecimalString to
 *  avoid IEEE-754 drift across the FFI. */
export type WireDouble =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }

/** Integer field on the wire. Sentinels (UNSET_INTEGER = 2^31-1) become
 *  { kind: 'unset' }; real values are unboxed numbers (safe-integer range). */
export type WireInteger =
  | { kind: 'unset' }
  | { kind: 'value'; value: number }
```

- [ ] **Step 2: Verify the file compiles**

```bash
npx tsc --noEmit
```
Expected: no NEW errors (pre-existing errors from elsewhere in the repo are not your concern).

- [ ] **Step 3: Commit**

```bash
git add src/domain/trading/wire-types.ts
git commit -m "feat(wire): base discriminated-union wire types (Task A)

DecimalString, WireDecimal, WireDouble, WireInteger discriminated
unions. No schemas or adapters yet — those follow in Tasks B+C.

v3-locked shape: { kind: 'unset' } | { kind: 'value'; value: ... }.
WireDouble values are string-encoded to avoid IEEE-754 drift across
the FFI in Phase 3.

Spec: docs/superpowers/specs/2026-05-12-phase-1b-wire-types-design.md"
```

---

## Task B: Schemas + mapped types

Append to `wire-types.ts` the 4 per-class schemas (`ORDER_SCHEMA`, `CONTRACT_SCHEMA`, `EXECUTION_SCHEMA`, `ORDER_STATE_SCHEMA`) hand-transcribed from `parity/decimal-inventory.md`, plus the `MakeWire<>` mapped type and the four derived `Wire*` types.

**Files:**
- Modify: `src/domain/trading/wire-types.ts` (append)

### Transcription procedure

For each `## <TypeName>` section in `parity/decimal-inventory.md`:

1. Find the section header in the inventory.
2. For each table row matching the pattern `` | `<field>` | `<TS type>` | <semantic> | `<WireType>` | <notes> |``:
   - Extract `<field>` (column 1, strip backticks)
   - Extract `<WireType>` (column 4, strip backticks) — one of `WireDecimal`, `WireDouble`, `WireInteger`
   - Add a schema entry: `<field>: '<WireType>',`
3. Skip rows where `<WireType>` is anything other than `WireDecimal`/`WireDouble`/`WireInteger` (e.g., `string` for the internal types — those are out of scope per spec).

**Worked example — Order's first 5 rows in the inventory:**

```
| `orderId` | `number` | value-only | `WireInteger` | Always set; 0 before server assigns |
| `clientId` | `number` | value-only | `WireInteger` | Always set |
| `permId` | `number` | value-only | `WireInteger` | 0 until TWS assigns permanent id |
| `totalQuantity` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; unset before qty is known |
| `lmtPrice` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; MKT orders leave this unset |
```

Transcribes to:

```typescript
orderId: 'WireInteger',
clientId: 'WireInteger',
permId: 'WireInteger',
totalQuantity: 'WireDecimal',
lmtPrice: 'WireDecimal',
```

Apply the same procedure to every row in every section (Order: 64 rows, Contract: 14, Execution: 10, OrderState: 13).

The schema-consistency tests in Task C catch any missed fields and any typo'd field names — failure mode is a clear test error listing the missing/extra field. Iterate until green.

- [ ] **Step 1: Read the inventory's Order section in full**

```bash
sed -n '/^## Order$/,/^## Contract/p' parity/decimal-inventory.md | head -80
```

Capture every row's field name + Wire type. Expected: 64 rows.

- [ ] **Step 2: Append `ORDER_SCHEMA` to `wire-types.ts`**

Append (after the existing content):

```typescript
import type { Order, Contract, Execution, OrderState } from '@traderalice/ibkr-types'

/**
 * Per-class schemas — hand-transcribed from parity/decimal-inventory.md.
 *
 * Each entry maps a numeric field name to its wire-type literal. Non-numeric
 * fields (strings, booleans, enums, nested objects) are NOT in the schema —
 * adapters pass them through verbatim.
 *
 * Schema-consistency tests in wire-adapters.spec.ts catch missed or typo'd
 * fields. If you add a numeric field to an IBKR class, add it here.
 */

export const ORDER_SCHEMA = {
  // <transcribed 64 entries from inventory's Order section, in source order>
  orderId: 'WireInteger',
  clientId: 'WireInteger',
  permId: 'WireInteger',
  totalQuantity: 'WireDecimal',
  lmtPrice: 'WireDecimal',
  // ... continue for all 64 rows ...
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>
```

Apply the transcription procedure to fill in all 64 entries. Use the inventory file as the source of truth; the row order should match.

⚠️ The `as const satisfies …` syntax pins the schema's literal types AND verifies each value is a valid wire-type literal at the schema definition site. If you typo `'wireinteger'` (lowercase), TypeScript catches it here.

- [ ] **Step 3: Append `CONTRACT_SCHEMA`** (14 entries)

```bash
sed -n '/^## Contract$/,/^## Execution/p' parity/decimal-inventory.md | head -30
```

Transcribe + append:

```typescript
export const CONTRACT_SCHEMA = {
  // <14 entries from inventory's Contract section>
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>
```

- [ ] **Step 4: Append `EXECUTION_SCHEMA`** (10 entries)

```bash
sed -n '/^## Execution$/,/^## OrderState/p' parity/decimal-inventory.md | head -25
```

Transcribe + append:

```typescript
export const EXECUTION_SCHEMA = {
  // <10 entries from inventory's Execution section>
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>
```

- [ ] **Step 5: Append `ORDER_STATE_SCHEMA`** (13 entries)

```bash
sed -n '/^## OrderState$/,/^## Position/p' parity/decimal-inventory.md | head -30
```

Transcribe + append:

```typescript
export const ORDER_STATE_SCHEMA = {
  // <13 entries from inventory's OrderState section>
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>
```

- [ ] **Step 6: Append the `MakeWire<>` mapped type + derived types**

```typescript
/**
 * Map from wire-type literal to the corresponding wire-value type.
 */
type WireMap = {
  WireDecimal: WireDecimal
  WireDouble: WireDouble
  WireInteger: WireInteger
}

/**
 * Derive a wire-form type from a source class + a schema.
 *
 * For each key K on Source:
 *   - if K is in Schema, substitute the wire-value type per WireMap
 *   - else pass through Source[K] verbatim
 */
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

- [ ] **Step 7: Verify the file compiles**

```bash
npx tsc --noEmit
```
Expected: clean. Common errors:
- "Property 'X' does not exist on type ..." — schema entry typo'd; field doesn't exist on the IBKR class. Check the inventory's field name vs. the class definition.
- "Type 'X' is not assignable to '\"WireDecimal\" | \"WireDouble\" | \"WireInteger\"'" — schema entry has a typo in the wire-type literal. Fix the case (must be exactly `WireDecimal` / `WireDouble` / `WireInteger`).

- [ ] **Step 8: Commit**

```bash
git add src/domain/trading/wire-types.ts
git commit -m "feat(wire): per-class schemas + mapped types (Task B)

- 101 schema entries hand-transcribed from parity/decimal-inventory.md
  (Order: 64, Contract: 14, Execution: 10, OrderState: 13).
- Each schema is 'as const satisfies Record<string, WireType>' — pins
  literal types AND catches wire-type-literal typos at definition site.
- MakeWire<> mapped type derives WireOrder/Contract/Execution/OrderState
  from the schemas. No hand-maintained interfaces parallel the schemas.

Drift between schema and class fields becomes a tsc error at consumer
import time, plus schema-consistency tests in Task C catch missing/typo'd
field names at test time."
```

---

## Task C: Adapters + sentinel helpers + canonical decimal + consistency tests

The heart of Phase 1b. Three files land in this task:

**Files:**
- Create: `src/domain/trading/wire-canonical-decimal.ts` (~25 lines, inline helper)
- Create: `src/domain/trading/wire-adapters.ts` (generic dispatch + 8 named entry points)
- Create: `src/domain/trading/__test__/wire-adapters.spec.ts` (schema-consistency tests)

- [ ] **Step 1: Create `src/domain/trading/wire-canonical-decimal.ts`**

This is byte-identical content to `parity/generators/_canonical-decimal.ts` from Phase 0, just placed under `src/`. Phase 1c will replace both with re-exports from a single public module.

```typescript
/**
 * Canonical decimal-string formatter — PHASE 1B INLINE HELPER.
 *
 * Phase 1c will replace this file with a re-export from
 * `src/domain/trading/canonical-decimal.ts`. Mirror of the Phase 0
 * private helper at `parity/generators/_canonical-decimal.ts`.
 *
 * Rules (v4 §6.1):
 *   - No exponent / scientific notation.
 *   - No leading '+'.
 *   - No trailing decimal point.
 *   - Canonical zero = "0" (not "0.0", not "-0").
 *   - Negative sign only on nonzero values.
 *   - Reject NaN / Infinity / -0 with a thrown error.
 *   - Trailing zeros after decimal point are stripped.
 */

import Decimal from 'decimal.js'

export class CanonicalDecimalError extends Error {}

export function toCanonicalDecimalString(d: Decimal): string {
  if (d.isNaN()) throw new CanonicalDecimalError('NaN is not representable')
  if (!d.isFinite()) throw new CanonicalDecimalError('Infinity is not representable')

  let s = d.toFixed()

  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }

  if (s === '-0' || s === '0') return '0'

  return s
}
```

- [ ] **Step 2: Create `src/domain/trading/wire-adapters.ts`**

```typescript
/**
 * Wire adapters for IBKR DTO classes — Phase 1b.
 *
 * Schema-driven, single-dispatch round-trip:
 *   Order → WireOrder via ibkrOrderToWire(order)
 *   WireOrder → Order via wireToIbkrOrder(wire)
 * (Same pattern for Contract / Execution / OrderState.)
 *
 * Wire-format rules:
 *   - Schema-listed numeric fields → wrapped in { kind: 'unset' | 'value' }
 *   - All other fields → passthrough (string, boolean, enum, nested object)
 *
 * Sentinel detection:
 *   - Decimal field equals UNSET_DECIMAL → emit { kind: 'unset' }
 *   - number === UNSET_DOUBLE (Number.MAX_VALUE) → emit { kind: 'unset' }
 *   - number === UNSET_INTEGER (2^31 - 1) → emit { kind: 'unset' }
 */

import Decimal from 'decimal.js'
import {
  Contract,
  Execution,
  Order,
  OrderState,
  UNSET_DECIMAL,
  UNSET_DOUBLE,
  UNSET_INTEGER,
} from '@traderalice/ibkr-types'
import { toCanonicalDecimalString } from './wire-canonical-decimal.js'
import {
  CONTRACT_SCHEMA,
  EXECUTION_SCHEMA,
  ORDER_SCHEMA,
  ORDER_STATE_SCHEMA,
  type WireContract,
  type WireDecimal,
  type WireDouble,
  type WireExecution,
  type WireInteger,
  type WireOrder,
  type WireOrderState,
} from './wire-types.js'

// ---- Sentinel detection ----

const isUnsetDecimal = (d: Decimal): boolean => d.equals(UNSET_DECIMAL)
const isUnsetDouble = (n: number): boolean => n === UNSET_DOUBLE
const isUnsetInteger = (n: number): boolean => n === UNSET_INTEGER

// ---- Wrap / unwrap ----

type WireTypeLiteral = 'WireDecimal' | 'WireDouble' | 'WireInteger'

function wrapValue(v: unknown, wireType: WireTypeLiteral): WireDecimal | WireDouble | WireInteger {
  if (wireType === 'WireDecimal') {
    if (!(v instanceof Decimal)) {
      throw new Error(`WireDecimal expected Decimal instance, got ${typeof v}`)
    }
    if (isUnsetDecimal(v)) return { kind: 'unset' }
    return { kind: 'value', value: toCanonicalDecimalString(v) }
  }
  if (wireType === 'WireDouble') {
    if (typeof v !== 'number') {
      throw new Error(`WireDouble expected number, got ${typeof v}`)
    }
    if (isUnsetDouble(v)) return { kind: 'unset' }
    return { kind: 'value', value: toCanonicalDecimalString(new Decimal(v)) }
  }
  if (wireType === 'WireInteger') {
    if (typeof v !== 'number') {
      throw new Error(`WireInteger expected number, got ${typeof v}`)
    }
    if (isUnsetInteger(v)) return { kind: 'unset' }
    return { kind: 'value', value: v }
  }
  throw new Error(`Unknown wire type: ${wireType as string}`)
}

function unwrapValue(
  v: WireDecimal | WireDouble | WireInteger,
  wireType: WireTypeLiteral,
): Decimal | number {
  if (v.kind === 'unset') {
    if (wireType === 'WireDecimal') return UNSET_DECIMAL
    if (wireType === 'WireDouble') return UNSET_DOUBLE
    if (wireType === 'WireInteger') return UNSET_INTEGER
    throw new Error(`Unknown wire type: ${wireType as string}`)
  }
  if (wireType === 'WireDecimal') {
    return new Decimal(v.value as string)
  }
  if (wireType === 'WireDouble') {
    return new Decimal(v.value as string).toNumber()
  }
  if (wireType === 'WireInteger') {
    return v.value as number
  }
  throw new Error(`Unknown wire type: ${wireType as string}`)
}

// ---- Generic dispatch ----

type Schema = Record<string, WireTypeLiteral>

function toWire<T extends object>(source: T, schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const v = (source as Record<string, unknown>)[key]
    if (key in schema) {
      out[key] = wrapValue(v, schema[key]!)
    } else {
      out[key] = v
    }
  }
  return out
}

function fromWire<T extends object>(
  wire: Record<string, unknown>,
  schema: Schema,
  ctor: new () => T,
): T {
  const out = new ctor()
  for (const key of Object.keys(wire)) {
    const v = wire[key]
    if (key in schema) {
      ;(out as Record<string, unknown>)[key] = unwrapValue(
        v as WireDecimal | WireDouble | WireInteger,
        schema[key]!,
      )
    } else {
      ;(out as Record<string, unknown>)[key] = v
    }
  }
  return out
}

// ---- Public entry points ----

export const ibkrOrderToWire = (o: Order): WireOrder =>
  toWire(o, ORDER_SCHEMA) as unknown as WireOrder
export const ibkrContractToWire = (c: Contract): WireContract =>
  toWire(c, CONTRACT_SCHEMA) as unknown as WireContract
export const ibkrExecutionToWire = (e: Execution): WireExecution =>
  toWire(e, EXECUTION_SCHEMA) as unknown as WireExecution
export const ibkrOrderStateToWire = (s: OrderState): WireOrderState =>
  toWire(s, ORDER_STATE_SCHEMA) as unknown as WireOrderState

export const wireToIbkrOrder = (w: WireOrder): Order =>
  fromWire(w as unknown as Record<string, unknown>, ORDER_SCHEMA, Order)
export const wireToIbkrContract = (w: WireContract): Contract =>
  fromWire(w as unknown as Record<string, unknown>, CONTRACT_SCHEMA, Contract)
export const wireToIbkrExecution = (w: WireExecution): Execution =>
  fromWire(w as unknown as Record<string, unknown>, EXECUTION_SCHEMA, Execution)
export const wireToIbkrOrderState = (w: WireOrderState): OrderState =>
  fromWire(w as unknown as Record<string, unknown>, ORDER_STATE_SCHEMA, OrderState)
```

- [ ] **Step 3: Create `src/domain/trading/__test__/wire-adapters.spec.ts` with schema-consistency tests**

These tests catch missed-field and typo'd-field bugs. They MUST be run before the round-trip tests in Task D — if a schema misses a field, the round-trip test will pass for fixtures that don't exercise that field but the production wire format will silently lose the field.

```typescript
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Execution, Order, OrderState } from '@traderalice/ibkr-types'
import {
  CONTRACT_SCHEMA,
  EXECUTION_SCHEMA,
  ORDER_SCHEMA,
  ORDER_STATE_SCHEMA,
} from '../wire-types.js'

/** Field is numeric if its default value is a Decimal or number (not NaN). */
function numericFieldsOf<T extends object>(instance: T): string[] {
  return Object.keys(instance).filter((k) => {
    const v = (instance as Record<string, unknown>)[k]
    return v instanceof Decimal || (typeof v === 'number' && !Number.isNaN(v))
  })
}

describe('schema consistency — every numeric field has a schema entry', () => {
  it('Order', () => {
    const fields = numericFieldsOf(new Order())
    for (const f of fields) {
      expect(f in ORDER_SCHEMA, `Order.${f} is numeric but not in ORDER_SCHEMA`).toBe(true)
    }
  })

  it('Contract', () => {
    const fields = numericFieldsOf(new Contract())
    for (const f of fields) {
      expect(f in CONTRACT_SCHEMA, `Contract.${f} is numeric but not in CONTRACT_SCHEMA`).toBe(true)
    }
  })

  it('Execution', () => {
    const fields = numericFieldsOf(new Execution())
    for (const f of fields) {
      expect(f in EXECUTION_SCHEMA, `Execution.${f} is numeric but not in EXECUTION_SCHEMA`).toBe(true)
    }
  })

  it('OrderState', () => {
    const fields = numericFieldsOf(new OrderState())
    for (const f of fields) {
      expect(f in ORDER_STATE_SCHEMA, `OrderState.${f} is numeric but not in ORDER_STATE_SCHEMA`).toBe(true)
    }
  })
})

describe('schema consistency — every schema entry maps to a real field', () => {
  it('Order', () => {
    const instance = new Order()
    for (const key of Object.keys(ORDER_SCHEMA)) {
      expect(key in instance, `ORDER_SCHEMA.${key} is not a field on Order`).toBe(true)
    }
  })

  it('Contract', () => {
    const instance = new Contract()
    for (const key of Object.keys(CONTRACT_SCHEMA)) {
      expect(key in instance, `CONTRACT_SCHEMA.${key} is not a field on Contract`).toBe(true)
    }
  })

  it('Execution', () => {
    const instance = new Execution()
    for (const key of Object.keys(EXECUTION_SCHEMA)) {
      expect(key in instance, `EXECUTION_SCHEMA.${key} is not a field on Execution`).toBe(true)
    }
  })

  it('OrderState', () => {
    const instance = new OrderState()
    for (const key of Object.keys(ORDER_STATE_SCHEMA)) {
      expect(key in instance, `ORDER_STATE_SCHEMA.${key} is not a field on OrderState`).toBe(true)
    }
  })
})
```

- [ ] **Step 4: Run the schema-consistency tests**

```bash
npx vitest run src/domain/trading/__test__/wire-adapters.spec.ts
```

Expected: 8/8 PASS.

If any FAIL:
- "X is numeric but not in SCHEMA" — the schema is missing a field. Add the entry (look up the field's TS type on the class to choose the right wire-type literal: `Decimal` → `WireDecimal`; integer `number` → `WireInteger`; floating `number` → `WireDouble`).
- "SCHEMA.X is not a field on class" — typo in the schema key. Fix the key name.

Iterate until 8/8 PASS.

- [ ] **Step 5: Verify type-checking is clean**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/domain/trading/wire-canonical-decimal.ts src/domain/trading/wire-adapters.ts src/domain/trading/__test__/wire-adapters.spec.ts
git commit -m "feat(wire): adapters + sentinel helpers + consistency tests (Task C)

- wire-canonical-decimal.ts: inline canonical formatter (~25 lines).
  Mirror of parity/generators/_canonical-decimal.ts; Phase 1c lifts
  both into a single public module.
- wire-adapters.ts: generic toWire/fromWire dispatch + sentinel
  helpers + 8 named entry points (ibkrXToWire + wireToIbkrX for
  Order/Contract/Execution/OrderState).
- wire-adapters.spec.ts: 8 schema-consistency tests (4 forward +
  4 inverse). Catches missed-field and typo'd-field bugs.

Sentinel detection:
- Decimal === UNSET_DECIMAL → { kind: 'unset' }
- number === UNSET_DOUBLE → { kind: 'unset' }
- number === UNSET_INTEGER → { kind: 'unset' }"
```

---

## Task D: Round-trip test

Walk the 427 Phase 0 fixtures and assert semantic round-trip.

**Files:**
- Create: `src/domain/trading/__test__/wire-roundtrip.spec.ts`

- [ ] **Step 1: Create `src/domain/trading/__test__/wire-roundtrip.spec.ts`**

```typescript
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Order } from '@traderalice/ibkr-types'
import {
  ibkrContractToWire,
  ibkrOrderToWire,
  wireToIbkrContract,
  wireToIbkrOrder,
} from '../wire-adapters.js'
import {
  CONTRACT_SCHEMA,
  ORDER_SCHEMA,
} from '../wire-types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, '../../../../parity/fixtures')

// ---- Helpers ----

/** Reconstruct an Order instance from a snapshot. Decimal-string fields get
 *  rewrapped as Decimal instances. */
function rehydrateOrder(json: Record<string, unknown>): Order {
  const order = new Order()
  Object.assign(order, json)
  for (const key of Object.keys(ORDER_SCHEMA)) {
    const wireType = (ORDER_SCHEMA as Record<string, string>)[key]
    if (wireType === 'WireDecimal') {
      const v = (json as Record<string, unknown>)[key]
      if (typeof v === 'string') {
        ;(order as Record<string, unknown>)[key] = new Decimal(v)
      }
    }
  }
  return order
}

function rehydrateContract(json: Record<string, unknown>): Contract {
  const c = new Contract()
  Object.assign(c, json)
  for (const key of Object.keys(CONTRACT_SCHEMA)) {
    const wireType = (CONTRACT_SCHEMA as Record<string, string>)[key]
    if (wireType === 'WireDecimal') {
      const v = (json as Record<string, unknown>)[key]
      if (typeof v === 'string') {
        ;(c as Record<string, unknown>)[key] = new Decimal(v)
      }
    }
  }
  return c
}

/** Assert two Order instances are semantically equal (Decimal.equals for
 *  Decimal fields, === for numbers, deep-equal for passthrough). */
function expectOrdersEqual(a: Order, b: Order): void {
  for (const key of Object.keys(a)) {
    const av = (a as Record<string, unknown>)[key]
    const bv = (b as Record<string, unknown>)[key]
    if (av instanceof Decimal && bv instanceof Decimal) {
      expect(av.equals(bv), `Order.${key}: ${av.toString()} !== ${bv.toString()}`).toBe(true)
    } else {
      expect(bv, `Order.${key}`).toEqual(av)
    }
  }
}

function expectContractsEqual(a: Contract, b: Contract): void {
  for (const key of Object.keys(a)) {
    const av = (a as Record<string, unknown>)[key]
    const bv = (b as Record<string, unknown>)[key]
    if (av instanceof Decimal && bv instanceof Decimal) {
      expect(av.equals(bv), `Contract.${key}: ${av.toString()} !== ${bv.toString()}`).toBe(true)
    } else {
      expect(bv, `Contract.${key}`).toEqual(av)
    }
  }
}

// ---- Orders-on-wire fixture round-trip ----

describe('orders-on-wire round-trip', () => {
  const orderDir = resolve(FIXTURES, 'orders-on-wire/order')
  const orderFiles = readdirSync(orderDir).filter((f) => f.endsWith('.json'))

  it.each(orderFiles)('order/%s round-trips', (filename) => {
    const json = JSON.parse(readFileSync(resolve(orderDir, filename), 'utf-8')) as Record<string, unknown>
    const original = rehydrateOrder(json)
    const wire = ibkrOrderToWire(original)
    const reconstructed = wireToIbkrOrder(wire)
    expectOrdersEqual(original, reconstructed)
  })

  const contractDir = resolve(FIXTURES, 'orders-on-wire/contract')
  const contractFiles = readdirSync(contractDir).filter((f) => f.endsWith('.json'))

  it.each(contractFiles)('contract/%s round-trips', (filename) => {
    const json = JSON.parse(readFileSync(resolve(contractDir, filename), 'utf-8')) as Record<string, unknown>
    const original = rehydrateContract(json)
    const wire = ibkrContractToWire(original)
    const reconstructed = wireToIbkrContract(wire)
    expectContractsEqual(original, reconstructed)
  })
})

// ---- Sentinel-detection fixtures ----

interface SentinelFixture {
  name: string
  type: 'Order' | 'Contract' | 'Execution' | 'OrderState'
  field?: string
  fieldKind?: 'decimal' | 'double' | 'integer'
  description: string
}

describe('sentinel-detection fixtures', () => {
  const types: Array<{ dir: string; ctor: () => object; toWire: (instance: any) => any }> = [
    { dir: 'order-fields',       ctor: () => new Order(),       toWire: (o) => ibkrOrderToWire(o) },
    { dir: 'contract-fields',    ctor: () => new Contract(),    toWire: (c) => ibkrContractToWire(c) },
    // Execution and OrderState don't have stable default-sentinel construction;
    // the sentinel fixtures for those types describe per-field setups. The simplest
    // and most general test: load the fixture; if it has 'field' set, construct a
    // fresh instance (which IBKR class defaults to sentinel for the field), then
    // assert toWire(instance)[field] === { kind: 'unset' }.
  ]

  // For each fixture in each *-fields subdir: construct a fresh instance of the
  // matching type, run xToWire, and assert the named field (or every schema
  // field for "all-unset" fixtures) is { kind: 'unset' }.

  for (const { dir, ctor, toWire } of types) {
    const fixtureDir = resolve(FIXTURES, 'sentinels', dir)
    const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'))

    it.each(files)(`${dir}/%s — sentinel detected`, (filename) => {
      const fixture = JSON.parse(readFileSync(resolve(fixtureDir, filename), 'utf-8')) as SentinelFixture
      const instance = ctor()
      const wire = toWire(instance) as Record<string, unknown>

      if (fixture.field) {
        // Per-field unset case: assert THAT field is { kind: 'unset' }.
        expect(wire[fixture.field]).toEqual({ kind: 'unset' })
      } else {
        // all-unset case: assert EVERY schema field is { kind: 'unset' }.
        // Don't need to know which schema applies — the test fixture's
        // type field tells us, but we can also just check every field
        // present in the wire that has the discriminant shape.
        for (const key of Object.keys(wire)) {
          const v = wire[key]
          if (v && typeof v === 'object' && 'kind' in v) {
            // It's a wire-typed field; assert kind is 'unset'.
            expect((v as { kind: string }).kind).toBe('unset')
          }
        }
      }
    })
  }

  // Execution-fields and orderstate-fields — same procedure, separate block to
  // keep imports tidy.
  describe('execution-fields + orderstate-fields', () => {
    // Note: Phase 1b's spec covers all 4 types. For brevity here we trust
    // the schema-consistency tests + the order/contract round-trip; if
    // Execution or OrderState sentinel handling were broken, the schema
    // consistency tests would catch the structural piece. Optional: add
    // a per-fixture sentinel check here for full coverage. Adding it
    // matches the spec's claim of 86 sentinel fixtures all-asserted.
    const execDir = resolve(FIXTURES, 'sentinels/execution-fields')
    const execFiles = readdirSync(execDir).filter((f) => f.endsWith('.json'))
    it.each(execFiles)('execution-fields/%s — sentinel detected', (filename) => {
      const fixture = JSON.parse(readFileSync(resolve(execDir, filename), 'utf-8')) as SentinelFixture
      const instance = new (require('@traderalice/ibkr-types').Execution)()
      const wire = ibkrExecutionToWireDispatch(instance, fixture)
      assertWireSentinel(wire, fixture)
    })

    const osDir = resolve(FIXTURES, 'sentinels/orderstate-fields')
    const osFiles = readdirSync(osDir).filter((f) => f.endsWith('.json'))
    it.each(osFiles)('orderstate-fields/%s — sentinel detected', (filename) => {
      const fixture = JSON.parse(readFileSync(resolve(osDir, filename), 'utf-8')) as SentinelFixture
      const instance = new (require('@traderalice/ibkr-types').OrderState)()
      const wire = ibkrOrderStateToWireDispatch(instance, fixture)
      assertWireSentinel(wire, fixture)
    })
  })
})

// Local helpers used above (would normally be inline but extracted for clarity).
import { ibkrExecutionToWire, ibkrOrderStateToWire } from '../wire-adapters.js'

function ibkrExecutionToWireDispatch(instance: any, _fixture: SentinelFixture) {
  return ibkrExecutionToWire(instance)
}

function ibkrOrderStateToWireDispatch(instance: any, _fixture: SentinelFixture) {
  return ibkrOrderStateToWire(instance)
}

function assertWireSentinel(wire: any, fixture: SentinelFixture): void {
  if (fixture.field) {
    expect(wire[fixture.field]).toEqual({ kind: 'unset' })
  } else {
    for (const key of Object.keys(wire)) {
      const v = wire[key]
      if (v && typeof v === 'object' && 'kind' in v) {
        expect((v as { kind: string }).kind).toBe('unset')
      }
    }
  }
}
```

⚠️ The above includes `require()` calls inside the `describe('execution-fields + orderstate-fields')` block — ESM-incompatible. Replace those with the existing top-level imports. The cleaner shape is to import `Execution`, `OrderState` at top and use them directly. Adjust during implementation:

```typescript
// At top of file, alongside other imports:
import { Execution, OrderState } from '@traderalice/ibkr-types'

// In the test body, replace require() calls with:
const instance = new Execution()
// ...
const instance = new OrderState()
```

- [ ] **Step 2: Run the round-trip test**

```bash
npx vitest run src/domain/trading/__test__/wire-roundtrip.spec.ts
```

Expected: 427 tests PASS (341 round-trip + 86 sentinel). Note: `it.each` produces one test per file, so the count is per-fixture not per-assertion.

If any FAIL:
- "Order.X: 1e+30 !== 1000000000000000000000000000000" — Decimal comparison failed. Check `Decimal.equals` is being used (not `===`).
- "Order.softDollarTier: ..." — nested object passthrough may need explicit handling if the snapshot has a nested object that differs structurally. Check the rehydration helper handles nested fields.
- "Cannot find module ..." — fixture path resolution. Check `FIXTURES` constant resolves to `<repo>/parity/fixtures`.
- "wire[field] expected { kind: 'unset' }, got { kind: 'value', value: '170141183460469231731687303715884105727' }" — sentinel detection is wrong; the adapter is treating the UNSET_DECIMAL value as a regular value. Check `isUnsetDecimal` is comparing via `Decimal.equals`.

- [ ] **Step 3: Run repo-wide tests to confirm no regressions**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests" | tail -2
```

Expected: previous baseline (1299) + new Phase 1b tests. Total around 1735-1740.

- [ ] **Step 4: Commit**

```bash
git add src/domain/trading/__test__/wire-roundtrip.spec.ts
git commit -m "test(wire): round-trip 427 Phase 0 fixtures (Task D)

- orders-on-wire/order/*.json: 340 fixtures (Phase 0 Task H)
- orders-on-wire/contract/*.json: 1 fixture (Phase 0 Task H)
- sentinels/{order,contract,execution,orderstate}-fields/*.json:
  86 fixtures (Phase 0 Task D)

Each orders-on-wire fixture: rehydrate to class instance, run
xToWire → wireToX, assert semantic equality via Decimal.equals
for Decimal fields, === for numbers, deep-equal for passthrough.

Each sentinel fixture: construct fresh instance (class defaults the
named field to its sentinel), run xToWire, assert wire[field] is
{ kind: 'unset' }. all-unset variants: assert every wire-typed field
is { kind: 'unset' }."
```

---

## Task E: UNSET_LONG precision test

Per v4 §6.1 caveat. Independent of Tasks D — can land before or after.

**Files:**
- Create: `src/domain/trading/__test__/unset-long-precision.spec.ts`

- [ ] **Step 1: Create the test file**

```typescript
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { UNSET_LONG } from '@traderalice/ibkr-types'

/**
 * UNSET_LONG precision check — Phase 1b deliverable 5.
 *
 * Per v4 §6.1 caveat: `UNSET_LONG = BigInt(2 ** 63) - 1n` is lossy because
 * `2 ** 63 = 9.223372036854776e18` (a JS Number that exceeds
 * Number.MAX_SAFE_INTEGER) is rounded BEFORE the BigInt(...) wrap.
 *
 * No current IBKR field defaults to UNSET_LONG (verified in Phase 0's
 * decimal-inventory.md). This test is a regression net for future i64-bound
 * fields: any such field must reconstruct i64::MAX = 9223372036854775807 from
 * a canonical string, NOT from this lossy TS constant.
 */
describe('UNSET_LONG vs canonical i64::MAX', () => {
  it('UNSET_LONG (lossy TS) differs from canonical i64::MAX', () => {
    const i64Max = BigInt('9223372036854775807')
    expect(UNSET_LONG).not.toBe(i64Max)
  })

  it('canonical i64::MAX string round-trips exactly through Decimal', () => {
    const canonical = '9223372036854775807'
    const d = new Decimal(canonical)
    expect(d.toFixed()).toBe(canonical)
  })
})
```

- [ ] **Step 2: Run the test**

```bash
npx vitest run src/domain/trading/__test__/unset-long-precision.spec.ts
```

Expected: 2/2 PASS.

If the first test FAILS — UNSET_LONG actually does equal i64::MAX — congratulations, the lossy bug got fixed somewhere else and this test should be updated to assert the new invariant. (Unlikely; check `packages/ibkr-types/src/const.ts` to see what the constant currently is.)

- [ ] **Step 3: Commit**

```bash
git add src/domain/trading/__test__/unset-long-precision.spec.ts
git commit -m "test(wire): UNSET_LONG precision regression net (Task E)

Per v4 §6.1: UNSET_LONG = BigInt(2 ** 63) - 1n is lossy. Test asserts
(1) the lossy TS constant ≠ canonical i64::MAX, (2) the canonical
i64::MAX string round-trips exactly through Decimal.

No current IBKR field uses UNSET_LONG; the test is a regression net
for future i64-bound fields. Any such field must reconstruct
i64::MAX from a canonical string, not from this lossy constant."
```

---

## Task F: DoD verification

No new code or commits in this task — verification only.

- [ ] **Step 1: All new files exist at expected paths**

```bash
ls src/domain/trading/wire-types.ts src/domain/trading/wire-adapters.ts src/domain/trading/wire-canonical-decimal.ts src/domain/trading/__test__/wire-adapters.spec.ts src/domain/trading/__test__/wire-roundtrip.spec.ts src/domain/trading/__test__/unset-long-precision.spec.ts
```

Expected: all 6 files listed (no "No such file" errors).

- [ ] **Step 2: tsc clean**

```bash
npx tsc --noEmit
```

Expected: no NEW errors vs. baseline. (Pre-existing errors from unrelated repo code are not your concern; if you see errors specifically referencing `wire-types.ts`/`wire-adapters.ts`/etc., those ARE your concern.)

- [ ] **Step 3: Full test suite**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests" | tail -2
```

Expected: ~1735 tests (~1299 baseline + 427 round-trip + 86 sentinel + 8 schema-consistency + 2 unset-long = ~1822 max; actual depends on how `it.each` reports). The KEY assertion is that the count INCREASED meaningfully and zero tests FAIL.

If the count went DOWN, some prior test is now failing. Investigate.

- [ ] **Step 4: Round-trip test specifically**

```bash
npx vitest run src/domain/trading/__test__/wire-roundtrip.spec.ts 2>&1 | grep -E "Test Files|Tests" | tail -2
```

Expected: 427 tests pass.

- [ ] **Step 5: Dev server smoke**

```bash
pnpm dev > /tmp/dev.log 2>&1 &
DEV_PID=$!
sleep 6
curl -s http://localhost:3002/api/status
echo ""
pkill -f "tsx watch src/main.ts" 2>/dev/null
```

Expected: JSON response like `{"ok":true,"version":"0.10.0-beta.0","uptimeSeconds":...,"ffiLoaded":false}`. The dev server boots cleanly despite Phase 1b's wire types being added.

- [ ] **Step 6: Zero edits to existing src/ files**

```bash
git diff 0778f83..HEAD -- src/ | grep -E "^---|^\+\+\+" | sort -u | head -20
```

Expected: only NEW files mentioned (lines starting with `+++ b/src/domain/trading/wire-*.ts` and `+++ b/src/domain/trading/__test__/wire-*.spec.ts` and `+++ b/src/domain/trading/__test__/unset-long-precision.spec.ts`). NO existing files should appear (no `---` lines referencing `a/src/...` for previously-existing files).

- [ ] **Step 7: Zero packages/ and root-config edits**

```bash
git diff 0778f83..HEAD -- packages/ pnpm-workspace.yaml turbo.json package.json
```

Expected: empty output.

- [ ] **Step 8: Zero edits to decimal-inventory.md**

```bash
git diff 0778f83..HEAD -- parity/decimal-inventory.md
```

Expected: empty output (the inventory is read-only for Phase 1b).

- [ ] **Step 9: TradingGit + live route untouched**

```bash
git diff 0778f83..HEAD -- src/domain/trading/git/ src/domain/trading/UnifiedTradingAccount.ts src/domain/trading/uta-manager.ts
```

Expected: empty output.

- [ ] **Step 10: Final summary**

```bash
echo "Phase 1b deliverables:"
echo "  wire-types.ts: $(wc -l < src/domain/trading/wire-types.ts) lines"
echo "  wire-adapters.ts: $(wc -l < src/domain/trading/wire-adapters.ts) lines"
echo "  wire-canonical-decimal.ts: $(wc -l < src/domain/trading/wire-canonical-decimal.ts) lines"
echo "  ORDER_SCHEMA entries: $(grep -cE "^\s+[a-zA-Z_]+: 'Wire" src/domain/trading/wire-types.ts | head -1)"
echo "  Total commits since spec: $(git log --oneline 0778f83..HEAD | wc -l)"
```

Expected: 5 implementation commits (Tasks A, B, C, D, E) — Task F is verification-only.

---

## Self-review

**Spec coverage:**
- Layer 1 (base wire types) → Task A
- Layer 2 (per-class schemas) → Task B (Steps 2-5)
- Layer 3 (mapped types) → Task B (Step 6)
- wire-adapters.ts (toWire/fromWire + 8 entry points + sentinel helpers) → Task C (Step 2)
- wire-canonical-decimal.ts → Task C (Step 1)
- Schema-consistency tests → Task C (Step 3)
- 427 fixture round-trip → Task D
- UNSET_LONG precision → Task E
- DoD verification → Task F

**Placeholder scan:** No "TBD"/"fill in details" placeholders in instructional steps. The schema entries in Task B (Steps 2-5) are explicitly described as "fill in all 64/14/10/13 entries from the inventory" — that's transcription work with a clear procedure, not a placeholder.

**Type consistency:** `WireDecimal`, `WireDouble`, `WireInteger`, `WireOrder`, `WireContract`, `WireExecution`, `WireOrderState`, `DecimalString`, `WireMap`, `MakeWire` defined consistently across tasks. Entry points `ibkrOrderToWire`/`wireToIbkrOrder`/etc. named consistently.

**Known risks acknowledged in the plan:**
- Task D's `require()` calls inside the test file are flagged as ESM-incompatible; the implementer must replace with top-level imports per the inline note.
- Task B's schema transcription is hand-driven; Task C's schema-consistency tests catch any missed/typo'd entries.
- `wire-canonical-decimal.ts` is intentionally duplicated from Phase 0's private helper; Phase 1c removes the duplication.

---

## Execution notes

- All Phase 1b code lives under `src/domain/trading/`. Zero edits to `packages/`, `parity/`, or root config.
- Tasks A → B → C are strictly sequential (each depends on the previous). Tasks D and E both depend on C but are independent of each other.
- The implementer should run `npx tsc --noEmit` after each commit to catch regressions early.
- Phase 1b is dead code — no production consumer until Phase 2. The schema-consistency tests + round-trip tests are the only verification that the code works.
- If Task B's transcription misses a field, Task C's schema-consistency test fails clearly listing the missing field name. Iterate.
- If Task D's round-trip fails on a specific fixture, the test output names the file. Inspect the snapshot and the rehydration helper.
