/**
 * src/__test__/telegram-rust-uta-smoke.spec.ts — Phase 4f Task E
 *
 * Telegram path smoke test for RustUtaProxy.
 *
 * Tests that the Telegram trading callback handler (TelegramPlugin.buildAccountPanel,
 * handleTradingCommand) can interoperate with both UnifiedTradingAccount and
 * RustUtaProxy through the AnyUta union (Task D).
 *
 * Strategy:
 *   - Build a UTAManager backed by a RustUtaProxy (mock broker)
 *   - Directly exercise the UTA API surface that the Telegram handler uses:
 *       uta.health, uta.status(), uta.getAccount(), uta.log(), uta.push(), uta.reject()
 *   - Verify commit.notify events reach the EventLog (same assertion as the
 *     real Telegram push flow)
 *   - Assert ≤10s round-trip (all calls complete quickly with mock broker)
 *   - Confirm RustUtaProxy satisfies AnyUta union without TypeScript errors
 *
 * Note: grammY bot API is NOT instantiated — this test exercises the UTAManager
 * and RustUtaProxy layers that the Telegram handler delegates to. A full
 * grammY integration test (network polling) is out of scope for Phase 4f.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createEventLog, type EventLog, type EventLogEntry } from '../core/event-log.js'
import { RustUtaProxy } from '../domain/trading/unified-trading-account-rust.js'
import { UTAManager, type AnyUta } from '../domain/trading/uta-manager.js'
import type { TradingCore as TradingCoreType } from '@traderalice/trading-core-bindings'

// CJS interop for napi binding
const require = createRequire(import.meta.url)
const { TradingCore } = require('../../packages/trading-core-bindings/index.js') as {
  TradingCore: typeof TradingCoreType
}

// ──────────────────────────────────────────────────────────────
// Shared setup
// ──────────────────────────────────────────────────────────────

let tc: TradingCoreType
let eventLog: EventLog
let proxy: RustUtaProxy
let manager: UTAManager
const dir = mkdtempSync(join(tmpdir(), 'phase4f-tg-'))

beforeAll(async () => {
  tc = await TradingCore.create({ dataRoot: dir })
  eventLog = await createEventLog({ logPath: join(dir, 'events.jsonl') })

  proxy = new RustUtaProxy({
    accountConfig: {
      id: 'tg-mock',
      label: 'Telegram Mock',
      presetId: 'mock-paper',
      enabled: true,
      guards: [],
      presetConfig: {},
    },
    tradingCore: tc,
    eventLog,
  })
  await proxy.start()

  manager = new UTAManager()
  manager.add(proxy)
})

afterAll(async () => {
  await proxy.stop()
  await eventLog.close()
})

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe('RustUtaProxy — Telegram path AnyUta compatibility', () => {

  it('UTAManager.resolve() returns the RustUtaProxy as AnyUta', () => {
    const accounts: AnyUta[] = manager.resolve()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toBe(proxy)
    expect(accounts[0].id).toBe('tg-mock')
  })

  it('uta.health is accessible (used by Telegram overview panel)', () => {
    // TelegramPlugin reads uta.health to display health icon
    const health = proxy.health
    expect(['healthy', 'degraded', 'offline']).toContain(health)
  })

  it('uta.status() returns GitStatus (used by Telegram panel)', async () => {
    const status = await proxy.status()
    expect(typeof status.commitCount).toBe('number')
    expect(status.staged).toBeInstanceOf(Array)
    // pendingMessage is null or string
    expect(status.pendingMessage === null || typeof status.pendingMessage === 'string').toBe(true)
  })

  it('uta.getAccount() returns AccountInfo (used by Telegram equity display)', async () => {
    const acct = await proxy.getAccount()
    expect(typeof acct.netLiquidation).toBe('string')
    expect(typeof acct.totalCashValue).toBe('string')
    expect(typeof acct.unrealizedPnL).toBe('string')
    expect(typeof acct.realizedPnL).toBe('string')
  })

  it('uta.log() returns CommitLogEntry[] (used by Telegram history display)', async () => {
    const log = await proxy.log({ limit: 3 })
    expect(Array.isArray(log)).toBe(true)
    // Each entry has the shape Telegram expects
    for (const entry of log) {
      expect(typeof entry.hash).toBe('string')
      expect(typeof entry.message).toBe('string')
      expect(Array.isArray(entry.operations)).toBe(true)
    }
  })

  it('stage → commit → push round-trip via AnyUta interface (≤10s)', async () => {
    const start = Date.now()

    // Telegram handler calls uta.status() first
    const statusBefore = await proxy.status()
    // Phase 4f: RustUtaProxy.status().pendingMessage is always null — the Rust
    // exportState() does not expose the staging area to the TS host. The Telegram
    // handler handles this gracefully (shows "No pending commit" when null).
    expect(statusBefore.pendingMessage).toBeNull()

    // Stage (via UTAManager path — same path as Telegram handler)
    const uta = manager.resolveOne('tg-mock')
    await uta.stagePlaceOrder({
      aliceId: 'mock-paper|AAPL',
      symbol: 'AAPL',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '5',
      tif: 'DAY',
    })

    // Commit
    await uta.commit('telegram smoke: buy AAPL')

    // Phase 4f note: uta.status().pendingMessage is null even after commit —
    // the Rust actor's staging area is not exposed via napi exportState().
    // Telegram flow in Phase 4f: operator stages via tool, then Telegram push
    // is triggered directly without relying on pendingMessage display.

    // Telegram "Approve" button calls uta.push()
    const result = await uta.push()
    expect(result.submitted.length).toBe(1)
    expect(result.rejected.length).toBe(0)
    const commitHash = result.hash

    // After push, commitCount increases
    const statusAfter = await uta.status()
    expect(statusAfter.commitCount).toBeGreaterThanOrEqual(1)

    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(10_000)
    console.log(`  round-trip: ${elapsed}ms, hash=${commitHash.slice(0, 8)}`)
  })

  it('commit.notify event reaches EventLog after push (Telegram can listen)', async () => {
    const receivedEvents: EventLogEntry[] = []
    const unsub = eventLog.subscribe(e => {
      if (e.type === 'commit.notify') receivedEvents.push(e)
    })

    // Do a second lifecycle
    await proxy.stagePlaceOrder({
      aliceId: 'mock-paper|MSFT',
      symbol: 'MSFT',
      action: 'SELL',
      orderType: 'LMT',
      totalQuantity: '3',
      lmtPrice: '420',
      tif: 'DAY',
    })
    await proxy.commit('telegram smoke: sell MSFT')
    const pushResult = await proxy.push()

    // Wait for event dispatch from Rust → NAPI → JS
    await new Promise(r => setTimeout(r, 300))
    unsub()

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1)
    const latest = receivedEvents[receivedEvents.length - 1]
    const payload = latest.payload as { accountId: string; commitHash: string }
    expect(payload.accountId).toBe('tg-mock')
    expect(payload.commitHash).toBe(pushResult.hash)
  })

  it('uta.reject() works (Telegram "Reject" button path)', async () => {
    // Stage + commit but reject instead of push
    await proxy.stagePlaceOrder({
      aliceId: 'mock-paper|GOOG',
      symbol: 'GOOG',
      action: 'BUY',
      orderType: 'MKT',
      totalQuantity: '1',
      tif: 'DAY',
    })
    await proxy.commit('telegram smoke: reject test')

    // Phase 4f: pendingMessage is always null from RustUtaProxy.status()
    // Telegram handler gracefully handles null (shows "No pending commit")
    const statusAfterCommit = await proxy.status()
    expect(statusAfterCommit.pendingMessage).toBeNull()

    // Telegram "Reject" button calls uta.reject()
    const rejectResult = await proxy.reject('user rejected via Telegram')
    expect(typeof rejectResult.hash).toBe('string')
    expect(rejectResult.hash.length).toBeGreaterThan(0)
    expect(rejectResult.operationCount).toBeGreaterThanOrEqual(1)
  })

  it('getMarketClock() returns {isOpen: boolean} (Telegram clock display)', async () => {
    const clock = await proxy.getMarketClock()
    expect(typeof clock.isOpen).toBe('boolean')
  })

  it('UTAManager.size reflects registered accounts', () => {
    expect(manager.size).toBe(1)
  })
})
