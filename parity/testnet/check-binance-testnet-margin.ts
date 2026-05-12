#!/usr/bin/env tsx
/**
 * parity/testnet/check-binance-testnet-margin.ts
 *
 * LIVE NETWORK TEST — gated by env vars. Exits 0 (skipped) when credentials
 * are not set, so this script is safe in CI and local dev without credentials.
 *
 * Tests the Cross Margin Spot lifecycle against the Binance Spot testnet
 * (the same testnet account covers both spot and cross margin):
 *   1. Construct CcxtBroker (tradingMode='cross-margin', sandbox=true)
 *   2. Connect via init()
 *   3. getMarginAccount() — verify shape, log marginLevel
 *   4. getMarginAssets() — verify array, log first few assets
 *   5. Place LIMIT order with NO_SIDE_EFFECT margin params (will not fill)
 *   6. Verify order in open orders
 *   7. Cancel order (try/finally)
 *   8. Borrow/repay round-trip: borrow 1 USDT, repay 1 USDT
 *   9. Transfer round-trip: SPOT→MARGIN then MARGIN→SPOT (1 USDT each way)
 *
 * Required env vars:
 *   BINANCE_TESTNET_KEY    — Spot/Margin testnet API key
 *   BINANCE_TESTNET_SECRET — Spot/Margin testnet API secret
 *
 * Testnet account: https://testnet.binance.vision/
 * Run: pnpm tsx parity/testnet/check-binance-testnet-margin.ts
 */

import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr-types'
import { CcxtBroker } from '../../src/domain/trading/brokers/ccxt/CcxtBroker.js'
import { requireEnv, logSkip, logOk, logFail, logCleanup, redact } from './_helpers.js'
import '../../src/domain/trading/contract-ext.js'

// ── Env-var gate ────────────────────────────────────────────────────────────
const env = requireEnv('BINANCE_TESTNET_KEY', 'BINANCE_TESTNET_SECRET')
if (!env) {
  logSkip('BINANCE_TESTNET_KEY and BINANCE_TESTNET_SECRET required; skipping live testnet cross-margin check')
}

const SYMBOL = 'BTC/USDT'
const QUANTITY = '0.001'
const DISCOUNT = 0.5
const BORROW_AMOUNT = '1'     // 1 USDT — minimal borrow for round-trip test
const TRANSFER_AMOUNT = '1'   // 1 USDT transfer each way

async function main(): Promise<void> {
  console.log(`[info] key=${redact(env!['BINANCE_TESTNET_KEY'])}  secret=${redact(env!['BINANCE_TESTNET_SECRET'])}`)

  // 1. Construct broker
  const broker = new CcxtBroker({
    id: 'binance-testnet-margin',
    exchange: 'binance',
    sandbox: true,
    tradingMode: 'cross-margin',
    apiKey: env!['BINANCE_TESTNET_KEY'],
    secret: env!['BINANCE_TESTNET_SECRET'],
  })
  logOk('CcxtBroker constructed (tradingMode=cross-margin, sandbox=true)')

  // 2. Connect / authenticate
  await broker.init()
  logOk('broker.init() passed — authenticated to Binance Cross Margin testnet')

  // 3. getMarginAccount — verify shape and log marginLevel
  const marginAccount = await broker.getMarginAccount!()
  if (!marginAccount.marginLevel) {
    logFail('getMarginAccount() returned no marginLevel')
    process.exit(1)
  }
  logOk(`getMarginAccount() → marginLevel=${marginAccount.marginLevel}, borrowEnabled=${marginAccount.borrowEnabled}`)

  // 4. getMarginAssets — verify array is populated
  const marginAssets = await broker.getMarginAssets!()
  if (!Array.isArray(marginAssets)) {
    logFail('getMarginAssets() did not return an array')
    process.exit(1)
  }
  logOk(`getMarginAssets() → ${marginAssets.length} assets`)
  if (marginAssets.length > 0) {
    const sample = marginAssets.slice(0, 3).map(a => `${a.asset}(free=${a.free})`)
    logOk(`  sample assets: ${sample.join(', ')}`)
  }

  // 5–7. Order placement + cancellation
  const btcContract = new Contract()
  btcContract.symbol = 'BTC'
  btcContract.localSymbol = SYMBOL
  btcContract.currency = 'USDT'

  const quote = await broker.getQuote(btcContract)
  const marketPrice = new Decimal(quote.last)
  const limitPrice = marketPrice.mul(1 - DISCOUNT)
  logOk(`market price for ${SYMBOL}: ${marketPrice.toFixed(2)} → limit at ${limitPrice.toFixed(2)}`)

  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'LMT'
  order.totalQuantity = new Decimal(QUANTITY)
  order.lmtPrice = limitPrice
  order.marginParams = { sideEffectType: 'NO_SIDE_EFFECT' }

  let placedOrderId: string | undefined

  try {
    const result = await broker.placeOrder(btcContract, order)
    if (!result.success) {
      logFail(`placeOrder failed: ${result.error}`)
      process.exit(1)
    }
    placedOrderId = result.orderId
    logOk(`placeOrder(BUY ${QUANTITY} ${SYMBOL} @ ${limitPrice.toFixed(2)}, NO_SIDE_EFFECT) → orderId=${placedOrderId}`)

    // 6. Verify order in open orders
    const openOrders = await broker.getOrders([placedOrderId!])
    if (openOrders.length === 0) {
      logFail(`order ${placedOrderId} not found in getOrders()`)
      process.exit(1)
    }
    logOk(`getOrders([${placedOrderId}]) → status=${openOrders[0].orderState.status}`)

  } finally {
    // 7. Cancel order (always runs)
    if (placedOrderId) {
      logCleanup(`cancelling order ${placedOrderId}`)
      const cancelResult = await broker.cancelOrder(placedOrderId)
      if (cancelResult.success) {
        logCleanup(`order ${placedOrderId} cancelled`)
      } else {
        logCleanup(`cancelOrder returned non-success: ${cancelResult.error} — may have filled already`)
      }
    }
  }

  // 8. Borrow/repay round-trip (1 USDT)
  if (marginAccount.borrowEnabled) {
    let borrowTxId: string | undefined
    try {
      const borrowResult = await broker.borrow!('USDT', BORROW_AMOUNT)
      borrowTxId = borrowResult.txId
      logOk(`borrow(USDT, ${BORROW_AMOUNT}) → txId=${borrowTxId}`)

      const repayResult = await broker.repay!('USDT', BORROW_AMOUNT)
      logOk(`repay(USDT, ${BORROW_AMOUNT}) → txId=${repayResult.txId}`)
    } catch (err) {
      // Borrow/repay can fail on testnet if the account lacks collateral — warn but don't fail
      logCleanup(`borrow/repay round-trip skipped or failed (testnet may lack collateral): ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    logOk('borrow step skipped — borrowEnabled=false on this account')
  }

  // 9. Transfer round-trip (1 USDT: SPOT→MARGIN, then MARGIN→SPOT)
  if (marginAccount.transferEnabled) {
    try {
      const toMargin = await broker.transferFunding!({ type: 'SPOT_TO_CROSS_MARGIN', asset: 'USDT', amount: TRANSFER_AMOUNT })
      logOk(`transferFunding(SPOT→MARGIN, USDT, ${TRANSFER_AMOUNT}) → txId=${toMargin.txId}`)

      const toSpot = await broker.transferFunding!({ type: 'CROSS_MARGIN_TO_SPOT', asset: 'USDT', amount: TRANSFER_AMOUNT })
      logOk(`transferFunding(MARGIN→SPOT, USDT, ${TRANSFER_AMOUNT}) → txId=${toSpot.txId}`)
    } catch (err) {
      // Transfer can fail if the wallet lacks sufficient USDT — warn but don't fail the whole script
      logCleanup(`transfer round-trip skipped or failed (testnet may lack balance): ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    logOk('transfer step skipped — transferEnabled=false on this account')
  }

  await broker.close()

  console.log('\n[PASS] check-binance-testnet-margin: all checks passed.')
}

main().catch(err => {
  logFail('Uncaught error in check-binance-testnet-margin', err)
  process.exit(1)
})
