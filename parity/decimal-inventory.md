# Decimal / Sentinel-Bearing Field Inventory

**Scope:** FFI-boundary types only — types that cross the napi boundary
in Phase 3 (`TradingGit` persisted state) and Phase 4f (`RustUtaProxy`).
Per-broker types (`Alpaca*`, `Ccxt*`), domain/analysis Decimals, and
market-data Decimals are out of scope for this inventory.

**Purpose:** Drives the wire-type design in Phase 1b. Each field is
classified for its semantic role; the proposed Wire type is a Phase 1b
recommendation, not binding.

**Source references:** Line numbers refer to TS source as of commit `0ec699e`.

## Glossary

- **value-only:** field always holds a real value; sentinel never observed.
- **value-or-unset:** field may hold its sentinel (`UNSET_DECIMAL` /
  `UNSET_DOUBLE` / `UNSET_INTEGER`) when the field is not applicable to
  the order/contract/execution kind.
- **computed-only:** derived from other fields; not persisted; not subject
  to wire-type design.

## Sentinels (per `packages/ibkr/src/const.ts`)

| Constant | TS value | Notes |
|---|---|---|
| `UNSET_DECIMAL` | `new Decimal('170141183460469231731687303715884105727')` (= `2**127 - 1`) | For `Decimal` fields |
| `UNSET_DOUBLE` | `Number.MAX_VALUE` | For floating-point `number` fields |
| `UNSET_INTEGER` | `2 ** 31 - 1` | For 32-bit-int `number` fields |
| `UNSET_LONG` | `BigInt(2 ** 63) - 1n` (lossy — see v4 §6.1 caveat) | For 64-bit fields if any |

---

## Order

Source: `packages/ibkr/src/order.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `orderId` | `number` | value-only | `WireInteger` | Always set; 0 before server assigns |
| `clientId` | `number` | value-only | `WireInteger` | Always set |
| `permId` | `number` | value-only | `WireInteger` | 0 until TWS assigns permanent id |
| `totalQuantity` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; unset before qty is known |
| `lmtPrice` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; MKT orders leave this unset |
| `auxPrice` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; STOP/TRAIL orders only |
| `ocaType` | `number` | value-only | `WireInteger` | 0 = no OCA group; always meaningful |
| `parentId` | `number` | value-only | `WireInteger` | 0 = no parent; always meaningful |
| `displaySize` | `number` | value-only | `WireInteger` | 0 = full size; always meaningful |
| `triggerMethod` | `number` | value-only | `WireInteger` | 0 = default; always meaningful |
| `minQty` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; unset for most order types |
| `percentOffset` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; REL orders only |
| `trailStopPrice` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; TRAIL orders only |
| `trailingPercent` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; TRAILLIMIT orders only |
| `origin` | `number` | value-only | `WireInteger` | 0 = CUSTOMER; always set |
| `shortSaleSlot` | `number` | value-only | `WireInteger` | 0 = N/A; always set |
| `exemptCode` | `number` | value-only | `WireInteger` | -1 = N/A; always set |
| `discretionaryAmt` | `number` | value-only | `WireDouble` | 0 = none; always set |
| `auctionStrategy` | `number` | value-only | `WireInteger` | AUCTION_UNSET = 0; always set |
| `startingPrice` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; BOX orders only |
| `stockRefPrice` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; pegged orders |
| `delta` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; VOL orders only |
| `stockRangeLower` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; pegged-to-stock |
| `stockRangeUpper` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; pegged-to-stock |
| `volatility` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; VOL orders only |
| `volatilityType` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; VOL orders only |
| `deltaNeutralAuxPrice` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; delta-neutral orders only |
| `deltaNeutralConId` | `number` | value-only | `WireInteger` | 0 = none; always set |
| `deltaNeutralShortSaleSlot` | `number` | value-only | `WireInteger` | 0 = N/A; always set |
| `referencePriceType` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; VOL orders only |
| `basisPoints` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; EFP orders only |
| `basisPointsType` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; EFP orders only |
| `scaleInitLevelSize` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; SCALE orders only |
| `scaleSubsLevelSize` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; SCALE orders only |
| `scalePriceIncrement` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; SCALE orders only |
| `scalePriceAdjustValue` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; SCALE orders only |
| `scalePriceAdjustInterval` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; SCALE orders only |
| `scaleProfitOffset` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; SCALE orders only |
| `scaleInitPosition` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; SCALE orders only |
| `scaleInitFillQty` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; SCALE orders only |
| `referenceContractId` | `number` | value-only | `WireInteger` | 0 = none; PEG2BENCH field |
| `peggedChangeAmount` | `number` | value-only | `WireDouble` | 0.0 = none; PEG2BENCH field |
| `referenceChangeAmount` | `number` | value-only | `WireDouble` | 0.0 = none; PEG2BENCH field |
| `refFuturesConId` | `number` | value-only | `WireInteger` | 0 = none; PEG2BENCH field |
| `triggerPrice` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; adjusted orders |
| `adjustedStopPrice` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; adjusted orders |
| `adjustedStopLimitPrice` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; adjusted orders |
| `adjustedTrailingAmount` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; adjusted orders |
| `adjustableTrailingUnit` | `number` | value-only | `WireInteger` | 0 = none; always set |
| `lmtPriceOffset` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; adjusted orders |
| `cashQty` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; cash-quantity orders only |
| `filledQuantity` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; 0 until partially/fully filled |
| `parentPermId` | `number` | value-only | `WireInteger` | 0 = no parent; always set |
| `duration` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; GTD orders only |
| `postToAts` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; ATS routing only |
| `minTradeQty` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; compete-against-best feature |
| `minCompeteSize` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; compete-against-best feature |
| `competeAgainstBestOffset` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; compete-against-best feature |
| `midOffsetAtWhole` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; compete-against-best feature |
| `midOffsetAtHalf` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; compete-against-best feature |
| `manualOrderIndicator` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; manual order tagging |
| `whatIfType` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; what-if simulation type |
| `slOrderId` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; attached stop-loss order |
| `ptOrderId` | `number` | value-or-unset | `WireInteger` | Default `UNSET_INTEGER`; attached profit-taker order |

**Field count:** 64 numeric fields. **Sentinel-bearing:** 44 (7 Decimal, 37 number).

---

## Contract

Source: `packages/ibkr/src/contract.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `conId` | `number` | value-only | `WireInteger` | 0 = unresolved contract; always set |
| `strike` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; options/warrants only |
| `minTick` | `number` | value-only | `WireDouble` | On `ContractDetails`; 0.0 default; always meaningful |
| `priceMagnifier` | `number` | value-only | `WireInteger` | On `ContractDetails`; 0 default |
| `underConId` | `number` | value-only | `WireInteger` | On `ContractDetails`; 0 = no underlying |
| `evMultiplier` | `number` | value-only | `WireDouble` | On `ContractDetails`; 0 default |
| `aggGroup` | `number` | value-only | `WireInteger` | On `ContractDetails`; 0 default |
| `coupon` | `number` | value-only | `WireDouble` | On `ContractDetails`; bond coupon; 0 for non-bonds |
| `minSize` | `Decimal` | value-or-unset | `WireDecimal` | On `ContractDetails`; default `UNSET_DECIMAL` |
| `sizeIncrement` | `Decimal` | value-or-unset | `WireDecimal` | On `ContractDetails`; default `UNSET_DECIMAL` |
| `suggestedSizeIncrement` | `Decimal` | value-or-unset | `WireDecimal` | On `ContractDetails`; default `UNSET_DECIMAL` |
| `minAlgoSize` | `Decimal` | value-or-unset | `WireDecimal` | On `ContractDetails`; default `UNSET_DECIMAL` |
| `lastPricePrecision` | `Decimal` | value-or-unset | `WireDecimal` | On `ContractDetails`; default `UNSET_DECIMAL` |
| `lastSizePrecision` | `Decimal` | value-or-unset | `WireDecimal` | On `ContractDetails`; default `UNSET_DECIMAL` |

**Field count:** 14 numeric fields. **Sentinel-bearing:** 7 (6 Decimal + 1 number: `strike`).

---

## Execution

Source: `packages/ibkr/src/execution.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `shares` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; always filled for real executions but unset sentinel until server populates |
| `price` | `number` | value-only | `WireDouble` | Default `0.0`; fill price; always a real value for a real execution |
| `permId` | `number` | value-only | `WireInteger` | 0 until TWS assigns |
| `clientId` | `number` | value-only | `WireInteger` | Always set |
| `orderId` | `number` | value-only | `WireInteger` | Always set |
| `liquidation` | `number` | value-only | `WireInteger` | 0 = not a liquidation; always set |
| `cumQty` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; cumulative filled qty |
| `avgPrice` | `number` | value-only | `WireDouble` | Default `0.0`; average fill price |
| `evMultiplier` | `number` | value-only | `WireDouble` | Default `0.0`; EV rule multiplier; 0 when not applicable |
| `lastLiquidity` | `number` | value-only | `WireInteger` | 0 = none; always set |

**Field count:** 10 numeric fields. **Sentinel-bearing:** 2 (2 Decimal: `shares`, `cumQty`).

---

## OrderState

Source: `packages/ibkr/src/order-state.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `commissionAndFees` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; unset for live (non-what-if) orders |
| `minCommissionAndFees` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; unset for live orders |
| `maxCommissionAndFees` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; unset for live orders |
| `initMarginBeforeOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `maintMarginBeforeOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `equityWithLoanBeforeOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `initMarginChangeOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `maintMarginChangeOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `equityWithLoanChangeOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `initMarginAfterOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `maintMarginAfterOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `equityWithLoanAfterOutsideRTH` | `number` | value-or-unset | `WireDouble` | Default `UNSET_DOUBLE`; outside-RTH what-if only |
| `suggestedSize` | `Decimal` | value-or-unset | `WireDecimal` | Default `UNSET_DECIMAL`; what-if suggested quantity |

**Field count:** 13 numeric fields. **Sentinel-bearing:** 13 (1 Decimal + 12 number). Note: margin fields `initMarginBefore`, `maintMarginBefore`, etc. are `string`-typed in the TS source and excluded from this table.

---

## Position

Source: `src/domain/trading/brokers/types.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `quantity` | `Decimal` | value-only | `WireDecimal` (Value variant) | Required interface field; always a real quantity |
| `avgCost` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention; no Wire wrapper |
| `marketPrice` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention |
| `marketValue` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention |
| `unrealizedPnL` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention |
| `realizedPnL` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention |
| `multiplier` | `string` | value-only | `string` | Optional; Decimal-as-string; shares-per-contract metadata |

**Field count:** 7 numeric-or-Decimal-as-string fields. **Sentinel-bearing:** 0 (no sentinel defaults; all required/always set).

---

## OpenOrder

Source: `src/domain/trading/brokers/types.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `avgFillPrice` | `string` | value-or-unset | `string` | Optional; Decimal-as-string; absent until a fill occurs |

**Field count:** 1 numeric-meaningful field (string-typed). **Sentinel-bearing:** 0. Note: the numeric fields of `OpenOrder` are carried by its embedded `Order` and `OrderState` members (already covered in those sections above). `avgFillPrice` is the only OpenOrder-native numeric field.

---

## GitState

Source: `src/domain/trading/git/types.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `netLiquidation` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention; no Wire wrapper needed |
| `totalCashValue` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention |
| `unrealizedPnL` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention |
| `realizedPnL` | `string` | value-only | `string` | Decimal-as-string per pre-existing convention |

**Field count:** 4 numeric-meaningful fields (all string-typed). **Sentinel-bearing:** 0. Note: `positions` and `pendingOrders` are array fields of complex types already inventoried above; not numeric scalars.

---

## OperationResult

Source: `src/domain/trading/git/types.ts`.

| Field | TS type | Semantic class | Wire type (Phase 1b proposal) | Notes |
|---|---|---|---|---|
| `filledQty` | `string` | value-or-unset | `string` | Decimal-as-string per pre-existing convention; optional — absent until fill |
| `filledPrice` | `string` | value-or-unset | `string` | Decimal-as-string per pre-existing convention; optional — absent until fill |

**Field count:** 2 numeric-meaningful fields (both string-typed). **Sentinel-bearing:** 0 (optional fields; absence encodes "unset" without a sentinel value).

---

## Summary

| Type | Field count | Sentinel-bearing | value-only | computed-only |
|---|---|---|---|---|
| Order | 64 | 44 | 20 | 0 |
| Contract | 14 | 7 | 7 | 0 |
| Execution | 10 | 2 | 8 | 0 |
| OrderState | 13 | 13 | 0 | 0 |
| Position | 7 | 0 | 7 | 0 |
| OpenOrder | 1 | 0 | 0 | 0 |
| GitState | 4 | 0 | 4 | 0 |
| OperationResult | 2 | 0 | 0 | 0 |

**Total numeric fields across all types:** 115  
**Total sentinel-bearing fields:** 66

## Wire-type recommendations for Phase 1b

- All `value-or-unset` Decimal fields → `WireDecimal` (tagged enum
  `Unset | Value(DecimalString)`).
- All `value-or-unset` floating `number` fields → `WireDouble`.
- All `value-or-unset` integer `number` fields → `WireInteger`.
- All `value-only` fields → the `Value` variant (no sentinel reconstruction).
- `computed-only` fields → omitted from wire types entirely.
- `string`-encoded Decimal fields (GitState, OperationResult) → already wire-friendly; no Wire wrapper.
