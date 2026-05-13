export interface CcxtBrokerConfig {
  id?: string
  label?: string
  exchange: string
  sandbox: boolean
  demoTrading?: boolean
  options?: Record<string, unknown>
  /**
   * Simulation routing for non-live testing:
   * - undefined or 'none' (default): live mainnet endpoints
   * - 'sandbox': legacy testnet (testnet.binance.vision for spot, testnet.binancefuture.com for futures)
   *              CCXT considers futures sandbox deprecated — we set disableFuturesSandboxWarning=true to bypass.
   *              Cross Margin Spot (sapi) has NO sandbox URL in CCXT — config will throw if used.
   * - 'demo': new official Binance Demo Trading (demo-api.binance.com / demo-fapi.binance.com / demo-dapi.binance.com)
   *           Recommended for futures. Spot also works. Cross Margin Spot still NOT supported (no demo sapi URL).
   *
   * The legacy `sandbox: boolean` field is retained for backward compat — `sandbox: true` is treated as `simulationMode: 'sandbox'`.
   */
  simulationMode?: 'none' | 'sandbox' | 'demo'
  /**
   * Trading mode (selects the Binance product family routed via CCXT defaultType):
   * - 'spot' (default): regular spot trading
   * - 'cross-margin': Cross Margin Spot (single wallet, all positions share collateral)
   * - 'usdm-futures': USDⓈ-M Perpetual Futures (fapi.binance.com)
   * - 'coinm-futures': COIN-M Perpetual Futures (dapi.binance.com)
   */
  tradingMode?: 'spot' | 'cross-margin' | 'usdm-futures' | 'coinm-futures'
  // CCXT standard credential fields (all optional — each exchange requires a different subset)
  apiKey?: string
  secret?: string
  uid?: string
  accountId?: string
  login?: string
  password?: string
  twofa?: string
  privateKey?: string
  walletAddress?: string
  token?: string
}

/** CCXT standard credential field names (matches base Exchange.requiredCredentials map). */
export const CCXT_CREDENTIAL_FIELDS = [
  'apiKey', 'secret', 'uid', 'accountId', 'login',
  'password', 'twofa', 'privateKey', 'walletAddress', 'token',
] as const

export type CcxtCredentialField = typeof CCXT_CREDENTIAL_FIELDS[number]

export interface CcxtMarket {
  id: string        // exchange-native symbol, e.g. "BTCUSDT"
  symbol: string    // CCXT unified format, e.g. "BTC/USDT:USDT"
  base: string      // e.g. "BTC"
  quote: string     // e.g. "USDT"
  type: string      // "spot" | "swap" | "future" | "option"
  settle?: string   // e.g. "USDT" (for derivatives)
  active?: boolean
  precision?: { price?: number; amount?: number }
}

export const MAX_INIT_RETRIES = 8
export const INIT_RETRY_BASE_MS = 500

// ==================== CCXT-specific types (not part of IBroker) ====================

import type { Contract } from '@traderalice/ibkr-types'
import type { Position } from '../types.js'

/** Position with crypto-specific fields (leverage, margin, liquidation). */
export interface CcxtPosition extends Position {
  leverage?: number
  margin?: number
  liquidationPrice?: number
}

/** CCXT-specific funding rate (contract-centric, returned by fetchFundingRateByContract). */
export interface CcxtFundingRate {
  contract: Contract
  fundingRate: number
  nextFundingTime?: Date
  previousFundingRate?: number
  timestamp: Date
}

/** [price, amount] */
export type OrderBookLevel = [price: number, amount: number]

export interface OrderBook {
  contract: Contract
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: Date
}
