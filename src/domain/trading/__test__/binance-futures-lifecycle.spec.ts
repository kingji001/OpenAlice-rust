/**
 * Binance Futures lifecycle integration tests.
 *
 * Exercises the full futures path through CcxtBroker — from placing a futures
 * order (with futuresParams) to getMarkPrice / getFundingRate, and the
 * setPositionMode → getPositionMode round-trip. Uses the same MockExchange
 * pattern as CcxtBroker.spec.ts (no live network).
 *
 * Scope: integration view. Fine-grained unit coverage lives in CcxtBroker.spec.ts.
 */

import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr-types'

// Mock ccxt BEFORE importing CcxtBroker so the constructor doesn't reach a
// real exchange. Mirrors the mock in CcxtBroker.spec.ts exactly.
vi.mock('ccxt', () => {
  const MockExchange = vi.fn(function (this: any) {
    this.markets = {}
    this.options = { fetchMarkets: { types: ['spot', 'linear'] } }
    this.setSandboxMode = vi.fn()
    this.loadMarkets = vi.fn().mockResolvedValue({})
    this.fetchMarkets = vi.fn().mockResolvedValue([])
    this.fetchTicker = vi.fn()
    this.fetchTickers = vi.fn().mockResolvedValue({})
    this.fetchBalance = vi.fn().mockResolvedValue({ free: {}, used: {}, total: {} })
    this.fetchPositions = vi.fn().mockResolvedValue([])
    this.fetchOpenOrders = vi.fn()
    this.fetchClosedOrders = vi.fn()
    this.createOrder = vi.fn()
    this.cancelOrder = vi.fn()
    this.editOrder = vi.fn()
    this.fetchOrder = vi.fn()
    this.fetchOpenOrder = vi.fn()
    this.fetchClosedOrder = vi.fn()
    this.fetchFundingRate = vi.fn()
    this.fetchOrderBook = vi.fn()
    // Binance SAPI margin endpoints
    this.sapiGetMarginAccount = vi.fn()
    this.sapiPostMarginLoan = vi.fn()
    this.sapiPostMarginRepay = vi.fn()
    this.sapiPostMarginTransfer = vi.fn()
    // Futures endpoints
    this.setLeverage = vi.fn()
    this.setPositionMode = vi.fn()
    this.setMarginMode = vi.fn()
    this.fapiPrivateGetPositionSideDual = vi.fn()
    this.dapiPrivateGetPositionSideDual = vi.fn()
    this.fapiPublicGetPremiumIndex = vi.fn()
    this.dapiPublicGetPremiumIndex = vi.fn()
  })

  return {
    default: {
      binance: MockExchange,
    },
  }
})

import { CcxtBroker } from '../brokers/ccxt/CcxtBroker.js'
import '../contract-ext.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsdmBroker() {
  return new CcxtBroker({
    exchange: 'binance',
    apiKey: 'test-key',
    secret: 'test-secret',
    sandbox: false,
    tradingMode: 'usdm-futures',
  })
}

function makeCoinmBroker() {
  return new CcxtBroker({
    exchange: 'binance',
    apiKey: 'test-key',
    secret: 'test-secret',
    sandbox: false,
    tradingMode: 'coinm-futures',
  })
}

function setInitialized(broker: CcxtBroker, markets: Record<string, any>) {
  ;(broker as any).initialized = true
  ;(broker as any).exchange.markets = markets
}

function makeFuturesMarket(base: string, quote: string, symbol: string): any {
  return {
    id: symbol.replace('/', '').replace(':', ''),
    symbol,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    type: 'future',
    active: true,
    precision: { price: 0.1 },
    limits: {},
    settle: quote.toUpperCase(),
  }
}

// ---------------------------------------------------------------------------
// Test 1: USDM tradingMode + setLeverage + placeOrder with futuresParams flow
// ---------------------------------------------------------------------------

describe('Binance USDM Futures — setLeverage + placeOrder with futuresParams', () => {
  it('sets leverage and routes futuresParams to CCXT createOrder params', async () => {
    const broker = makeUsdmBroker()
    setInitialized(broker, {
      'BTC/USDT:USDT': makeFuturesMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    // Step 1: setLeverage
    ;(broker as any).exchange.setLeverage = vi.fn().mockResolvedValue({ leverage: 10 })
    const leverageResult = await broker.setLeverage!('BTC/USDT:USDT', 10)
    expect(leverageResult.symbol).toBe('BTC/USDT:USDT')
    expect(leverageResult.leverage).toBe(10)

    // Verify CCXT received leverage + symbol in correct positional order
    expect((broker as any).exchange.setLeverage).toHaveBeenCalledWith(10, 'BTC/USDT:USDT')

    // Also verify the exchange was constructed with defaultType: 'future'
    const exchangeOptions = (broker as any).exchange.options
    // The mock captures the options passed to the constructor via 'this.options'
    // but because options are set in the constructor before the mock captures them,
    // we verify via tradingMode internal state instead
    expect((broker as any).tradingMode).toBe('usdm-futures')
    expect((broker as any).isFutures).toBe(true)

    // Step 2: placeOrder with futuresParams
    ;(broker as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'futures-lifecycle-ord-1',
      status: 'open',
      average: undefined,
      filled: undefined,
    })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT'
    contract.secType = 'CRYPTO'
    contract.exchange = 'binance'
    contract.currency = 'USDT'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.001')
    order.futuresParams = {
      positionSide: 'LONG',
      reduceOnly: false,
      timeInForce: 'GTC',
    }

    const placeResult = await broker.placeOrder(contract, order)

    // Order placed successfully
    expect(placeResult.success).toBe(true)
    expect(placeResult.orderId).toBe('futures-lifecycle-ord-1')

    // Verify futuresParams were forwarded to CCXT createOrder params
    const createCall = (broker as any).exchange.createOrder.mock.calls[0]
    const params = createCall[5] as Record<string, unknown>
    expect(params.positionSide).toBe('LONG')
    expect(params.reduceOnly).toBe(false)
    expect(params.timeInForce).toBe('GTC')
  })
})

// ---------------------------------------------------------------------------
// Test 2: COINM tradingMode + getMarkPrice + getFundingRate
// ---------------------------------------------------------------------------

describe('Binance COINM Futures — getMarkPrice + getFundingRate', () => {
  it('returns canonical MarkPriceSnapshot and FundingRate shapes', async () => {
    const broker = makeCoinmBroker()
    setInitialized(broker, {})

    // Mock dapiPublicGetPremiumIndex for getMarkPrice
    ;(broker as any).exchange.dapiPublicGetPremiumIndex = vi.fn().mockResolvedValue({
      markPrice: '43210.50',
      indexPrice: '43198.75',
      lastFundingRate: '0.0001',
      estimatedSettlePrice: '43205.00',
    })

    const markPrice = await broker.getMarkPrice!('BTCUSD_PERP')

    expect(markPrice.symbol).toBe('BTCUSD_PERP')
    expect(markPrice.markPrice).toBe('43210.50')
    expect(markPrice.indexPrice).toBe('43198.75')
    expect(markPrice.estimatedFundingRate).toBe('0.0001')

    // Verify the COINM-specific endpoint was called (not fapi)
    expect((broker as any).exchange.dapiPublicGetPremiumIndex).toHaveBeenCalledWith({ symbol: 'BTCUSD_PERP' })
    expect((broker as any).exchange.fapiPublicGetPremiumIndex).not.toHaveBeenCalled()

    // Mock fetchFundingRate for getFundingRate
    const nextFundingMs = Date.now() + 8 * 60 * 60 * 1000 // 8h from now
    ;(broker as any).exchange.fetchFundingRate = vi.fn().mockResolvedValue({
      fundingRate: 0.0001,
      fundingTimestamp: nextFundingMs,
      markPrice: '43210.50',
      indexPrice: '43198.75',
      estimatedAnnualizedRate: 0.1095,
    })

    const fundingRate = await broker.getFundingRate!('BTCUSD_PERP')

    expect(fundingRate.symbol).toBe('BTCUSD_PERP')
    expect(fundingRate.rate).toBe('0.0001')
    expect(fundingRate.markPrice).toBe('43210.50')
    expect(fundingRate.indexPrice).toBe('43198.75')
    expect(fundingRate.annualizedRate).toBe('0.1095')
    // nextFundingTime is ISO 8601
    expect(typeof fundingRate.nextFundingTime).toBe('string')
    expect(new Date(fundingRate.nextFundingTime).getTime()).toBeCloseTo(nextFundingMs, -3)

    expect((broker as any).exchange.fetchFundingRate).toHaveBeenCalledWith('BTCUSD_PERP')
  })
})

// ---------------------------------------------------------------------------
// Test 3: Position mode (hedge) round-trip
// ---------------------------------------------------------------------------

describe('Binance USDM Futures — setPositionMode → getPositionMode hedge round-trip', () => {
  it('sets HEDGE mode and reads it back via fapiPrivateGetPositionSideDual', async () => {
    const broker = makeUsdmBroker()
    setInitialized(broker, {})

    // Step 1: setPositionMode('HEDGE') — CCXT expects hedged: boolean
    ;(broker as any).exchange.setPositionMode = vi.fn().mockResolvedValue({})
    await broker.setPositionMode!('HEDGE')

    // CCXT's setPositionMode should be called with true (hedged)
    expect((broker as any).exchange.setPositionMode).toHaveBeenCalledWith(true)

    // Step 2: getPositionMode — reads from fapiPrivateGetPositionSideDual
    ;(broker as any).exchange.fapiPrivateGetPositionSideDual = vi.fn().mockResolvedValue({
      dualSidePosition: true,
    })

    const mode = await broker.getPositionMode!()

    // Should return canonical 'HEDGE' string
    expect(mode).toBe('HEDGE')

    // Verify USDM-specific endpoint was called (not dapi)
    expect((broker as any).exchange.fapiPrivateGetPositionSideDual).toHaveBeenCalledWith({})
    expect((broker as any).exchange.dapiPrivateGetPositionSideDual).not.toHaveBeenCalled()
  })
})
