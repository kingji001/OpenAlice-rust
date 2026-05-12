#!/usr/bin/env tsx
/**
 * parity/check-rust-proxy-mock.ts — Phase 4f Task E
 *
 * End-to-end lifecycle test for RustUtaProxy with the Mock broker.
 *
 *   1. Create TradingCore + EventLog
 *   2. Construct RustUtaProxy and call start()
 *   3. Subscribe to EventLog; collect commit.notify events
 *   4. Stage a placeOrder, commit, push
 *   5. Assert: push result has 1 submitted operation
 *   6. Assert: commit.notify event lands in EventLog with matching commitHash
 *   7. Assert: getAccount() and status() work without throwing
 *   8. Cleanup: proxy.stop()
 *
 * Run: pnpm tsx parity/check-rust-proxy-mock.ts
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

// The napi binding ships as CJS; use createRequire for interop in ESM/tsx.
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

// ──────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-mock-'))
  const logPath = join(dir, 'events.jsonl')

  // 1. TradingCore
  const tc = await TradingCore.create({ dataRoot: dir })
  console.log('[ok] TradingCore created')

  // 2. EventLog
  const eventLog = await createEventLog({ logPath })
  console.log('[ok] EventLog created')

  // 3. RustUtaProxy
  const accountConfig: UTAConfig = {
    id: 'test-mock',
    label: 'Phase 4f Mock',
    presetId: 'mock-paper',   // resolves accountType=mock, brokerId=mock-paper
    enabled: true,
    guards: [],
    presetConfig: {},
  }

  const proxy = new RustUtaProxy({
    accountConfig,
    tradingCore: tc,
    eventLog,
  })

  await proxy.start()
  console.log('[ok] RustUtaProxy started (id=test-mock)')

  // 4. Subscribe
  const collected: EventLogEntry[] = []
  const unsub = eventLog.subscribe(ev => collected.push(ev))

  // 5. Stage a placeOrder
  const stageResult = await proxy.stagePlaceOrder({
    aliceId: 'mock-paper|AAPL',
    symbol: 'AAPL',
    action: 'BUY',
    orderType: 'MKT',
    totalQuantity: '10',
    tif: 'DAY',
  })
  assert(stageResult.staged, `stagePlaceOrder should return staged=true, got staged=${stageResult.staged}`)
  assert(stageResult.index === 0, `first staged op should be at index 0, got ${stageResult.index}`)
  console.log('[ok] stagePlaceOrder → staged at index 0')

  // 6. Commit
  const prep = await proxy.commit('test buy AAPL')
  assert(prep.prepared, `commit should return prepared=true`)
  assert(typeof prep.hash === 'string' && prep.hash.length > 0, `commit hash should be a non-empty string`)
  assert(prep.operationCount === 1, `commit should have 1 operation, got ${prep.operationCount}`)
  console.log(`[ok] commit prepared → hash=${prep.hash.slice(0, 8)}…`)

  // 7. Push
  const push = await proxy.push()
  assert(typeof push.hash === 'string' && push.hash.length > 0, `push hash should be non-empty`)
  assert(push.submitted.length === 1, `push should have 1 submitted op, got ${push.submitted.length}`)
  assert(push.rejected.length === 0, `push should have 0 rejected ops, got ${push.rejected.length}`)
  const submitted = push.submitted[0]
  assert(submitted.success === true, `submitted op should have success=true`)
  console.log(`[ok] push completed → ${push.submitted.length} submitted, hash=${push.hash.slice(0, 8)}…`)

  // 8. Wait for event dispatch (Rust → NAPI → JS thread is async)
  await delay(300)
  unsub()

  // 9. Assert commit.notify event
  const commitEvents = collected.filter(e => e.type === 'commit.notify')
  assert(
    commitEvents.length >= 1,
    `expected at least 1 commit.notify event, got ${commitEvents.length} (all events: ${collected.map(e => e.type).join(', ')})`,
  )

  const lastCommitEvent = commitEvents[commitEvents.length - 1]
  const payload = lastCommitEvent.payload as { accountId: string; commitHash: string }
  assert(
    payload.accountId === 'test-mock',
    `commit.notify accountId should be 'test-mock', got '${payload.accountId}'`,
  )
  assert(
    payload.commitHash === push.hash,
    `commit.notify commitHash should match push.hash\n  expected: ${push.hash}\n  got: ${payload.commitHash}`,
  )
  console.log(`[ok] commit.notify received → accountId=${payload.accountId}, commitHash=${payload.commitHash.slice(0, 8)}…`)

  // 10. status() round-trip
  const status = await proxy.status()
  assert(typeof status.commitCount === 'number', `status.commitCount should be a number`)
  assert(status.commitCount >= 1, `at least 1 commit should exist, got ${status.commitCount}`)
  console.log(`[ok] status() → commitCount=${status.commitCount}`)

  // 11. getAccount() round-trip
  const acct = await proxy.getAccount()
  assert(typeof acct.netLiquidation === 'string', `getAccount() should return netLiquidation string`)
  console.log(`[ok] getAccount() → netLiquidation=${acct.netLiquidation}`)

  // 12. getMarketClock() round-trip
  const clock = await proxy.getMarketClock()
  assert(clock.isOpen === true, `mock getMarketClock should always return isOpen=true`)
  console.log(`[ok] getMarketClock() → isOpen=${clock.isOpen}`)

  // Cleanup
  await proxy.stop()
  await eventLog.close()
  console.log('[ok] proxy.stop() and eventLog.close() completed')

  console.log('\nAll check-rust-proxy-mock assertions passed.')
}

main().catch(err => {
  console.error('[fail] Uncaught error:', err)
  process.exit(1)
})
