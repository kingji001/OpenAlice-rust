# Phase 2 — Hash v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land v2 hashing for new TradingGit commits — canonical-JSON over wire-form operations + `hashInputTimestamp`. v1 commits stay opaque; v1 fallback retained for opt-out. Fix the v3 latent timestamp-desync bug at all 4 sites (commit/push/reject/sync).

**Architecture:** Schema extension on `GitCommit` (5 new optional fields, 3 active). New `hash-v2.ts` builds the canonical input via `operation-wire.ts` walker + Phase 1c `canonicalJson`. `TradingGit` captures `hashInputTimestamp` at the intent site, threads it through downstream writes via a new `pendingV2` struct. `PersistedCommit` discriminated union classifies loaded commits as `v1-opaque | v2`. Verifier CLI recomputes intentFullHash for v2 commits.

**Tech Stack:** TypeScript, `decimal.js`, `node:crypto`, `vitest`, Phase 1b wire-adapters, Phase 1c canonical helpers.

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-2-hash-v2-design.md`](../specs/2026-05-12-phase-2-hash-v2-design.md) (commit `5e35b26`).

**Pre-flight checks:**

- [ ] Working tree clean: `git status --short` empty.
- [ ] HEAD includes Phase 1c: `git log --oneline | grep "Phase 1c"` shows commits.
- [ ] Baseline test count: `pnpm test 2>&1 | grep -E "^\s+Tests" | tail -1` (~2189).
- [ ] Phase 0 fixture corpus present: `find parity/fixtures -name '*.json' | wc -l` returns >= 1000.
- [ ] Existing `TradingGit.spec.ts` uses `toHaveLength(8)` for hashes (not specific bytes): `grep -c "toBe('[0-9a-f]\{8\}')" src/domain/trading/git/TradingGit.spec.ts` → 0.

---

## Task A: Schema extension

Add 5 new optional fields to `GitCommit`. No runtime change yet.

**Files:**
- Modify: `src/domain/trading/git/types.ts`

- [ ] **Step 1: Locate `GitCommit` interface**

```bash
grep -n "^export interface GitCommit" src/domain/trading/git/types.ts
```
Expected: one match around line 62.

- [ ] **Step 2: Replace the `GitCommit` interface with the extended version**

Use Edit. Find:

```typescript
export interface GitCommit {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  round?: number
}
```

Replace with:

```typescript
export interface GitCommit {
  /** 8-char display hash. For v2 commits, this is intentFullHash.slice(0, 8). */
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  /** Wall-clock timestamp of commit creation. For v2 commits, equals hashInputTimestamp. */
  timestamp: string
  round?: number

  // Phase 2 — populated for v2 commits only
  /** Absent or 1 = legacy v1 opaque hash. 2 = canonical v2 intent hash. */
  hashVersion?: 1 | 2
  /** 64-char SHA-256 over the canonical v2 input. Present iff hashVersion === 2. */
  intentFullHash?: string
  /** Exact timestamp fed into the v2 hash input. Present iff hashVersion === 2.
   *  For v2 commits, this is also the value persisted as `timestamp` above. */
  hashInputTimestamp?: string

  // Phase 2.5 reservation — NOT populated in Phase 2
  /** Reserved for Phase 2.5. Do not populate in Phase 2. */
  entryHashVersion?: 1
  /** Reserved for Phase 2.5. Do not populate in Phase 2. */
  entryFullHash?: string
}
```

- [ ] **Step 3: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: no NEW errors.

- [ ] **Step 4: Verify existing tests still pass**

Run: `pnpm test src/domain/trading/git/`
Expected: all green (the new fields are optional; no existing test sets them).

- [ ] **Step 5: Commit**

```bash
git add src/domain/trading/git/types.ts
git commit -m "feat(git): extend GitCommit schema for v2 hashing (Task A)

5 new optional fields on GitCommit:
- hashVersion?: 1 | 2 (active in Phase 2)
- intentFullHash?: string (active in Phase 2)
- hashInputTimestamp?: string (active in Phase 2)
- entryHashVersion?: 1 (Phase 2.5 reservation, never set in Phase 2)
- entryFullHash?: string (Phase 2.5 reservation, never set in Phase 2)

For v2 commits, timestamp === hashInputTimestamp (fixes v3 latent bug
where commit/push/reject/sync each called new Date() independently).

Spec: docs/superpowers/specs/2026-05-12-phase-2-hash-v2-design.md"
```

---

## Task B: partial-Order wire adapter

Add `partialToWire` + `ibkrPartialOrderToWire` to Phase 1b's `wire-adapters.ts`, plus tests.

**Files:**
- Modify: `src/domain/trading/wire-adapters.ts`
- Modify: `src/domain/trading/__test__/wire-adapters.spec.ts`

- [ ] **Step 1: Add `partialToWire` + named entry point to `wire-adapters.ts`**

Append at the bottom of `src/domain/trading/wire-adapters.ts` (after the existing `wireToIbkrOrderState` export):

```typescript
// ---- Partial-Order wire support (for Operation.modifyOrder.changes) ----

/**
 * Like toWire but accepts a partial source. Fields present in `partial`
 * AND in the schema are wrapped; non-schema fields pass through; absent
 * fields stay absent. Used for Operation.modifyOrder.changes (Partial<Order>).
 */
export function partialToWire<T extends object>(
  partial: Partial<T>,
  schema: Schema,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(partial)) {
    const v = (partial as Record<string, unknown>)[key]
    if (v === undefined) continue
    if (key in schema) {
      out[key] = wrapValue(v, schema[key]!)
    } else {
      out[key] = v
    }
  }
  return out
}

export const ibkrPartialOrderToWire = (changes: Partial<Order>): Partial<WireOrder> =>
  partialToWire(changes, ORDER_SCHEMA) as Partial<WireOrder>
```

(`Schema` and `wrapValue` are already file-local; `Order`, `ORDER_SCHEMA`, and `WireOrder` are already imported.)

- [ ] **Step 2: Add tests to `wire-adapters.spec.ts`**

Append at the end of `src/domain/trading/__test__/wire-adapters.spec.ts`:

```typescript
describe('partialToWire / ibkrPartialOrderToWire', () => {
  it('empty input produces empty output', () => {
    expect(ibkrPartialOrderToWire({})).toEqual({})
  })

  it('single Decimal field wraps as { kind: "value", value: canonical }', () => {
    const result = ibkrPartialOrderToWire({ lmtPrice: new Decimal('150.50') })
    expect(result).toEqual({
      lmtPrice: { kind: 'value', value: '150.5' },
    })
  })

  it('UNSET_DECIMAL on a partial wraps as { kind: "unset" }', () => {
    const result = ibkrPartialOrderToWire({ lmtPrice: UNSET_DECIMAL })
    expect(result).toEqual({
      lmtPrice: { kind: 'unset' },
    })
  })

  it('non-schema (string) field passes through verbatim', () => {
    const result = ibkrPartialOrderToWire({ action: 'BUY' as const })
    expect(result).toEqual({ action: 'BUY' })
  })

  it('undefined field is omitted entirely', () => {
    const result = ibkrPartialOrderToWire({ lmtPrice: undefined })
    expect(result).toEqual({})
  })

  it('multiple fields combined', () => {
    const result = ibkrPartialOrderToWire({
      lmtPrice: new Decimal('100'),
      action: 'SELL' as const,
      tif: 'DAY',
    })
    expect(result).toEqual({
      lmtPrice: { kind: 'value', value: '100' },
      action: 'SELL',
      tif: 'DAY',
    })
  })
})
```

Also add `Decimal` and `UNSET_DECIMAL` to the imports at the top of the spec if not already imported:

```typescript
import Decimal from 'decimal.js'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import { ibkrPartialOrderToWire } from '../wire-adapters.js'
```

- [ ] **Step 3: Run the new tests**

```bash
pnpm test src/domain/trading/__test__/wire-adapters.spec.ts
```
Expected: 16 tests pass (10 existing schema-consistency + 6 new partial tests).

- [ ] **Step 4: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/trading/wire-adapters.ts src/domain/trading/__test__/wire-adapters.spec.ts
git commit -m "feat(wire): partialToWire + ibkrPartialOrderToWire (Task B)

Phase 2 prerequisite: Operation.modifyOrder.changes is Partial<Order>
and needs to flow through wire form for v2 hashing. Adds:
- partialToWire<T>(partial, schema) generic — like toWire but skips
  absent fields, otherwise identical (sentinel detection, wrap kinds)
- ibkrPartialOrderToWire(changes) named entry point

6 new tests cover: empty in, Decimal value, sentinel, string passthrough,
undefined omission, multi-field. All 16 wire-adapters tests pass."
```

---

## Task C: operation-wire + hash-v2

Two new files implementing the v2 hash algorithm.

**Files:**
- Create: `src/domain/trading/git/operation-wire.ts`
- Create: `src/domain/trading/git/hash-v2.ts`
- Create: `src/domain/trading/__test__/hash-v2.spec.ts`
- Create: `src/domain/trading/__test__/operation-wire.spec.ts`

- [ ] **Step 1: Create `src/domain/trading/git/operation-wire.ts`**

```typescript
/**
 * Operation → wire-form converter for v2 hash inputs.
 *
 * Walks each Operation variant and converts IBKR-class fields (Order,
 * Contract) to wire form via Phase 1b adapters. Decimal fields outside
 * the wire-schema (e.g., closePosition.quantity) are canonicalized via
 * Phase 1c's toCanonicalDecimalString.
 *
 * Used by hash-v2.ts. The hash input is canonical JSON over the wire form.
 */

import Decimal from 'decimal.js'
import { toCanonicalDecimalString } from '../canonical-decimal.js'
import type { CanonicalJsonValue } from '../canonical-json.js'
import {
  ibkrContractToWire,
  ibkrOrderToWire,
  ibkrPartialOrderToWire,
} from '../wire-adapters.js'
import type { Operation } from './types.js'

export function operationToWire(op: Operation): CanonicalJsonValue {
  switch (op.action) {
    case 'placeOrder':
      return {
        action: 'placeOrder',
        order: ibkrOrderToWire(op.order) as unknown as CanonicalJsonValue,
        contract: ibkrContractToWire(op.contract) as unknown as CanonicalJsonValue,
        ...(op.tpsl ? { tpsl: tpslToWire(op.tpsl) } : {}),
      }
    case 'modifyOrder':
      return {
        action: 'modifyOrder',
        orderId: op.orderId,
        changes: ibkrPartialOrderToWire(op.changes) as unknown as CanonicalJsonValue,
      }
    case 'closePosition':
      return {
        action: 'closePosition',
        contract: ibkrContractToWire(op.contract) as unknown as CanonicalJsonValue,
        ...(op.quantity ? { quantity: toCanonicalDecimalString(op.quantity) } : {}),
      }
    case 'cancelOrder':
      return {
        action: 'cancelOrder',
        orderId: op.orderId,
        ...(op.orderCancel ? { orderCancel: op.orderCancel as unknown as CanonicalJsonValue } : {}),
      }
    case 'syncOrders':
      return { action: 'syncOrders' }
  }
}

function tpslToWire(tpsl: { takeProfit?: string | Decimal; stopLoss?: string | Decimal }): CanonicalJsonValue {
  return {
    ...(tpsl.takeProfit !== undefined
      ? { takeProfit: typeof tpsl.takeProfit === 'string' ? tpsl.takeProfit : toCanonicalDecimalString(tpsl.takeProfit) }
      : {}),
    ...(tpsl.stopLoss !== undefined
      ? { stopLoss: typeof tpsl.stopLoss === 'string' ? tpsl.stopLoss : toCanonicalDecimalString(tpsl.stopLoss) }
      : {}),
  }
}
```

- [ ] **Step 2: Create `src/domain/trading/__test__/operation-wire.spec.ts`**

```typescript
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Order, OrderCancel } from '@traderalice/ibkr'
import { operationToWire } from '../git/operation-wire.js'
import type { Operation } from '../git/types.js'

function buildContract(): Contract {
  const c = new Contract()
  c.symbol = 'AAPL'
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  return c
}

function buildOrder(): Order {
  const o = new Order()
  o.action = 'BUY'
  o.orderType = 'LMT'
  o.tif = 'DAY'
  o.totalQuantity = new Decimal('100')
  o.lmtPrice = new Decimal('150.50')
  return o
}

describe('operationToWire', () => {
  it('placeOrder converts order + contract to wire form', () => {
    const op: Operation = { action: 'placeOrder', order: buildOrder(), contract: buildContract() }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('placeOrder')
    expect(wire.order).toBeDefined()
    expect(wire.contract).toBeDefined()
    // Spot-check that totalQuantity went through the wire (kind/value shape)
    const order = wire.order as Record<string, unknown>
    expect(order.totalQuantity).toEqual({ kind: 'value', value: '100' })
    expect(order.lmtPrice).toEqual({ kind: 'value', value: '150.5' })
  })

  it('placeOrder with tpsl includes tpsl block', () => {
    const op: Operation = {
      action: 'placeOrder',
      order: buildOrder(),
      contract: buildContract(),
      tpsl: { takeProfit: '160.0', stopLoss: '140.0' },
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.tpsl).toEqual({ takeProfit: '160.0', stopLoss: '140.0' })
  })

  it('placeOrder with Decimal tpsl canonicalizes', () => {
    const op: Operation = {
      action: 'placeOrder',
      order: buildOrder(),
      contract: buildContract(),
      tpsl: { takeProfit: new Decimal('160.50'), stopLoss: new Decimal('140.50') },
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.tpsl).toEqual({ takeProfit: '160.5', stopLoss: '140.5' })
  })

  it('modifyOrder uses partial-order wire adapter', () => {
    const op: Operation = {
      action: 'modifyOrder',
      orderId: 'order-1',
      changes: { lmtPrice: new Decimal('200') },
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('modifyOrder')
    expect(wire.orderId).toBe('order-1')
    expect(wire.changes).toEqual({ lmtPrice: { kind: 'value', value: '200' } })
  })

  it('closePosition with quantity canonicalizes', () => {
    const op: Operation = {
      action: 'closePosition',
      contract: buildContract(),
      quantity: new Decimal('50.5'),
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('closePosition')
    expect(wire.quantity).toBe('50.5')
  })

  it('closePosition without quantity omits the field', () => {
    const op: Operation = { action: 'closePosition', contract: buildContract() }
    const wire = operationToWire(op) as Record<string, unknown>
    expect('quantity' in wire).toBe(false)
  })

  it('cancelOrder with orderCancel includes the OrderCancel object', () => {
    const orderCancel = new OrderCancel()
    const op: Operation = { action: 'cancelOrder', orderId: 'order-1', orderCancel }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('cancelOrder')
    expect(wire.orderId).toBe('order-1')
    expect(wire.orderCancel).toBeDefined()
  })

  it('cancelOrder without orderCancel omits the field', () => {
    const op: Operation = { action: 'cancelOrder', orderId: 'order-1' }
    const wire = operationToWire(op) as Record<string, unknown>
    expect('orderCancel' in wire).toBe(false)
  })

  it('syncOrders produces minimal output', () => {
    const op: Operation = { action: 'syncOrders' }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire).toEqual({ action: 'syncOrders' })
  })
})
```

- [ ] **Step 3: Run operation-wire tests**

```bash
pnpm test src/domain/trading/__test__/operation-wire.spec.ts
```
Expected: 9 tests pass.

- [ ] **Step 4: Create `src/domain/trading/git/hash-v2.ts`**

```typescript
/**
 * Hash v2 algorithm — canonical SHA-256 over wire-form commit intent.
 *
 * Per v4 §5 Phase 2: new commits embed `hashVersion: 2` + `intentFullHash`
 * (64-char SHA-256) + `hashInputTimestamp`. The hash input is the
 * canonical JSON of:
 *   { hashVersion: 2, parentHash, message, operations (wire form), hashInputTimestamp }
 *
 * The `hashVersion: 2` literal is embedded in the canonical input, binding
 * the hash to this algorithm version. A future v3 would have `hashVersion: 3`
 * in its input and produce different bytes.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from '../canonical-json.js'
import { operationToWire } from './operation-wire.js'
import type { CommitHash, Operation } from './types.js'

export interface HashV2Input {
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  hashInputTimestamp: string
}

export function generateIntentHashV2(input: HashV2Input): {
  intentFullHash: string
  shortHash: CommitHash
} {
  const canonical = canonicalJson({
    hashVersion: 2,
    parentHash: input.parentHash,
    message: input.message,
    operations: input.operations.map(operationToWire),
    hashInputTimestamp: input.hashInputTimestamp,
  })
  const intentFullHash = createHash('sha256').update(canonical).digest('hex')
  return { intentFullHash, shortHash: intentFullHash.slice(0, 8) }
}
```

- [ ] **Step 5: Create `src/domain/trading/__test__/hash-v2.spec.ts`**

```typescript
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Order } from '@traderalice/ibkr'
import { generateIntentHashV2 } from '../git/hash-v2.js'
import type { Operation } from '../git/types.js'

function buildPlaceOrderOp(): Operation {
  const c = new Contract()
  c.symbol = 'AAPL'
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  const o = new Order()
  o.action = 'BUY'
  o.orderType = 'LMT'
  o.tif = 'DAY'
  o.totalQuantity = new Decimal('100')
  o.lmtPrice = new Decimal('150.50')
  return { action: 'placeOrder', order: o, contract: c }
}

describe('generateIntentHashV2', () => {
  it('produces a 64-char hex hash + 8-char short hash', () => {
    const result = generateIntentHashV2({
      parentHash: null,
      message: 'test commit',
      operations: [buildPlaceOrderOp()],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(result.intentFullHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.shortHash).toBe(result.intentFullHash.slice(0, 8))
    expect(result.shortHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is deterministic — same inputs produce same hash', () => {
    const op = buildPlaceOrderOp()
    const input = {
      parentHash: null,
      message: 'test commit',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    }
    const a = generateIntentHashV2(input)
    const b = generateIntentHashV2(input)
    expect(a.intentFullHash).toBe(b.intentFullHash)
  })

  it('different timestamps produce different hashes', () => {
    const op = buildPlaceOrderOp()
    const a = generateIntentHashV2({
      parentHash: null,
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    const b = generateIntentHashV2({
      parentHash: null,
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-02T00:00:00.000Z',
    })
    expect(a.intentFullHash).not.toBe(b.intentFullHash)
  })

  it('different parent hashes produce different hashes', () => {
    const op = buildPlaceOrderOp()
    const a = generateIntentHashV2({
      parentHash: null,
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    const b = generateIntentHashV2({
      parentHash: 'abc12345',
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(a.intentFullHash).not.toBe(b.intentFullHash)
  })

  it('different messages produce different hashes', () => {
    const op = buildPlaceOrderOp()
    const a = generateIntentHashV2({
      parentHash: null,
      message: 'commit a',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    const b = generateIntentHashV2({
      parentHash: null,
      message: 'commit b',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(a.intentFullHash).not.toBe(b.intentFullHash)
  })

  it('empty operations array is valid input', () => {
    const result = generateIntentHashV2({
      parentHash: null,
      message: 'empty',
      operations: [],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(result.intentFullHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 6: Run hash-v2 tests**

```bash
pnpm test src/domain/trading/__test__/hash-v2.spec.ts
```
Expected: 6 tests pass.

- [ ] **Step 7: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/domain/trading/git/operation-wire.ts src/domain/trading/git/hash-v2.ts src/domain/trading/__test__/operation-wire.spec.ts src/domain/trading/__test__/hash-v2.spec.ts
git commit -m "feat(git): operation-wire + hash-v2 algorithm (Task C)

- operation-wire.ts: walks Operation variants, converts IBKR-class
  fields to wire form via Phase 1b adapters. Decimal fields outside
  wire-schema canonicalized via Phase 1c toCanonicalDecimalString.
- hash-v2.ts: SHA-256 over canonical JSON of v2 hash input
  (hashVersion:2 + parentHash + message + operations(wire) +
  hashInputTimestamp). Returns intentFullHash (64-char) + shortHash
  (first 8 chars).
- 15 new tests (9 operation-wire + 6 hash-v2 determinism)

Not wired into TradingGit yet — Task F cuts over."
```

---

## Task D: Extract rehydration

Move `TradingGit.rehydrateCommit/rehydrateOperation/rehydrateOrder/rehydrateGitState` from private static methods on the class to a standalone helper. Behavior preserved byte-identically.

**Files:**
- Create: `src/domain/trading/git/_rehydrate.ts`
- Modify: `src/domain/trading/git/TradingGit.ts` (delete private methods, import from `_rehydrate.ts`)

- [ ] **Step 1: Read the current rehydration methods**

```bash
sed -n '300,375p' src/domain/trading/git/TradingGit.ts
```

Capture: `rehydrateCommit`, `rehydrateOperation`, `rehydrateOrder`, `rehydrateGitState`. Note their exact bodies.

- [ ] **Step 2: Create `src/domain/trading/git/_rehydrate.ts`**

Copy the body of each method verbatim, change `private static` → `export function`, update self-references:

```typescript
/**
 * Operation/commit rehydration helpers.
 *
 * Extracted from TradingGit (was private static methods). Phase 2 needs
 * these callable without instantiating TradingGit — the verifier CLI
 * loads commit.json and rehydrates operations before computing hashes.
 *
 * Behavior preserved byte-identically from the original methods.
 */

import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import type { GitCommit, GitState, Operation } from './types.js'

export function rehydrateCommit(commit: GitCommit): GitCommit {
  return {
    ...commit,
    operations: commit.operations.map(rehydrateOperation),
    stateAfter: rehydrateGitState(commit.stateAfter),
  }
}

export function rehydrateOperation(op: Operation): Operation {
  if (op.action === 'placeOrder') {
    return {
      ...op,
      order: op.order ? rehydrateOrder(op.order) : op.order,
    }
  }
  return op
}

export function rehydrateOrder(order: Order): Order {
  const rehydrated = Object.assign(new Order(), order)
  // Rewrap Decimal fields (lost during JSON.stringify → JSON.parse round trip)
  if (order.totalQuantity !== undefined && order.totalQuantity !== null) {
    rehydrated.totalQuantity = new Decimal(String(order.totalQuantity))
  }
  if (order.lmtPrice !== undefined && order.lmtPrice !== null) {
    rehydrated.lmtPrice = new Decimal(String(order.lmtPrice))
  }
  if (order.auxPrice !== undefined && order.auxPrice !== null) {
    rehydrated.auxPrice = new Decimal(String(order.auxPrice))
  }
  // ... copy verbatim from TradingGit's original rehydrateOrder ...
  return rehydrated
}

export function rehydrateGitState(state: GitState): GitState {
  // ... copy verbatim from TradingGit's original rehydrateGitState ...
  return state
}
```

**IMPORTANT**: Copy the body of each helper VERBATIM from `TradingGit.ts` (lines 312-375). Don't reinterpret — the goal is byte-identical behavior. If `rehydrateOrder` has a field-by-field rewrap pattern (totalQuantity, lmtPrice, auxPrice, trailStopPrice, trailingPercent, etc.), copy ALL the rewraps.

- [ ] **Step 3: Replace the static methods in `TradingGit.ts` with imports**

In `src/domain/trading/git/TradingGit.ts`:

1. Add import near the top:
   ```typescript
   import { rehydrateCommit, rehydrateOperation, rehydrateOrder, rehydrateGitState } from './_rehydrate.js'
   ```

2. Find the call sites and update them:
   - Line 306: `git.commits = state.commits.map(TradingGit.rehydrateCommit)` → `git.commits = state.commits.map(rehydrateCommit)`
   - Any other internal calls using `TradingGit.rehydrate*` → drop the `TradingGit.` prefix.

3. Delete the 4 `private static rehydrate*` method definitions (lines ~312-375).

- [ ] **Step 4: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: no NEW errors.

- [ ] **Step 5: Run TradingGit specs to confirm behavior preserved**

```bash
pnpm test src/domain/trading/git/TradingGit.spec.ts
```
Expected: all existing tests pass (the rehydration paths are exercised by export/import tests in the spec).

- [ ] **Step 6: Commit**

```bash
git add src/domain/trading/git/_rehydrate.ts src/domain/trading/git/TradingGit.ts
git commit -m "refactor(git): extract rehydration helpers to _rehydrate.ts (Task D)

Was 4 private static methods on TradingGit (rehydrateCommit /
rehydrateOperation / rehydrateOrder / rehydrateGitState). Now
standalone functions in src/domain/trading/git/_rehydrate.ts.

Behavior preserved byte-identically; TradingGit imports and calls
the helpers instead of having them inline. The verifier CLI in
Task G will reuse these without instantiating TradingGit."
```

---

## Task E: PersistedCommit decoder

`PersistedCommit` discriminated union + classifier + verifier + serializer.

**Files:**
- Create: `src/domain/trading/git/persisted-commit.ts`
- Create: `src/domain/trading/__test__/persisted-commit.spec.ts`

- [ ] **Step 1: Create `src/domain/trading/git/persisted-commit.ts`**

```typescript
/**
 * PersistedCommit decoder — v4 §5 Phase 2 Deliverable 4.
 *
 * Discriminates a GitCommit (off disk or in-memory) by its hashVersion:
 *   - hashVersion === 2 → 'v2'; verify intentFullHash on demand.
 *   - hashVersion absent or === 1 → 'v1-opaque'; never recomputed.
 *
 * The verifier expects c.operations to be REHYDRATED (Decimal instances,
 * not strings) — wire-conversion expects Decimal class instances. Callers
 * run rehydrateOperation first.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from '../canonical-json.js'
import { operationToWire } from './operation-wire.js'
import type { GitCommit } from './types.js'

// ---- Variant types ----

export interface PersistedCommitV1Opaque {
  kind: 'v1-opaque'
  raw: GitCommit
}

export interface PersistedCommitV2 {
  kind: 'v2'
  commit: GitCommit
}

export type PersistedCommit = PersistedCommitV1Opaque | PersistedCommitV2

// ---- Classifier ----

export function classifyCommit(raw: GitCommit): PersistedCommit {
  if (raw.hashVersion === 2) return { kind: 'v2', commit: raw }
  return { kind: 'v1-opaque', raw }
}

// ---- Verifier ----

export interface VerifyResult {
  kind: 'verified' | 'mismatch' | 'skipped'
  hash: string
  expectedIntentFullHash?: string
  actualIntentFullHash?: string
  message?: string
}

export interface VerifyOptions {
  strict?: boolean
}

export function verifyCommit(persisted: PersistedCommit, opts: VerifyOptions = {}): VerifyResult {
  if (persisted.kind === 'v1-opaque') {
    return { kind: 'skipped', hash: persisted.raw.hash }
  }

  const c = persisted.commit
  if (c.intentFullHash === undefined || c.hashInputTimestamp === undefined) {
    const msg = `v2 commit ${c.hash} is missing intentFullHash or hashInputTimestamp`
    if (opts.strict) throw new Error(msg)
    return { kind: 'mismatch', hash: c.hash, message: msg }
  }

  const canonical = canonicalJson({
    hashVersion: 2,
    parentHash: c.parentHash,
    message: c.message,
    operations: c.operations.map(operationToWire),
    hashInputTimestamp: c.hashInputTimestamp,
  })
  const actualIntentFullHash = createHash('sha256').update(canonical).digest('hex')

  if (actualIntentFullHash !== c.intentFullHash) {
    const msg = `v2 commit ${c.hash}: intentFullHash mismatch (expected ${c.intentFullHash.slice(0, 8)}…, got ${actualIntentFullHash.slice(0, 8)}…)`
    if (opts.strict) throw new Error(msg)
    return {
      kind: 'mismatch',
      hash: c.hash,
      expectedIntentFullHash: c.intentFullHash,
      actualIntentFullHash,
      message: msg,
    }
  }

  return {
    kind: 'verified',
    hash: c.hash,
    actualIntentFullHash,
    expectedIntentFullHash: c.intentFullHash,
  }
}

// ---- Round-trip serialization ----

export function serializeCommit(persisted: PersistedCommit): GitCommit {
  return persisted.kind === 'v1-opaque' ? persisted.raw : persisted.commit
}
```

- [ ] **Step 2: Create `src/domain/trading/__test__/persisted-commit.spec.ts`**

```typescript
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Order } from '@traderalice/ibkr'
import { generateIntentHashV2 } from '../git/hash-v2.js'
import {
  classifyCommit,
  serializeCommit,
  verifyCommit,
} from '../git/persisted-commit.js'
import type { GitCommit, Operation } from '../git/types.js'

function buildOp(): Operation {
  const c = new Contract()
  c.symbol = 'AAPL'
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  const o = new Order()
  o.action = 'BUY'
  o.orderType = 'LMT'
  o.tif = 'DAY'
  o.totalQuantity = new Decimal('100')
  o.lmtPrice = new Decimal('150.50')
  return { action: 'placeOrder', order: o, contract: c }
}

function buildV1Commit(): GitCommit {
  return {
    hash: 'aabbccdd',
    parentHash: null,
    message: 'v1 commit',
    operations: [buildOp()],
    results: [],
    stateAfter: {
      netLiquidation: '0',
      totalCashValue: '0',
      unrealizedPnL: '0',
      realizedPnL: '0',
      positions: [],
      pendingOrders: [],
    },
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function buildV2Commit(): GitCommit {
  const op = buildOp()
  const { intentFullHash, shortHash } = generateIntentHashV2({
    parentHash: null,
    message: 'v2 commit',
    operations: [op],
    hashInputTimestamp: '2026-01-01T00:00:00.000Z',
  })
  return {
    hash: shortHash,
    parentHash: null,
    message: 'v2 commit',
    operations: [op],
    results: [],
    stateAfter: {
      netLiquidation: '0',
      totalCashValue: '0',
      unrealizedPnL: '0',
      realizedPnL: '0',
      positions: [],
      pendingOrders: [],
    },
    timestamp: '2026-01-01T00:00:00.000Z',
    hashVersion: 2,
    intentFullHash,
    hashInputTimestamp: '2026-01-01T00:00:00.000Z',
  }
}

describe('classifyCommit', () => {
  it('hashVersion: 2 → v2', () => {
    const c = buildV2Commit()
    const result = classifyCommit(c)
    expect(result.kind).toBe('v2')
    if (result.kind === 'v2') expect(result.commit).toBe(c)
  })

  it('hashVersion absent → v1-opaque', () => {
    const c = buildV1Commit()
    const result = classifyCommit(c)
    expect(result.kind).toBe('v1-opaque')
    if (result.kind === 'v1-opaque') expect(result.raw).toBe(c)
  })

  it('hashVersion: 1 → v1-opaque', () => {
    const c: GitCommit = { ...buildV1Commit(), hashVersion: 1 }
    const result = classifyCommit(c)
    expect(result.kind).toBe('v1-opaque')
  })
})

describe('verifyCommit', () => {
  it('v1-opaque is skipped', () => {
    const c = buildV1Commit()
    const result = verifyCommit(classifyCommit(c))
    expect(result.kind).toBe('skipped')
    expect(result.hash).toBe('aabbccdd')
  })

  it('v2 with valid intentFullHash verifies', () => {
    const c = buildV2Commit()
    const result = verifyCommit(classifyCommit(c))
    expect(result.kind).toBe('verified')
    expect(result.actualIntentFullHash).toBe(c.intentFullHash)
  })

  it('v2 with corrupted intentFullHash → mismatch', () => {
    const c = buildV2Commit()
    const corrupted: GitCommit = { ...c, intentFullHash: '0'.repeat(64) }
    const result = verifyCommit(classifyCommit(corrupted))
    expect(result.kind).toBe('mismatch')
    expect(result.expectedIntentFullHash).toBe('0'.repeat(64))
    expect(result.actualIntentFullHash).toBeDefined()
  })

  it('v2 with missing intentFullHash → mismatch', () => {
    const c = buildV2Commit()
    const incomplete: GitCommit = { ...c, intentFullHash: undefined }
    const result = verifyCommit(classifyCommit(incomplete))
    expect(result.kind).toBe('mismatch')
    expect(result.message).toContain('missing intentFullHash')
  })

  it('strict mode throws on mismatch', () => {
    const c = buildV2Commit()
    const corrupted: GitCommit = { ...c, intentFullHash: '0'.repeat(64) }
    expect(() => verifyCommit(classifyCommit(corrupted), { strict: true })).toThrow()
  })
})

describe('serializeCommit', () => {
  it('round-trips a v1 commit verbatim', () => {
    const c = buildV1Commit()
    const persisted = classifyCommit(c)
    expect(serializeCommit(persisted)).toBe(c)
  })

  it('round-trips a v2 commit verbatim', () => {
    const c = buildV2Commit()
    const persisted = classifyCommit(c)
    expect(serializeCommit(persisted)).toBe(c)
  })
})
```

- [ ] **Step 3: Run persisted-commit tests**

```bash
pnpm test src/domain/trading/__test__/persisted-commit.spec.ts
```
Expected: 10 tests pass (3 classify + 5 verify + 2 serialize).

- [ ] **Step 4: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/trading/git/persisted-commit.ts src/domain/trading/__test__/persisted-commit.spec.ts
git commit -m "feat(git): PersistedCommit decoder + verifier (Task E)

Discriminated union { kind: 'v1-opaque' | 'v2' } over GitCommit.
- classifyCommit(raw): walks hashVersion field; defaults to v1-opaque
- verifyCommit(persisted, opts?): recomputes intentFullHash from
  canonical wire input; v1-opaque returns 'skipped'; v2 returns
  'verified' or 'mismatch'; opts.strict throws on mismatch
- serializeCommit(persisted): round-trips verbatim

Operations on the commit MUST be rehydrated (Decimal instances) before
calling verifyCommit. The verifier CLI (Task G) handles this.

10 new tests cover all branches."
```

---

## Task F: TradingGit cutover — the big one

Rewrite `commit()`, `push()`, `reject()`, `sync()` with the v2 path + v1 fallback. **This is the highest-risk task.**

**Files:**
- Modify: `src/domain/trading/git/TradingGit.ts` (4 methods + new instance var + renamed v1 hash function)
- Modify: `src/domain/trading/git/interfaces.ts` (add `hashVersion?: 1 | 2` to TradingGitConfig)

- [ ] **Step 1: Add `hashVersion` to `TradingGitConfig`**

Edit `src/domain/trading/git/interfaces.ts`. Find:

```typescript
export interface TradingGitConfig {
  executeOperation: (operation: Operation) => Promise<unknown>
  getGitState: () => Promise<GitState>
  onCommit?: (state: GitExportState) => void | Promise<void>
}
```

Replace with:

```typescript
export interface TradingGitConfig {
  executeOperation: (operation: Operation) => Promise<unknown>
  getGitState: () => Promise<GitState>
  onCommit?: (state: GitExportState) => void | Promise<void>
  /** Hash version for new commits. Defaults to 2 (canonical intent hash).
   *  Set to 1 to fall back to legacy opaque hashing — byte-identical to
   *  pre-Phase-2 behavior. v1 commits always load regardless. */
  hashVersion?: 1 | 2
}
```

- [ ] **Step 2: Rename `generateCommitHash` to `generateCommitHashV1`**

In `src/domain/trading/git/TradingGit.ts`, find the existing `function generateCommitHash(content: object)` (around line 33). Rename to `generateCommitHashV1`. Update its single call site within commit() (line 70-something) and within sync() (line 386-something).

- [ ] **Step 3: Add `generateIntentHashV2` import and `pendingV2` state**

In `src/domain/trading/git/TradingGit.ts`:

Add import near the top (after the existing imports):

```typescript
import { generateIntentHashV2 } from './hash-v2.js'
```

In the `TradingGit` class body, add the new instance variable next to the other `pending*` fields:

```typescript
private pendingV2: { hashInputTimestamp: string; intentFullHash: string } | null = null
```

- [ ] **Step 4: Rewrite `commit()` for v2 path + v1 fallback**

Find the existing `commit(message: string)` method body. Replace with:

```typescript
commit(message: string): CommitPrepareResult {
  if (this.stagingArea.length === 0) {
    throw new Error('Nothing to commit: staging area is empty')
  }

  const hashInputTimestamp = new Date().toISOString()
  const hashVersion = this.config.hashVersion ?? 2

  let pendingHash: CommitHash
  let pendingV2: { hashInputTimestamp: string; intentFullHash: string } | null = null

  if (hashVersion === 2) {
    const { intentFullHash, shortHash } = generateIntentHashV2({
      parentHash: this.head,
      message,
      operations: this.stagingArea,
      hashInputTimestamp,
    })
    pendingHash = shortHash
    pendingV2 = { hashInputTimestamp, intentFullHash }
  } else {
    pendingHash = generateCommitHashV1({
      message,
      operations: this.stagingArea,
      timestamp: hashInputTimestamp,
      parentHash: this.head,
    })
  }

  this.pendingHash = pendingHash
  this.pendingMessage = message
  this.pendingV2 = pendingV2

  return { prepared: true, hash: pendingHash, message, operationCount: this.stagingArea.length }
}
```

- [ ] **Step 5: Rewrite `push()` to use `pendingV2`**

Find the existing `push()` method. Locate the `const commit: GitCommit = { ... }` block that includes `timestamp: new Date().toISOString()`. Replace the commit construction with:

```typescript
const commit: GitCommit = {
  hash,
  parentHash: this.head,
  message,
  operations,
  results,
  stateAfter,
  timestamp: this.pendingV2?.hashInputTimestamp ?? new Date().toISOString(),
  round: this.currentRound,
  ...(this.pendingV2 !== null
    ? {
        hashVersion: 2 as const,
        intentFullHash: this.pendingV2.intentFullHash,
        hashInputTimestamp: this.pendingV2.hashInputTimestamp,
      }
    : {}),
}
```

At the end of `push()` (after the existing cleanup of `pendingMessage` and `pendingHash`), add:

```typescript
this.pendingV2 = null
```

- [ ] **Step 6: Rewrite `reject()` similarly**

Find the existing `reject()` method. Apply the same pattern as `push()`: replace its commit-construction block to use `this.pendingV2?.hashInputTimestamp` for `timestamp` and conditionally include the v2 fields. Add `this.pendingV2 = null` to the cleanup.

- [ ] **Step 7: Rewrite `sync()` with v2 path + v1 fallback**

Find the existing `sync()` method (around line 380). Replace the body's hash + commit-construction section with:

```typescript
const hashInputTimestamp = new Date().toISOString()
const message = `[sync] ${updates.length} order(s) updated`
const operations: Operation[] = [{ action: 'syncOrders' as const }]
const results: OperationResult[] = updates.map((u) => ({
  action: 'syncOrders' as const,
  success: true,
  orderId: u.orderId,
  status: u.currentStatus,
  filledQty: u.filledQty,
  filledPrice: u.filledPrice,
}))

const hashVersion = this.config.hashVersion ?? 2
let hash: CommitHash
let v2Fields: { hashVersion: 2; intentFullHash: string; hashInputTimestamp: string } | undefined

if (hashVersion === 2) {
  const { intentFullHash, shortHash } = generateIntentHashV2({
    parentHash: this.head,
    message,
    operations,
    hashInputTimestamp,
  })
  hash = shortHash
  v2Fields = { hashVersion: 2, intentFullHash, hashInputTimestamp }
} else {
  hash = generateCommitHashV1({
    updates,
    timestamp: hashInputTimestamp,
    parentHash: this.head,
  })
}

const commit: GitCommit = {
  hash,
  parentHash: this.head,
  message,
  operations,
  results,
  stateAfter: currentState,
  timestamp: hashInputTimestamp,
  round: this.currentRound,
  ...(v2Fields ?? {}),
}
```

- [ ] **Step 8: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: no NEW errors.

- [ ] **Step 9: Run existing TradingGit specs — these should pass without modification**

```bash
pnpm test src/domain/trading/git/TradingGit.spec.ts
```
Expected: all green. The existing tests use `expect(result.hash).toHaveLength(8)` (not specific hex strings), so the v2 hash values don't break them. The new `hashVersion`/`intentFullHash`/`hashInputTimestamp` fields are optional and unobservable to those tests.

If any test fails, inspect carefully — likely candidates:
- Test that constructs a `GitCommit` literal expecting only the old fields (TS strict-mode complaint about missing optional fields? Shouldn't happen since they're optional).
- Test that compares two commits for deep-equal and one comes from before the v2 cutover (won't happen in fresh test run, but worth knowing).

- [ ] **Step 10: Add new tests covering v2 behavior**

In `src/domain/trading/git/TradingGit.spec.ts`, add a new `describe` block at the end:

```typescript
import { generateIntentHashV2 } from './hash-v2.js'

describe('TradingGit v2 hashing', () => {
  it('default config produces v2 commits', async () => {
    const git = new TradingGit({
      executeOperation: async (op) => ({ action: op.action, success: true, status: 'submitted' }),
      getGitState: async () => DEFAULT_STATE,
    })
    git.add(buildPlaceOrderOp())
    git.commit('test')
    await git.push()
    const log = git.log()
    expect(log[0].hash).toHaveLength(8)
    // Access the underlying commit via show()
    const commit = git.show(log[0].hash)!
    expect(commit.hashVersion).toBe(2)
    expect(commit.intentFullHash).toMatch(/^[0-9a-f]{64}$/)
    expect(commit.hashInputTimestamp).toBeDefined()
    expect(commit.timestamp).toBe(commit.hashInputTimestamp)  // v4 erratum fix
  })

  it('hashVersion: 1 config produces v1-style commits (no v2 fields)', async () => {
    const git = new TradingGit({
      executeOperation: async (op) => ({ action: op.action, success: true, status: 'submitted' }),
      getGitState: async () => DEFAULT_STATE,
      hashVersion: 1,
    })
    git.add(buildPlaceOrderOp())
    git.commit('test')
    await git.push()
    const log = git.log()
    const commit = git.show(log[0].hash)!
    expect(commit.hashVersion).toBeUndefined()
    expect(commit.intentFullHash).toBeUndefined()
    expect(commit.hashInputTimestamp).toBeUndefined()
  })

  it('v2 timestamp equals hashInputTimestamp across commit→push', async () => {
    const git = new TradingGit({
      executeOperation: async (op) => ({ action: op.action, success: true, status: 'submitted' }),
      getGitState: async () => DEFAULT_STATE,
    })
    git.add(buildPlaceOrderOp())
    const commitResult = git.commit('test')
    // Even after a real-time delay, push() should reuse the commit() timestamp
    await new Promise((r) => setTimeout(r, 10))
    await git.push()
    const commit = git.show(commitResult.hash)!
    expect(commit.timestamp).toBe(commit.hashInputTimestamp)
  })

  it('pendingV2 cleared after push (next commit gets fresh timestamp)', async () => {
    const git = new TradingGit({
      executeOperation: async (op) => ({ action: op.action, success: true, status: 'submitted' }),
      getGitState: async () => DEFAULT_STATE,
    })
    git.add(buildPlaceOrderOp())
    git.commit('first')
    await git.push()
    await new Promise((r) => setTimeout(r, 10))
    git.add(buildPlaceOrderOp())
    git.commit('second')
    await git.push()
    const log = git.log()
    const first = git.show(log[1].hash)!
    const second = git.show(log[0].hash)!
    expect(first.hashInputTimestamp).not.toBe(second.hashInputTimestamp)
  })
})
```

You'll need to either reference an existing `buildPlaceOrderOp` helper in the spec, or define one in the new describe block. If the existing spec already has a similar helper, reuse it.

Define `DEFAULT_STATE` at the top of the describe or import from `_construct.ts` if available:
```typescript
const DEFAULT_STATE: GitState = {
  netLiquidation: '100000',
  totalCashValue: '100000',
  unrealizedPnL: '0',
  realizedPnL: '0',
  positions: [],
  pendingOrders: [],
}
```

- [ ] **Step 11: Run the new v2 tests**

```bash
pnpm test src/domain/trading/git/TradingGit.spec.ts
```
Expected: all green (including the 4 new tests).

- [ ] **Step 12: Run the full repo test suite to catch regressions**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests" | tail -2
```
Expected: baseline (~2189) + Tasks A-F new tests (≈40) = ~2230. Zero failures.

- [ ] **Step 13: Smoke test via run-ts.ts**

```bash
SAMPLE=$(ls parity/fixtures/operations/placeOrder | head -1)
pnpm tsx parity/run-ts.ts parity/fixtures/operations/placeOrder/$SAMPLE | head -40
```
Expected: output now includes `hashVersion: 2`, `intentFullHash`, `hashInputTimestamp` on the `exportState.commits[0]` entry.

- [ ] **Step 14: Commit**

```bash
git add src/domain/trading/git/TradingGit.ts src/domain/trading/git/interfaces.ts src/domain/trading/git/TradingGit.spec.ts
git commit -m "feat(git): v2 hashing cutover in TradingGit (Task F)

Live trading code now emits v2 commits by default.

- commit(): captures hashInputTimestamp, computes v2 intentFullHash,
  stashes pendingV2 struct (hashInputTimestamp + intentFullHash)
- push(): reuses pendingV2 for both persisted timestamp AND v2 fields;
  clears pendingV2 at end
- reject(): same pattern as push()
- sync(): captures own hashInputTimestamp (no pending state needed);
  uses for both timestamp and hash input

v1 fallback retained: hashVersion: 1 config produces byte-identical
pre-Phase-2 output. generateCommitHash renamed to generateCommitHashV1.

For v2 commits: timestamp === hashInputTimestamp (v4 erratum row 2 fix
for the latent bug where commit() and push()/reject()/sync() each
called new Date() independently).

4 new tests cover: default v2 output, v1 opt-out byte-identical,
timestamp-equals-hashInputTimestamp invariant, pendingV2 lifecycle."
```

---

## Task G: verify-v2-hashes.ts CLI

On-demand CLI for recomputing intentFullHash on all v2 commits in `data/trading/`.

**Files:**
- Create: `scripts/verify-v2-hashes.ts`

- [ ] **Step 1: Create `scripts/verify-v2-hashes.ts`**

```typescript
#!/usr/bin/env tsx
/**
 * scripts/verify-v2-hashes.ts — on-demand v2 hash verifier.
 *
 * Walks data/trading/<accountId>/commit.json files. For each commit:
 *   - v1-opaque: skipped (v1 hashes are change-detection tokens, not
 *     content addresses per v4 §6.2; they don't verify by recomputation)
 *   - v2: recompute intentFullHash from canonical wire input;
 *     compare to persisted; warn or error (--strict)
 *
 * Usage:
 *   pnpm tsx scripts/verify-v2-hashes.ts                # all accounts
 *   pnpm tsx scripts/verify-v2-hashes.ts --account=<id> # one account
 *   pnpm tsx scripts/verify-v2-hashes.ts --strict       # exit 1 on first mismatch
 */

import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadGitState } from '../src/domain/trading/git-persistence.js'
import {
  classifyCommit,
  verifyCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'

interface AccountReport {
  accountId: string
  totalCommits: number
  v1Skipped: number
  v2Verified: number
  v2Mismatches: { hash: string; message: string }[]
}

async function verifyAccount(accountId: string, strict: boolean): Promise<AccountReport> {
  const state = await loadGitState(accountId)
  if (state === undefined) {
    return { accountId, totalCommits: 0, v1Skipped: 0, v2Verified: 0, v2Mismatches: [] }
  }
  const report: AccountReport = {
    accountId,
    totalCommits: state.commits.length,
    v1Skipped: 0,
    v2Verified: 0,
    v2Mismatches: [],
  }
  for (const rawCommit of state.commits) {
    const commit = {
      ...rawCommit,
      operations: rawCommit.operations.map(rehydrateOperation),
    }
    const persisted = classifyCommit(commit)
    const result = verifyCommit(persisted, { strict })
    if (result.kind === 'skipped') report.v1Skipped++
    else if (result.kind === 'verified') report.v2Verified++
    else report.v2Mismatches.push({ hash: result.hash, message: result.message ?? 'unknown' })
  }
  return report
}

function discoverAccounts(): string[] {
  const dir = resolve('data/trading')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict')
  const accountArg = process.argv.find((a) => a.startsWith('--account='))
  const accounts = accountArg
    ? [accountArg.slice('--account='.length)]
    : discoverAccounts()

  if (accounts.length === 0) {
    console.log('No accounts found under data/trading/. Nothing to verify.')
    return
  }

  let totalMismatches = 0
  for (const accountId of accounts) {
    const r = await verifyAccount(accountId, strict)
    console.log(
      `${accountId}: ${r.totalCommits} commits (${r.v2Verified} v2 verified, ` +
      `${r.v1Skipped} v1 skipped, ${r.v2Mismatches.length} v2 mismatches)`,
    )
    for (const m of r.v2Mismatches) {
      console.log(`  MISMATCH: ${m.hash} — ${m.message}`)
    }
    totalMismatches += r.v2Mismatches.length
  }

  if (totalMismatches > 0) {
    console.log(`\nTotal v2 mismatches: ${totalMismatches}`)
    if (strict) process.exit(1)
  } else {
    console.log('\nAll v2 commits verified.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 2: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the CLI against current data/ (likely empty)**

```bash
pnpm tsx scripts/verify-v2-hashes.ts
```
Expected: `No accounts found under data/trading/. Nothing to verify.` (in a fresh dev environment) — or per-account reports if data/ has entries.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-v2-hashes.ts
git commit -m "feat(scripts): verify-v2-hashes.ts on-demand CLI (Task G)

Walks data/trading/<accountId>/commit.json files; recomputes
intentFullHash for v2 commits; reports per-account summary.

v1-opaque commits skipped (v1 hashes are change-detection tokens,
not content addresses — v4 §6.2). --strict exits 1 on mismatch.

Does NOT walk LEGACY_GIT_PATHS (legacy paths only contain v1 commits
which are skipped anyway)."
```

---

## Task H: fixture corpus rebuild

Freeze the current v1 git-states, regenerate to v2, author mixed-version logs.

**Files:**
- Create: `parity/fixtures/git-states-v1-frozen/01-single-commit.json` … `10-long-chain.json` (10 files, copies of current `git-states/*.json` before regeneration)
- Modify: `parity/fixtures/git-states/01-single-commit.json` … `10-long-chain.json` (regenerated via `run-ts.ts --scenario`)
- Create: `parity/fixtures/mixed-version-logs/01-v1-then-v2.json` … `05-alternating.json` (5 hand-authored)

- [ ] **Step 1: Freeze current v1 git-states**

```bash
mkdir -p parity/fixtures/git-states-v1-frozen
cp parity/fixtures/git-states/*.json parity/fixtures/git-states-v1-frozen/
ls parity/fixtures/git-states-v1-frozen/
```
Expected: 10 files copied (`01-single-commit.json` through `10-long-chain.json`).

- [ ] **Step 2: Regenerate git-states/ via run-ts.ts**

```bash
for n in 01 02 03 04 05 06 07 08 09 10; do
  scenario=$(ls parity/fixtures/scenarios/${n}-*.scenario.json | head -1)
  if [ -z "$scenario" ]; then continue; fi
  name=$(basename "$scenario" .scenario.json)
  pnpm tsx parity/run-ts.ts --scenario="$scenario" --emit-git-state="parity/fixtures/git-states/${name}.json"
done
```

- [ ] **Step 3: Verify regenerated git-states are v2**

```bash
grep -c '"hashVersion": 2' parity/fixtures/git-states/01-single-commit.json
```
Expected: 1 (the single commit has hashVersion: 2). For `10-long-chain.json`, the count should be 10.

```bash
grep -l '"hashVersion"' parity/fixtures/git-states/*.json | wc -l
```
Expected: 10 (all 10 files contain at least one hashVersion field).

- [ ] **Step 4: Confirm v1-frozen versions are still v1 (no hashVersion field)**

```bash
grep -l '"hashVersion"' parity/fixtures/git-states-v1-frozen/*.json | wc -l
```
Expected: 0.

- [ ] **Step 5: Create `parity/fixtures/mixed-version-logs/01-v1-then-v2.json`**

```bash
mkdir -p parity/fixtures/mixed-version-logs
```

Construct this fixture by combining commits from 2 sources:
- Take the 2 v1 commits from `git-states-v1-frozen/02-three-commits-with-rejection.json` (only the first 2)
- Take 2 v2 commits from `git-states/05-multi-op-commit.json` (or whichever produces multi commits)

Or simpler: hand-author. The schema is:
```json
{
  "commits": [
    { /* v1 commit — no hashVersion field */ },
    { /* v1 commit — no hashVersion field */ },
    { /* v2 commit — hashVersion: 2, intentFullHash, hashInputTimestamp */ },
    { /* v2 commit — hashVersion: 2, ... */ }
  ],
  "head": "<last commit's hash>"
}
```

The simplest authoring is to copy 2 commits from `git-states-v1-frozen/03-sync-after-fill.json` (any 2 v1 commits), then 2 commits from `git-states/01-single-commit.json` (but with `parentHash` rewired to chain properly), then set `head` to the last commit's hash.

Use a small TypeScript script (`parity/build-mixed-logs.ts` — can be deleted after use) OR hand-edit. For hand-edit:

```bash
cat parity/fixtures/git-states-v1-frozen/02-three-commits-with-rejection.json
cat parity/fixtures/git-states/01-single-commit.json
# Then hand-author 01-v1-then-v2.json via a code editor with commits from both
```

The exact content is determined by the source fixtures + parentHash chaining. Document in a header comment within the file:

```json
{
  "_description": "Mixed v1+v2 log: 2 v1 commits then 2 v2 commits. Tests migration path.",
  "commits": [ /* ... */ ],
  "head": "..."
}
```

- [ ] **Step 6: Create the other 4 mixed-version fixtures**

Same procedure for:
- `02-v2-then-v2.json` (5 v2 commits) — copy commits from `git-states/05-multi-op-commit.json` and `10-long-chain.json`, rechain
- `03-v1-only.json` (4 v1 commits) — copy from `git-states-v1-frozen/10-long-chain.json` (first 4 commits)
- `04-v2-only.json` (4 v2 commits) — copy from `git-states/10-long-chain.json` (first 4 commits)
- `05-alternating.json` (v1, v2, v1, v2, v2) — hand-author

For each, ensure:
- `parentHash` of commit N matches `hash` of commit N-1 (chain is well-formed)
- `head` field matches the last commit's `hash`
- v1 commits have NO `hashVersion` field
- v2 commits have `hashVersion: 2`, `intentFullHash`, `hashInputTimestamp`

These fixtures don't need to verify (Task I's `legacy-v1-untouched.ts` will not recompute v1 hashes; `check-mixed-log.ts` will verify v2 commits but skip v1).

- [ ] **Step 7: Commit fixtures**

```bash
git add parity/fixtures/git-states-v1-frozen/ parity/fixtures/git-states/ parity/fixtures/mixed-version-logs/
git commit -m "test(parity): fixture corpus rebuild for Phase 2 (Task H)

- git-states-v1-frozen/ NEW: 10 v1-format captures copied from
  pre-Phase-2 git-states/. Frozen forever; tests assert v1 loads
  verbatim via PersistedCommit.V1Opaque.
- git-states/ REGENERATED: 10 captures now in v2 form. Each commit
  has hashVersion: 2, intentFullHash, hashInputTimestamp. The hash
  short form is intentFullHash.slice(0, 8).
- mixed-version-logs/ NEW: 5 hand-authored mixed v1+v2 logs covering
  migration path (v1-then-v2), steady state (v2-only, v2-then-v2),
  pre-Phase-2 user (v1-only), edge case (alternating).

Existing parity tests (orders-on-wire round-trip, sentinels) still
pass against the unchanged operations and sentinel fixtures."
```

---

## Task I: DoD scripts + verification

Three new parity scripts + run all DoD commands.

**Files:**
- Create: `parity/hash-v2-roundtrip.ts`
- Create: `parity/check-mixed-log.ts`
- Create: `parity/legacy-v1-untouched.ts`

- [ ] **Step 1: Create `parity/hash-v2-roundtrip.ts`**

```typescript
#!/usr/bin/env tsx
/**
 * parity/hash-v2-roundtrip.ts
 *
 * For a git-state fixture file: rehydrate operations on each v2 commit,
 * recompute intentFullHash from canonical wire input, assert match with
 * persisted intentFullHash. v1 commits skipped.
 *
 * Usage:
 *   pnpm tsx parity/hash-v2-roundtrip.ts parity/fixtures/git-states/01-single-commit.json
 */

import { readFileSync } from 'node:fs'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'
import {
  classifyCommit,
  verifyCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import type { GitExportState } from '../src/domain/trading/git/types.js'

async function main(): Promise<void> {
  const fixturePath = process.argv[2]
  if (!fixturePath) {
    console.error('Usage: pnpm tsx parity/hash-v2-roundtrip.ts <git-state-fixture>')
    process.exit(2)
  }

  const state = JSON.parse(readFileSync(fixturePath, 'utf-8')) as GitExportState
  let v2Verified = 0
  let v1Skipped = 0
  let mismatches = 0

  for (const rawCommit of state.commits) {
    const commit = {
      ...rawCommit,
      operations: rawCommit.operations.map(rehydrateOperation),
    }
    const persisted = classifyCommit(commit)
    const result = verifyCommit(persisted)
    if (result.kind === 'skipped') {
      v1Skipped++
    } else if (result.kind === 'verified') {
      v2Verified++
    } else {
      mismatches++
      console.error(`MISMATCH ${result.hash}: ${result.message}`)
    }
  }

  console.log(`${fixturePath}: ${v2Verified} v2 verified, ${v1Skipped} v1 skipped, ${mismatches} mismatches`)
  if (mismatches > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Create `parity/check-mixed-log.ts`**

```typescript
#!/usr/bin/env tsx
/**
 * parity/check-mixed-log.ts
 *
 * For each fixture in parity/fixtures/mixed-version-logs/:
 *   - Load
 *   - For each commit: classify (must be 'v1-opaque' or 'v2')
 *   - For each v2 commit: rehydrate operations, run verifyCommit
 *   - Re-serialize each commit (serializeCommit) → assert deep-equal to source
 *
 * Asserts mixed v1+v2 logs round-trip without losing either form.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'
import {
  classifyCommit,
  serializeCommit,
  verifyCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import type { GitExportState } from '../src/domain/trading/git/types.js'

const FIXTURE_DIR = resolve('parity/fixtures/mixed-version-logs')

async function checkFixture(filename: string): Promise<{ pass: boolean; report: string }> {
  const path = resolve(FIXTURE_DIR, filename)
  const state = JSON.parse(readFileSync(path, 'utf-8')) as GitExportState

  let v1 = 0, v2Verified = 0, mismatches = 0

  for (const rawCommit of state.commits) {
    const rehydrated = {
      ...rawCommit,
      operations: rawCommit.operations.map(rehydrateOperation),
    }
    const persisted = classifyCommit(rehydrated)

    if (persisted.kind === 'v1-opaque') {
      v1++
      // Round-trip check: serialized form should equal source
      const serialized = serializeCommit(persisted)
      if (JSON.stringify(serialized) !== JSON.stringify(rehydrated)) {
        mismatches++
        return { pass: false, report: `${filename}: v1 commit ${rawCommit.hash} round-trip failed` }
      }
    } else {
      const result = verifyCommit(persisted)
      if (result.kind === 'verified') v2Verified++
      else { mismatches++; return { pass: false, report: `${filename}: ${result.message}` } }
    }
  }

  return {
    pass: mismatches === 0,
    report: `${filename}: ${v1} v1 + ${v2Verified} v2 verified, ${mismatches} mismatches`,
  }
}

async function main(): Promise<void> {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('No fixtures in mixed-version-logs/')
    return
  }

  let allPass = true
  for (const f of files) {
    const { pass, report } = await checkFixture(f)
    console.log(report)
    if (!pass) allPass = false
  }

  if (!allPass) process.exit(1)
  console.log('\nAll mixed-version-log fixtures verified.')
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: Create `parity/legacy-v1-untouched.ts`**

```typescript
#!/usr/bin/env tsx
/**
 * parity/legacy-v1-untouched.ts
 *
 * For each fixture in parity/fixtures/git-states-v1-frozen/:
 *   - Load
 *   - For each commit: assert classifies as 'v1-opaque'
 *   - For each commit: serializeCommit must equal source verbatim
 *   - Assert NO call to generateIntentHashV2 occurs (mocked spy)
 *
 * Pins the invariant that v1 commits never get recomputed or
 * re-canonicalized.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  classifyCommit,
  serializeCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import type { GitExportState } from '../src/domain/trading/git/types.js'

const FIXTURE_DIR = resolve('parity/fixtures/git-states-v1-frozen')

async function checkFixture(filename: string): Promise<{ pass: boolean; report: string }> {
  const path = resolve(FIXTURE_DIR, filename)
  const state = JSON.parse(readFileSync(path, 'utf-8')) as GitExportState

  for (const rawCommit of state.commits) {
    const persisted = classifyCommit(rawCommit)
    if (persisted.kind !== 'v1-opaque') {
      return { pass: false, report: `${filename}: commit ${rawCommit.hash} classified as ${persisted.kind}, expected v1-opaque` }
    }
    const serialized = serializeCommit(persisted)
    if (JSON.stringify(serialized) !== JSON.stringify(rawCommit)) {
      return { pass: false, report: `${filename}: v1 commit ${rawCommit.hash} not preserved verbatim` }
    }
  }

  return { pass: true, report: `${filename}: ${state.commits.length} v1 commits, all preserved verbatim` }
}

async function main(): Promise<void> {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('No fixtures in git-states-v1-frozen/')
    return
  }

  let allPass = true
  for (const f of files) {
    const { pass, report } = await checkFixture(f)
    console.log(report)
    if (!pass) allPass = false
  }

  if (!allPass) process.exit(1)
  console.log('\nAll v1-frozen fixtures preserved verbatim.')
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 4: Run all 3 DoD scripts**

```bash
pnpm tsx parity/hash-v2-roundtrip.ts parity/fixtures/git-states/01-single-commit.json
pnpm tsx parity/check-mixed-log.ts
pnpm tsx parity/legacy-v1-untouched.ts
```

Expected:
- `hash-v2-roundtrip.ts`: "01-single-commit.json: 1 v2 verified, 0 v1 skipped, 0 mismatches" — exit 0
- `check-mixed-log.ts`: 5 fixtures all pass, summary "All mixed-version-log fixtures verified." — exit 0
- `legacy-v1-untouched.ts`: 10 fixtures all preserved verbatim — exit 0

If any fail:
- `hash-v2-roundtrip` failure on a regenerated v2 fixture means Task H's regeneration didn't actually use the v2 path, OR rehydration drops a field, OR canonical-JSON is non-deterministic. Investigate the named commit.
- `check-mixed-log` failure usually means a hand-authored fixture has a broken parentHash chain or a malformed v2 commit. Inspect the fixture and the `serializeCommit` output.
- `legacy-v1-untouched` failure means classifier mis-categorized a v1 commit OR serializeCommit modified the raw — both bugs in `persisted-commit.ts`.

- [ ] **Step 5: Run all DoD commands**

```bash
echo "=== npx tsc --noEmit ==="
npx tsc --noEmit 2>&1 | tail -3

echo "=== pnpm test ==="
pnpm test 2>&1 | grep -E "Test Files|Tests" | tail -2

echo "=== verify-v2-hashes.ts ==="
pnpm tsx scripts/verify-v2-hashes.ts

echo "=== dev server ==="
pnpm dev > /tmp/dev.log 2>&1 &
sleep 10
curl -s http://localhost:3002/api/status
pkill -f "tsx watch src/main.ts" 2>/dev/null

echo "=== fixture scope ==="
ls parity/fixtures/git-states-v1-frozen/ | wc -l
ls parity/fixtures/git-states/ | wc -l
ls parity/fixtures/mixed-version-logs/ | wc -l
```

Expected:
- `tsc --noEmit`: clean
- `pnpm test`: baseline + new tests (around 2235), no failures
- `verify-v2-hashes.ts`: "No accounts found under data/trading/. Nothing to verify." (or per-account reports if data/ has entries)
- `dev`: returns `{"ok":true,"version":...}`
- 10 v1-frozen, 10 git-states (now v2), 5 mixed-version-logs

- [ ] **Step 6: Commit**

```bash
git add parity/hash-v2-roundtrip.ts parity/check-mixed-log.ts parity/legacy-v1-untouched.ts
git commit -m "test(parity): 3 DoD scripts for Phase 2 hash v2 (Task I)

- hash-v2-roundtrip.ts: for a git-state fixture, recompute
  intentFullHash for each v2 commit and assert match.
- check-mixed-log.ts: walk mixed-version-logs/*.json, classify
  each commit, verify v2, assert v1 round-trips verbatim.
- legacy-v1-untouched.ts: walk git-states-v1-frozen/*.json,
  assert all commits classify as v1-opaque and serialize verbatim.

All 3 scripts exit 0 on the Phase 2 fixture corpus. Phase 2 done."
```

---

## Self-Review

**Spec coverage:**
- §Architecture deliverable 1 (schema extension) → Task A
- §Architecture deliverable 2 (hash-v2 algorithm) → Task C
- §Architecture deliverable 3 (4 timestamp sites) → Task F
- §Architecture deliverable 4 (PersistedCommit decoder) → Task E
- §Architecture deliverable 5 (verify-v2-hashes.ts) → Task G
- §Architecture deliverable 6 (reversibility config) → Task F Step 1
- §Architecture partial-Order wire adapter → Task B
- §Architecture rehydration extraction → Task D
- §Fixture corpus changes → Task H
- §DoD scripts → Task I
- §DoD verification → Task I Step 5

**Placeholder scan:** None. Task F Step 7's "copy verbatim from TradingGit's original rehydrateOrder" is a verbatim-transcription instruction, not a placeholder.

**Type consistency:** `HashV2Input`, `PersistedCommit`, `VerifyResult`, `PersistedCommitV1Opaque`, `PersistedCommitV2`, `pendingV2`, `hashInputTimestamp`, `intentFullHash` used consistently across tasks. Helper functions (`rehydrateOperation`, `rehydrateOrder`, `generateIntentHashV2`, `generateCommitHashV1`, `classifyCommit`, `verifyCommit`, `serializeCommit`, `operationToWire`, `partialToWire`, `ibkrPartialOrderToWire`) referenced by consistent names throughout.

---

## Execution notes

- A → B → C → D → E → F → G → H → I strictly sequential. Task F is the most complex and highest-risk.
- The existing `TradingGit.spec.ts` tests use `toHaveLength(8)` for hash assertions (not specific bytes), so the v2 cutover won't break them. New v2-specific tests are added separately in Task F Step 10.
- All Phase 2 work lives under `src/`, `parity/`, and `scripts/`. Zero `packages/` edits.
- Implementer should run `npx tsc --noEmit` after each task — catches regressions early.
- For Task H's mixed-version fixtures: if hand-authoring proves error-prone, falling back to a small `parity/build-mixed-logs.ts` helper (run once, delete after) is fine. The fixtures don't need to be hand-typed character-by-character.
- Task F's commit message should explicitly note "test expectations may need updating" — but `toHaveLength(8)` pattern means most don't.
