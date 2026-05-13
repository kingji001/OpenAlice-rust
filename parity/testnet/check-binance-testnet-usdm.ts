#!/usr/bin/env tsx
/**
 * parity/testnet/check-binance-testnet-usdm.ts
 *
 * LIVE NETWORK TEST — gated by env vars. Exits 0 (skipped) when credentials
 * are not set, so this script is safe in CI and local dev without credentials.
 *
 * Tests the USDⓈ-M Futures lifecycle against the Binance Demo Trading environment:
 *   1. Construct CcxtBroker (tradingMode='usdm-futures', simulationMode='demo')
 *   2. Connect via init()
 *   3. setPositionMode('ONE_WAY') — idempotent setup
 *   4. setLeverage('BTC/USDT', 5) — verify returned leverage
 *   5. setMarginMode('BTC/USDT', 'CROSS')
 *   6. getMarkPrice('BTC/USDT') — verify shape
 *   7. getFundingRate('BTC/USDT') — verify shape
 *   8. getPositionMode() — should return 'ONE_WAY'
 *   9. Place LIMIT order (50% below market, positionSide=BOTH, reduceOnly=false)
 *  10. Verify order is open
 *  11. Cancel order (try/finally)
 *  12. Verify cancellation
 *
 * Uses Binance Demo Trading (demo-fapi.binance.com) via CCXT enableDemoTrading(true).
 * This is the official Binance replacement for the deprecated futures sandbox.
 *
 * Required env vars:
 *   BINANCE_DEMO_KEY    — Binance Demo Trading API key (covers both USDM and COINM)
 *   BINANCE_DEMO_SECRET — Binance Demo Trading API secret
 *
 * Demo account registration: https://demo.binance.com/
 * Run: pnpm tsx parity/testnet/check-binance-testnet-usdm.ts
 */

import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr-types'
import { CcxtBroker } from '../../src/domain/trading/brokers/ccxt/CcxtBroker.js'
import { requireDemoEnv, logSkip, logOk, logFail, logCleanup, redact, shouldDryRun, logDryRun } from './_helpers.js'
import '../../src/domain/trading/contract-ext.js'

// ── Dry-run path ─────────────────────────────────────────────────────────────
if (shouldDryRun()) {
  console.log('[dry-run] check-binance-testnet-usdm.ts intended call sequence:')
  logDryRun('new CcxtBroker', { exchange: 'binance', tradingMode: 'usdm-futures', simulationMode: 'demo' })
  logDryRun('broker.init', {})
  logDryRun('broker.getAccount', {})
  logDryRun('broker.setPositionMode', 'ONE_WAY')
  logDryRun('broker.setLeverage', { symbol: 'BTC/USDT', leverage: 5 })
  logDryRun('broker.setMarginMode', { symbol: 'BTC/USDT', mode: 'CROSS' })
  logDryRun('broker.getMarkPrice', 'BTC/USDT')
  logDryRun('broker.getFundingRate', 'BTC/USDT')
  logDryRun('broker.getPositionMode', {})
  logDryRun('broker.placeOrder', { contract: 'BTC/USDT', side: 'BUY', type: 'LMT', limit: '<50% below mark>', quantity: 0.001, positionSide: 'BOTH', timeInForce: 'GTC' })
  logDryRun('broker.getOrders', ['<orderId>'])
  logDryRun('broker.cancelOrder', '<orderId>')
  logDryRun('broker.getOrders', ['<orderId>'])
  logDryRun('broker.close', {})
  console.log('[ok] dry-run completed; 14 intended calls printed')
  process.exit(0)
}

// ── Env-var gate ────────────────────────────────────────────────────────────
const demoEnv = requireDemoEnv()
if (!demoEnv) {
  logSkip('BINANCE_DEMO_KEY and BINANCE_DEMO_SECRET required; skipping Binance Demo Trading USDM-futures check')
}

// CCXT canonical symbol for USDⓈ-M perpetual BTC futures
const SYMBOL = 'BTC/USDT'
const QUANTITY = '0.001'
const DISCOUNT = 0.5
const TARGET_LEVERAGE = 5

async function main(): Promise<void> {
  console.log(`[info] key=${redact(demoEnv!.apiKey)}  secret=${redact(demoEnv!.secret)}`)

  // 1. Construct broker
  const broker = new CcxtBroker({
    id: 'binance-demo-usdm',
    exchange: 'binance',
    sandbox: false,
    simulationMode: 'demo',
    tradingMode: 'usdm-futures',
    apiKey: demoEnv!.apiKey,
    secret: demoEnv!.secret,
  })
  logOk('CcxtBroker constructed (tradingMode=usdm-futures, simulationMode=demo)')

  // 2. Connect / authenticate
  await broker.init()
  logOk('broker.init() passed — authenticated to Binance Demo Trading USDM-futures')

  // Pre-flight balance check: futures account needs some USDT to proceed
  const account = await broker.getAccount()
  const accountBalance = parseFloat(String(account.netLiquidation ?? '0'))
  logOk(`getAccount() → netLiquidation=${account.netLiquidation} ${account.baseCurrency}`)
  if (accountBalance < 1) {
    logSkip(`insufficient demo USDM balance — netLiquidation=${accountBalance.toFixed(4)} (need ≥1); fund the demo account first`)
  }

  // 3. setPositionMode('ONE_WAY') — idempotent (Binance returns an error if already set;
  //    we swallow it gracefully because it means we're already in the right mode)
  try {
    await broker.setPositionMode!('ONE_WAY')
    logOk('setPositionMode(ONE_WAY) — applied')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('No need') || msg.includes('already') || msg.includes('same')) {
      logOk('setPositionMode(ONE_WAY) — already ONE_WAY (idempotent)')
    } else {
      logFail('setPositionMode(ONE_WAY) failed unexpectedly', err)
      process.exit(1)
    }
  }

  // 4. setLeverage
  const levResult = await broker.setLeverage!(SYMBOL, TARGET_LEVERAGE)
  if (levResult.leverage !== TARGET_LEVERAGE) {
    logFail(`setLeverage(${SYMBOL}, ${TARGET_LEVERAGE}) → unexpected leverage=${levResult.leverage}`)
    process.exit(1)
  }
  logOk(`setLeverage(${SYMBOL}, ${TARGET_LEVERAGE}) → leverage=${levResult.leverage}`)

  // 5. setMarginMode (CROSS) — swallow "already set" errors like setPositionMode
  try {
    await broker.setMarginMode!(SYMBOL, 'CROSS')
    logOk(`setMarginMode(${SYMBOL}, CROSS) — applied`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('No need') || msg.includes('already') || msg.includes('same')) {
      logOk(`setMarginMode(${SYMBOL}, CROSS) — already CROSS (idempotent)`)
    } else {
      logFail(`setMarginMode(${SYMBOL}, CROSS) failed unexpectedly`, err)
      process.exit(1)
    }
  }

  // 6. getMarkPrice
  const markPrice = await broker.getMarkPrice!(SYMBOL)
  if (!markPrice.markPrice || markPrice.markPrice === '0') {
    logFail(`getMarkPrice(${SYMBOL}) returned zero or missing markPrice`)
    process.exit(1)
  }
  logOk(`getMarkPrice(${SYMBOL}) → markPrice=${markPrice.markPrice}, indexPrice=${markPrice.indexPrice ?? 'n/a'}`)

  // 7. getFundingRate
  const fundingRate = await broker.getFundingRate!(SYMBOL)
  if (!fundingRate.nextFundingTime) {
    logFail(`getFundingRate(${SYMBOL}) returned missing nextFundingTime`)
    process.exit(1)
  }
  logOk(`getFundingRate(${SYMBOL}) → rate=${fundingRate.rate}, nextFundingTime=${fundingRate.nextFundingTime}, markPrice=${fundingRate.markPrice}`)

  // 8. getPositionMode
  const posMode = await broker.getPositionMode!()
  if (posMode !== 'ONE_WAY') {
    logFail(`getPositionMode() → expected 'ONE_WAY', got '${posMode}'`)
    process.exit(1)
  }
  logOk(`getPositionMode() → ${posMode}`)

  // 9–12. Order lifecycle
  const btcContract = new Contract()
  btcContract.symbol = 'BTC'
  btcContract.localSymbol = SYMBOL
  btcContract.currency = 'USDT'

  const currentMarkPrice = new Decimal(markPrice.markPrice)
  const limitPrice = currentMarkPrice.mul(1 - DISCOUNT)
  logOk(`placing LIMIT BUY at ${limitPrice.toFixed(2)} (50% below mark price ${currentMarkPrice.toFixed(2)})`)

  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(QUANTITY)
  order.lmtPrice = limitPrice
  order.futuresParams = {
    positionSide: 'BOTH',
    reduceOnly: false,
    timeInForce: 'GTC',
  }

  let placedOrderId: string | undefined

  try {
    const result = await broker.placeOrder(btcContract, order)
    if (!result.success) {
      logFail(`placeOrder failed: ${result.error}`)
      process.exit(1)
    }
    placedOrderId = result.orderId
    logOk(`placeOrder(BUY ${QUANTITY} ${SYMBOL} @ ${limitPrice.toFixed(2)}, BOTH/GTC) → orderId=${placedOrderId}`)

    // 10. Verify open
    const openOrders = await broker.getOrders([placedOrderId!])
    if (openOrders.length === 0) {
      logFail(`order ${placedOrderId} not found in getOrders()`)
      process.exit(1)
    }
    logOk(`getOrders([${placedOrderId}]) → status=${openOrders[0].orderState.status}`)

  } finally {
    // 11. Cancel order (always runs)
    if (placedOrderId) {
      logCleanup(`cancelling futures order ${placedOrderId}`)
      const cancelResult = await broker.cancelOrder(placedOrderId)
      if (cancelResult.success) {
        logCleanup(`order ${placedOrderId} cancelled`)
      } else {
        logCleanup(`cancelOrder returned non-success: ${cancelResult.error} — may have filled`)
      }
    }
  }

  // 12. Verify cancellation
  if (placedOrderId) {
    const afterCancel = await broker.getOrders([placedOrderId])
    if (afterCancel.length > 0 && afterCancel[0].orderState.status !== 'Cancelled') {
      logFail(`order ${placedOrderId} still active after cancel: status=${afterCancel[0].orderState.status}`)
      process.exit(1)
    }
    logOk(`post-cancel check passed — order is cancelled or no longer visible`)
  }

  await broker.close()

  console.log('\n[PASS] check-binance-testnet-usdm: all checks passed.')
}

main().catch(err => {
  logFail('Uncaught error in check-binance-testnet-usdm', err)
  process.exit(1)
})
