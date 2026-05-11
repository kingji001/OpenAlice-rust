import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Order } from '@traderalice/ibkr'
import { generateIntentHashV2 } from '../git/hash-v2.js'
import {
  classifyCommit,
  serializeCommit,
  verifyCommit,
} from '../git/persisted-commit.js'
import type { GitCommit, Operation } from '../git/types.js'

function buildOp(): Operation {
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

function buildV1Commit(): GitCommit {
  return {
    hash: 'aabbccdd',
    parentHash: null,
    message: 'v1 commit',
    operations: [buildOp()],
    results: [],
    stateAfter: {
      netLiquidation: '0',
      totalCashValue: '0',
      unrealizedPnL: '0',
      realizedPnL: '0',
      positions: [],
      pendingOrders: [],
    },
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function buildV2Commit(): GitCommit {
  const op = buildOp()
  const { intentFullHash, shortHash } = generateIntentHashV2({
    parentHash: null,
    message: 'v2 commit',
    operations: [op],
    hashInputTimestamp: '2026-01-01T00:00:00.000Z',
  })
  return {
    hash: shortHash,
    parentHash: null,
    message: 'v2 commit',
    operations: [op],
    results: [],
    stateAfter: {
      netLiquidation: '0',
      totalCashValue: '0',
      unrealizedPnL: '0',
      realizedPnL: '0',
      positions: [],
      pendingOrders: [],
    },
    timestamp: '2026-01-01T00:00:00.000Z',
    hashVersion: 2,
    intentFullHash,
    hashInputTimestamp: '2026-01-01T00:00:00.000Z',
  }
}

describe('classifyCommit', () => {
  it('hashVersion: 2 → v2', () => {
    const c = buildV2Commit()
    const result = classifyCommit(c)
    expect(result.kind).toBe('v2')
    if (result.kind === 'v2') expect(result.commit).toBe(c)
  })

  it('hashVersion absent → v1-opaque', () => {
    const c = buildV1Commit()
    const result = classifyCommit(c)
    expect(result.kind).toBe('v1-opaque')
    if (result.kind === 'v1-opaque') expect(result.raw).toBe(c)
  })

  it('hashVersion: 1 → v1-opaque', () => {
    const c: GitCommit = { ...buildV1Commit(), hashVersion: 1 }
    const result = classifyCommit(c)
    expect(result.kind).toBe('v1-opaque')
  })
})

describe('verifyCommit', () => {
  it('v1-opaque is skipped', () => {
    const c = buildV1Commit()
    const result = verifyCommit(classifyCommit(c))
    expect(result.kind).toBe('skipped')
    expect(result.hash).toBe('aabbccdd')
  })

  it('v2 with valid intentFullHash verifies', () => {
    const c = buildV2Commit()
    const result = verifyCommit(classifyCommit(c))
    expect(result.kind).toBe('verified')
    expect(result.actualIntentFullHash).toBe(c.intentFullHash)
  })

  it('v2 with corrupted intentFullHash → mismatch', () => {
    const c = buildV2Commit()
    const corrupted: GitCommit = { ...c, intentFullHash: '0'.repeat(64) }
    const result = verifyCommit(classifyCommit(corrupted))
    expect(result.kind).toBe('mismatch')
    expect(result.expectedIntentFullHash).toBe('0'.repeat(64))
    expect(result.actualIntentFullHash).toBeDefined()
  })

  it('v2 with missing intentFullHash → mismatch', () => {
    const c = buildV2Commit()
    const incomplete: GitCommit = { ...c, intentFullHash: undefined }
    const result = verifyCommit(classifyCommit(incomplete))
    expect(result.kind).toBe('mismatch')
    expect(result.message).toContain('missing intentFullHash')
  })

  it('strict mode throws on mismatch', () => {
    const c = buildV2Commit()
    const corrupted: GitCommit = { ...c, intentFullHash: '0'.repeat(64) }
    expect(() => verifyCommit(classifyCommit(corrupted), { strict: true })).toThrow()
  })
})

describe('serializeCommit', () => {
  it('round-trips a v1 commit verbatim', () => {
    const c = buildV1Commit()
    const persisted = classifyCommit(c)
    expect(serializeCommit(persisted)).toBe(c)
  })

  it('round-trips a v2 commit verbatim', () => {
    const c = buildV2Commit()
    const persisted = classifyCommit(c)
    expect(serializeCommit(persisted)).toBe(c)
  })
})
