/**
 * Broker types — IBroker interface and associated data types.
 *
 * All broker implementations (Alpaca, CCXT, IBKR, ...) implement IBroker.
 * Order/Contract/Execution/OrderState come directly from @traderalice/ibkr.
 * Only types that IBKR doesn't define (Position, AccountInfo, Quote, etc.)
 * are defined here, with field names aligned to IBKR conventions.
 */

import type { Contract, ContractDescription, ContractDetails, Order, OrderState, Execution, OrderCancel } from '@traderalice/ibkr-types'
import type Decimal from 'decimal.js'
import '../contract-ext.js'

// ==================== Errors ====================

export type BrokerErrorCode = 'CONFIG' | 'AUTH' | 'NETWORK' | 'EXCHANGE' | 'MARKET_CLOSED' | 'UNKNOWN'

/**
 * Structured broker error.
 * - `permanent` errors (CONFIG, AUTH) disable the account — will not be retried.
 * - Transient errors (NETWORK, EXCHANGE, MARKET_CLOSED) trigger auto-recovery.
 */
export class BrokerError extends Error {
  readonly code: BrokerErrorCode
  readonly permanent: boolean

  constructor(code: BrokerErrorCode, message: string) {
    super(message)
    this.name = 'BrokerError'
    this.code = code
    this.permanent = code === 'CONFIG' || code === 'AUTH'
  }

  /** Wrap any error as a BrokerError, classifying by message patterns. */
  static from(err: unknown, fallbackCode: BrokerErrorCode = 'UNKNOWN'): BrokerError {
    if (err instanceof BrokerError) return err
    const msg = err instanceof Error ? err.message : String(err)
    const code = BrokerError.classifyMessage(msg) ?? fallbackCode
    const be = new BrokerError(code, msg)
    if (err instanceof Error) be.cause = err
    return be
  }

  /** Infer error code from common message patterns. */
  private static classifyMessage(msg: string): BrokerErrorCode | null {
    const m = msg.toLowerCase()
    // Market closed — check before AUTH to avoid 403 misclassification
    if (/market.?closed|not.?open|trading.?halt|outside.?trading.?hours/i.test(m)) return 'MARKET_CLOSED'
    // Network / infrastructure
    if (/timeout|etimedout|econnrefused|econnreset|socket hang up|enotfound|fetch failed/i.test(m)) return 'NETWORK'
    if (/429|rate.?limit|too many requests/i.test(m)) return 'NETWORK'
    if (/502|503|504|service.?unavailable|bad.?gateway/i.test(m)) return 'NETWORK'
    // Authentication (401 only — 403 can mean market closed or permission denied)
    if (/401|unauthorized|invalid.?key|invalid.?signature|authentication/i.test(m)) return 'AUTH'
    // Exchange-level rejections
    if (/403|forbidden/i.test(m)) return 'EXCHANGE'
    if (/insufficient|not.?enough|margin/i.test(m)) return 'EXCHANGE'
    return null
  }
}

// ==================== Futures types ====================

/**
 * Futures-specific order parameters. When set on Order.futuresParams,
 * the order routes through the futures endpoint with Binance-specific behavior.
 */
export interface FuturesOrderParams {
  /**
   * - 'BOTH' (default, one-way mode): single position per symbol
   * - 'LONG' / 'SHORT' (hedge mode): independent long and short positions
   */
  positionSide?: 'BOTH' | 'LONG' | 'SHORT'
  /** If true, order can only reduce position (never flip side). */
  reduceOnly?: boolean
  /** If true, close entire position at market on fill. */
  closePosition?: boolean
  /** Time-in-force. Default GTC. */
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX'
}

/**
 * Funding rate snapshot for a USDM/COINM perpetual contract.
 */
export interface FundingRate {
  symbol: string
  /** Funding rate (decimal, e.g. "0.0001" = 0.01%) */
  rate: string
  /** Annualized rate estimate, if computable */
  annualizedRate?: string
  /** Next funding time (ISO 8601) */
  nextFundingTime: string
  /** Mark price at snapshot */
  markPrice: string
  /** Index price at snapshot */
  indexPrice?: string
}

/**
 * Per-symbol leverage setting.
 */
export interface LeverageSetting {
  symbol: string
  /** Effective leverage (1–125 typically, symbol-dependent) */
  leverage: number
  /** Max notional value at this leverage (USD or quote currency) */
  maxNotionalValue?: string
}

/**
 * Mark price snapshot — used by futures for liquidation/margin/funding calculations.
 * Distinct from last-trade price.
 */
export interface MarkPriceSnapshot {
  symbol: string
  markPrice: string
  /** Index price (basket of spot exchanges, where applicable) */
  indexPrice?: string
  /** Estimated annualized funding rate, if available */
  estimatedFundingRate?: string
}

export type PositionMode = 'ONE_WAY' | 'HEDGE'
export type MarginMode = 'CROSS' | 'ISOLATED'

// ==================== Cross Margin types ====================

/**
 * Cross Margin account snapshot from a broker that supports margin trading.
 * All asset values are in BTC equivalent per Binance API convention.
 */
export interface MarginAccount {
  /** Total collateral value in BTC equivalent */
  totalAssetBtc: string
  /** Total borrowed in BTC equivalent (principal only, excludes interest) */
  totalLiabilityBtc: string
  /** totalAssetBtc - totalLiabilityBtc */
  totalNetAssetBtc: string
  /** Binance "margin ratio": totalAssetBtc / (totalLiabilityBtc + outstandingInterest). Higher is safer. */
  marginLevel: string
  /** Can this account borrow? */
  borrowEnabled: boolean
  /** Can funds be transferred to/from this account? */
  transferEnabled: boolean
  /** Can this account place orders? */
  tradeEnabled: boolean
}

/**
 * One asset's balance + borrow state in a Cross Margin account.
 */
export interface MarginAsset {
  asset: string
  /** Available balance (not in orders, not borrowed against) */
  free: string
  /** Locked in open orders */
  locked: string
  /** Outstanding loan principal */
  borrowed: string
  /** Accrued interest on the loan */
  interest: string
  /** free + locked - borrowed - interest */
  netAsset: string
}

/**
 * Per-order parameters for margin trading. When set, the order is routed
 * through the margin endpoint instead of spot.
 */
export interface MarginOrderParams {
  /**
   * - 'NO_SIDE_EFFECT' (default): margin order without auto-borrow or auto-repay
   * - 'MARGIN_BUY': auto-borrow the quote asset to fund the buy
   * - 'AUTO_REPAY': auto-repay the loan with proceeds when the order fills
   */
  sideEffectType?: 'NO_SIDE_EFFECT' | 'MARGIN_BUY' | 'AUTO_REPAY'
  /** Cross Margin = false (pivot default). Isolated Margin = true. */
  isIsolated?: boolean
  /** If true, repay any outstanding loan on this asset when the order is cancelled. */
  autoRepayAtCancel?: boolean
}

/**
 * Funds transfer between Spot Wallet and Cross Margin Wallet.
 */
export interface FundingTransfer {
  type: 'SPOT_TO_CROSS_MARGIN' | 'CROSS_MARGIN_TO_SPOT'
  asset: string
  amount: string
}

/**
 * Result of a margin-related operation that returns a transaction reference.
 */
export interface MarginOperationResult {
  /** Broker-issued transaction ID */
  txId: string
  /** Broker-issued client-side ID echoed back (matches the journal's client_order_id) */
  clientOrderId?: string
}

// ==================== Position ====================

/**
 * Unified position/holding.
 * Field names aligned with IBKR EWrapper.updatePortfolio() parameters.
 */
export interface Position {
  contract: Contract
  /** Currency denomination for all monetary fields (avgCost, marketPrice, marketValue, PnL). */
  currency: string
  side: 'long' | 'short'
  quantity: Decimal
  /** All monetary fields are strings to prevent IEEE 754 floating-point artifacts. Use Decimal for arithmetic. */
  avgCost: string
  marketPrice: string
  marketValue: string
  unrealizedPnL: string
  realizedPnL: string
  /**
   * Shares-per-contract metadata: how many underlying shares one
   * unit of `quantity` represents. `'1'` for plain stocks; `'100'`
   * for US equity options; HK warrants/CBBCs use the issuer-specific
   * conversion ratio (often a non-integer like '0.1' or '10').
   *
   * `marketValue` is already multiplier-applied at the broker layer —
   * this field is metadata for UI / analytics ("1 contract = 100
   * shares"), not a math input. Consumers must NOT re-apply.
   */
  multiplier?: string
  /**
   * Margin-specific metadata. Undefined for spot positions; populated for
   * positions held in a Cross Margin account.
   */
  marginMetadata?: {
    /** Amount borrowed against this position's asset (principal) */
    borrowed: string
    /** Accrued interest on the borrow */
    interest: string
    /** Snapshot of the account's margin level at position read time */
    marginLevel: string
  }
  /**
   * Futures-specific metadata. Undefined for spot and Cross Margin positions;
   * populated for positions held on USDM/COINM Futures.
   */
  futuresMetadata?: {
    /** Mark price at read time (different from market trade price) */
    markPrice: string
    /** Liquidation price (broker-calculated). Undefined for positions with no liquidation risk. */
    liquidationPrice?: string
    /** Effective leverage on this position (1-125 typically) */
    leverage: number
    /** Margin mode at the position level */
    marginMode: MarginMode
    /** Position side (relevant in hedge mode). 'BOTH' in one-way mode. */
    positionSide: 'BOTH' | 'LONG' | 'SHORT'
    /** Initial margin used (Decimal string) */
    initialMargin?: string
    /** Maintenance margin required (Decimal string) */
    maintMargin?: string
  }
}

// ==================== Order result ====================

/** Result of placeOrder / modifyOrder / closePosition. */
export interface PlaceOrderResult {
  success: boolean
  orderId?: string
  error?: string
  message?: string
  execution?: Execution
  orderState?: OrderState
}

/** An open/completed order triplet as returned by getOrders(). */
export interface OpenOrder {
  contract: Contract
  order: Order
  orderState: OrderState
  /**
   * Average fill price — from orderStatus callback or broker-specific
   * source. String to preserve Decimal precision end-to-end (sub-tick
   * fills + sub-satoshi accounting in OKX/Bybit unified accounts can
   * lose information through float).
   */
  avgFillPrice?: string
  /** Attached take-profit / stop-loss (CCXT: from order fields; Alpaca: from bracket legs). */
  tpsl?: TpSlParams
}

// ==================== Account info ====================

/** Field names aligned with IBKR AccountSummaryTags. All monetary fields are strings to prevent IEEE 754 artifacts. */
export interface AccountInfo {
  /** Base currency of this account — all monetary fields are denominated in this currency. */
  baseCurrency: string
  netLiquidation: string
  totalCashValue: string
  unrealizedPnL: string
  realizedPnL?: string
  buyingPower?: string
  initMarginReq?: string
  maintMarginReq?: string
  dayTradesRemaining?: number
}

// ==================== Market data ====================

/**
 * Real-time tick data from the broker. Monetary fields are strings —
 * trading-side numerics stay in Decimal-as-string end-to-end.
 * (Distinct from `domain/market-data` Quote types, which serve the
 * read-only analysis surface and stay number-typed there.)
 */
export interface Quote {
  contract: Contract
  last: string
  bid: string
  ask: string
  volume: string
  high?: string
  low?: string
  timestamp: Date
}

export interface MarketClock {
  isOpen: boolean
  nextOpen?: Date
  nextClose?: Date
  timestamp?: Date
}

// ==================== Broker health ====================

export type BrokerHealth = 'healthy' | 'degraded' | 'offline'

export interface BrokerHealthInfo {
  status: BrokerHealth
  consecutiveFailures: number
  lastError?: string
  lastSuccessAt?: Date
  lastFailureAt?: Date
  recovering: boolean
  disabled: boolean
}

// ==================== Account capabilities ====================

export interface AccountCapabilities {
  supportedSecTypes: string[]
  supportedOrderTypes: string[]
}

// ==================== Broker config field descriptor ====================

/** Describes a single config field for a broker type — used by the frontend to dynamically render forms. */
export interface BrokerConfigField {
  name: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select'
  label: string
  placeholder?: string
  default?: unknown
  required?: boolean
  options?: Array<{ value: string; label: string }>
  description?: string
  /** True for secrets (apiKey, etc.) — backend masks these in API responses. */
  sensitive?: boolean
}

// ==================== Take Profit / Stop Loss ====================

export interface TpSlParams {
  takeProfit?: { price: string }
  stopLoss?: { price: string; limitPrice?: string }
}

// ==================== IBroker ====================

export interface IBroker<TMeta = unknown> {
  /** Unique account ID, e.g. "alpaca-paper", "bybit-main". */
  readonly id: string

  /** User-facing display name. */
  readonly label: string

  /** Broker-specific metadata. Generic allows typed access in implementations. */
  readonly meta?: TMeta

  // ---- Lifecycle ----

  init(): Promise<void>
  close(): Promise<void>

  // ---- Contract search (IBKR: reqMatchingSymbols + reqContractDetails) ----

  searchContracts(pattern: string): Promise<ContractDescription[]>
  getContractDetails(query: Contract): Promise<ContractDetails | null>

  /**
   * Refresh the broker's local catalog cache from upstream.
   * Optional — only EnumeratingCatalog brokers (Alpaca / CCXT / Mock)
   * implement this. SearchingCatalog brokers (IBKR via reqMatchingSymbols)
   * leave it undefined; the cron loop in main.ts skips them via `?.`.
   *
   * Implementations should keep the prior cache on failure and let the
   * exception propagate so the caller can log.
   */
  refreshCatalog?(): Promise<void>

  // ---- Trading operations (IBKR Order as source of truth) ----

  placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult>
  modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult>
  cancelOrder(orderId: string, orderCancel?: OrderCancel): Promise<PlaceOrderResult>
  closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult>

  // ---- Queries ----

  getAccount(): Promise<AccountInfo>
  getPositions(): Promise<Position[]>
  getOrders(orderIds: string[]): Promise<OpenOrder[]>
  getOrder(orderId: string): Promise<OpenOrder | null>
  getQuote(contract: Contract): Promise<Quote>
  getMarketClock(): Promise<MarketClock>

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities

  // ---- Contract identity ----

  /** Extract the broker-native unique key from a contract (for aliceId construction).
   *  Each broker defines its own uniqueness: Alpaca = ticker, CCXT = unified symbol, IBKR = conId. */
  getNativeKey(contract: Contract): string

  /** Reconstruct a trade-ready contract from a nativeKey (for aliceId resolution).
   *  Broker fills in secType, exchange, currency, conId, etc. as needed. */
  resolveNativeKey(nativeKey: string): Contract

  // ---- Margin trading (optional — only implemented by margin-capable brokers) ----

  /**
   * Get the margin account snapshot. Optional — only implemented by brokers
   * that support margin trading (CCXT with marginType='cross').
   */
  getMarginAccount?(): Promise<MarginAccount>

  /**
   * List all margin assets with their borrow/free/locked state.
   */
  getMarginAssets?(): Promise<MarginAsset[]>

  /**
   * Borrow an asset against the margin account's collateral.
   * @param asset - e.g., 'USDT'
   * @param amount - quantity to borrow, as a string (broker-canonical decimal)
   */
  borrow?(asset: string, amount: string): Promise<MarginOperationResult>

  /**
   * Repay a borrowed amount.
   */
  repay?(asset: string, amount: string): Promise<MarginOperationResult>

  /**
   * Transfer funds between Spot Wallet and Cross Margin Wallet.
   */
  transferFunding?(op: FundingTransfer): Promise<MarginOperationResult>

  // ---- Futures trading (optional — only implemented by futures-capable brokers) ----

  /**
   * Set per-symbol leverage. Idempotent — calling with the same value is a no-op.
   * Required before placing leveraged orders on most futures symbols.
   */
  setLeverage?(symbol: string, leverage: number): Promise<LeverageSetting>

  /** Read the current leverage setting for a symbol. */
  getLeverage?(symbol: string): Promise<LeverageSetting>

  /**
   * Set account-wide position mode (one-way vs hedge).
   * Note: cannot be changed while open positions exist.
   */
  setPositionMode?(mode: PositionMode): Promise<void>

  /** Read current account-wide position mode. */
  getPositionMode?(): Promise<PositionMode>

  /**
   * Set per-symbol margin mode (CROSS or ISOLATED).
   * Cannot be changed while there are open positions on the symbol.
   */
  setMarginMode?(symbol: string, mode: MarginMode): Promise<void>

  /** Read the current funding rate for a perpetual symbol. */
  getFundingRate?(symbol: string): Promise<FundingRate>

  /**
   * Read mark price for a symbol (futures-specific). Different from
   * last-trade price — used internally for liquidation calculations.
   */
  getMarkPrice?(symbol: string): Promise<MarkPriceSnapshot>
}
