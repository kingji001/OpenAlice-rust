/**
 * Operations fixture generator.
 *
 * Emits one JSON file per Operation case in fixtures/operations/<action>/.
 * Deterministic: PRNG seeded; output sort-keyed; numeric fields canonical.
 *
 * Cross product enumerated:
 *   placeOrder: BUY/SELL × {MKT, LMT, STP, STP LMT} × {DAY, GTC, IOC, FOK, GTD, OPG}
 *               × {with TP-SL, without} × {default, 8-dec, 12-dec, 18-dec, 1e30,
 *                  1e-30, negative, zero, sub-satoshi}
 *               (trim invalid TIF×orderType combinations)
 *   modifyOrder: 2 × {MKT, LMT, STP, STP LMT} × 5 change-types
 *   closePosition: 2 × 4 size-classes
 *   cancelOrder: 2 × 5 reason variants
 *   syncOrders: 1 case (parameterless)
 *
 * Re-running overwrites the target dirs entirely. Idempotent.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import Decimal from 'decimal.js'
import { Order, Contract } from '@traderalice/ibkr'
import { toCanonicalDecimalString } from './_canonical-decimal.js'
import { canonicalJson, type CanonicalJsonValue } from './_canonical-json.js'

// ---- Cross-product enumerations ----

const ACTIONS = ['BUY', 'SELL'] as const
const ORDER_TYPES = ['MKT', 'LMT', 'STP', 'STP LMT'] as const
const TIFS = ['DAY', 'GTC', 'IOC', 'FOK', 'GTD', 'OPG'] as const

// Combos that don't make sense in TWS — exclude.
const INVALID_TIF_ORDER_TYPE: ReadonlySet<string> = new Set([
  'OPG-STP', 'OPG-STP LMT',  // OPG only on day orders
  'FOK-MKT',                  // FOK requires a price
  'IOC-MKT',                  // IOC for market is meaningless (always immediate)
])

const DECIMAL_PRECISIONS: ReadonlyArray<{ name: string; qty: string; price: string }> = [
  { name: 'default', qty: '100', price: '150.50' },
  { name: '008dec', qty: '0.12345678', price: '0.12345678' },
  { name: '012dec', qty: '0.123456789012', price: '0.123456789012' },
  { name: '018dec', qty: '0.123456789012345678', price: '0.123456789012345678' },
  { name: '1e30',    qty: '1000000000000000000000000000000', price: '1000000000000000000000000000000' },
  { name: '1e-30',   qty: '0.000000000000000000000000000001', price: '0.000000000000000000000000000001' },
  { name: 'negative', qty: '-100', price: '-150.50' },
  { name: 'zero',    qty: '0', price: '0' },
  { name: 'subsat',  qty: '0.000000001', price: '0.000000001' },
]

// ---- Builders ----

function buildContract(symbol = 'AAPL'): Contract {
  const c = new Contract()
  c.symbol = symbol
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  return c
}

function buildOrder(opts: {
  action: typeof ACTIONS[number]
  orderType: typeof ORDER_TYPES[number]
  tif: typeof TIFS[number]
  qty: string
  price: string
}): Order {
  const o = new Order()
  o.action = opts.action
  o.orderType = opts.orderType
  o.tif = opts.tif
  o.totalQuantity = new Decimal(opts.qty)
  // For LMT and STP LMT, set the limit price.
  if (opts.orderType === 'LMT' || opts.orderType === 'STP LMT') {
    o.lmtPrice = new Decimal(opts.price)
  }
  // For STP and STP LMT, set the stop / aux price.
  if (opts.orderType === 'STP' || opts.orderType === 'STP LMT') {
    o.auxPrice = new Decimal(opts.price)
  }
  return o
}

// ---- Serialization helpers ----

function decimalToCanonical(d: Decimal): string {
  return toCanonicalDecimalString(d)
}

function serializeOrder(o: Order): CanonicalJsonValue {
  // Emit only the fields that were meaningfully set (non-default).
  const out: Record<string, CanonicalJsonValue> = {
    action: o.action,
    orderType: o.orderType,
    tif: o.tif,
    totalQuantity: decimalToCanonical(o.totalQuantity),
  }
  // lmtPrice: only emit if set (non-zero Decimal indicates it was set)
  if (o.orderType === 'LMT' || o.orderType === 'STP LMT') {
    out['lmtPrice'] = decimalToCanonical(o.lmtPrice)
  }
  // auxPrice: only emit if set
  if (o.orderType === 'STP' || o.orderType === 'STP LMT') {
    out['auxPrice'] = decimalToCanonical(o.auxPrice)
  }
  return out
}

function serializeContract(c: Contract): CanonicalJsonValue {
  const out: Record<string, CanonicalJsonValue> = {
    currency: c.currency,
    exchange: c.exchange,
    secType: c.secType,
    symbol: c.symbol,
  }
  return out
}

// ---- File emission ----

async function emit(dir: string, name: string, payload: CanonicalJsonValue): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.json`), canonicalJson(payload, { pretty: true }))
}

// ---- Main enumeration ----

async function emitPlaceOrders(): Promise<number> {
  const baseDir = resolve('parity/fixtures/operations/placeOrder')
  await rm(baseDir, { recursive: true, force: true })
  let n = 0
  for (const action of ACTIONS) {
    for (const orderType of ORDER_TYPES) {
      for (const tif of TIFS) {
        if (INVALID_TIF_ORDER_TYPE.has(`${tif}-${orderType}`)) continue
        for (const tpsl of [false, true] as const) {
          for (const prec of DECIMAL_PRECISIONS) {
            // Skip negative qty for SELL (already represented by action=SELL with positive qty)
            if (prec.name === 'negative' && action === 'SELL') continue
            n++
            const idx = String(n).padStart(3, '0')
            const slug = `${action.toLowerCase()}-${orderType.toLowerCase().replace(' ', '')}-${tif.toLowerCase()}-${tpsl ? 'tpsl' : 'plain'}-${prec.name}`
            const order = buildOrder({ action, orderType, tif, qty: prec.qty, price: prec.price })
            const contract = buildContract()
            const operation: CanonicalJsonValue = {
              action: 'placeOrder',
              contract: serializeContract(contract),
              order: serializeOrder(order),
              ...(tpsl ? { tpsl: { stopLoss: '140.0', takeProfit: '160.0' } } : {}),
            }
            await emit(baseDir, `case-${slug}-${idx}`, {
              name: `case-${slug}-${idx}`,
              operation,
            })
          }
        }
      }
    }
  }
  return n
}

async function emitModifyOrders(): Promise<number> {
  const baseDir = resolve('parity/fixtures/operations/modifyOrder')
  await rm(baseDir, { recursive: true, force: true })
  let n = 0
  for (const action of ACTIONS) {
    for (const orderType of ORDER_TYPES) {
      const changes = [
        { name: 'qtyup', changes: { totalQuantity: '200' } },
        { name: 'qtydown', changes: { totalQuantity: '50' } },
        { name: 'priceup', changes: { lmtPrice: '160.5' } },
        { name: 'pricedown', changes: { lmtPrice: '140.5' } },
        { name: 'typechange', changes: { orderType: 'LMT' } },
      ]
      for (const c of changes) {
        n++
        const idx = String(n).padStart(3, '0')
        const slug = `${action.toLowerCase()}-${orderType.toLowerCase().replace(' ', '')}-${c.name}`
        await emit(baseDir, `case-${slug}-${idx}`, {
          name: `case-${slug}-${idx}`,
          operation: {
            action: 'modifyOrder',
            changes: c.changes,
            orderId: `mock-existing-${idx}`,
          },
        })
      }
    }
  }
  return n
}

async function emitClosePositions(): Promise<number> {
  const baseDir = resolve('parity/fixtures/operations/closePosition')
  await rm(baseDir, { recursive: true, force: true })
  let n = 0
  const sizes: ReadonlyArray<{ name: string; qty?: string }> = [
    { name: 'whole' },
    { name: 'half', qty: '50' },
    { name: 'subsat', qty: '0.000000001' },
    { name: 'verylarge', qty: '1000000000000000000000000000000' },
  ]
  for (const withQty of [false, true] as const) {
    for (const size of sizes) {
      if (withQty && size.qty === undefined) continue
      if (!withQty && size.name !== 'whole') continue
      n++
      const idx = String(n).padStart(3, '0')
      const slug = `${withQty ? 'withqty' : 'whole'}-${size.name}`
      const operation: CanonicalJsonValue = {
        action: 'closePosition',
        contract: serializeContract(buildContract()),
        ...(withQty && size.qty ? { quantity: size.qty } : {}),
      }
      await emit(baseDir, `case-${slug}-${idx}`, { name: `case-${slug}-${idx}`, operation })
    }
  }
  return n
}

async function emitCancelOrders(): Promise<number> {
  const baseDir = resolve('parity/fixtures/operations/cancelOrder')
  await rm(baseDir, { recursive: true, force: true })
  let n = 0
  const reasons = ['user-requested', 'risk-limit', 'duplicate', 'expired', 'amend']
  for (const withCancel of [false, true] as const) {
    for (const reason of reasons) {
      n++
      const idx = String(n).padStart(3, '0')
      const slug = `${withCancel ? 'withcancel' : 'plain'}-${reason}`
      const operation: CanonicalJsonValue = {
        action: 'cancelOrder',
        ...(withCancel ? { orderCancel: { manualOrderCancelTime: '20260101 00:00:00' } } : {}),
        orderId: `mock-existing-${idx}`,
      }
      await emit(baseDir, `case-${slug}-${idx}`, { name: `case-${slug}-${idx}`, operation })
    }
  }
  return n
}

async function emitSyncOrders(): Promise<number> {
  const baseDir = resolve('parity/fixtures/operations/syncOrders')
  await rm(baseDir, { recursive: true, force: true })
  await emit(baseDir, 'case-001', {
    name: 'case-001',
    operation: { action: 'syncOrders' },
  })
  return 1
}

async function main(): Promise<void> {
  const placed = await emitPlaceOrders()
  const modified = await emitModifyOrders()
  const closed = await emitClosePositions()
  const cancelled = await emitCancelOrders()
  const synced = await emitSyncOrders()
  const total = placed + modified + closed + cancelled + synced
  console.log(`Emitted ${total} fixtures: ${placed} placeOrder, ${modified} modifyOrder, ${closed} closePosition, ${cancelled} cancelOrder, ${synced} syncOrders`)
  if (total < 200) {
    throw new Error(`Phase 0 requires ≥200 fixtures; emitted only ${total}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
