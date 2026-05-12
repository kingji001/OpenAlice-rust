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
import { Contract, Order } from '@traderalice/ibkr-types'
import { CcxtBroker } from '../../src/domain/trading/brokers/ccxt/CcxtBroker.js'
import { requireEnv, logSkip, logOk, logFail, logCleanup, redact } from './_helpers.js'
import '../../src/domain/trading/contract-ext.js'

// ── Env-var gate ────────────────────────────────────────────────────────────
const env = requireEnv('BINANCE_COINM_TESTNET_KEY', 'BINANCE_COINM_TESTNET_SECRET')
if (!env) {
  logSkip('BINANCE_COINM_TESTNET_KEY and BINANCE_COINM_TESTNET_SECRET required; skipping live testnet COIN-M futures check')
}

/**
 * COIN-M symbol candidates to try in order.
 * CCXT dapi.binance.com perpetual is typically 'BTC/USD:BTC';
 * some CCXT versions expose it as 'BTC/USD' without the settle suffix.
 * We try the canonical form first and fall back if the market lookup fails.
 */
const KNOWN_SYMBOL_CANDIDATES = ['BTC/USD:BTC', 'BTC/USD']

const QUANTITY = '1'       // 1 contract — minimum for COIN-M (each contract = 100 USD)
const DISCOUNT = 0.5
const TARGET_LEVERAGE = 5

/**
 * Attempt to resolve a COIN-M symbol by checking which candidate appears in the
 * broker's loaded market catalog. Returns the first matching symbol or throws.
 */
async function resolveCoinMSymbol(broker: CcxtBroker): Promise<string> {
  // getQuote will throw if the symbol isn't in the catalog; use it as a probe
  for (const candidate of KNOWN_SYMBOL_CANDIDATES) {
    try {
      const contract = new Contract()
      contract.symbol = 'BTC'
      contract.localSymbol = candidate
      contract.currency = 'USD'
      await broker.getQuote(contract)
      logOk(`resolveCoinMSymbol: using symbol '${candidate}'`)
      return candidate
    } catch {
      // not in catalog — try next
    }
  }
  throw new Error(
    `None of the COIN-M symbol candidates resolved: ${KNOWN_SYMBOL_CANDIDATES.join(', ')}. ` +
    'Check CCXT version and testnet market catalog.',
  )
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

  // Resolve the correct COIN-M symbol for BTC perpetual
  const SYMBOL = await resolveCoinMSymbol(broker)

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
