/**
 * Wire-format types for IBKR DTO classes — Phase 1b.
 *
 * Wire types are the FFI-crossing form: canonical, sentinel-aware,
 * IEEE-754-safe. Phase 1b ships these types + adapters as dead code.
 * Phase 2 wires them into TradingGit's hash inputs.
 *
 * See docs/superpowers/specs/2026-05-12-phase-1b-wire-types-design.md
 * for the design rationale.
 */

/** Canonical decimal-string form: no exponent, no leading +, no trailing
 *  decimal point, "0" for zero (never "-0"). Validated by canonical-decimal.ts. */
export type DecimalString = string

/** Decimal field on the wire. Sentinels (UNSET_DECIMAL = 2^127-1) become
 *  { kind: 'unset' }; real values become { kind: 'value', value: <DecimalString> }. */
export type WireDecimal =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }

/** Floating-point field on the wire. Sentinels (UNSET_DOUBLE = Number.MAX_VALUE)
 *  become { kind: 'unset' }. Real values are string-encoded as DecimalString to
 *  avoid IEEE-754 drift across the FFI. */
export type WireDouble =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }

/** Integer field on the wire. Sentinels (UNSET_INTEGER = 2^31-1) become
 *  { kind: 'unset' }; real values are unboxed numbers (safe-integer range). */
export type WireInteger =
  | { kind: 'unset' }
  | { kind: 'value'; value: number }

import type { Order, Contract, ContractDetails, Execution, OrderState } from '@traderalice/ibkr-types'

/**
 * Per-class schemas — hand-transcribed from parity/decimal-inventory.md.
 *
 * Each entry maps a numeric field name to its wire-type literal. Non-numeric
 * fields (strings, booleans, enums, nested objects) are NOT in the schema —
 * adapters pass them through verbatim.
 *
 * Schema-consistency tests in Task C catch missed or typo'd fields. If you
 * add a numeric field to an IBKR class, add it here too.
 */

export const ORDER_SCHEMA = {
  orderId: 'WireInteger',
  clientId: 'WireInteger',
  permId: 'WireInteger',
  totalQuantity: 'WireDecimal',
  lmtPrice: 'WireDecimal',
  auxPrice: 'WireDecimal',
  ocaType: 'WireInteger',
  parentId: 'WireInteger',
  displaySize: 'WireInteger',
  triggerMethod: 'WireInteger',
  minQty: 'WireInteger',
  percentOffset: 'WireDouble',
  trailStopPrice: 'WireDecimal',
  trailingPercent: 'WireDecimal',
  origin: 'WireInteger',
  shortSaleSlot: 'WireInteger',
  exemptCode: 'WireInteger',
  discretionaryAmt: 'WireDouble',
  auctionStrategy: 'WireInteger',
  startingPrice: 'WireDouble',
  stockRefPrice: 'WireDouble',
  delta: 'WireDouble',
  stockRangeLower: 'WireDouble',
  stockRangeUpper: 'WireDouble',
  volatility: 'WireDouble',
  volatilityType: 'WireInteger',
  deltaNeutralAuxPrice: 'WireDouble',
  deltaNeutralConId: 'WireInteger',
  deltaNeutralShortSaleSlot: 'WireInteger',
  referencePriceType: 'WireInteger',
  basisPoints: 'WireDouble',
  basisPointsType: 'WireInteger',
  scaleInitLevelSize: 'WireInteger',
  scaleSubsLevelSize: 'WireInteger',
  scalePriceIncrement: 'WireDouble',
  scalePriceAdjustValue: 'WireDouble',
  scalePriceAdjustInterval: 'WireInteger',
  scaleProfitOffset: 'WireDouble',
  scaleInitPosition: 'WireInteger',
  scaleInitFillQty: 'WireInteger',
  referenceContractId: 'WireInteger',
  peggedChangeAmount: 'WireDouble',
  referenceChangeAmount: 'WireDouble',
  refFuturesConId: 'WireInteger',
  triggerPrice: 'WireDouble',
  adjustedStopPrice: 'WireDouble',
  adjustedStopLimitPrice: 'WireDouble',
  adjustedTrailingAmount: 'WireDouble',
  adjustableTrailingUnit: 'WireInteger',
  lmtPriceOffset: 'WireDouble',
  cashQty: 'WireDecimal',
  filledQuantity: 'WireDecimal',
  parentPermId: 'WireInteger',
  duration: 'WireInteger',
  postToAts: 'WireInteger',
  minTradeQty: 'WireInteger',
  minCompeteSize: 'WireInteger',
  competeAgainstBestOffset: 'WireDouble',
  midOffsetAtWhole: 'WireDouble',
  midOffsetAtHalf: 'WireDouble',
  manualOrderIndicator: 'WireInteger',
  whatIfType: 'WireInteger',
  slOrderId: 'WireInteger',
  ptOrderId: 'WireInteger',
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>

export const CONTRACT_SCHEMA = {
  conId: 'WireInteger',
  strike: 'WireDouble',
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>

export const CONTRACT_DETAILS_SCHEMA = {
  minTick: 'WireDouble',
  priceMagnifier: 'WireInteger',
  underConId: 'WireInteger',
  evMultiplier: 'WireDouble',
  aggGroup: 'WireInteger',
  coupon: 'WireDouble',
  minSize: 'WireDecimal',
  sizeIncrement: 'WireDecimal',
  suggestedSizeIncrement: 'WireDecimal',
  minAlgoSize: 'WireDecimal',
  lastPricePrecision: 'WireDecimal',
  lastSizePrecision: 'WireDecimal',
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>

export const EXECUTION_SCHEMA = {
  shares: 'WireDecimal',
  price: 'WireDouble',
  permId: 'WireInteger',
  clientId: 'WireInteger',
  orderId: 'WireInteger',
  liquidation: 'WireInteger',
  cumQty: 'WireDecimal',
  avgPrice: 'WireDouble',
  evMultiplier: 'WireDouble',
  lastLiquidity: 'WireInteger',
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>

export const ORDER_STATE_SCHEMA = {
  commissionAndFees: 'WireDouble',
  minCommissionAndFees: 'WireDouble',
  maxCommissionAndFees: 'WireDouble',
  initMarginBeforeOutsideRTH: 'WireDouble',
  maintMarginBeforeOutsideRTH: 'WireDouble',
  equityWithLoanBeforeOutsideRTH: 'WireDouble',
  initMarginChangeOutsideRTH: 'WireDouble',
  maintMarginChangeOutsideRTH: 'WireDouble',
  equityWithLoanChangeOutsideRTH: 'WireDouble',
  initMarginAfterOutsideRTH: 'WireDouble',
  maintMarginAfterOutsideRTH: 'WireDouble',
  equityWithLoanAfterOutsideRTH: 'WireDouble',
  suggestedSize: 'WireDecimal',
} as const satisfies Record<string, 'WireDecimal' | 'WireDouble' | 'WireInteger'>

/**
 * Map from wire-type literal to the corresponding wire-value type.
 */
type WireMap = {
  WireDecimal: WireDecimal
  WireDouble: WireDouble
  WireInteger: WireInteger
}

/**
 * Derive a wire-form type from a source class + a schema.
 *
 * For each key K on Source:
 *   - if K is in Schema, substitute the wire-value type per WireMap
 *   - else pass through Source[K] verbatim
 */
type MakeWire<Schema extends Record<string, keyof WireMap>, Source> = {
  [K in keyof Source]: K extends keyof Schema
    ? WireMap[Schema[K]]
    : Source[K]
}

export type WireOrder = MakeWire<typeof ORDER_SCHEMA, Order>
export type WireContract = MakeWire<typeof CONTRACT_SCHEMA, Contract>
export type WireContractDetails = MakeWire<typeof CONTRACT_DETAILS_SCHEMA, ContractDetails>
export type WireExecution = MakeWire<typeof EXECUTION_SCHEMA, Execution>
export type WireOrderState = MakeWire<typeof ORDER_STATE_SCHEMA, OrderState>
