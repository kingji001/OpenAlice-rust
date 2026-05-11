/**
 * Wire adapters for IBKR DTO classes — Phase 1b.
 *
 * Schema-driven, single-dispatch round-trip:
 *   Order → WireOrder via ibkrOrderToWire(order)
 *   WireOrder → Order via wireToIbkrOrder(wire)
 * (Same pattern for Contract / Execution / OrderState.)
 *
 * Wire-format rules:
 *   - Schema-listed numeric fields → wrapped in { kind: 'unset' | 'value' }
 *   - All other fields → passthrough (string, boolean, enum, nested object)
 *
 * Sentinel detection:
 *   - Decimal field equals UNSET_DECIMAL → emit { kind: 'unset' }
 *   - number === UNSET_DOUBLE (Number.MAX_VALUE) → emit { kind: 'unset' }
 *   - number === UNSET_INTEGER (2^31 - 1) → emit { kind: 'unset' }
 */

import Decimal from 'decimal.js'
import {
  Contract,
  ContractDetails,
  Execution,
  Order,
  OrderState,
  UNSET_DECIMAL,
  UNSET_DOUBLE,
  UNSET_INTEGER,
} from '@traderalice/ibkr'
import { toCanonicalDecimalString } from './canonical-decimal.js'
import {
  CONTRACT_DETAILS_SCHEMA,
  CONTRACT_SCHEMA,
  EXECUTION_SCHEMA,
  ORDER_SCHEMA,
  ORDER_STATE_SCHEMA,
  type WireContract,
  type WireContractDetails,
  type WireDecimal,
  type WireDouble,
  type WireExecution,
  type WireInteger,
  type WireOrder,
  type WireOrderState,
} from './wire-types.js'

// ---- Sentinel detection ----

const isUnsetDecimal = (d: Decimal): boolean => d.equals(UNSET_DECIMAL)
const isUnsetDouble = (n: number): boolean => n === UNSET_DOUBLE
const isUnsetInteger = (n: number): boolean => n === UNSET_INTEGER

// ---- Wrap / unwrap ----

type WireTypeLiteral = 'WireDecimal' | 'WireDouble' | 'WireInteger'

function wrapValue(v: unknown, wireType: WireTypeLiteral): WireDecimal | WireDouble | WireInteger {
  if (wireType === 'WireDecimal') {
    if (!(v instanceof Decimal)) {
      throw new Error(`WireDecimal expected Decimal instance, got ${typeof v}`)
    }
    if (isUnsetDecimal(v)) return { kind: 'unset' }
    return { kind: 'value', value: toCanonicalDecimalString(v) }
  }
  if (wireType === 'WireDouble') {
    if (typeof v !== 'number') {
      throw new Error(`WireDouble expected number, got ${typeof v}`)
    }
    if (isUnsetDouble(v)) return { kind: 'unset' }
    return { kind: 'value', value: toCanonicalDecimalString(new Decimal(v)) }
  }
  if (wireType === 'WireInteger') {
    if (typeof v !== 'number') {
      throw new Error(`WireInteger expected number, got ${typeof v}`)
    }
    if (isUnsetInteger(v)) return { kind: 'unset' }
    return { kind: 'value', value: v }
  }
  throw new Error(`Unknown wire type: ${wireType as string}`)
}

function unwrapValue(
  v: WireDecimal | WireDouble | WireInteger,
  wireType: WireTypeLiteral,
): Decimal | number {
  if (v.kind === 'unset') {
    if (wireType === 'WireDecimal') return UNSET_DECIMAL
    if (wireType === 'WireDouble') return UNSET_DOUBLE
    if (wireType === 'WireInteger') return UNSET_INTEGER
    throw new Error(`Unknown wire type: ${wireType as string}`)
  }
  if (wireType === 'WireDecimal') {
    return new Decimal(v.value as string)
  }
  if (wireType === 'WireDouble') {
    return new Decimal(v.value as string).toNumber()
  }
  if (wireType === 'WireInteger') {
    return v.value as number
  }
  throw new Error(`Unknown wire type: ${wireType as string}`)
}

// ---- Generic dispatch ----

type Schema = Record<string, WireTypeLiteral>

function toWire<T extends object>(source: T, schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const v = (source as Record<string, unknown>)[key]
    if (key in schema) {
      out[key] = wrapValue(v, schema[key]!)
    } else {
      out[key] = v
    }
  }
  return out
}

function fromWire<T extends object>(
  wire: Record<string, unknown>,
  schema: Schema,
  ctor: new () => T,
): T {
  const out = new ctor()
  for (const key of Object.keys(wire)) {
    const v = wire[key]
    if (key in schema) {
      ;(out as Record<string, unknown>)[key] = unwrapValue(
        v as WireDecimal | WireDouble | WireInteger,
        schema[key]!,
      )
    } else {
      ;(out as Record<string, unknown>)[key] = v
    }
  }
  return out
}

// ---- Public entry points ----

export const ibkrOrderToWire = (o: Order): WireOrder =>
  toWire(o, ORDER_SCHEMA) as unknown as WireOrder
export const ibkrContractToWire = (c: Contract): WireContract =>
  toWire(c, CONTRACT_SCHEMA) as unknown as WireContract
export const ibkrContractDetailsToWire = (d: ContractDetails): WireContractDetails =>
  toWire(d, CONTRACT_DETAILS_SCHEMA) as unknown as WireContractDetails
export const ibkrExecutionToWire = (e: Execution): WireExecution =>
  toWire(e, EXECUTION_SCHEMA) as unknown as WireExecution
export const ibkrOrderStateToWire = (s: OrderState): WireOrderState =>
  toWire(s, ORDER_STATE_SCHEMA) as unknown as WireOrderState

export const wireToIbkrOrder = (w: WireOrder): Order =>
  fromWire(w as unknown as Record<string, unknown>, ORDER_SCHEMA, Order)
export const wireToIbkrContract = (w: WireContract): Contract =>
  fromWire(w as unknown as Record<string, unknown>, CONTRACT_SCHEMA, Contract)
export const wireToIbkrContractDetails = (w: WireContractDetails): ContractDetails =>
  fromWire(w as unknown as Record<string, unknown>, CONTRACT_DETAILS_SCHEMA, ContractDetails)
export const wireToIbkrExecution = (w: WireExecution): Execution =>
  fromWire(w as unknown as Record<string, unknown>, EXECUTION_SCHEMA, Execution)
export const wireToIbkrOrderState = (w: WireOrderState): OrderState =>
  fromWire(w as unknown as Record<string, unknown>, ORDER_STATE_SCHEMA, OrderState)
