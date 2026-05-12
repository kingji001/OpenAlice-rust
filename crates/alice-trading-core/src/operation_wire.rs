//! Operation → wire-form converter.
//!
//! Mirrors src/domain/trading/git/operation-wire.ts and the schema-driven
//! adapters in src/domain/trading/wire-adapters.ts.
//!
//! Input: a serde_json::Value representing a stored Operation
//! (with IBKR Order/Contract in their native JSON-serialized form).
//!
//! Output: a serde_json::Value in canonical wire form ready for canonical_json.

use crate::decimal::to_canonical_decimal_string;
use crate::wire_schema::{WireKind, CONTRACT_SCHEMA, ORDER_SCHEMA};
use bigdecimal::BigDecimal;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::str::FromStr;

// Sentinel values — must match TS:
//   UNSET_DECIMAL = 2^127 - 1
//   UNSET_DOUBLE  = Number.MAX_VALUE = f64::MAX
//   UNSET_INTEGER = 2^31 - 1
const UNSET_DECIMAL_STR: &str = "1.70141183460469231731687303715884105727e+38";
const UNSET_INTEGER: i64 = 2_147_483_647;

fn is_unset_double(n: f64) -> bool {
    // Direct equality to f64::MAX. Number.MAX_VALUE in JS is 1.7976931348623157e+308.
    n == f64::MAX
}

fn is_unset_decimal_str(s: &str) -> bool {
    // Compare numerically — the persisted form may be "1.7e+38" or normalized.
    if s.eq_ignore_ascii_case(UNSET_DECIMAL_STR) {
        return true;
    }
    if let Ok(bd) = BigDecimal::from_str(s) {
        if let Ok(unset) = BigDecimal::from_str(UNSET_DECIMAL_STR) {
            return bd == unset;
        }
    }
    false
}

/// Walk an object (Order, Contract, etc.) and convert numeric fields per the schema.
/// Non-schema fields are passed through verbatim.
fn walk_to_wire(obj: &Map<String, Value>, schema: &HashMap<&'static str, WireKind>) -> Value {
    let mut out = Map::new();
    for (k, v) in obj.iter() {
        if let Some(kind) = schema.get(k.as_str()) {
            out.insert(k.clone(), wrap_value(v, *kind));
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

fn wrap_value(v: &Value, kind: WireKind) -> Value {
    match (kind, v) {
        // WireDecimal: input is a string (Decimal serialized via toString())
        (WireKind::Decimal, Value::String(s)) => {
            if is_unset_decimal_str(s) {
                json!({ "kind": "unset" })
            } else {
                let bd = BigDecimal::from_str(s).unwrap_or_else(|_| panic!("decimal parse: {}", s));
                let canonical = to_canonical_decimal_string(&bd).expect("canonical");
                json!({ "kind": "value", "value": canonical })
            }
        }
        // WireDouble: input is a number (f64). UNSET_DOUBLE = f64::MAX.
        (WireKind::Double, Value::Number(n)) => {
            let f = n.as_f64().expect("number is finite");
            if is_unset_double(f) {
                json!({ "kind": "unset" })
            } else {
                let bd = BigDecimal::from_str(&f.to_string()).expect("f64 to bigdecimal");
                let canonical = to_canonical_decimal_string(&bd).expect("canonical");
                json!({ "kind": "value", "value": canonical })
            }
        }
        // WireInteger: input is a number (i64-castable). UNSET_INTEGER = 2^31 - 1.
        (WireKind::Integer, Value::Number(n)) => {
            let i = n.as_i64().expect("integer is i64-castable");
            if i == UNSET_INTEGER {
                json!({ "kind": "unset" })
            } else {
                json!({ "kind": "value", "value": i })
            }
        }
        _ => panic!("type mismatch: kind={:?} value={:?}", kind, v),
    }
}

/// Walk an Operation to its canonical wire form.
///
/// `op` is a serde_json::Value matching the persisted shape (e.g.,
/// `{"action": "placeOrder", "order": {...}, "contract": {...}}`).
pub fn operation_to_wire(op: &Value) -> Value {
    let action = op
        .get("action")
        .and_then(|a| a.as_str())
        .expect("operation must have action");

    match action {
        "placeOrder" => {
            let mut out = Map::new();
            out.insert("action".to_string(), json!("placeOrder"));
            let order = op.get("order").and_then(|v| v.as_object()).expect("order");
            out.insert("order".to_string(), walk_to_wire(order, &ORDER_SCHEMA));
            let contract = op
                .get("contract")
                .and_then(|v| v.as_object())
                .expect("contract");
            out.insert(
                "contract".to_string(),
                walk_to_wire(contract, &CONTRACT_SCHEMA),
            );
            if let Some(tpsl) = op.get("tpsl") {
                if !tpsl.is_null() {
                    out.insert("tpsl".to_string(), tpsl_to_wire(tpsl));
                }
            }
            Value::Object(out)
        }
        "modifyOrder" => {
            let mut out = Map::new();
            out.insert("action".to_string(), json!("modifyOrder"));
            out.insert(
                "orderId".to_string(),
                op.get("orderId").cloned().unwrap_or(Value::Null),
            );
            let changes = op
                .get("changes")
                .and_then(|v| v.as_object())
                .expect("changes");
            // partialToWire: same as walk_to_wire but skips undefined.
            // serde_json doesn't represent undefined; absent keys are simply not present.
            out.insert("changes".to_string(), walk_to_wire(changes, &ORDER_SCHEMA));
            Value::Object(out)
        }
        "closePosition" => {
            let mut out = Map::new();
            out.insert("action".to_string(), json!("closePosition"));
            let contract = op
                .get("contract")
                .and_then(|v| v.as_object())
                .expect("contract");
            out.insert(
                "contract".to_string(),
                walk_to_wire(contract, &CONTRACT_SCHEMA),
            );
            if let Some(qty) = op.get("quantity") {
                if !qty.is_null() {
                    let bd = if let Some(s) = qty.as_str() {
                        BigDecimal::from_str(s).expect("quantity decimal")
                    } else {
                        BigDecimal::from_str(&qty.to_string()).expect("quantity numeric")
                    };
                    let canonical = to_canonical_decimal_string(&bd).expect("canonical");
                    out.insert("quantity".to_string(), json!(canonical));
                }
            }
            Value::Object(out)
        }
        "cancelOrder" => {
            let mut out = Map::new();
            out.insert("action".to_string(), json!("cancelOrder"));
            out.insert(
                "orderId".to_string(),
                op.get("orderId").cloned().unwrap_or(Value::Null),
            );
            // TODO: add ibkr_order_cancel_to_wire when OrderCancel gains numeric sentinel fields
            if let Some(oc) = op.get("orderCancel") {
                if !oc.is_null() {
                    out.insert("orderCancel".to_string(), oc.clone());
                }
            }
            Value::Object(out)
        }
        "syncOrders" => json!({ "action": "syncOrders" }),
        other => panic!("unknown operation action: {}", other),
    }
}

fn tpsl_to_wire(tpsl: &Value) -> Value {
    let mut out = Map::new();
    if let Some(tp) = tpsl.get("takeProfit") {
        if !tp.is_null() {
            out.insert("takeProfit".to_string(), tp.clone());
        }
    }
    if let Some(sl) = tpsl.get("stopLoss") {
        if !sl.is_null() {
            out.insert("stopLoss".to_string(), sl.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_order_wraps_decimals_and_passes_strings_through() {
        let op = json!({
            "action": "placeOrder",
            "order": {
                "totalQuantity": "100",
                "lmtPrice": "150.50",
                "action": "BUY",
                "orderId": 0_i64,
                "auxPrice": UNSET_DECIMAL_STR,
            },
            "contract": {
                "symbol": "AAPL",
                "secType": "STK",
                "exchange": "SMART",
                "currency": "USD",
                "conId": 0_i64,
                "strike": f64::MAX,
            }
        });
        let wire = operation_to_wire(&op);
        let order = wire.get("order").unwrap();
        assert_eq!(
            order.get("totalQuantity"),
            Some(&json!({ "kind": "value", "value": "100" }))
        );
        assert_eq!(
            order.get("lmtPrice"),
            Some(&json!({ "kind": "value", "value": "150.5" }))
        );
        assert_eq!(order.get("auxPrice"), Some(&json!({ "kind": "unset" })));
        assert_eq!(
            order.get("orderId"),
            Some(&json!({ "kind": "value", "value": 0_i64 }))
        );
        assert_eq!(order.get("action"), Some(&json!("BUY"))); // passthrough
        let contract = wire.get("contract").unwrap();
        assert_eq!(contract.get("strike"), Some(&json!({ "kind": "unset" })));
    }

    #[test]
    fn sync_orders_minimal() {
        let op = json!({ "action": "syncOrders" });
        assert_eq!(operation_to_wire(&op), json!({ "action": "syncOrders" }));
    }
}
