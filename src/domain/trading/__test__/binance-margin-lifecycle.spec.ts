/**
 * Binance Cross Margin lifecycle integration tests.
 *
 * Exercises the full margin path through CcxtBroker — from placing a margin
 * order (with sideEffectType) to reading the margin account snapshot, and the
 * borrow → repay → transferFunding round-trip. Uses the same MockExchange
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

function makeBinanceMarginBroker() {
  return new CcxtBroker({
    exchange: 'binance',
    apiKey: 'test-key',
    secret: 'test-secret',
    sandbox: false,
    marginType: 'cross',
  })
}

function setInitialized(broker: CcxtBroker, markets: Record<string, any>) {
  ;(broker as any).initialized = true
  ;(broker as any).exchange.markets = markets
}

function makeSpotMarket(base: string, quote: string, symbol: string): any {
  return {
    id: symbol.replace('/', ''),
    symbol,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    type: 'spot',
    active: true,
    precision: { price: 0.01 },
    limits: {},
    settle: undefined,
  }
}

// ---------------------------------------------------------------------------
// Test 1: Place margin order + read account (end-to-end integration view)
// ---------------------------------------------------------------------------

describe('Binance Cross Margin — place margin order then read account', () => {
  it('accepts sideEffectType MARGIN_BUY and returns canonical MarginAccount snapshot', async () => {
    const broker = makeBinanceMarginBroker()
    setInitialized(broker, {
      'BTC/USDT': makeSpotMarket('BTC', 'USDT', 'BTC/USDT'),
    })

    // Step 1: place a margin order with sideEffectType
    ;(broker as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'margin-lifecycle-ord-1',
      status: 'open',
      average: undefined,
      filled: undefined,
    })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT'
    contract.symbol = 'BTC/USDT'
    contract.secType = 'CRYPTO'
    contract.exchange = 'binance'
    contract.currency = 'USDT'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')
    order.marginParams = { sideEffectType: 'MARGIN_BUY', isIsolated: false }

    const placeResult = await broker.placeOrder(contract, order)

    // Order placed successfully
    expect(placeResult.success).toBe(true)
    expect(placeResult.orderId).toBe('margin-lifecycle-ord-1')

    // Verify CCXT received the correct sideEffectType in params
    const createCall = (broker as any).exchange.createOrder.mock.calls[0]
    const params = createCall[5] as Record<string, unknown>
    expect(params.sideEffectType).toBe('MARGIN_BUY')
    expect(params.isIsolated).toBe(false)
    expect(params.type).toBe('margin')

    // Step 2: read margin account — broker is still in cross margin mode
    ;(broker as any).exchange.sapiGetMarginAccount = vi.fn().mockResolvedValue({
      totalAssetOfBtc: '1.5',
      totalLiabilityOfBtc: '0.5',
      totalNetAssetOfBtc: '1.0',
      marginLevel: '3.0',
      borrowEnabled: true,
      transferEnabled: true,
      tradeEnabled: true,
    })

    const marginAccount = await broker.getMarginAccount!()

    expect(marginAccount.totalAssetBtc).toBe('1.5')
    expect(marginAccount.totalLiabilityBtc).toBe('0.5')
    expect(marginAccount.totalNetAssetBtc).toBe('1.0')
    expect(marginAccount.marginLevel).toBe('3.0')
    expect(marginAccount.borrowEnabled).toBe(true)
    expect(marginAccount.tradeEnabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 2: borrow → repay → transferFunding round-trip
// ---------------------------------------------------------------------------

describe('Binance Cross Margin — borrow → repay → transferFunding round-trip', () => {
  it('calls all three SAPI endpoints in sequence and returns correct txIds', async () => {
    const broker = makeBinanceMarginBroker()
    setInitialized(broker, {})

    // Step 1: borrow USDT
    ;(broker as any).exchange.sapiPostMarginLoan = vi.fn().mockResolvedValue({ tranId: 100001 })
    const borrowResult = await broker.borrow!('USDT', '500')
    expect(borrowResult.txId).toBe('100001')
    expect((broker as any).exchange.sapiPostMarginLoan).toHaveBeenCalledWith({ asset: 'USDT', amount: '500' })

    // Step 2: repay USDT
    ;(broker as any).exchange.sapiPostMarginRepay = vi.fn().mockResolvedValue({ tranId: 100002 })
    const repayResult = await broker.repay!('USDT', '500')
    expect(repayResult.txId).toBe('100002')
    expect((broker as any).exchange.sapiPostMarginRepay).toHaveBeenCalledWith({ asset: 'USDT', amount: '500' })

    // Step 3: transfer remaining USDT back to spot wallet
    ;(broker as any).exchange.sapiPostMarginTransfer = vi.fn().mockResolvedValue({ tranId: 100003 })
    const transferResult = await broker.transferFunding!({ type: 'CROSS_MARGIN_TO_SPOT', asset: 'USDT', amount: '50' })
    expect(transferResult.txId).toBe('100003')
    expect((broker as any).exchange.sapiPostMarginTransfer).toHaveBeenCalledWith({
      asset: 'USDT',
      amount: '50',
      type: 2, // CROSS_MARGIN_TO_SPOT = Binance type 2
    })
  })
})

// ---------------------------------------------------------------------------
// Test 3: Cross-margin methods unavailable in spot mode (guard)
// ---------------------------------------------------------------------------

describe('Binance Cross Margin — spot-mode broker rejects margin methods', () => {
  it('getMarginAccount throws when marginType is not cross', async () => {
    const spotBroker = new CcxtBroker({
      exchange: 'binance',
      apiKey: 'k',
      secret: 's',
      sandbox: false,
      // No marginType — defaults to spot mode
    })
    setInitialized(spotBroker, {})

    await expect(spotBroker.getMarginAccount!()).rejects.toThrow("margin operations require marginType='cross'")
  })
})
