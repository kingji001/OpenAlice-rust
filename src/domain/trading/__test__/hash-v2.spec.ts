import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Order } from '@traderalice/ibkr-types'
import { generateIntentHashV2 } from '../git/hash-v2.js'
import type { Operation } from '../git/types.js'

function buildPlaceOrderOp(): Operation {
  const c = new Contract()
  c.symbol = 'AAPL'
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  const o = new Order()
  o.action = 'BUY'
  o.orderType = 'LMT'
  o.tif = 'DAY'
  o.totalQuantity = new Decimal('100')
  o.lmtPrice = new Decimal('150.50')
  return { action: 'placeOrder', order: o, contract: c }
}

describe('generateIntentHashV2', () => {
  it('produces a 64-char hex hash + 8-char short hash', () => {
    const result = generateIntentHashV2({
      parentHash: null,
      message: 'test commit',
      operations: [buildPlaceOrderOp()],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(result.intentFullHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.shortHash).toBe(result.intentFullHash.slice(0, 8))
    expect(result.shortHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is deterministic — same inputs produce same hash', () => {
    const op = buildPlaceOrderOp()
    const input = {
      parentHash: null,
      message: 'test commit',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    }
    const a = generateIntentHashV2(input)
    const b = generateIntentHashV2(input)
    expect(a.intentFullHash).toBe(b.intentFullHash)
  })

  it('different timestamps produce different hashes', () => {
    const op = buildPlaceOrderOp()
    const a = generateIntentHashV2({
      parentHash: null,
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    const b = generateIntentHashV2({
      parentHash: null,
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-02T00:00:00.000Z',
    })
    expect(a.intentFullHash).not.toBe(b.intentFullHash)
  })

  it('different parent hashes produce different hashes', () => {
    const op = buildPlaceOrderOp()
    const a = generateIntentHashV2({
      parentHash: null,
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    const b = generateIntentHashV2({
      parentHash: 'abc12345',
      message: 'test',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(a.intentFullHash).not.toBe(b.intentFullHash)
  })

  it('different messages produce different hashes', () => {
    const op = buildPlaceOrderOp()
    const a = generateIntentHashV2({
      parentHash: null,
      message: 'commit a',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    const b = generateIntentHashV2({
      parentHash: null,
      message: 'commit b',
      operations: [op],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(a.intentFullHash).not.toBe(b.intentFullHash)
  })

  it('empty operations array is valid input', () => {
    const result = generateIntentHashV2({
      parentHash: null,
      message: 'empty',
      operations: [],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(result.intentFullHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('golden bytes — pins canonical-JSON + SHA-256 output (regression guard)', () => {
    // If this test fails, it means canonicalJson, toCanonicalDecimalString,
    // or the hash input shape changed. Stored v2 hashes from before the change
    // will no longer verify. Update with care.
    const result = generateIntentHashV2({
      parentHash: null,
      message: 'golden test',
      operations: [],
      hashInputTimestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(result.intentFullHash).toBe('2a98a2d0ae18fa1bd6a744d5281b641a38296018aad9f73d7df9b209be23c97d')
  })
})
