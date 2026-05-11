import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, Order, OrderCancel } from '@traderalice/ibkr'
import { operationToWire } from '../git/operation-wire.js'
import type { Operation } from '../git/types.js'

function buildContract(): Contract {
  const c = new Contract()
  c.symbol = 'AAPL'
  c.secType = 'STK'
  c.exchange = 'SMART'
  c.currency = 'USD'
  return c
}

function buildOrder(): Order {
  const o = new Order()
  o.action = 'BUY'
  o.orderType = 'LMT'
  o.tif = 'DAY'
  o.totalQuantity = new Decimal('100')
  o.lmtPrice = new Decimal('150.50')
  return o
}

describe('operationToWire', () => {
  it('placeOrder converts order + contract to wire form', () => {
    const op: Operation = { action: 'placeOrder', order: buildOrder(), contract: buildContract() }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('placeOrder')
    expect(wire.order).toBeDefined()
    expect(wire.contract).toBeDefined()
    const order = wire.order as Record<string, unknown>
    expect(order.totalQuantity).toEqual({ kind: 'value', value: '100' })
    expect(order.lmtPrice).toEqual({ kind: 'value', value: '150.5' })
  })

  it('placeOrder with tpsl includes tpsl block', () => {
    const op: Operation = {
      action: 'placeOrder',
      order: buildOrder(),
      contract: buildContract(),
      tpsl: { takeProfit: { price: '160.0' }, stopLoss: { price: '140.0' } },
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.tpsl).toEqual({ takeProfit: { price: '160.0' }, stopLoss: { price: '140.0' } })
  })

  it('placeOrder with partial tpsl includes only present fields', () => {
    const op: Operation = {
      action: 'placeOrder',
      order: buildOrder(),
      contract: buildContract(),
      tpsl: { takeProfit: { price: '160.0' } },
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect((wire.tpsl as Record<string, unknown>).takeProfit).toEqual({ price: '160.0' })
    expect('stopLoss' in (wire.tpsl as Record<string, unknown>)).toBe(false)
  })

  it('modifyOrder uses partial-order wire adapter', () => {
    const op: Operation = {
      action: 'modifyOrder',
      orderId: 'order-1',
      changes: { lmtPrice: new Decimal('200') },
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('modifyOrder')
    expect(wire.orderId).toBe('order-1')
    expect(wire.changes).toEqual({ lmtPrice: { kind: 'value', value: '200' } })
  })

  it('closePosition with quantity canonicalizes', () => {
    const op: Operation = {
      action: 'closePosition',
      contract: buildContract(),
      quantity: new Decimal('50.5'),
    }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('closePosition')
    expect(wire.quantity).toBe('50.5')
  })

  it('closePosition without quantity omits the field', () => {
    const op: Operation = { action: 'closePosition', contract: buildContract() }
    const wire = operationToWire(op) as Record<string, unknown>
    expect('quantity' in wire).toBe(false)
  })

  it('cancelOrder with orderCancel includes the OrderCancel object', () => {
    const orderCancel = new OrderCancel()
    const op: Operation = { action: 'cancelOrder', orderId: 'order-1', orderCancel }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire.action).toBe('cancelOrder')
    expect(wire.orderId).toBe('order-1')
    expect(wire.orderCancel).toBeDefined()
  })

  it('cancelOrder without orderCancel omits the field', () => {
    const op: Operation = { action: 'cancelOrder', orderId: 'order-1' }
    const wire = operationToWire(op) as Record<string, unknown>
    expect('orderCancel' in wire).toBe(false)
  })

  it('syncOrders produces minimal output', () => {
    const op: Operation = { action: 'syncOrders' }
    const wire = operationToWire(op) as Record<string, unknown>
    expect(wire).toEqual({ action: 'syncOrders' })
  })
})
