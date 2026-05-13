#!/usr/bin/env tsx
/**
 * parity/testnet/check-binance-testnet-margin.ts
 *
 * Cross Margin Spot (sapi) CANNOT be tested through CCXT testnet or demo trading.
 * CCXT's URL resolution layer has no 'sapi' key in either urls.api.test or urls.api.demo.
 * This script documents that constraint and exits cleanly so CI stays green.
 *
 * Reference: ccxt/ts/src/binance.ts — urls.api.test (no sapi key), urls.api.demo (no sapi key)
 *
 * Dry-run mode: BINANCE_TESTNET_DRY_RUN=1 prints the intended call sequence that
 * would run if CCXT supported sapi on testnet/demo (for documentation purposes).
 */

import { shouldDryRun, logDryRun } from './_helpers.js'

// ── Dry-run path ─────────────────────────────────────────────────────────────
if (shouldDryRun()) {
  console.log('[dry-run] check-binance-testnet-margin.ts intended call sequence (for documentation):')
  logDryRun('new CcxtBroker', { exchange: 'binance', tradingMode: 'cross-margin', simulationMode: 'demo' })
  logDryRun('broker.init', {})
  logDryRun('broker.getMarginAccount', {})
  logDryRun('broker.getMarginAssets', {})
  logDryRun('broker.getQuote', 'BTC/USDT')
  logDryRun('broker.placeOrder', { contract: 'BTC/USDT', side: 'BUY', type: 'LMT', limit: '<50% below market>', quantity: 0.001, sideEffectType: 'NO_SIDE_EFFECT' })
  logDryRun('broker.getOrders', ['<orderId>'])
  logDryRun('broker.cancelOrder', '<orderId>')
  logDryRun('broker.borrow', { asset: 'USDT', amount: '1' })
  logDryRun('broker.repay', { asset: 'USDT', amount: '1' })
  logDryRun('broker.transferFunding', { type: 'SPOT_TO_CROSS_MARGIN', asset: 'USDT', amount: '1' })
  logDryRun('broker.transferFunding', { type: 'CROSS_MARGIN_TO_SPOT', asset: 'USDT', amount: '1' })
  logDryRun('broker.close', {})
  console.log('[ok] dry-run completed; 13 intended calls printed')
  process.exit(0)
}

// ── Cannot-test marker ───────────────────────────────────────────────────────
console.log('[skip] Cross Margin Spot (sapi) cannot be tested through CCXT — neither testnet nor demo trading')
console.log('       supports sapi endpoints. CCXT enforces this at the URL-resolution layer.')
console.log('       Reference: ccxt/ts/src/binance.ts urls.api.test (no sapi key) and urls.api.demo (no sapi key).')
console.log('')
console.log('       Cross Margin Spot integration is verified by:')
console.log('         - Unit tests with MockExchange (CcxtBroker.spec.ts, 8+ margin tests)')
console.log('         - Integration tests (binance-margin-lifecycle.spec.ts)')
console.log('       Live mainnet testing is the only end-to-end option — recommend extreme caution + small amounts.')
process.exit(0)
