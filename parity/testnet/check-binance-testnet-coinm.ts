#!/usr/bin/env tsx
/**
 * parity/testnet/check-binance-testnet-coinm.ts
 *
 * LIVE NETWORK TEST — gated by env vars. Exits 0 (skipped) when credentials
 * are not set, so this script is safe in CI and local dev without credentials.
 *
 * Tests the COIN-M Futures lifecycle against the Binance Futures testnet:
 *   1. Construct CcxtBroker (tradingMode='coinm-futures', sandbox=true)
 *   2. Connect via init()
 *   3. setPositionMode('ONE_WAY') — idempotent setup
 *   4. setLeverage for the COIN-M symbol
 *   5. setMarginMode (CROSS)
 *   6. getMarkPrice — verify shape
 *   7. getFundingRate — verify shape
 *   8. getPositionMode() — should return 'ONE_WAY'
 *   9. Place LIMIT order at 50% below market
 *  10. Verify order open
 *  11. Cancel order (try/finally)
 *  12. Verify cancellation
 *
 * COIN-M Symbol note:
 *   CCXT's canonical symbol for the BTC perpetual on dapi.binance.com is
 *   'BTC/USD:BTC'. This script tries 'BTC/USD:BTC' first, then falls back to
 *   'BTC/USD' — whichever resolves correctly against the loaded market catalog.
 *   The testnet symbol is documented in KNOWN_SYMBOL_CANDIDATES below.
 *
 * Testnet account: https://testnet.binancefuture.com/ → switch to COIN-M tab
 *   → API Management → create a separate COIN-M key (different from USDM key).
 *   Assumption: COINM testnet may share the same portal but requires a different
 *   API key pair from USDM. Verify on the testnet portal.
 *
 * Required env vars:
 *   BINANCE_COINM_TESTNET_KEY    — COIN-M Futures testnet API key
 *   BINANCE_COINM_TESTNET_SECRET — COIN-M Futures testnet API secret
 *
 * Run: pnpm tsx parity/testnet/check-binance-testnet-coinm.ts
 */

import Decimal from 'decimal.js'
import * as ccxt from 'ccxt'
import { Contract, Order } from '@traderalice/ibkr-types'
import { CcxtBroker } from '../../src/domain/trading/brokers/ccxt/CcxtBroker.js'
import { requireEnv, logSkip, logOk, logFail, logCleanup, redact, shouldDryRun, logDryRun } from './_helpers.js'
import '../../src/domain/trading/contract-ext.js'

// ── Dry-run path ─────────────────────────────────────────────────────────────
if (shouldDryRun()) {
  console.log('[dry-run] check-binance-testnet-coinm.ts intended call sequence:')
  logDryRun('new CcxtBroker', { exchange: 'binance', tradingMode: 'coinm-futures', sandbox: true })
  logDryRun('broker.init', {})
  logDryRun('broker.getAccount', {})
  logDryRun('exchange.loadMarkets', {})
  logDryRun('findCoinmBtcPerp', { type: 'swap', settle: 'BTC', base: 'BTC', quote: 'USD' })
  logDryRun('broker.setPositionMode', 'ONE_WAY')
  logDryRun('broker.setLeverage', { symbol: 'BTC/USD:BTC', leverage: 5 })
  logDryRun('broker.setMarginMode', { symbol: 'BTC/USD:BTC', mode: 'CROSS' })
  logDryRun('broker.getMarkPrice', 'BTC/USD:BTC')
  logDryRun('broker.getFundingRate', 'BTC/USD:BTC')
  logDryRun('broker.getPositionMode', {})
  logDryRun('broker.placeOrder', { contract: 'BTC/USD:BTC', side: 'BUY', type: 'LMT', limit: '<50% below mark>', quantity: 1, positionSide: 'BOTH', timeInForce: 'GTC' })
  logDryRun('broker.getOrders', ['<orderId>'])
  logDryRun('broker.cancelOrder', '<orderId>')
  logDryRun('broker.getOrders', ['<orderId>'])
  logDryRun('broker.close', {})
  console.log('[ok] dry-run completed; 16 intended calls printed')
  process.exit(0)
}

// ── Env-var gate ────────────────────────────────────────────────────────────
const env = requireEnv('BINANCE_COINM_TESTNET_KEY', 'BINANCE_COINM_TESTNET_SECRET')
if (!env) {
  logSkip('BINANCE_COINM_TESTNET_KEY and BINANCE_COINM_TESTNET_SECRET required; skipping live testnet COIN-M futures check')
}

const QUANTITY = '1'       // 1 contract — minimum for COIN-M (each contract = 100 USD)
const DISCOUNT = 0.5
const TARGET_LEVERAGE = 5

/**
 * Auto-detect the BTC COIN-M perpetual symbol by inspecting the exchange's
 * loaded market catalog. Looks for a swap market settled in BTC with
 * base=BTC, quote=USD, and no expiry (perpetual).
 */
async function findCoinmBtcPerp(exchange: ccxt.Exchange): Promise<string> {
  await exchange.loadMarkets()
  for (const m of Object.values(exchange.markets)) {
    if (m.type === 'swap' && m.settle === 'BTC' && m.base === 'BTC' && m.quote === 'USD' && !m.expiry) {
      return m.symbol
    }
  }
  throw new Error('Could not find BTC coin-margined perpetual on this exchange')
}

async function main(): Promise<void> {
  console.log(`[info] key=${redact(env!['BINANCE_COINM_TESTNET_KEY'])}  secret=${redact(env!['BINANCE_COINM_TESTNET_SECRET'])}`)

  // 1. Construct broker
  const broker = new CcxtBroker({
    id: 'binance-testnet-coinm',
    exchange: 'binance',
    sandbox: true,
    tradingMode: 'coinm-futures',
    apiKey: env!['BINANCE_COINM_TESTNET_KEY'],
    secret: env!['BINANCE_COINM_TESTNET_SECRET'],
  })
  logOk('CcxtBroker constructed (tradingMode=coinm-futures, sandbox=true)')

  // 2. Connect / authenticate
  await broker.init()
  logOk('broker.init() passed — authenticated to Binance COIN-M Futures testnet')

  // Pre-flight balance check: futures account needs some BTC to proceed
  const account = await broker.getAccount()
  const accountBalance = parseFloat(String(account.netLiquidation ?? '0'))
  logOk(`getAccount() → netLiquidation=${account.netLiquidation} ${account.baseCurrency}`)
  if (accountBalance < 0.0001) {
    logSkip(`insufficient testnet COINM balance — netLiquidation=${accountBalance.toFixed(8)} (need ≥0.0001 BTC); fund the account first`)
  }

  // Resolve the correct COIN-M symbol by scanning the live market catalog
  // Use a standalone CCXT exchange to call findCoinmBtcPerp (broker.exchange is private)
  const exchanges = ccxt as unknown as Record<string, new (opts: Record<string, unknown>) => ccxt.Exchange>
  const rawExchange = new exchanges['binancecoinm']!({
    apiKey: env!['BINANCE_COINM_TESTNET_KEY'],
    secret: env!['BINANCE_COINM_TESTNET_SECRET'],
    sandbox: true,
  })
  const SYMBOL = await findCoinmBtcPerp(rawExchange)
  logOk(`findCoinmBtcPerp: using symbol '${SYMBOL}'`)

  // 3. setPositionMode('ONE_WAY') — idempotent
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

  // 5. setMarginMode (CROSS)
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
  const markPriceSnap = await broker.getMarkPrice!(SYMBOL)
  if (!markPriceSnap.markPrice || markPriceSnap.markPrice === '0') {
    logFail(`getMarkPrice(${SYMBOL}) returned zero or missing markPrice`)
    process.exit(1)
  }
  logOk(`getMarkPrice(${SYMBOL}) → markPrice=${markPriceSnap.markPrice}, indexPrice=${markPriceSnap.indexPrice ?? 'n/a'}`)

  // 7. getFundingRate
  const fundingRate = await broker.getFundingRate!(SYMBOL)
  if (!fundingRate.nextFundingTime) {
    logFail(`getFundingRate(${SYMBOL}) returned missing nextFundingTime`)
    process.exit(1)
  }
  logOk(`getFundingRate(${SYMBOL}) → rate=${fundingRate.rate}, nextFundingTime=${fundingRate.nextFundingTime}`)

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
  btcContract.currency = 'USD'

  const currentMarkPrice = new Decimal(markPriceSnap.markPrice)
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
      logCleanup(`cancelling COIN-M futures order ${placedOrderId}`)
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

  console.log('\n[PASS] check-binance-testnet-coinm: all checks passed.')
}

main().catch(err => {
  logFail('Uncaught error in check-binance-testnet-coinm', err)
  process.exit(1)
})
