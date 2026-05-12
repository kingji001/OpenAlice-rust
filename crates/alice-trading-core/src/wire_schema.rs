//! Wire schemas — mirror src/domain/trading/wire-types.ts.
//!
//! Each schema maps a numeric field name to its WireKind. Non-numeric
//! fields (strings, booleans, nested objects) are NOT in the schema —
//! the wire walker passes them through verbatim.
//!
//! Adding a numeric field to an IBKR class requires updating both the
//! TS schema AND this Rust mirror.

use once_cell::sync::Lazy;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireKind {
    Decimal,
    Double,
    Integer,
}

/// Mirror of TS ORDER_SCHEMA at src/domain/trading/wire-types.ts:48-113 (64 fields).
pub static ORDER_SCHEMA: Lazy<HashMap<&'static str, WireKind>> = Lazy::new(|| {
    let mut m = HashMap::new();
    use WireKind::*;
    // Integer fields
    for k in [
        "orderId",
        "clientId",
        "permId",
        "ocaType",
        "parentId",
        "displaySize",
        "triggerMethod",
        "minQty",
        "origin",
        "shortSaleSlot",
        "exemptCode",
        "auctionStrategy",
        "volatilityType",
        "deltaNeutralConId",
        "deltaNeutralShortSaleSlot",
        "referencePriceType",
        "basisPointsType",
        "scaleInitLevelSize",
        "scaleSubsLevelSize",
        "scalePriceAdjustInterval",
        "scaleInitPosition",
        "scaleInitFillQty",
        "referenceContractId",
        "refFuturesConId",
        "adjustableTrailingUnit",
        "parentPermId",
        "duration",
        "postToAts",
        "minTradeQty",
        "minCompeteSize",
        "manualOrderIndicator",
        "whatIfType",
        "slOrderId",
        "ptOrderId",
    ] {
        m.insert(k, Integer);
    }
    // Decimal fields
    for k in [
        "totalQuantity",
        "lmtPrice",
        "auxPrice",
        "trailStopPrice",
        "trailingPercent",
        "cashQty",
        "filledQuantity",
    ] {
        m.insert(k, Decimal);
    }
    // Double fields
    for k in [
        "percentOffset",
        "discretionaryAmt",
        "startingPrice",
        "stockRefPrice",
        "delta",
        "stockRangeLower",
        "stockRangeUpper",
        "volatility",
        "deltaNeutralAuxPrice",
        "basisPoints",
        "scalePriceIncrement",
        "scalePriceAdjustValue",
        "scaleProfitOffset",
        "peggedChangeAmount",
        "referenceChangeAmount",
        "triggerPrice",
        "adjustedStopPrice",
        "adjustedStopLimitPrice",
        "adjustedTrailingAmount",
        "lmtPriceOffset",
        "competeAgainstBestOffset",
        "midOffsetAtWhole",
        "midOffsetAtHalf",
    ] {
        m.insert(k, Double);
    }
    m
});

/// Mirror of TS CONTRACT_SCHEMA (2 fields).
pub static CONTRACT_SCHEMA: Lazy<HashMap<&'static str, WireKind>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert("conId", WireKind::Integer);
    m.insert("strike", WireKind::Double);
    m
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_sizes_match_ts() {
        assert_eq!(ORDER_SCHEMA.len(), 64, "ORDER_SCHEMA size drift");
        assert_eq!(CONTRACT_SCHEMA.len(), 2, "CONTRACT_SCHEMA size drift");
    }

    #[test]
    fn order_schema_contains_known_fields() {
        assert_eq!(ORDER_SCHEMA.get("totalQuantity"), Some(&WireKind::Decimal));
        assert_eq!(ORDER_SCHEMA.get("lmtPrice"), Some(&WireKind::Decimal));
        assert_eq!(ORDER_SCHEMA.get("orderId"), Some(&WireKind::Integer));
        assert_eq!(ORDER_SCHEMA.get("percentOffset"), Some(&WireKind::Double));
    }
}
