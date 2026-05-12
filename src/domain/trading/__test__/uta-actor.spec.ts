import { describe, it, expect } from 'vitest'
import { AsyncQueue, TsUtaActor } from '../uta-actor.js'

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
