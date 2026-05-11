import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Contract, ContractDetails, Execution, Order, OrderState } from '@traderalice/ibkr'
import {
  ibkrContractDetailsToWire,
  ibkrContractToWire,
  ibkrExecutionToWire,
  ibkrOrderStateToWire,
  ibkrOrderToWire,
  wireToIbkrContract,
  wireToIbkrOrder,
} from '../wire-adapters.js'
import {
  CONTRACT_DETAILS_SCHEMA,
  CONTRACT_SCHEMA,
  ORDER_SCHEMA,
} from '../wire-types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, '../../../../parity/fixtures')

// ---- Helpers ----

/** Reconstruct an Order instance from a snapshot. Decimal-string fields get
 *  rewrapped as Decimal instances. */
function rehydrateOrder(json: Record<string, unknown>): Order {
  const order = new Order()
  Object.assign(order, json)
  for (const key of Object.keys(ORDER_SCHEMA)) {
    const wireType = (ORDER_SCHEMA as Record<string, string>)[key]
    if (wireType === 'WireDecimal') {
      const v = (json as Record<string, unknown>)[key]
      if (typeof v === 'string') {
        ;(order as Record<string, unknown>)[key] = new Decimal(v)
      }
    }
  }
  return order
}

function rehydrateContract(json: Record<string, unknown>): Contract {
  const c = new Contract()
  Object.assign(c, json)
  for (const key of Object.keys(CONTRACT_SCHEMA)) {
    const wireType = (CONTRACT_SCHEMA as Record<string, string>)[key]
    if (wireType === 'WireDecimal') {
      const v = (json as Record<string, unknown>)[key]
      if (typeof v === 'string') {
        ;(c as Record<string, unknown>)[key] = new Decimal(v)
      }
    }
  }
  return c
}

/** Assert two class instances are semantically equal — Decimal.equals for
 *  Decimal fields, === for numbers, deep-equal (via expect.toEqual) for
 *  passthrough fields. */
function expectInstancesEqual(a: Record<string, unknown>, b: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(a)) {
    const av = a[key]
    const bv = b[key]
    if (av instanceof Decimal && bv instanceof Decimal) {
      expect(av.equals(bv), `${label}.${key}: ${av.toString()} !== ${bv.toString()}`).toBe(true)
    } else {
      expect(bv, `${label}.${key}`).toEqual(av)
    }
  }
}

// ---- Orders-on-wire round-trip ----

describe('orders-on-wire round-trip', () => {
  const orderDir = resolve(FIXTURES, 'orders-on-wire/order')
  const orderFiles = readdirSync(orderDir).filter((f) => f.endsWith('.json'))

  it.each(orderFiles)('order/%s round-trips', (filename) => {
    const json = JSON.parse(readFileSync(resolve(orderDir, filename), 'utf-8')) as Record<string, unknown>
    const original = rehydrateOrder(json)
    const wire = ibkrOrderToWire(original)
    const reconstructed = wireToIbkrOrder(wire)
    expectInstancesEqual(
      original as unknown as Record<string, unknown>,
      reconstructed as unknown as Record<string, unknown>,
      'Order',
    )
  })

  const contractDir = resolve(FIXTURES, 'orders-on-wire/contract')
  const contractFiles = readdirSync(contractDir).filter((f) => f.endsWith('.json'))

  it.each(contractFiles)('contract/%s round-trips', (filename) => {
    const json = JSON.parse(readFileSync(resolve(contractDir, filename), 'utf-8')) as Record<string, unknown>
    const original = rehydrateContract(json)
    const wire = ibkrContractToWire(original)
    const reconstructed = wireToIbkrContract(wire)
    expectInstancesEqual(
      original as unknown as Record<string, unknown>,
      reconstructed as unknown as Record<string, unknown>,
      'Contract',
    )
  })
})

// ---- Sentinel detection ----

interface SentinelFixture {
  name: string
  type: 'Order' | 'Contract' | 'Execution' | 'OrderState'
  field?: string
  fieldKind?: 'decimal' | 'double' | 'integer'
  description: string
  fields?: Record<string, unknown>
}

function assertWireSentinel(wire: Record<string, unknown>, fixture: SentinelFixture): void {
  if (fixture.field) {
    // Per-field case: assert just the named field is { kind: 'unset' }.
    expect(wire[fixture.field], `${fixture.type}.${fixture.field}`).toEqual({ kind: 'unset' })
  } else {
    // All-unset case: assert that every field listed in fixture.fields is
    // { kind: 'unset' } on the wire. Only sentinel-valued fields are listed;
    // non-sentinel fields (e.g. orderId: 0) are intentionally absent from
    // the fixtures.fields map and must NOT be asserted.
    const fields = fixture.fields ?? {}
    for (const key of Object.keys(fields)) {
      const v = wire[key]
      if (v && typeof v === 'object' && 'kind' in (v as object)) {
        expect((v as { kind: string }).kind, `${fixture.type}.${key}`).toBe('unset')
      }
    }
  }
}

describe('order-fields sentinel detection', () => {
  const dir = resolve(FIXTURES, 'sentinels/order-fields')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  it.each(files)('order-fields/%s — sentinel detected', (filename) => {
    const fixture = JSON.parse(readFileSync(resolve(dir, filename), 'utf-8')) as SentinelFixture
    const instance = new Order()
    const wire = ibkrOrderToWire(instance) as unknown as Record<string, unknown>
    assertWireSentinel(wire, fixture)
  })
})

describe('contract-fields sentinel detection', () => {
  const dir = resolve(FIXTURES, 'sentinels/contract-fields')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  /** Decide whether the fixture targets Contract (the strike field) or
   *  ContractDetails (every other per-field fixture + all all-unset cases). */
  function targetsContractClass(fixture: SentinelFixture): boolean {
    if (fixture.field === 'strike') return true
    return false
  }

  it.each(files)('contract-fields/%s — sentinel detected', (filename) => {
    const fixture = JSON.parse(readFileSync(resolve(dir, filename), 'utf-8')) as SentinelFixture
    if (targetsContractClass(fixture)) {
      const instance = new Contract()
      const wire = ibkrContractToWire(instance) as unknown as Record<string, unknown>
      assertWireSentinel(wire, fixture)
    } else {
      const instance = new ContractDetails()
      const wire = ibkrContractDetailsToWire(instance) as unknown as Record<string, unknown>
      assertWireSentinel(wire, fixture)
    }
  })
})

describe('execution-fields sentinel detection', () => {
  const dir = resolve(FIXTURES, 'sentinels/execution-fields')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  it.each(files)('execution-fields/%s — sentinel detected', (filename) => {
    const fixture = JSON.parse(readFileSync(resolve(dir, filename), 'utf-8')) as SentinelFixture
    const instance = new Execution()
    const wire = ibkrExecutionToWire(instance) as unknown as Record<string, unknown>
    assertWireSentinel(wire, fixture)
  })
})

describe('orderstate-fields sentinel detection', () => {
  const dir = resolve(FIXTURES, 'sentinels/orderstate-fields')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  it.each(files)('orderstate-fields/%s — sentinel detected', (filename) => {
    const fixture = JSON.parse(readFileSync(resolve(dir, filename), 'utf-8')) as SentinelFixture
    const instance = new OrderState()
    const wire = ibkrOrderStateToWire(instance) as unknown as Record<string, unknown>
    assertWireSentinel(wire, fixture)
  })
})
