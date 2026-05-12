# Phase 4a — TS UTA Actor Retrofit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap every public `UnifiedTradingAccount` method in a FIFO actor queue (`TsUtaActor`) so concurrent calls serialize, eliminating the latent concurrency hole where parallel AI tool calls can interleave `stage/commit/push/sync` on the same UTA.

**Architecture:** New module `src/domain/trading/uta-actor.ts` exports `AsyncQueue<T>` + `UtaCommand` discriminated union + `TsUtaActor` class. UTA gains `private actor: TsUtaActor` and ~29 private `_doFoo` impl methods (existing bodies, verbatim). Public methods become thin `actor.send({ type: 'foo', ... })` wrappers. Strict no-reentrancy enforced via depth counter.

**Tech Stack:** TypeScript strict ESM, vitest, no third-party queue dep (hand-rolled AsyncQueue).

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-4a-uta-actor-retrofit-design.md`](../specs/2026-05-12-phase-4a-uta-actor-retrofit-design.md) (commit `1e664e8`).

**Strictly sequential:** A → B → C → D. Big-bang migration: all UTA methods land in this PR. A half-migrated UTA (some serialized, some not) creates a race possibility at the boundary that's harder to reason about than either extreme.

---

## Pre-flight

- [ ] **Working tree clean**

```bash
git status --short                    # empty
git log -1 --oneline                  # confirm Phase 4a spec (1e664e8) is the latest commit
```

- [ ] **Baseline test count**

```bash
pnpm test 2>&1 | grep -E "Tests" | tail -1   # ~2228 tests (Phase 3 baseline)
```

- [ ] **Confirm UTA shape unchanged from spec**

```bash
wc -l src/domain/trading/UnifiedTradingAccount.ts                    # ~586 lines
grep -cE "^  (async +)?[a-z][a-zA-Z]+\(" src/domain/trading/UnifiedTradingAccount.ts | head -1   # ~29 methods + 1 constructor
```

---

## Task A: AsyncQueue + TsUtaActor + UtaCommand union

**Goal:** Create the new module + comprehensive unit tests. The actor must work correctly in isolation before wiring it into the UTA.

**Files:**
- Create: `src/domain/trading/uta-actor.ts`
- Create: `src/domain/trading/__test__/uta-actor.spec.ts`

### Step 1: Create `src/domain/trading/uta-actor.ts` skeleton

```typescript
/**
 * TsUtaActor — single-mutator queue for UnifiedTradingAccount.
 *
 * Phase 4a: wraps every public UTA method in a FIFO queue so concurrent
 * calls serialize. Eliminates the latent race where parallel AI tool
 * calls today can interleave stage/commit/push on the same UTA.
 *
 * Strict no-reentrancy: handlers MUST NOT call actor.send() — that
 * deadlocks. Internal callers invoke _doFoo() impl methods directly.
 *
 * Spec: docs/superpowers/specs/2026-05-12-phase-4a-uta-actor-retrofit-design.md
 */

import type { Contract } from '@traderalice/ibkr'
import type {
  StagePlaceOrderParams,
  StageModifyOrderParams,
  StageClosePositionParams,
  UnifiedTradingAccount,
} from './UnifiedTradingAccount.js'
import type { PriceChangeInput } from './git/types.js'

// ============================================================================
// AsyncQueue — minimal FIFO queue with async pop
// ============================================================================

export class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(item: T) => void> = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  pop(): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    return new Promise<T>((resolve) => this.waiters.push(resolve))
  }

  /** For test introspection only — not used in production. */
  get pendingCount(): number { return this.items.length }
}

// ============================================================================
// UtaCommand — one variant per public UTA method
// ============================================================================

export type UtaCommand =
  // ---- Mutators (touch local state) ----
  | { type: 'nudgeRecovery' }
  | { type: 'stagePlaceOrder'; params: StagePlaceOrderParams }
  | { type: 'stageModifyOrder'; params: StageModifyOrderParams }
  | { type: 'stageClosePosition'; params: StageClosePositionParams }
  | { type: 'stageCancelOrder'; params: { orderId: string } }
  | { type: 'commit'; message: string }
  | { type: 'push' }
  | { type: 'reject'; reason?: string }
  | { type: 'sync'; opts?: { delayMs?: number } }
  | { type: 'setCurrentRound'; round: number }
  | { type: 'close' }
  // ---- Local-state readers ----
  | { type: 'getHealthInfo' }
  | { type: 'log'; options?: { limit?: number; symbol?: string } }
  | { type: 'show'; hash: string }
  | { type: 'status' }
  | { type: 'getPendingOrderIds' }
  | { type: 'exportGitState' }
  | { type: 'getCapabilities' }
  // ---- Broker passthroughs (no local state) ----
  | { type: 'waitForConnect' }
  | { type: 'simulatePriceChange'; priceChanges: PriceChangeInput[] }
  | { type: 'getAccount' }
  | { type: 'getPositions' }
  | { type: 'getOrders'; orderIds: string[] }
  | { type: 'getQuote'; contract: Contract }
  | { type: 'getMarketClock' }
  | { type: 'searchContracts'; pattern: string }
  | { type: 'refreshCatalog' }
  | { type: 'getContractDetails'; query: Contract }
  | { type: 'getState' }

// ============================================================================
// TsUtaActor — single-mutator queue
// ============================================================================

interface QueuedCommand {
  cmd: UtaCommand
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timeoutMs?: number
}

export interface SendOptions {
  timeoutMs?: number
}

export class TsUtaActor {
  private readonly queue = new AsyncQueue<QueuedCommand>()
  private reentrancyDepth = 0
  private stopped = false

  constructor(private readonly uta: UnifiedTradingAccount) {
    void this.runLoop()
  }

  async send<R>(cmd: UtaCommand, opts: SendOptions = {}): Promise<R> {
    if (this.reentrancyDepth > 0) {
      throw new Error(
        `TsUtaActor: reentrant send() detected for command '${cmd.type}'. ` +
        `Command handlers must call _doFoo() impl methods directly, not actor.send().`,
      )
    }
    if (this.stopped) {
      throw new Error(`TsUtaActor: cannot send command '${cmd.type}' — actor stopped.`)
    }
    return new Promise<R>((resolve, reject) => {
      this.queue.push({
        cmd,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutMs: opts.timeoutMs,
      })
    })
  }

  /** For test introspection only. */
  get pendingCount(): number { return this.queue.pendingCount }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const queued = await this.queue.pop()
      this.reentrancyDepth++
      try {
        const work = this.dispatch(queued.cmd)
        const result = queued.timeoutMs
          ? await Promise.race([work, this.timeoutPromise(queued.timeoutMs, queued.cmd.type)])
          : await work
        queued.resolve(result)
      } catch (e) {
        queued.reject(e)
      } finally {
        this.reentrancyDepth--
      }
    }
  }

  private dispatch(cmd: UtaCommand): Promise<unknown> | unknown {
    switch (cmd.type) {
      // ---- Mutators ----
      case 'nudgeRecovery':       return this.uta._doNudgeRecovery()
      case 'stagePlaceOrder':     return this.uta._doStagePlaceOrder(cmd.params)
      case 'stageModifyOrder':    return this.uta._doStageModifyOrder(cmd.params)
      case 'stageClosePosition':  return this.uta._doStageClosePosition(cmd.params)
      case 'stageCancelOrder':    return this.uta._doStageCancelOrder(cmd.params)
      case 'commit':              return this.uta._doCommit(cmd.message)
      case 'push':                return this.uta._doPush()
      case 'reject':              return this.uta._doReject(cmd.reason)
      case 'sync':                return this.uta._doSync(cmd.opts)
      case 'setCurrentRound':     return this.uta._doSetCurrentRound(cmd.round)
      case 'close':               return this.uta._doClose()
      // ---- Readers ----
      case 'getHealthInfo':       return this.uta._doGetHealthInfo()
      case 'log':                 return this.uta._doLog(cmd.options)
      case 'show':                return this.uta._doShow(cmd.hash)
      case 'status':              return this.uta._doStatus()
      case 'getPendingOrderIds':  return this.uta._doGetPendingOrderIds()
      case 'exportGitState':      return this.uta._doExportGitState()
      case 'getCapabilities':     return this.uta._doGetCapabilities()
      // ---- Broker passthroughs ----
      case 'waitForConnect':      return this.uta._doWaitForConnect()
      case 'simulatePriceChange': return this.uta._doSimulatePriceChange(cmd.priceChanges)
      case 'getAccount':          return this.uta._doGetAccount()
      case 'getPositions':        return this.uta._doGetPositions()
      case 'getOrders':           return this.uta._doGetOrders(cmd.orderIds)
      case 'getQuote':            return this.uta._doGetQuote(cmd.contract)
      case 'getMarketClock':      return this.uta._doGetMarketClock()
      case 'searchContracts':     return this.uta._doSearchContracts(cmd.pattern)
      case 'refreshCatalog':      return this.uta._doRefreshCatalog()
      case 'getContractDetails':  return this.uta._doGetContractDetails(cmd.query)
      case 'getState':            return this.uta._doGetState()
      default: {
        const _exhaustive: never = cmd
        throw new Error(`TsUtaActor: unknown command type ${(_exhaustive as { type: string }).type}`)
      }
    }
  }

  private timeoutPromise(ms: number, name: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TsUtaActor: command '${name}' timed out after ${ms}ms`)), ms),
    )
  }
}
```

This file references `UnifiedTradingAccount._doFoo` methods that don't exist yet. **The file will not compile until Tasks B/C/D add those methods.** That's expected. We commit Task A as a self-contained unit but defer the cross-file tsc check until Task D's pre-commit.

NOTE: the import `import type { ..., UnifiedTradingAccount } from './UnifiedTradingAccount.js'` is a TYPE-only import — won't cause a circular dependency at runtime. The actual `TsUtaActor` instantiation happens INSIDE `UnifiedTradingAccount.ts`, so the types just need to be visible to each other.

- [ ] **Step 2: Verify the file is syntactically valid (lib-only check)**

```bash
npx tsc --noEmit --skipLibCheck src/domain/trading/uta-actor.ts 2>&1 | head -20
```

Expected: errors about UnifiedTradingAccount missing `_doFoo` methods. That's fine — Tasks B/C/D add them. The file's OWN syntax should be sound; the `_doFoo` errors are cross-file.

If the import line itself errors, fix it. If only the dispatch switch lines error, you're good.

- [ ] **Step 3: Create AsyncQueue unit tests**

Create `src/domain/trading/__test__/uta-actor.spec.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { AsyncQueue, TsUtaActor, type UtaCommand } from '../uta-actor.js'

describe('AsyncQueue', () => {
  it('pop after push returns the item synchronously (Promise.resolve)', async () => {
    const q = new AsyncQueue<string>()
    q.push('a')
    expect(await q.pop()).toBe('a')
  })

  it('pop before push waits for the push', async () => {
    const q = new AsyncQueue<string>()
    const popPromise = q.pop()
    q.push('b')
    expect(await popPromise).toBe('b')
  })

  it('FIFO order is preserved under push-then-pop', async () => {
    const q = new AsyncQueue<number>()
    for (let i = 0; i < 10; i++) q.push(i)
    const out: number[] = []
    for (let i = 0; i < 10; i++) out.push(await q.pop())
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('FIFO order is preserved under interleaved push/pop', async () => {
    const q = new AsyncQueue<number>()
    const popResults: Promise<number>[] = []
    // 5 waiters first
    for (let i = 0; i < 5; i++) popResults.push(q.pop())
    // 5 pushes — should satisfy waiters in order
    for (let i = 0; i < 5; i++) q.push(i)
    expect(await Promise.all(popResults)).toEqual([0, 1, 2, 3, 4])
  })

  it('pendingCount reflects buffered (un-popped) items', () => {
    const q = new AsyncQueue<number>()
    expect(q.pendingCount).toBe(0)
    q.push(1)
    q.push(2)
    expect(q.pendingCount).toBe(2)
  })

  it('1000-element stress test maintains FIFO order', async () => {
    const q = new AsyncQueue<number>()
    for (let i = 0; i < 1000; i++) q.push(i)
    const out: number[] = []
    for (let i = 0; i < 1000; i++) out.push(await q.pop())
    expect(out).toEqual(Array.from({ length: 1000 }, (_, i) => i))
  })
})
```

- [ ] **Step 4: Run AsyncQueue tests**

```bash
pnpm test src/domain/trading/__test__/uta-actor.spec.ts 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 5: Add TsUtaActor unit tests with a stub UTA**

Append to the same spec file:

```typescript
// ============================================================================
// TsUtaActor tests with a stubbed UTA
// ============================================================================

/**
 * Builds a minimal stub UTA that implements just the _do methods needed
 * for actor unit tests. Real UTA wiring is exercised in
 * UnifiedTradingAccount.spec.ts and parity/check-uta-concurrency.ts.
 */
function makeStubUta(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const log: Array<{ method: string; args: unknown[] }> = []
  const stub = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (overrides[prop]) {
        return (...args: unknown[]) => {
          log.push({ method: prop, args })
          return overrides[prop](...args)
        }
      }
      return (...args: unknown[]) => {
        log.push({ method: prop, args })
        return undefined
      }
    },
  })
  return { stub, log }
}

describe('TsUtaActor — FIFO ordering', () => {
  it('processes commands in FIFO order', async () => {
    const calls: string[] = []
    const { stub } = makeStubUta({
      _doStagePlaceOrder: () => { calls.push('place'); return { staged: true } },
      _doCommit:          () => { calls.push('commit'); return { prepared: true } },
      _doPush:            () => Promise.resolve().then(() => calls.push('push')),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = new TsUtaActor(stub as any)
    const a = actor.send({ type: 'stagePlaceOrder', params: {} as never })
    const b = actor.send({ type: 'commit', message: 'm' })
    const c = actor.send({ type: 'push' })
    await Promise.all([a, b, c])
    expect(calls).toEqual(['place', 'commit', 'push'])
  })

  it('a slow handler blocks subsequent commands', async () => {
    const order: string[] = []
    let resolveSlow: () => void = () => {}
    const slow = new Promise<void>((r) => { resolveSlow = r })
    const { stub } = makeStubUta({
      _doSync:   async () => { order.push('sync-start'); await slow; order.push('sync-end') },
      _doStatus: () => { order.push('status'); return {} },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = new TsUtaActor(stub as any)
    const syncPromise = actor.send({ type: 'sync' })
    const statusPromise = actor.send({ type: 'status' })
    // Yield once so syncPromise reaches sync-start
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['sync-start']) // status hasn't run yet
    resolveSlow()
    await Promise.all([syncPromise, statusPromise])
    expect(order).toEqual(['sync-start', 'sync-end', 'status'])
  })
})

describe('TsUtaActor — error isolation', () => {
  it('a throwing handler does NOT block subsequent commands', async () => {
    const calls: string[] = []
    const { stub } = makeStubUta({
      _doPush:    () => { calls.push('push'); throw new Error('boom') },
      _doStatus:  () => { calls.push('status'); return {} },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = new TsUtaActor(stub as any)
    const pushP = actor.send({ type: 'push' }).catch((e) => e)
    const statusP = actor.send({ type: 'status' })
    const [pushErr, statusResult] = await Promise.all([pushP, statusP])
    expect((pushErr as Error).message).toBe('boom')
    expect(statusResult).toEqual({})
    expect(calls).toEqual(['push', 'status'])
  })

  it('a rejected promise from a handler propagates as a rejected send()', async () => {
    const { stub } = makeStubUta({
      _doSync: () => Promise.reject(new Error('sync failed')),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = new TsUtaActor(stub as any)
    await expect(actor.send({ type: 'sync' })).rejects.toThrow('sync failed')
  })
})

describe('TsUtaActor — reentrancy detection', () => {
  it('detects reentrant send() and throws', async () => {
    let actor: TsUtaActor | null = null
    const { stub } = makeStubUta({
      // The handler tries to call actor.send() while already inside the actor.
      _doPush: async () => {
        return actor!.send({ type: 'status' })
      },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actor = new TsUtaActor(stub as any)
    await expect(actor.send({ type: 'push' })).rejects.toThrow(/reentrant send/)
  })
})

describe('TsUtaActor — timeout', () => {
  it('rejects after timeoutMs but keeps queue processing', async () => {
    const calls: string[] = []
    const { stub } = makeStubUta({
      _doPush:   () => new Promise(() => { /* never resolves */ }),
      _doStatus: () => { calls.push('status'); return { ok: true } },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = new TsUtaActor(stub as any)
    const pushP = actor.send({ type: 'push' }, { timeoutMs: 50 }).catch((e) => e)
    const statusP = actor.send({ type: 'status' })
    const [pushErr, statusResult] = await Promise.all([pushP, statusP])
    expect((pushErr as Error).message).toMatch(/timed out after 50ms/)
    expect(statusResult).toEqual({ ok: true })
    expect(calls).toEqual(['status'])
  })

  it('does not timeout when handler completes within timeoutMs', async () => {
    const { stub } = makeStubUta({
      _doStatus: async () => { await new Promise((r) => setTimeout(r, 10)); return { fast: true } },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = new TsUtaActor(stub as any)
    const result = await actor.send({ type: 'status' }, { timeoutMs: 100 })
    expect(result).toEqual({ fast: true })
  })
})
```

- [ ] **Step 6: Run all uta-actor tests**

```bash
pnpm test src/domain/trading/__test__/uta-actor.spec.ts 2>&1 | tail -15
```

Expected: 6 (AsyncQueue) + 2 (FIFO) + 2 (error isolation) + 1 (reentrancy) + 2 (timeout) = 13 tests pass.

If any test fails, the actor implementation has a bug — fix in `uta-actor.ts` before proceeding. Tasks B/C/D depend on this being rock-solid.

- [ ] **Step 7: Verify no TS regressions in UNRELATED files**

The actor file references `UnifiedTradingAccount._doFoo` methods that don't exist yet. tsc on the whole repo will fail. To verify the actor file itself is sound:

```bash
pnpm test 2>&1 | tail -5
```

Expected: existing 2228 tests + 13 new uta-actor tests = ~2241 pass. The vitest test runner imports `uta-actor.ts` via the spec file but doesn't trigger full tsc — so the spec runs in isolation.

If tests fail unrelated to the actor, investigate. Otherwise proceed.

- [ ] **Step 8: Commit**

```bash
git add src/domain/trading/uta-actor.ts src/domain/trading/__test__/uta-actor.spec.ts
git commit -m "feat(uta): add TsUtaActor + AsyncQueue + UtaCommand union (Task A)

Phase 4a sub-task A. New module src/domain/trading/uta-actor.ts:
- AsyncQueue<T>: hand-rolled FIFO queue with async pop, no third-party
  dep (~25 lines).
- UtaCommand: discriminated union with one variant per public UTA
  method (29 variants total, grouped: mutators / local readers /
  broker passthroughs).
- TsUtaActor: serial dispatcher reading from the queue, calling
  uta._doFoo() impl methods. Strict no-reentrancy via depth counter.
  Optional per-command timeout via Promise.race.

Note: actor's dispatch switch references uta._doFoo methods that do
not exist yet — Tasks B/C/D add them. tsc errors on the whole repo
until then; vitest can still import the actor spec in isolation.

13 unit tests pass:
- 6 AsyncQueue (push/pop ordering, waiters, 1000-element stress)
- 2 TsUtaActor FIFO (in-order dispatch, slow handler blocks others)
- 2 TsUtaActor error isolation (throws + rejected promises propagate
  but do NOT poison the queue)
- 1 reentrancy detection (handler calling actor.send() throws)
- 2 timeout (rejects on timeout but queue continues; doesn't trigger
  early)

Spec: docs/superpowers/specs/2026-05-12-phase-4a-uta-actor-retrofit-design.md"
```

---

## Task B: UTA refit — mutators (11 methods, the highest-risk group)

**Goal:** Wrap the 11 mutator methods through the actor. These are where the actual concurrency bug lives — `stage*/commit/push/reject/sync` are the methods two parallel AI tool calls today can interleave on the same UTA.

**Files:**
- Modify: `src/domain/trading/UnifiedTradingAccount.ts`

### Method-by-method refit pattern

For EACH of the 11 mutators below, the transformation is identical:

1. **Add a private `_doFoo` method** containing the EXISTING body verbatim. Same return type, same signature minus the `async` keyword on the wrapper (the wrapper becomes `async` because `actor.send` returns Promise).
2. **Add a `UtaCommand` variant** in `uta-actor.ts` (already done in Task A).
3. **Add a switch case in `TsUtaActor.dispatch`** (already done in Task A).
4. **Replace the public `foo()` body** with `return this.actor.send({ type: 'foo', ... })`.
5. **Make sure existing internal callers** (other UTA private methods that currently call `this.foo()`) instead call `this._doFoo()` directly. Otherwise the actor will deadlock on reentrancy.

### Step 1: Add `private actor: TsUtaActor` field + import

Edit `src/domain/trading/UnifiedTradingAccount.ts`. Add the import near the top (with other relative imports):

```typescript
import { TsUtaActor } from './uta-actor.js'
```

In the `UnifiedTradingAccount` class body, near other private fields:

```typescript
private readonly actor: TsUtaActor
```

In the constructor, AFTER all other initialization (so `_doFoo` methods can rely on populated state):

```typescript
this.actor = new TsUtaActor(this)
```

The `this` reference passes the UTA into the actor; the actor calls `this.uta._doFoo()` from its dispatch switch.

### Step 2: Refit `nudgeRecovery()`

Find the current `nudgeRecovery(): void` method (~line 290).

```typescript
// BEFORE:
nudgeRecovery(): void {
  // ... existing body ...
}

// AFTER (split into wrapper + impl):
nudgeRecovery(): void {
  // Note: returns void synchronously; we don't await actor.send for
  // backward-compat. The command still queues correctly.
  void this.actor.send({ type: 'nudgeRecovery' })
}

_doNudgeRecovery(): void {
  // ... existing body, verbatim ...
}
```

NOTE on void return: `nudgeRecovery` was synchronous and returned void. After refit, it queues the command but doesn't wait. This is acceptable for "fire-and-forget" mutators. If callers actually depend on synchronous completion (check by grepping `nudgeRecovery()` callers), promote the wrapper to async + await:

```bash
grep -rn "\.nudgeRecovery(" src/ --include='*.ts' | grep -v ".spec." | head
```

If no caller awaits or chains a promise off it, the void wrapper is fine.

- [ ] **Step 3: Refit `stagePlaceOrder()`**

Find current method (~line 347):

```typescript
// BEFORE:
stagePlaceOrder(params: StagePlaceOrderParams): AddResult {
  // ... existing body ...
}

// AFTER:
async stagePlaceOrder(params: StagePlaceOrderParams): Promise<AddResult> {
  return this.actor.send<AddResult>({ type: 'stagePlaceOrder', params })
}

_doStagePlaceOrder(params: StagePlaceOrderParams): AddResult {
  // ... existing body, verbatim ...
}
```

NOTE on signature change: `stagePlaceOrder` was synchronous returning `AddResult`. After refit, it's async returning `Promise<AddResult>`. **This is a public API breaking change.** Callers that did `const r = uta.stagePlaceOrder(...)` will now get a Promise — they must `await` it.

Check callers:

```bash
grep -rn "\.stagePlaceOrder(" src/ --include='*.ts' | grep -v ".spec." | head
```

For each caller, add `await` if not already present. The TS compiler will catch missing awaits in strict mode (warning about Promise<X> not assignable to X). Update callers in this same commit.

This async-ification applies to ALL mutators that were previously synchronous: `stagePlaceOrder/Modify/Close/Cancel`, `commit`, `setCurrentRound`. Plan for caller updates ahead of time:

```bash
for fn in stagePlaceOrder stageModifyOrder stageClosePosition stageCancelOrder commit setCurrentRound nudgeRecovery; do
  echo "=== $fn ==="
  grep -rn "\.$fn(" src/ --include='*.ts' | grep -v ".spec." | grep -v "_do$fn" | head -5
done
```

Track call sites in your editor; update them as you refit each method.

- [ ] **Step 4: Refit `stageModifyOrder()`**

Find current method (~line 381). Same transformation:

```typescript
async stageModifyOrder(params: StageModifyOrderParams): Promise<AddResult> {
  return this.actor.send<AddResult>({ type: 'stageModifyOrder', params })
}

_doStageModifyOrder(params: StageModifyOrderParams): AddResult {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 5: Refit `stageClosePosition()`**

Find current method (~line 395). Same transformation:

```typescript
async stageClosePosition(params: StageClosePositionParams): Promise<AddResult> {
  return this.actor.send<AddResult>({ type: 'stageClosePosition', params })
}

_doStageClosePosition(params: StageClosePositionParams): AddResult {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 6: Refit `stageCancelOrder()`**

Find current method (~line 411). Same transformation:

```typescript
async stageCancelOrder(params: { orderId: string }): Promise<AddResult> {
  return this.actor.send<AddResult>({ type: 'stageCancelOrder', params })
}

_doStageCancelOrder(params: { orderId: string }): AddResult {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 7: Refit `commit()`**

Find current method (~line 417). Same transformation:

```typescript
async commit(message: string): Promise<CommitPrepareResult> {
  return this.actor.send<CommitPrepareResult>({ type: 'commit', message })
}

_doCommit(message: string): CommitPrepareResult {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 8: Refit `push()`**

Find current method (~line 421). Already async — easier:

```typescript
async push(): Promise<PushResult> {
  return this.actor.send<PushResult>({ type: 'push' })
}

async _doPush(): Promise<PushResult> {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 9: Refit `reject()`**

Find current method (~line 433). Same transformation as push:

```typescript
async reject(reason?: string): Promise<RejectResult> {
  return this.actor.send<RejectResult>({ type: 'reject', reason })
}

async _doReject(reason?: string): Promise<RejectResult> {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 10: Refit `sync()`**

Find current method (~line 453). Same transformation:

```typescript
async sync(opts?: { delayMs?: number }): Promise<SyncResult> {
  return this.actor.send<SyncResult>({ type: 'sync', opts })
}

async _doSync(opts?: { delayMs?: number }): Promise<SyncResult> {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 11: Refit `setCurrentRound()`**

Find current method (~line 506). Same transformation:

```typescript
async setCurrentRound(round: number): Promise<void> {
  await this.actor.send<void>({ type: 'setCurrentRound', round })
}

_doSetCurrentRound(round: number): void {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 12: Refit `close()`**

Find current method (~line 578). Already async:

```typescript
async close(): Promise<void> {
  return this.actor.send<void>({ type: 'close' })
}

async _doClose(): Promise<void> {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 13: Update internal UTA callers that use mutators**

Some private UTA methods may call other public UTA methods internally. For each refit method, those internal calls MUST switch to `_doFoo` to avoid reentrant deadlock.

```bash
grep -nE "this\.(stagePlaceOrder|stageModifyOrder|stageClosePosition|stageCancelOrder|commit|push|reject|sync|setCurrentRound|nudgeRecovery|close)\(" src/domain/trading/UnifiedTradingAccount.ts | head
```

For each match (excluding the public method's own definition line), change `this.foo(...)` to `this._doFoo(...)`. Keep the same arguments.

If a match is in a public method body that you've already refit (the wrapper just calls `this.actor.send(...)`), no change needed — it's already correctly using the public path.

If a match is in a private helper, update it.

- [ ] **Step 14: Update external callers that newly need await**

For each method whose signature changed from sync to async (`stagePlaceOrder/Modify/Close/Cancel`, `commit`, `setCurrentRound`, `nudgeRecovery` if its callers were treating it as sync), find and update callers:

```bash
grep -rn "\.stagePlaceOrder(\|\.stageModifyOrder(\|\.stageClosePosition(\|\.stageCancelOrder(\|\.commit(\|\.setCurrentRound(" src/ --include='*.ts' | grep -v ".spec." | grep -v "_doStage\|_doCommit\|_doSetCurrentRound" | grep -v "UnifiedTradingAccount.ts"
```

For each caller, add `await` if the surrounding function is async. If it's sync, the function itself needs to become async or the call needs `void` prefix (fire-and-forget) — choose based on whether the caller depends on the return value.

NOTE: `tool/trading.ts` is a likely caller (the AI tools dispatch through here). Update carefully.

- [ ] **Step 15: tsc check**

```bash
npx tsc --noEmit 2>&1 | tail -20
```

Expected: clean OR a small list of "Type 'Promise<X>' is not assignable to type 'X'" errors at sync→async boundaries you missed in Step 14. Fix each by adding `await` and (if needed) propagating async upward.

- [ ] **Step 16: Run UTA spec tests**

```bash
pnpm test src/domain/trading/UnifiedTradingAccount.spec.ts 2>&1 | tail -15
```

Expected: existing tests pass (any tests that called the now-async methods may need `await`). If a test fails because it expected synchronous return, update the test to await.

- [ ] **Step 17: Run full TS test suite**

```bash
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: ~2241 tests pass (2228 baseline + 13 from Task A; UTA refit doesn't add tests in B but doesn't lose any either).

- [ ] **Step 18: Commit**

```bash
git add src/domain/trading/UnifiedTradingAccount.ts src/  # also any caller files modified in Step 14
git commit -m "refactor(uta): route 11 mutator methods through TsUtaActor (Task B)

Phase 4a sub-task B. Adds private _doFoo impl methods for each of the
11 mutators (existing bodies verbatim) and replaces public method
bodies with this.actor.send wrappers:

  nudgeRecovery, stagePlaceOrder, stageModifyOrder, stageClosePosition,
  stageCancelOrder, commit, push, reject, sync, setCurrentRound, close

Public API change: previously-synchronous methods (stage*, commit,
setCurrentRound, nudgeRecovery) now return Promise<...>. Callers
updated accordingly.

Internal callers that previously invoked public methods now call
_doFoo() impl methods directly (otherwise the actor would deadlock
on reentrancy).

Existing UnifiedTradingAccount.spec.ts tests pass with await additions
where needed. Full suite ~2241 green."
```

---

## Task C: UTA refit — local-state readers (7 methods)

**Goal:** Wrap the 7 local-state-reader methods. Same mechanical pattern as Task B. Lower risk because readers don't mutate state — but they still race with mutators, so serializing them through the actor closes the read/write race.

**Files:**
- Modify: `src/domain/trading/UnifiedTradingAccount.ts`

Methods to refit (all read local UTA state — TradingGit, broker connection state, health):

1. `getHealthInfo`
2. `log`
3. `show`
4. `status`
5. `getPendingOrderIds`
6. `exportGitState`
7. `getCapabilities`

### Step 1: Refit `getHealthInfo()`

Find current method (~line 206). Same pattern as Task B:

```typescript
async getHealthInfo(): Promise<BrokerHealthInfo> {
  return this.actor.send<BrokerHealthInfo>({ type: 'getHealthInfo' })
}

_doGetHealthInfo(): BrokerHealthInfo {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 2: Refit `log()`**

Find current method (~line 441):

```typescript
async log(options?: { limit?: number; symbol?: string }): Promise<CommitLogEntry[]> {
  return this.actor.send<CommitLogEntry[]>({ type: 'log', options })
}

_doLog(options?: { limit?: number; symbol?: string }): CommitLogEntry[] {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 3: Refit `show()`**

Find current method (~line 445):

```typescript
async show(hash: string): Promise<GitCommit | null> {
  return this.actor.send<GitCommit | null>({ type: 'show', hash })
}

_doShow(hash: string): GitCommit | null {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 4: Refit `status()`**

Find current method (~line 449):

```typescript
async status(): Promise<GitStatus> {
  return this.actor.send<GitStatus>({ type: 'status' })
}

_doStatus(): GitStatus {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 5: Refit `getPendingOrderIds()`**

Find current method (~line 498):

```typescript
async getPendingOrderIds(): Promise<Array<{ orderId: string; symbol: string }>> {
  return this.actor.send<Array<{ orderId: string; symbol: string }>>({ type: 'getPendingOrderIds' })
}

_doGetPendingOrderIds(): Array<{ orderId: string; symbol: string }> {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 6: Refit `exportGitState()`**

Find current method (~line 572):

```typescript
async exportGitState(): Promise<GitExportState> {
  return this.actor.send<GitExportState>({ type: 'exportGitState' })
}

_doExportGitState(): GitExportState {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 7: Refit `getCapabilities()`**

Find current method (~line 562):

```typescript
async getCapabilities(): Promise<AccountCapabilities> {
  return this.actor.send<AccountCapabilities>({ type: 'getCapabilities' })
}

_doGetCapabilities(): AccountCapabilities {
  // ... existing body, verbatim ...
}
```

- [ ] **Step 8: Update external callers needing `await`**

```bash
for fn in getHealthInfo log show status getPendingOrderIds exportGitState getCapabilities; do
  echo "=== $fn ==="
  grep -rn "\.$fn(" src/ --include='*.ts' | grep -v ".spec." | grep -v "_doGet\|_doLog\|_doShow\|_doStatus\|_doExport" | grep -v "UnifiedTradingAccount.ts" | head -3
done
```

For each caller, add `await` if surrounding context is async. Update.

- [ ] **Step 9: Update internal UTA callers**

```bash
grep -nE "this\.(getHealthInfo|log|show|status|getPendingOrderIds|exportGitState|getCapabilities)\(" src/domain/trading/UnifiedTradingAccount.ts | head
```

Match these to private helpers. Replace `this.foo(...)` with `this._doFoo(...)` to avoid reentrant deadlock.

- [ ] **Step 10: tsc check**

```bash
npx tsc --noEmit 2>&1 | tail -20
```

Expected: clean.

- [ ] **Step 11: Run full TS test suite**

```bash
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: ~2241 tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/domain/trading/UnifiedTradingAccount.ts src/
git commit -m "refactor(uta): route 7 local-state readers through TsUtaActor (Task C)

Phase 4a sub-task C. Adds private _doFoo impl methods for the 7
local-state readers and replaces public method bodies with
this.actor.send wrappers:

  getHealthInfo, log, show, status, getPendingOrderIds,
  exportGitState, getCapabilities

Closes the read/write race where status() called concurrently with
push() could observe torn TradingGit state. Both calls now serialize
through the actor.

Public API change: all 7 methods now return Promise<...>. Callers
updated. No behavioral change for sequential callers.

Full suite ~2241 green."
```

---

## Task D: UTA refit — broker passthroughs + concurrency test + DoD

**Goal:** Wrap the 11 broker passthrough methods. Then add the concurrency test that proves the actor pattern actually fixes the race. Final DoD verification.

**Files:**
- Modify: `src/domain/trading/UnifiedTradingAccount.ts`
- Create: `parity/check-uta-concurrency.ts`

### Methods to refit

1. `waitForConnect`
2. `simulatePriceChange`
3. `getAccount`
4. `getPositions`
5. `getOrders`
6. `getQuote`
7. `getMarketClock`
8. `searchContracts`
9. `refreshCatalog`
10. `getContractDetails`
11. `getState`

All are already async (all return `Promise<X>`), so the refit is even simpler than Task B/C — no sync→async signature change.

### Step 1: Refit all 11 broker passthroughs

Same mechanical pattern. For each method, the wrapper becomes:

```typescript
async fooName(arg1: T1, arg2: T2): Promise<R> {
  return this.actor.send<R>({ type: 'fooName', /* embed args */ })
}

async _doFooName(arg1: T1, arg2: T2): Promise<R> {
  // ... existing body, verbatim ...
}
```

Specific transformations (one bullet per method):

```typescript
// waitForConnect (~line 189)
async waitForConnect(): Promise<void> {
  return this.actor.send<void>({ type: 'waitForConnect' })
}
async _doWaitForConnect(): Promise<void> { /* existing body */ }

// simulatePriceChange (~line 502)
async simulatePriceChange(priceChanges: PriceChangeInput[]): Promise<SimulatePriceChangeResult> {
  return this.actor.send<SimulatePriceChangeResult>({ type: 'simulatePriceChange', priceChanges })
}
async _doSimulatePriceChange(priceChanges: PriceChangeInput[]): Promise<SimulatePriceChangeResult> { /* existing body */ }

// getAccount (~line 512)
async getAccount(): Promise<AccountInfo> {
  return this.actor.send<AccountInfo>({ type: 'getAccount' })
}
async _doGetAccount(): Promise<AccountInfo> { /* existing body */ }

// getPositions (~line 516)
async getPositions(): Promise<Position[]> {
  return this.actor.send<Position[]>({ type: 'getPositions' })
}
async _doGetPositions(): Promise<Position[]> { /* existing body */ }

// getOrders (~line 522)
async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
  return this.actor.send<OpenOrder[]>({ type: 'getOrders', orderIds })
}
async _doGetOrders(orderIds: string[]): Promise<OpenOrder[]> { /* existing body */ }

// getQuote (~line 528)
async getQuote(contract: Contract): Promise<Quote> {
  return this.actor.send<Quote>({ type: 'getQuote', contract })
}
async _doGetQuote(contract: Contract): Promise<Quote> { /* existing body */ }

// getMarketClock (~line 534)
async getMarketClock(): Promise<MarketClock> {
  return this.actor.send<MarketClock>({ type: 'getMarketClock' })
}
async _doGetMarketClock(): Promise<MarketClock> { /* existing body */ }

// searchContracts (~line 538)
async searchContracts(pattern: string): Promise<ContractDescription[]> {
  return this.actor.send<ContractDescription[]>({ type: 'searchContracts', pattern })
}
async _doSearchContracts(pattern: string): Promise<ContractDescription[]> { /* existing body */ }

// refreshCatalog (~line 551)
async refreshCatalog(): Promise<void> {
  return this.actor.send<void>({ type: 'refreshCatalog' })
}
async _doRefreshCatalog(): Promise<void> { /* existing body */ }

// getContractDetails (~line 556)
async getContractDetails(query: Contract): Promise<ContractDetails | null> {
  return this.actor.send<ContractDetails | null>({ type: 'getContractDetails', query })
}
async _doGetContractDetails(query: Contract): Promise<ContractDetails | null> { /* existing body */ }

// getState (~line 568)
async getState(): Promise<GitState> {
  return this.actor.send<GitState>({ type: 'getState' })
}
async _doGetState(): Promise<GitState> { /* existing body */ }
```

- [ ] **Step 2: Update internal UTA callers**

```bash
grep -nE "this\.(waitForConnect|simulatePriceChange|getAccount|getPositions|getOrders|getQuote|getMarketClock|searchContracts|refreshCatalog|getContractDetails|getState)\(" src/domain/trading/UnifiedTradingAccount.ts | head
```

For each match in a private helper, switch to `this._doFoo(...)`.

- [ ] **Step 3: tsc check**

```bash
npx tsc --noEmit 2>&1 | tail -20
```

Expected: clean. The actor's dispatch switch in `uta-actor.ts` (written in Task A) references all 29 `_doFoo` methods — they should ALL exist now after Tasks B/C/D. If tsc still errors with "Property '_doFoo' does not exist", a method was missed.

- [ ] **Step 4: Run full TS test suite**

```bash
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: ~2241 tests pass.

- [ ] **Step 5: Create the concurrency test**

Create `parity/check-uta-concurrency.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * parity/check-uta-concurrency.ts
 *
 * Phase 4a DoD: 100 parallel stage/commit/push/sync calls on one UTA
 * produce a coherent serialized log.
 *
 * Strategy:
 *   1. Construct a UTA backed by a stubbed broker that introduces
 *      randomized 0-50ms delays per call (forces microtask interleaving)
 *   2. Fire 100 lifecycles in parallel via Promise.all
 *   3. Assert:
 *      a. Total commit count = expected (no lost / duplicate commits)
 *      b. Per-commit operation lists are coherent (each commit's
 *         operations match its own lifecycle, never another's)
 *      c. Every v2 hash in the export re-verifies via Phase 2
 *         PersistedCommit::verify
 *
 * With the actor in place, all 3 assertions pass every run.
 */

import { Contract } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { UnifiedTradingAccount } from '../src/domain/trading/UnifiedTradingAccount.js'
import {
  classifyCommit,
  verifyCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'
import type { IBroker, AccountInfo, Position, Quote, OpenOrder, AccountCapabilities, BrokerHealthInfo, MarketClock, BrokerHealth } from '../src/domain/trading/brokers/types.js'

const N_LIFECYCLES = 100
const STUB_DELAY_MAX_MS = 50

function randDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.random() * STUB_DELAY_MAX_MS))
}

function buildContract(symbol: string): Contract {
  const c = new Contract()
  c.aliceId = `mock|${symbol}`
  c.symbol = symbol
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  return c
}

function makeStubBroker(): IBroker {
  let nextOrderId = 1
  return {
    async connect() { await randDelay() },
    async disconnect() { await randDelay() },
    async getAccount(): Promise<AccountInfo> {
      await randDelay()
      return { accountId: 'TEST', currency: 'USD' } as AccountInfo
    },
    async getPositions(): Promise<Position[]> { await randDelay(); return [] },
    async getOpenOrders(): Promise<OpenOrder[]> { await randDelay(); return [] },
    async placeOrder(_contract, _order, _tpsl) {
      await randDelay()
      return { orderId: `o-${nextOrderId++}`, status: 'submitted' as const }
    },
    async modifyOrder() { await randDelay(); return { orderId: 'modified', status: 'submitted' as const } },
    async cancelOrder() { await randDelay() },
    async closePosition(contract: Contract) {
      await randDelay()
      return { orderId: `o-${nextOrderId++}`, status: 'submitted' as const }
    },
    async getQuote(contract: Contract): Promise<Quote> {
      await randDelay()
      return { contract, bid: '100', ask: '100.5', last: '100.25', timestamp: new Date().toISOString() } as Quote
    },
    async getOrderState() { await randDelay(); return null },
    async getMarketClock(): Promise<MarketClock> {
      await randDelay()
      return { isOpen: true, nextOpen: '', nextClose: '' } as MarketClock
    },
    async searchContracts() { await randDelay(); return [] },
    async refreshCatalog() { await randDelay() },
    async getContractDetails() { await randDelay(); return null },
    getCapabilities(): AccountCapabilities {
      return { name: 'StubBroker', supportsModifyOrder: true, supportsTpSl: true } as AccountCapabilities
    },
    getHealth(): BrokerHealth { return 'healthy' },
    getHealthInfo(): BrokerHealthInfo { return { status: 'healthy', lastCheck: new Date().toISOString() } as BrokerHealthInfo },
    async waitForConnect() { /* no-op */ },
  } as unknown as IBroker
}

async function singleLifecycle(uta: UnifiedTradingAccount, lifecycleId: number): Promise<void> {
  const symbol = `SYM${lifecycleId.toString().padStart(3, '0')}`
  await uta.stagePlaceOrder({
    contract: buildContract(symbol),
    side: 'BUY',
    qty: new Decimal(1),
    orderType: 'MKT',
  } as any)
  await uta.commit(`lifecycle-${lifecycleId}`)
  await uta.push()
}

async function main(): Promise<void> {
  const broker = makeStubBroker()
  const uta = new UnifiedTradingAccount(broker)
  await uta.waitForConnect()

  const tasks: Promise<void>[] = []
  for (let i = 0; i < N_LIFECYCLES; i++) tasks.push(singleLifecycle(uta, i))
  await Promise.all(tasks)

  // ---- Assertion 1: total commit count ----
  const exportState = await uta.exportGitState()
  if (exportState.commits.length !== N_LIFECYCLES) {
    throw new Error(`Expected ${N_LIFECYCLES} commits, got ${exportState.commits.length}`)
  }
  console.log(`OK: ${exportState.commits.length} commits (matches ${N_LIFECYCLES} lifecycles)`)

  // ---- Assertion 2: per-commit operation coherence ----
  const seenLifecycles = new Set<number>()
  for (const commit of exportState.commits) {
    const match = commit.message.match(/lifecycle-(\d+)/)
    if (!match) throw new Error(`Commit message missing lifecycle id: ${commit.message}`)
    const lifecycleId = parseInt(match[1])
    if (seenLifecycles.has(lifecycleId)) throw new Error(`Duplicate lifecycle ${lifecycleId}`)
    seenLifecycles.add(lifecycleId)
    if (commit.operations.length !== 1) {
      throw new Error(`Commit ${commit.hash} has ${commit.operations.length} ops; expected 1`)
    }
    const op = commit.operations[0]
    if (op.action !== 'placeOrder') throw new Error(`Commit ${commit.hash}: expected placeOrder, got ${op.action}`)
    const expectedSymbol = `SYM${lifecycleId.toString().padStart(3, '0')}`
    const opSymbol = (op as any).contract?.symbol
    if (opSymbol !== expectedSymbol) {
      throw new Error(`Commit ${commit.hash}: operation symbol ${opSymbol}, expected ${expectedSymbol} (lifecycle interleaving!)`)
    }
  }
  console.log(`OK: all ${exportState.commits.length} commits have coherent operation lists`)

  // ---- Assertion 3: every v2 hash re-verifies ----
  let verified = 0
  let mismatches = 0
  for (const raw of exportState.commits) {
    const rehydrated = { ...raw, operations: raw.operations.map(rehydrateOperation) }
    const result = verifyCommit(classifyCommit(rehydrated))
    if (result.kind === 'verified') verified++
    else if (result.kind === 'mismatch') {
      console.error(`MISMATCH ${result.hash}: ${result.message}`)
      mismatches++
    }
  }
  if (mismatches > 0) throw new Error(`${mismatches} v2 hash mismatches`)
  console.log(`OK: all ${verified} v2 commits verify`)

  console.log('\nAll Phase 4a concurrency assertions passed.')
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 6: Run the concurrency test**

```bash
pnpm tsx parity/check-uta-concurrency.ts 2>&1 | tail -10
```

Expected:
```
OK: 100 commits (matches 100 lifecycles)
OK: all 100 commits have coherent operation lists
OK: all 100 v2 commits verify
All Phase 4a concurrency assertions passed.
```

If any assertion fails, the actor isn't actually serializing or there's a leak in the refit. Diagnosis paths:
- Assertion 1 fails: commits being lost or duplicated → race in commit/push pair
- Assertion 2 fails: operations interleaving across lifecycles → stage/commit boundary race
- Assertion 3 fails: hash mismatch → operation pre-inflation issue (unlikely since this matches what we already verify)

Run the script 5-10 times to confirm stability:

```bash
for i in {1..10}; do echo "Run $i:"; pnpm tsx parity/check-uta-concurrency.ts 2>&1 | tail -1; done
```

All 10 runs should pass.

- [ ] **Step 7: Run e2e tests if they exist**

```bash
pnpm test:e2e 2>&1 | tail -10
```

Expected: pass (or skip cleanly if e2e infrastructure isn't present in dev env).

- [ ] **Step 8: Final DoD verification**

```bash
echo "=== npx tsc --noEmit ==="
npx tsc --noEmit 2>&1 | tail -3

echo "=== pnpm test ==="
pnpm test 2>&1 | grep -E "Tests" | tail -1

echo "=== concurrency test ==="
pnpm tsx parity/check-uta-concurrency.ts 2>&1 | tail -5

echo "=== UTA method counts ==="
grep -c "^  async [a-z]" src/domain/trading/UnifiedTradingAccount.ts | head -1
grep -c "^  _do[A-Z]" src/domain/trading/UnifiedTradingAccount.ts | head -1
```

Expected:
- tsc clean
- ~2241 tests pass
- Concurrency assertions pass
- ~29 public async methods + ~29 _do private methods (numbers should match)

- [ ] **Step 9: Commit**

```bash
git add src/domain/trading/UnifiedTradingAccount.ts parity/check-uta-concurrency.ts
git commit -m "refactor(uta): route 11 broker passthroughs through actor + concurrency test (Task D)

Phase 4a sub-task D. Closes Phase 4a.

- Adds _doFoo impl methods for the 11 broker passthroughs and routes
  the public methods through this.actor.send. All 11 were already
  async, so no signature change for callers.

- New parity/check-uta-concurrency.ts: fires 100 parallel stage/commit/
  push lifecycles on one UTA backed by a stubbed broker with
  randomized 0-50ms delays. Asserts:
  1. Total commit count = 100 (no lost / duplicate commits)
  2. Per-commit operation lists coherent (no interleaving across
     lifecycles)
  3. Every v2 hash re-verifies via Phase 2 PersistedCommit::verify

All 3 assertions pass consistently across 10 consecutive runs.

DoD gates:
  - npx tsc --noEmit: clean
  - pnpm test: ~2241 tests pass (2228 baseline + 13 actor unit tests)
  - pnpm tsx parity/check-uta-concurrency.ts: all assertions pass
  - pnpm test:e2e: pass

Phase 4a complete. UnifiedTradingAccount is now safe under concurrent
use. Public surface unchanged from external callers' perspective except
that previously-sync mutators (stage*, commit, setCurrentRound) are
now async. All in-tree callers updated."
```

---

## Self-Review

**Spec coverage:**
- Spec §Architecture (single new module, big-bang migration) → Tasks A-D
- Spec §Resolved decisions 1-7 → embedded throughout
- Spec §AsyncQueue → Task A Step 1
- Spec §UtaCommand discriminated union → Task A Step 1
- Spec §TsUtaActor (reentrancy, timeout, error handling) → Task A Steps 1-6
- Spec §Reentrancy (strict no-reentrancy + runtime detection) → Task A Step 1, tested in Step 5
- Spec §Backpressure / timeout (no backpressure, opt-in timeout) → Task A Step 1, tested in Step 5
- Spec §Error handling (queue continues after handler throws) → tested in Task A Step 5
- Spec §Migration approach (big-bang within one PR) → Tasks B+C+D explicit; commits per cluster
- Spec §Concurrency test → Task D Step 5
- Spec §Files → all 4 files present
- Spec §DoD gates → Task D Step 8
- Spec §Cutover gate (concurrency test passes consistently across 100+ runs) → Task D Step 6 includes a 10-run loop

**Placeholder scan:** None. The `// ... existing body, verbatim ...` comments in Tasks B/C/D are deliberate transcription instructions (the existing TS body must be COPIED verbatim into the new `_doFoo`), not implementation gaps.

**Type consistency:** `TsUtaActor`, `AsyncQueue`, `UtaCommand`, `_doFoo` (the private impl convention), `actor.send`, `reentrancyDepth` used consistently across all 4 tasks. The 29 method names in Task A's union are the same names refit in Tasks B/C/D.

**Potential concerns flagged:**
1. Public API breaking change (sync→async for stage*/commit/setCurrentRound/nudgeRecovery). Tasks B Steps 3 + 14 explicitly call out caller updates. The user should confirm they're ok with this — it's load-bearing for the actor pattern.
2. Concurrency test imports `IBroker` types — the stub may need adjustment if IBroker shape doesn't exactly match (Task D Step 5's stub uses `as unknown as IBroker` to handle any drift; if it's too aggressive, narrow per-method).
3. `nudgeRecovery` returns void synchronously in the wrapper (fire-and-forget). If any caller relies on completion, change to `await this.actor.send(...)`.

---

## Execution notes

- Strict A → B → C → D order. Don't parallelize.
- Tasks B/C/D are the bulk of the work — each ~30 minutes per method × 11/7/11 methods = roughly 5/3/5 hours total. Plus caller updates.
- After Task A, the repo's `tsc --noEmit` will fail until Task D completes (the actor's dispatch switch references methods that don't exist yet). Use `pnpm test` which runs vitest in isolation per file.
- The `_doFoo` naming convention is enforced by grep, not by the type system. Keep it consistent — future Phase 4d Rust port will mirror.
