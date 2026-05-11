import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, ContractDetails, Execution, Order, OrderState, UNSET_DECIMAL } from '@traderalice/ibkr'
import { ibkrPartialOrderToWire } from '../wire-adapters.js'
import {
  CONTRACT_DETAILS_SCHEMA,
  CONTRACT_SCHEMA,
  EXECUTION_SCHEMA,
  ORDER_SCHEMA,
  ORDER_STATE_SCHEMA,
} from '../wire-types.js'

/** Field is numeric if its default value is a Decimal or number (not NaN). */
function numericFieldsOf<T extends object>(instance: T): string[] {
  return Object.keys(instance).filter((k) => {
    const v = (instance as Record<string, unknown>)[k]
    return v instanceof Decimal || (typeof v === 'number' && !Number.isNaN(v))
  })
}

describe('schema consistency — every numeric field has a schema entry', () => {
  it('Order', () => {
    const fields = numericFieldsOf(new Order())
    for (const f of fields) {
      expect(f in ORDER_SCHEMA, `Order.${f} is numeric but not in ORDER_SCHEMA`).toBe(true)
    }
  })

  it('Contract', () => {
    const fields = numericFieldsOf(new Contract())
    for (const f of fields) {
      expect(f in CONTRACT_SCHEMA, `Contract.${f} is numeric but not in CONTRACT_SCHEMA`).toBe(true)
    }
  })

  it('Execution', () => {
    const fields = numericFieldsOf(new Execution())
    for (const f of fields) {
      expect(f in EXECUTION_SCHEMA, `Execution.${f} is numeric but not in EXECUTION_SCHEMA`).toBe(true)
    }
  })

  it('OrderState', () => {
    const fields = numericFieldsOf(new OrderState())
    for (const f of fields) {
      expect(f in ORDER_STATE_SCHEMA, `OrderState.${f} is numeric but not in ORDER_STATE_SCHEMA`).toBe(true)
    }
  })

  it('ContractDetails', () => {
    const fields = numericFieldsOf(new ContractDetails())
    for (const f of fields) {
      expect(f in CONTRACT_DETAILS_SCHEMA, `ContractDetails.${f} is numeric but not in CONTRACT_DETAILS_SCHEMA`).toBe(true)
    }
  })
})

describe('schema consistency — every schema entry maps to a real field', () => {
  it('Order', () => {
    const instance = new Order()
    for (const key of Object.keys(ORDER_SCHEMA)) {
      expect(key in instance, `ORDER_SCHEMA.${key} is not a field on Order`).toBe(true)
    }
  })

  it('Contract', () => {
    const instance = new Contract()
    for (const key of Object.keys(CONTRACT_SCHEMA)) {
      expect(key in instance, `CONTRACT_SCHEMA.${key} is not a field on Contract`).toBe(true)
    }
  })

  it('Execution', () => {
    const instance = new Execution()
    for (const key of Object.keys(EXECUTION_SCHEMA)) {
      expect(key in instance, `EXECUTION_SCHEMA.${key} is not a field on Execution`).toBe(true)
    }
  })

  it('OrderState', () => {
    const instance = new OrderState()
    for (const key of Object.keys(ORDER_STATE_SCHEMA)) {
      expect(key in instance, `ORDER_STATE_SCHEMA.${key} is not a field on OrderState`).toBe(true)
    }
  })

  it('ContractDetails', () => {
    const instance = new ContractDetails()
    for (const key of Object.keys(CONTRACT_DETAILS_SCHEMA)) {
      expect(key in instance, `CONTRACT_DETAILS_SCHEMA.${key} is not a field on ContractDetails`).toBe(true)
    }
  })
})

describe('partialToWire / ibkrPartialOrderToWire', () => {
  it('empty input produces empty output', () => {
    expect(ibkrPartialOrderToWire({})).toEqual({})
  })

  it('single Decimal field wraps as { kind: "value", value: canonical }', () => {
    const result = ibkrPartialOrderToWire({ lmtPrice: new Decimal('150.50') })
    expect(result).toEqual({
      lmtPrice: { kind: 'value', value: '150.5' },
    })
  })

  it('UNSET_DECIMAL on a partial wraps as { kind: "unset" }', () => {
    const result = ibkrPartialOrderToWire({ lmtPrice: UNSET_DECIMAL })
    expect(result).toEqual({
      lmtPrice: { kind: 'unset' },
    })
  })

  it('non-schema (string) field passes through verbatim', () => {
    const result = ibkrPartialOrderToWire({ action: 'BUY' as const })
    expect(result).toEqual({ action: 'BUY' })
  })

  it('undefined field is omitted entirely', () => {
    const result = ibkrPartialOrderToWire({ lmtPrice: undefined })
    expect(result).toEqual({})
  })

  it('multiple fields combined', () => {
    const result = ibkrPartialOrderToWire({
      lmtPrice: new Decimal('100'),
      action: 'SELL' as const,
      tif: 'DAY',
    })
    expect(result).toEqual({
      lmtPrice: { kind: 'value', value: '100' },
      action: 'SELL',
      tif: 'DAY',
    })
  })
})
