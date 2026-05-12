/**
 * snapshot-trigger-parity.spec.ts
 *
 * 100-commit atomicity test for the EventLog-based snapshot trigger path.
 *
 * Verifies that every push emits exactly one 'commit.notify' event via the
 * injected EventLog, with no event loss under 100 sequential commits.
 *
 * Phase 4d Task E — closes the TS snapshot trigger swap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Order } from '@traderalice/ibkr-types'
import { createEventLog, type EventLog, type EventLogEntry } from '../../../core/event-log.js'
import { UnifiedTradingAccount } from '../UnifiedTradingAccount.js'
import { MockBroker, makeContract } from '../brokers/mock/index.js'

// ==================== Helpers ====================

function tempPath(ext: string): string {
  return join(tmpdir(), `snapshot-parity-${randomUUID()}.${ext}`)
}

// ==================== Tests ====================

describe('commit.notify — 100-commit atomicity', () => {
  let eventLog: EventLog
  let uta: UnifiedTradingAccount
  let broker: MockBroker

  beforeEach(async () => {
    const logPath = tempPath('jsonl')
    eventLog = await createEventLog({ logPath })

    broker = new MockBroker({ id: 'parity-acct', label: 'Parity Test' })
    broker.setQuote('AAPL', 150)

    uta = new UnifiedTradingAccount(broker, { eventLog })
  })

  afterEach(async () => {
    await eventLog._resetForTest()
    await uta.close()
  })

  it('emits exactly one commit.notify per push over 100 sequential commits', async () => {
    const events: EventLogEntry[] = []

    // Subscribe to commit.notify events before any commits
    const unsubscribe = eventLog.subscribeType('commit.notify', (entry) => {
      events.push(entry)
    })

    // 100 sequential add → commit → push cycles
    for (let i = 0; i < 100; i++) {
      uta.git.add({
        action: 'placeOrder',
        contract: makeContract({ symbol: 'AAPL', aliceId: 'parity-acct|AAPL' }),
        order: new Order(),
      })
      uta.git.commit(`buy #${i + 1}`)
      await uta.push()
    }

    // EventLog appends are fire-and-forget voids; wait one tick for the
    // microtask queue to flush any in-flight Promises.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    unsubscribe()

    // ── Atomicity assertions ──

    // 1. Exactly 100 events — no loss, no duplicates
    expect(events).toHaveLength(100)

    // 2. All events have the correct accountId
    for (const evt of events) {
      const payload = evt.payload as { accountId: string; commitHash: string }
      expect(payload.accountId).toBe('parity-acct')
    }

    // 3. All commitHashes are unique (each push produces a distinct commit)
    const hashes = events.map((e) => (e.payload as { commitHash: string }).commitHash)
    const uniqueHashes = new Set(hashes)
    expect(uniqueHashes.size).toBe(100)

    // 4. All events are of type 'commit.notify'
    for (const evt of events) {
      expect(evt.type).toBe('commit.notify')
    }

    // 5. Seq numbers are unique and positive (each EventLog append gets a distinct seq)
    //    Note: fire-and-forget appends may arrive out of push order, so we only
    //    check uniqueness — not strict monotonicity relative to push order.
    const seqs = events.map((e) => e.seq)
    const uniqueSeqs = new Set(seqs)
    expect(uniqueSeqs.size).toBe(100)
    for (const seq of seqs) {
      expect(seq).toBeGreaterThan(0)
    }
  })

  it('does not emit commit.notify when push is rejected (disabled account)', async () => {
    const events: EventLogEntry[] = []
    const unsubscribe = eventLog.subscribeType('commit.notify', (entry) => {
      events.push(entry)
    })

    // Force the account offline
    ;(uta as any)._disabled = true

    uta.git.add({
      action: 'placeOrder',
      contract: makeContract({ symbol: 'AAPL', aliceId: 'parity-acct|AAPL' }),
      order: new Order(),
    })
    uta.git.commit('buy')

    await expect(uta.push()).rejects.toThrow()

    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    unsubscribe()

    expect(events).toHaveLength(0)
  })

  it('commit.notify payload is present in EventLog.recent() after 100 pushes', async () => {
    for (let i = 0; i < 100; i++) {
      uta.git.add({
        action: 'placeOrder',
        contract: makeContract({ symbol: 'AAPL', aliceId: 'parity-acct|AAPL' }),
        order: new Order(),
      })
      uta.git.commit(`buy #${i + 1}`)
      await uta.push()
    }

    // Flush pending microtasks
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    // EventLog.recent() queries the in-memory ring buffer (default size 500)
    const recent = eventLog.recent({ type: 'commit.notify' })
    expect(recent).toHaveLength(100)

    // Verify all payloads are well-formed
    for (const entry of recent) {
      const payload = entry.payload as { accountId: string; commitHash: string }
      expect(typeof payload.accountId).toBe('string')
      expect(typeof payload.commitHash).toBe('string')
      expect(payload.commitHash.length).toBeGreaterThan(0)
    }
  })
})
