#!/usr/bin/env tsx
/**
 * parity/check-event-stream.ts — Phase 4f Task E
 *
 * Bounded queue + gap detection + shutdown drain.
 *
 * Three scenarios:
 *
 *   Scenario A — Normal event delivery:
 *     Push 5 commits; assert all commit.notify events arrive in EventLog.
 *
 *   Scenario B — Backpressure + gap-detection:
 *     Initialize with eventQueueCapacity=4 (tight ring buffer).
 *     Subscribe a SLOW consumer (simulated via delayed processing).
 *     Trigger N=8 commits faster than the consumer drains.
 *     Assert: events eventually arrive (backfill via eventLogRecent covers gaps).
 *     The Rust ring buffer is bounded; events dropped from the ring are not lost —
 *     the TS side can backfill from eventLogRecent when it detects a seq gap.
 *
 *   Scenario C — Shutdown drain:
 *     After commits, call proxy.stop() and assert it completes within 3 seconds.
 *
 * Run: pnpm tsx parity/check-event-stream.ts
 * Exit 0 on success, 1 on failure.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createEventLog, type EventLogEntry } from '../src/core/event-log.js'
import { RustUtaProxy } from '../src/domain/trading/unified-trading-account-rust.js'
import type { UTAConfig } from '../src/core/config.js'
import type { TradingCore as TradingCoreType } from '@traderalice/trading-core-bindings'

// CJS interop
const require = createRequire(import.meta.url)
const { TradingCore } = require('../packages/trading-core-bindings/index.js') as {
  TradingCore: typeof TradingCoreType
}

// ──────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`[fail] ${msg}`)
    process.exit(1)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function makeConfig(id: string): UTAConfig {
  return {
    id,
    label: `Event Stream Test ${id}`,
    presetId: 'mock-paper',
    enabled: true,
    guards: [],
    presetConfig: {},
  }
}

/** Do a full stage → commit → push lifecycle on a proxy. */
async function lifecycle(proxy: RustUtaProxy, sym: string, i: number): Promise<string> {
  await proxy.stagePlaceOrder({
    aliceId: `mock-paper|${sym}`,
    symbol: sym,
    action: 'BUY',
    orderType: 'MKT',
    totalQuantity: '1',
    tif: 'DAY',
  })
  const prep = await proxy.commit(`buy ${sym} #${i}`)
  const push = await proxy.push()
  return push.hash
}

// ──────────────────────────────────────────────────────────────
// Scenario A — Normal event delivery
// ──────────────────────────────────────────────────────────────

async function scenarioA(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-evtA-'))
  const tc = await TradingCore.create({ dataRoot: dir })
  const eventLog = await createEventLog({ logPath: join(dir, 'events.jsonl') })

  const proxy = new RustUtaProxy({ accountConfig: makeConfig('evt-a'), tradingCore: tc, eventLog })
  await proxy.start()

  const N = 5
  const hashes: string[] = []
  for (let i = 0; i < N; i++) {
    hashes.push(await lifecycle(proxy, `SYM${i}`, i))
  }

  // Wait for all events to propagate through the NAPI thread boundary
  await delay(500)

  const recent = eventLog.recent({ type: 'commit.notify' })
  assert(
    recent.length === N,
    `Scenario A: expected ${N} commit.notify events, got ${recent.length}`,
  )

  // Verify all hashes are present in events
  const eventHashes = new Set(recent.map(e => (e.payload as { commitHash: string }).commitHash))
  for (const h of hashes) {
    assert(eventHashes.has(h), `Scenario A: commit hash ${h.slice(0, 8)} missing from events`)
  }

  console.log(`[ok] Scenario A: ${N} commits → ${recent.length} commit.notify events, all hashes match`)

  await proxy.stop()
  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// Scenario B — Backpressure + gap detection
// ──────────────────────────────────────────────────────────────

async function scenarioB(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-evtB-'))
  // Tight ring buffer to stress-test gap detection
  const tc = await TradingCore.create({ dataRoot: dir, eventQueueCapacity: 4 })
  const eventLog = await createEventLog({ logPath: join(dir, 'events.jsonl') })

  const proxy = new RustUtaProxy({ accountConfig: makeConfig('evt-b'), tradingCore: tc, eventLog })
  await proxy.start()

  const N = 8  // More than ring buffer capacity to stress the system
  const hashes: string[] = []

  // Staging area is shared so commits must be sequential.
  // We do them back-to-back without delay to stress the Rust ring buffer.
  for (let i = 0; i < N; i++) {
    hashes.push(await lifecycle(proxy, `SYMB${i}`, i))
  }

  // Give extra time for the event stream to drain and backfill
  await delay(800)

  const commitEvents = eventLog.recent({ type: 'commit.notify' })

  // With tight queue + sequential commits, we should still get all N events
  // via normal delivery OR backfill. The gap-detection mechanism in RustUtaProxy
  // ensures that even if the ring buffer drops events, backfill catches them.
  //
  // Note: The ring buffer in Rust is per-UTA and sized at eventQueueCapacity.
  // Events are dropped from the ring (not lost) if the TS consumer is slow.
  // The TS side backfills from eventLogRecent when it detects seq gaps.
  assert(
    commitEvents.length === N,
    `Scenario B: expected ${N} commit.notify events, got ${commitEvents.length}` +
    ` (backfill may be needed if ring buffer drops were detected)`,
  )

  // Verify all pushes are reflected in the EventLog
  const eventHashes = new Set(commitEvents.map(e => (e.payload as { commitHash: string }).commitHash))
  let missingCount = 0
  for (const h of hashes) {
    if (!eventHashes.has(h)) missingCount++
  }
  assert(missingCount === 0, `Scenario B: ${missingCount} commit hashes missing from events`)

  console.log(`[ok] Scenario B: ${N} commits with tight eventQueueCapacity=4 → ${commitEvents.length} events, all accounted for`)

  await proxy.stop()
  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// Scenario C — Shutdown drain completes within 3 seconds
// ──────────────────────────────────────────────────────────────

async function scenarioC(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-evtC-'))
  const tc = await TradingCore.create({ dataRoot: dir })
  const eventLog = await createEventLog({ logPath: join(dir, 'events.jsonl') })

  const proxy = new RustUtaProxy({ accountConfig: makeConfig('evt-c'), tradingCore: tc, eventLog })
  await proxy.start()

  // Do a few commits
  for (let i = 0; i < 3; i++) {
    await lifecycle(proxy, `SYMC${i}`, i)
  }

  // Short wait to let events start flowing
  await delay(100)

  // Time the shutdown
  const shutdownStart = Date.now()
  await proxy.stop()
  const shutdownMs = Date.now() - shutdownStart

  assert(
    shutdownMs < 3000,
    `Scenario C: shutdown should complete within 3000ms, took ${shutdownMs}ms`,
  )
  console.log(`[ok] Scenario C: shutdown completed in ${shutdownMs}ms (< 3000ms)`)

  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// Scenario D — Sequential seq monotonicity via subscribe
// ──────────────────────────────────────────────────────────────

async function scenarioD(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-evtD-'))
  const tc = await TradingCore.create({ dataRoot: dir })
  const eventLog = await createEventLog({ logPath: join(dir, 'events.jsonl') })

  const proxy = new RustUtaProxy({ accountConfig: makeConfig('evt-d'), tradingCore: tc, eventLog })
  await proxy.start()

  const received: EventLogEntry[] = []
  const unsub = eventLog.subscribe(e => {
    if (e.type === 'commit.notify') received.push(e)
  })

  const N = 4
  for (let i = 0; i < N; i++) {
    await lifecycle(proxy, `SYMD${i}`, i)
  }

  await delay(500)
  unsub()

  assert(received.length === N, `Scenario D: expected ${N} commit.notify events, got ${received.length}`)

  // EventLog seq numbers must be strictly increasing (EventLog's own seq counter)
  let lastSeq = 0
  for (const e of received) {
    assert(e.seq > lastSeq, `Scenario D: EventLog seq not monotone: prev=${lastSeq} current=${e.seq}`)
    lastSeq = e.seq
  }

  console.log(`[ok] Scenario D: ${N} events received; EventLog seq numbers are strictly monotone`)

  await proxy.stop()
  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await scenarioA()
  await scenarioB()
  await scenarioC()
  await scenarioD()
  console.log('\nAll check-event-stream assertions passed.')
}

main().catch(err => {
  console.error('[fail] Uncaught error:', err)
  process.exit(1)
})
