#!/usr/bin/env tsx
/**
 * parity/testnet/check-binance-testnet-spot.ts
 *
 * LIVE NETWORK TEST — gated by env vars. Exits 0 (skipped) when credentials
 * are not set, so this script is safe in CI and local dev without credentials.
 *
 * Tests the basic spot order lifecycle against the Binance Spot testnet:
 *   1. Construct CcxtBroker (tradingMode='spot', sandbox=true)
 *   2. Connect via init() — verifies authentication
 *   3. Read account balance via getAccount()
 *   4. Place a tiny LIMIT BUY at 50% below market (will not fill)
 *   5. Verify order appears in open orders
 *   6. Cancel the order (try/finally — always runs)
 *   7. Verify cancellation
 *
 * Required env vars:
 *   BINANCE_TESTNET_KEY    — Spot/Margin testnet API key
 *   BINANCE_TESTNET_SECRET — Spot/Margin testnet API secret
 *
 * Testnet account: https://testnet.binance.vision/
 * Run: pnpm tsx parity/testnet/check-binance-testnet-spot.ts
 */

import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr-types'
import { CcxtBroker } from '../../src/domain/trading/brokers/ccxt/CcxtBroker.js'
import { requireEnv, logSkip, logOk, logFail, logCleanup, redact, shouldDryRun, logDryRun } from './_helpers.js'

// ── Dry-run path ─────────────────────────────────────────────────────────────
if (shouldDryRun()) {
  console.log('[dry-run] check-binance-testnet-spot.ts intended call sequence:')
  logDryRun('new CcxtBroker', { exchange: 'binance', tradingMode: 'spot', sandbox: true })
  logDryRun('broker.init', {})
  logDryRun('broker.getAccount', {})
  logDryRun('broker.getQuote', 'BTC/USDT')
  logDryRun('broker.placeOrder', { contract: 'BTC/USDT', side: 'BUY', type: 'LMT', limit: '<50% below market>', quantity: 0.001 })
  logDryRun('broker.getOrders', ['<orderId>'])
  logDryRun('broker.cancelOrder', '<orderId>')
  logDryRun('broker.getOrders', ['<orderId>'])
  logDryRun('broker.close', {})
  console.log('[ok] dry-run completed; 9 intended calls printed')
  process.exit(0)
}

// ── Env-var gate ────────────────────────────────────────────────────────────
const env = requireEnv('BINANCE_TESTNET_KEY', 'BINANCE_TESTNET_SECRET')
if (!env) {
  logSkip('BINANCE_TESTNET_KEY and BINANCE_TESTNET_SECRET required; skipping live testnet check')
}

const SYMBOL = 'BTC/USDT'
const QUANTITY = '0.001'   // tiny order — well below most testnet minimums; increase to 0.01 if rejected
const DISCOUNT = 0.5       // place limit 50% below market — should never fill

async function main(): Promise<void> {
  console.log(`[info] key=${redact(env!['BINANCE_TESTNET_KEY'])}  secret=${redact(env!['BINANCE_TESTNET_SECRET'])}`)

  // 1. Construct broker
  const broker = new CcxtBroker({
    id: 'binance-testnet-spot',
    exchange: 'binance',
    sandbox: true,
    tradingMode: 'spot',
    apiKey: env!['BINANCE_TESTNET_KEY'],
    secret: env!['BINANCE_TESTNET_SECRET'],
  })
  logOk('CcxtBroker constructed (tradingMode=spot, sandbox=true)')

  // 2. Connect / authenticate
  await broker.init()
  logOk('broker.init() passed — authenticated to Binance Spot testnet')

  // 3. Read account balance
  const account = await broker.getAccount()
  logOk(`getAccount() → netLiquidation=${account.netLiquidation} ${account.baseCurrency}`)

  // 4. Get live market price for BTC/USDT
  const btcContract = new Contract()
  btcContract.symbol = 'BTC'
  btcContract.localSymbol = SYMBOL
  btcContract.currency = 'USDT'

  const quote = await broker.getQuote(btcContract)
  const marketPrice = new Decimal(quote.last)
  logOk(`getQuote(${SYMBOL}) → last=${marketPrice.toFixed(2)}`)

  // 5. Place a LIMIT BUY at 50% below market (will not fill on testnet)
  const limitPrice = marketPrice.mul(1 - DISCOUNT)

  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(QUANTITY)
  order.lmtPrice = limitPrice

  let placedOrderId: string | undefined

  try {
    const result = await broker.placeOrder(btcContract, order)
    if (!result.success) {
      logFail(`placeOrder failed: ${result.error}`)
      process.exit(1)
    }
    placedOrderId = result.orderId
    logOk(`placeOrder(BUY ${QUANTITY} ${SYMBOL} @ ${limitPrice.toFixed(2)}) → orderId=${placedOrderId}`)

    // 6. Verify order appears in open orders
    const openOrders = await broker.getOrders([placedOrderId!])
    if (openOrders.length === 0) {
      logFail(`order ${placedOrderId} not found in getOrders()`)
      process.exit(1)
    }
    const openOrder = openOrders[0]
    logOk(`getOrders([${placedOrderId}]) → status=${openOrder.orderState.status}`)

  } finally {
    // 7. Cancel order (cleanup — always runs even if assertions above fail)
    if (placedOrderId) {
      logCleanup(`cancelling order ${placedOrderId}`)
      const cancelResult = await broker.cancelOrder(placedOrderId)
      if (cancelResult.success) {
        logCleanup(`order ${placedOrderId} cancelled`)
      } else {
        // Non-fatal: order may have filled (testnet can be generous with fills)
        logCleanup(`cancelOrder returned non-success: ${cancelResult.error} — may have filled already`)
      }
    }
  }

  // 8. Verify cancellation — order should no longer appear in open orders
  if (placedOrderId) {
    const afterCancel = await broker.getOrders([placedOrderId])
    if (afterCancel.length > 0 && afterCancel[0].orderState.status !== 'Cancelled') {
      logFail(`order ${placedOrderId} still active after cancel: status=${afterCancel[0].orderState.status}`)
      process.exit(1)
    }
    logOk(`post-cancel check passed — order is cancelled or no longer visible`)
  }

  await broker.close()

  console.log('\n[PASS] check-binance-testnet-spot: all checks passed.')
}

main().catch(err => {
  logFail('Uncaught error in check-binance-testnet-spot', err)
  process.exit(1)
})
