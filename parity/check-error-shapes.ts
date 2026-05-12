#!/usr/bin/env tsx
/**
 * parity/check-error-shapes.ts — Phase 4f Task E
 *
 * BrokerError reconstruction parity: verifies that errors crossing the
 * napi boundary are reconstructed on the TS side with the correct shape.
 *
 *   Scenario A — _call() BROKER_ERROR prefix reconstruction:
 *     Inject a synthetic napi-style BROKER_ERROR error into _call().
 *     Expect a fully-shaped BrokerError with code, name, instanceof, permanent.
 *
 *   Scenario B — TS-side disabled account BrokerError shape:
 *     A disabled TS UnifiedTradingAccount throws a CONFIG BrokerError.
 *     Verify the same shape: code='CONFIG', name='BrokerError', instanceof BrokerError.
 *
 *   Scenario C — UNKNOWN error code reconstruction (non-permanent):
 *     Inject a BROKER_ERROR with code=UNKNOWN into _call().
 *     Expect permanent=false.
 *
 *   Scenario D — Real Rust proxy BrokerError (fail injection via broker config):
 *     Use a mock-paper proxy; manually trigger _call() with a simulated error
 *     to confirm the error path works end-to-end.
 *
 * Run: pnpm tsx parity/check-error-shapes.ts
 * Exit 0 on success, 1 on failure.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createEventLog } from '../src/core/event-log.js'
import { RustUtaProxy } from '../src/domain/trading/unified-trading-account-rust.js'
import { BrokerError } from '../src/domain/trading/brokers/types.js'
import { UnifiedTradingAccount } from '../src/domain/trading/UnifiedTradingAccount.js'
import { MockBroker, makeContract } from '../src/domain/trading/brokers/mock/index.js'
import { Order } from '@traderalice/ibkr'
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

function assertBrokerErrorShape(err: unknown, expectedCode: string, expectedPermanent: boolean, label: string): void {
  assert(err !== null && err !== undefined, `${label}: error should not be null`)
  assert(
    err instanceof BrokerError,
    `${label}: error should be instanceof BrokerError; got ${Object.prototype.toString.call(err)}, msg=${(err as Error).message?.slice(0, 60)}`,
  )
  const be = err as BrokerError
  assert(be.name === 'BrokerError', `${label}: name should be 'BrokerError', got '${be.name}'`)
  assert(be.code === expectedCode, `${label}: code should be '${expectedCode}', got '${be.code}'`)
  assert(
    be.permanent === expectedPermanent,
    `${label}: permanent should be ${expectedPermanent}, got ${be.permanent}`,
  )
  assert(typeof be.message === 'string' && be.message.length > 0, `${label}: message should be non-empty`)
}

// ──────────────────────────────────────────────────────────────
// Scenario A — _call() CONFIG BROKER_ERROR reconstruction
// ──────────────────────────────────────────────────────────────

async function scenarioA(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-err-a-'))
  const logPath = join(dir, 'events.jsonl')
  const tc = await TradingCore.create({ dataRoot: dir })
  const eventLog = await createEventLog({ logPath })

  const proxy = new RustUtaProxy({
    accountConfig: {
      id: 'err-shape-a',
      presetId: 'mock-paper',
      enabled: true,
      guards: [],
      presetConfig: {},
    } satisfies UTAConfig,
    tradingCore: tc,
    eventLog,
  })
  await proxy.start()

  // Inject a synthetic napi-style BROKER_ERROR into _call()
  const syntheticError = new Error(
    'BROKER_ERROR:' + JSON.stringify({
      code: 'CONFIG',
      message: 'Account "err-shape-a" is disabled due to configuration error',
      permanent: true,
      broker: null,
    }),
  )

  let caughtError: unknown = null
  try {
    await proxy._call(async () => { throw syntheticError })
  } catch (e) {
    caughtError = e
  }

  assertBrokerErrorShape(caughtError, 'CONFIG', true, 'Scenario A (CONFIG BROKER_ERROR)')
  const be = caughtError as BrokerError
  const ownKeys = Object.keys(be)
  assert(ownKeys.includes('code'), `Scenario A: 'code' must be own enumerable key; keys=${ownKeys.join(',')}`)
  assert(ownKeys.includes('permanent'), `Scenario A: 'permanent' must be own enumerable key; keys=${ownKeys.join(',')}`)
  console.log(`[ok] Scenario A: CONFIG BROKER_ERROR → BrokerError(code=${be.code}, permanent=${be.permanent}, name=${be.name})`)

  await proxy.stop()
  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// Scenario B — TS-side disabled account BrokerError shape
// ──────────────────────────────────────────────────────────────

async function scenarioB(): Promise<void> {
  const eventLog = await createEventLog({
    logPath: join(mkdtempSync(join(tmpdir(), 'phase4f-err-b-')), 'events.jsonl'),
  })

  const broker = new MockBroker({ id: 'ts-disabled', label: 'TS Disabled' })
  const uta = new UnifiedTradingAccount(broker, { eventLog })

  // Force disabled on the TS side
  ;(uta as unknown as Record<string, boolean>)._disabled = true

  uta.git.add({
    action: 'placeOrder',
    contract: makeContract({ symbol: 'AAPL', aliceId: 'ts-disabled|AAPL' }),
    order: new Order(),
  })
  uta.git.commit('disabled ts test')

  let caughtError: unknown = null
  try {
    await uta.push()
  } catch (e) {
    caughtError = e
  }

  assert(caughtError !== null, 'Scenario B: TS push on a disabled account should throw')
  assertBrokerErrorShape(caughtError, 'CONFIG', true, 'Scenario B (TS disabled UTA)')
  const be = caughtError as BrokerError
  console.log(`[ok] Scenario B: TS disabled UTA → BrokerError(code=${be.code}, permanent=${be.permanent}, name=${be.name})`)
  console.log(`     message: "${be.message.slice(0, 80)}"`)

  await uta.close()
  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// Scenario C — UNKNOWN code reconstruction (non-permanent)
// ──────────────────────────────────────────────────────────────

async function scenarioC(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-err-c-'))
  const logPath = join(dir, 'events.jsonl')
  const tc = await TradingCore.create({ dataRoot: dir })
  const eventLog = await createEventLog({ logPath })

  const proxy = new RustUtaProxy({
    accountConfig: {
      id: 'err-shape-c',
      presetId: 'mock-paper',
      enabled: true,
      guards: [],
      presetConfig: {},
    } satisfies UTAConfig,
    tradingCore: tc,
    eventLog,
  })
  await proxy.start()

  // UNKNOWN error is non-permanent
  const syntheticError = new Error(
    'BROKER_ERROR:' + JSON.stringify({
      code: 'UNKNOWN',
      message: 'MockBroker[mock-paper]: simulated placeOrder failure',
      permanent: false,
      broker: null,
    }),
  )

  let caughtError: unknown = null
  try {
    await proxy._call(async () => { throw syntheticError })
  } catch (e) {
    caughtError = e
  }

  assertBrokerErrorShape(caughtError, 'UNKNOWN', false, 'Scenario C (UNKNOWN BROKER_ERROR)')
  const be = caughtError as BrokerError
  console.log(`[ok] Scenario C: UNKNOWN BROKER_ERROR → BrokerError(code=${be.code}, permanent=${be.permanent})`)

  await proxy.stop()
  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// Scenario D — NETWORK code (non-permanent) + all error codes
// ──────────────────────────────────────────────────────────────

async function scenarioD(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-err-d-'))
  const logPath = join(dir, 'events.jsonl')
  const tc = await TradingCore.create({ dataRoot: dir })
  const eventLog = await createEventLog({ logPath })

  const proxy = new RustUtaProxy({
    accountConfig: {
      id: 'err-shape-d',
      presetId: 'mock-paper',
      enabled: true,
      guards: [],
      presetConfig: {},
    } satisfies UTAConfig,
    tradingCore: tc,
    eventLog,
  })
  await proxy.start()

  const codeCases: Array<{ code: string; permanent: boolean }> = [
    { code: 'NETWORK', permanent: false },
    { code: 'AUTH', permanent: true },
    { code: 'EXCHANGE', permanent: false },
    { code: 'MARKET_CLOSED', permanent: false },
  ]

  for (const { code, permanent } of codeCases) {
    const syntheticError = new Error(
      'BROKER_ERROR:' + JSON.stringify({ code, message: `test ${code} error`, permanent, broker: null }),
    )
    let caughtError: unknown = null
    try {
      await proxy._call(async () => { throw syntheticError })
    } catch (e) {
      caughtError = e
    }
    assertBrokerErrorShape(caughtError, code, permanent, `Scenario D (${code})`)
  }
  console.log(`[ok] Scenario D: all error codes reconstruct correctly: ${codeCases.map(c => c.code).join(', ')}`)

  await proxy.stop()
  await eventLog.close()
}

// ──────────────────────────────────────────────────────────────
// Scenario E — non-BROKER_ERROR passes through unmodified
// ──────────────────────────────────────────────────────────────

async function scenarioE(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phase4f-err-e-'))
  const logPath = join(dir, 'events.jsonl')
  const tc = await TradingCore.create({ dataRoot: dir })
  const eventLog = await createEventLog({ logPath })

  const proxy = new RustUtaProxy({
    accountConfig: {
      id: 'err-shape-e',
      presetId: 'mock-paper',
      enabled: true,
      guards: [],
      presetConfig: {},
    } satisfies UTAConfig,
    tradingCore: tc,
    eventLog,
  })
  await proxy.start()

  const plainError = new TypeError('not a broker error')
  let caughtError: unknown = null
  try {
    await proxy._call(async () => { throw plainError })
  } catch (e) {
    caughtError = e
  }

  assert(caughtError === plainError, `Scenario E: non-BROKER_ERROR should pass through unchanged`)
  assert(!(caughtError instanceof BrokerError), `Scenario E: plain TypeError should not become BrokerError`)
  console.log(`[ok] Scenario E: non-BROKER_ERROR passes through as-is`)

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
  await scenarioE()
  console.log('\nAll check-error-shapes assertions passed.')
}

main().catch(err => {
  console.error('[fail] Uncaught error:', err)
  process.exit(1)
})
