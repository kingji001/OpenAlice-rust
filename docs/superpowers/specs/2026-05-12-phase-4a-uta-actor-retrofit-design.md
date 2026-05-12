# Phase 4a — TS UTA Actor Retrofit

**Status:** approved 2026-05-12.
**Source:** [`docs/RUST_MIGRATION_PLAN.v4.md:775-809`](../../RUST_MIGRATION_PLAN.v4.md), expanded with the design decisions below.

## Resolved decisions

| # | Decision |
|---|----------|
| 1 | **All ~30 public UTA methods route through the actor.** Uniform discipline; no cognitive load deciding "is this method safe to call concurrently?" Trade-off: queue latency added to read-only broker passthroughs, accepted for simplicity. |
| 2 | **Discriminated `UtaCommand` union** with one variant per public method. Type-safe explicit list; per-command tracing/metrics straightforward. Trade-off: boilerplate scales linearly with method count (~30 entries) — accepted for explicit auditing on every new method. |
| 3 | **Strict no-reentrancy.** Command handlers never call `actor.send()`. Internal callers invoke `_doFoo()` impl methods directly. Reentrant calls detected at runtime and throw. |
| 4 | **No backpressure / queue depth limit.** Queue grows unbounded — same as today's behavior. Phase 4d (Rust UtaActor) can add limits when warranted. |
| 5 | **Per-command timeout: optional, default unset.** `actor.send(cmd, { timeoutMs })` rejects on timeout but keeps queue processing. UTA's existing methods don't pass a timeout — behavior unchanged for default callers. |
| 6 | **Big-bang migration within one PR.** All ~30 methods retrofitted at once. A half-migrated UTA (some serialized, some not) is more dangerous than the current state. |
| 7 | **State ownership: UTA keeps owning all state** (broker, TradingGit, health counters). Actor only owns the queue + a reference to the UTA. Least-invasive refit. |

## Goal

Eliminate the latent concurrency hole in `src/domain/trading/UnifiedTradingAccount.ts` (586 lines, ~30 public methods) where parallel AI tool calls can interleave `stage / commit / push / sync` on the same UTA instance with no lock. Wrap every public method in an actor queue so calls serialize FIFO.

The actor pattern is independently valuable: ships a real concurrency safety improvement to TS production code regardless of whether Phase 4d (Rust UtaActor) ever lands. Phase 4d will adopt the same shape on the Rust side.

## Architecture

Single new module `src/domain/trading/uta-actor.ts` exporting `AsyncQueue<T>`, `UtaCommand` discriminated union, and `TsUtaActor` class. The actor holds:

- A FIFO queue (hand-rolled — see §AsyncQueue)
- A reference to the UTA: `private uta: UnifiedTradingAccount`
- A reentrancy depth counter

The UTA's public methods become thin wrappers — public API is unchanged from outside callers' perspective:

```typescript
async push(): Promise<PushResult> {
  return this.actor.send({ type: 'push' })
}
private async _doPush(): Promise<PushResult> {
  // existing body, verbatim from before refit
}
```

The actor's handler dispatches by command type:

```typescript
switch (cmd.type) {
  case 'stagePlaceOrder':  return this.uta._doStagePlaceOrder(cmd.params)
  case 'commit':           return this.uta._doCommit(cmd.message)
  case 'push':             return this.uta._doPush()
  case 'sync':             return this.uta._doSync(cmd.opts)
  case 'getQuote':         return this.uta._doGetQuote(cmd.contract)
  // ... ~30 cases total
  default: { const _exhaustive: never = cmd; throw new Error('unknown command') }
}
```

## AsyncQueue

Hand-rolled, ~50 lines. No third-party dependency. The actor doesn't need priority/concurrency/throttling — just FIFO serialization with async `pop()`.

```typescript
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
}
```

Reasoning: vendoring a small dep (`p-queue`, `@opcw/queue`, etc.) trades trivial code for a supply-chain risk. The implementation is testable in isolation.

## UtaCommand discriminated union

One variant per public UTA method. Approximately 30 variants in 3 groups. Each variant carries the parameters the method takes (or omits the field if the method takes none).

Example sketch (the full list maps 1:1 to UTA's current public methods):

```typescript
export type UtaCommand =
  // ---- Mutators (touch local state) ----
  | { type: 'stagePlaceOrder'; params: StagePlaceOrderParams }
  | { type: 'stageModifyOrder'; params: StageModifyOrderParams }
  | { type: 'stageClosePosition'; params: StageClosePositionParams }
  | { type: 'stageCancelOrder'; params: { orderId: string } }
  | { type: 'commit'; message: string }
  | { type: 'push' }
  | { type: 'reject'; reason?: string }
  | { type: 'sync'; opts?: { delayMs?: number } }
  | { type: 'nudgeRecovery' }
  | { type: 'setCurrentRound'; round: number }
  | { type: 'close' }
  // ---- Local-state readers ----
  | { type: 'log'; options?: { limit?: number; symbol?: string } }
  | { type: 'show'; hash: string }
  | { type: 'status' }
  | { type: 'getPendingOrderIds' }
  | { type: 'exportGitState' }
  | { type: 'getCapabilities' }
  | { type: 'getHealthInfo' }
  // ---- Broker passthroughs ----
  | { type: 'getAccount' }
  | { type: 'getPositions' }
  | { type: 'getOrders'; orderIds: string[] }
  | { type: 'getQuote'; contract: Contract }
  | { type: 'getMarketClock' }
  | { type: 'searchContracts'; pattern: string }
  | { type: 'refreshCatalog' }
  | { type: 'getContractDetails'; query: Contract }
  | { type: 'simulatePriceChange'; priceChanges: PriceChangeInput[] }
  | { type: 'getState' }
  | { type: 'waitForConnect' }
```

Adding a 31st UTA method requires adding the variant + switch case. The TS exhaustiveness check (`const _exhaustive: never = cmd`) catches any missed case at compile time.

## TsUtaActor

```typescript
export class TsUtaActor {
  private readonly queue = new AsyncQueue<QueuedCommand>()
  private running = false
  private reentrancyDepth = 0

  constructor(private readonly uta: UnifiedTradingAccount) {
    void this.runLoop()
  }

  async send<R>(cmd: UtaCommand, opts: { timeoutMs?: number } = {}): Promise<R> {
    if (this.reentrancyDepth > 0) {
      throw new Error(
        `TsUtaActor: reentrant send() detected for command '${cmd.type}'. ` +
        `Command handlers must call _doFoo() impl methods directly, not actor.send().`,
      )
    }
    return new Promise<R>((resolve, reject) => {
      const queued: QueuedCommand = { cmd, resolve, reject, timeoutMs: opts.timeoutMs }
      this.queue.push(queued)
    })
  }

  private async runLoop(): Promise<void> {
    while (true) {
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

  private dispatch(cmd: UtaCommand): Promise<unknown> {
    switch (cmd.type) {
      case 'push': return this.uta._doPush()
      // ... ~30 cases ...
      default: { const _: never = cmd; throw new Error(`unknown command`) }
    }
  }

  private timeoutPromise(ms: number, name: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TsUtaActor: command '${name}' timed out after ${ms}ms`)), ms),
    )
  }
}

interface QueuedCommand {
  cmd: UtaCommand
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timeoutMs?: number
}
```

## Reentrancy

**Strict no-reentrancy.** Command handlers (the `_doFoo` private methods on UTA) MUST NOT call `this.actor.send(...)`. Internal callers MUST invoke `_doFoo()` directly.

Detection: the actor increments `reentrancyDepth` before dispatching a command and decrements after. If `send()` is called while `reentrancyDepth > 0`, it throws synchronously with a clear error message naming the offending command.

Convention: the `_do` prefix on impl methods makes "I'm already inside the actor — call this directly, not via the public API" obvious to maintainers.

## Backpressure / timeout

**No backpressure.** Queue grows unbounded — same as today (the current UTA has no admission control either). If a handler hangs, all subsequent commands hang too. Phase 4d can revisit when warranted.

**Per-command timeout: optional, default unset.** `actor.send(cmd, { timeoutMs })` rejects on timeout but keeps the queue processing. UTA's existing public methods do NOT pass `timeoutMs` — default behavior unchanged. Future callers (e.g., a watchdog wrapper) can opt in.

## Error handling

A handler that throws → the `send()` promise rejects, queue continues with the next command. The actor itself never enters a poisoned state.

UTA state (broker connection, TradingGit, health counters) might be left mid-update by a throwing handler — same risk as today, not made worse by this refit.

Test coverage: a handler that throws does NOT block subsequent commands.

## Migration approach

**Big-bang within one PR.** All ~30 methods retrofitted at once. A half-migrated UTA (some methods serialized via the actor, others called directly) creates a race possibility at the boundary that's harder to reason about than either extreme.

Each method's transformation is mechanical:

1. Add a private `_doFoo` method containing the EXISTING body verbatim
2. Add a `UtaCommand` variant `{ type: 'foo', ... }`
3. Add a switch case in `TsUtaActor.dispatch`
4. Replace the public `foo()` body with `return this.actor.send({ type: 'foo', ... })`

Implementation can group these into ~5 commits per logical cluster (stagers, commit/push/reject, sync/log/show, broker passthroughs, lifecycle) for easier review, but all must land in the same PR — partial state is unsafe.

Existing tests should pass unchanged. Public surface is identical from outside callers' perspective.

## Concurrency test

`parity/check-uta-concurrency.ts` — Node single-process, no worker threads (JS is single-threaded; the race is via microtask interleaving, not true threads).

The test:

1. Construct a UTA backed by a stubbed broker that introduces randomized 0-50ms delays per call (forces microtask interleaving)
2. Fire 100 parallel `stage/commit/push/sync` lifecycles via `Promise.all`
3. Assert:
   - Total commit count matches expected (no lost commits, no duplicates)
   - Per-commit operation lists are coherent (no operations from lifecycle N landed in lifecycle M's commit)
   - The exported state's commit log re-verifies via Phase 2 `PersistedCommit::verify` (every v2 hash matches its canonical input)

With the actor in place, all 3 assertions pass every run. Without the actor (or with the actor incorrectly bypassed), at least one assertion fails on most runs.

## Files

- **Create:** `src/domain/trading/uta-actor.ts` (~150 lines: `AsyncQueue` + `UtaCommand` union + `TsUtaActor` class)
- **Create:** `src/domain/trading/__test__/uta-actor.spec.ts` (unit tests: FIFO ordering, error isolation, reentrancy detection, timeout)
- **Modify:** `src/domain/trading/UnifiedTradingAccount.ts` (add `private actor: TsUtaActor` field, add `_doFoo` private methods for each public method, replace public method bodies with `actor.send` wrappers)
- **Create:** `parity/check-uta-concurrency.ts` (100-parallel-ops test using a stubbed broker with randomized delays)

## DoD

```bash
pnpm test                                   # ~2228+ tests still pass
pnpm tsx parity/check-uta-concurrency.ts   # 100 parallel ops, coherent log, re-verifies
pnpm test:e2e                               # existing e2e tests pass
npx tsc --noEmit                            # clean
```

## Cutover gate

- Concurrency test passes consistently across 100+ runs (script can be looped via shell to confirm reliability)
- Existing TS UTA behavior unchanged for sequential cases (full test suite green)
- No `actor.send()` reachable from inside any `_do` handler (grep enforces convention; runtime detection backstops)

## Rollback

`git revert` the Phase 4a commits. Public surface is unchanged so no caller migration is needed. Hidden state (the actor's queue + reentrancy counter) disappears with the revert.

## Estimated effort

3-4 eng-days:
- Day 1: AsyncQueue + TsUtaActor + UtaCommand union + unit tests (~150 lines + 6-8 unit tests)
- Day 2-3: UTA refit — 30 methods × ~5 minutes each + iterative tsc fixes
- Day 4: Concurrency test + reliability loop + bug-fix buffer

## Out of scope

- **Backpressure / queue depth limits.** Deferred — current UTA doesn't have either.
- **Cancellation tokens.** No caller currently wants to cancel an in-flight commit.
- **Priority queues.** FIFO is sufficient for Phase 4a.
- **Phase 4d Rust port.** Separate work — this Phase 4a only ships TS.
- **Per-method timeouts in default UTA usage.** The mechanism exists (opts.timeoutMs) but no UTA method currently passes one. Future watchdog work can opt in.

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Reentrant call slips through without runtime detection | Medium | High | runtime check (depth counter) AND grep-based convention review (`_do` prefix) |
| Queue latency on hot read paths (getQuote etc.) becomes noticeable | Medium | Low | benchmark added: `parity/bench-uta-actor.ts` measures p50/p99 added latency for typical command sequences |
| Big-bang refit introduces a typo in one of 30 method signatures | Medium | Medium | tsc strict mode catches signature drift; existing test suite catches behavioral drift |
| AsyncQueue hand-roll has a subtle bug (lost item, lost waiter) | Low | High | unit tests for queue under stress (1000 push/pop interleavings); FIFO order assertion |
| 30-variant union becomes unwieldy as UTA grows | Medium | Low | acceptable trade-off; new methods get explicit audit at variant + switch update |
