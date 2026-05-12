//! Helpers shared across guards.

use serde_json::Value;

/// Mirrors TS getOperationSymbol at src/domain/trading/git/types.ts:225-233.
/// For placeOrder/closePosition: contract.symbol → contract.aliceId → "unknown".
/// For modifyOrder/cancelOrder/syncOrders: always "unknown".
pub fn get_operation_symbol(op: &Value) -> String {
    let action = op
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    match action {
        "placeOrder" | "closePosition" => {
            let contract = op.get("contract");
            contract
                .and_then(|c| c.get("symbol").and_then(|v| v.as_str()))
                .or_else(|| contract.and_then(|c| c.get("aliceId").and_then(|v| v.as_str())))
                .map(String::from)
                .unwrap_or_else(|| "unknown".into())
        }
        _ => "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn place_order_uses_symbol() {
        let op =
            json!({"action": "placeOrder", "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL"}});
        assert_eq!(get_operation_symbol(&op), "AAPL");
    }

    #[test]
    fn place_order_falls_back_to_alice_id_when_symbol_missing() {
        let op = json!({"action": "placeOrder", "contract": {"aliceId": "mock|BTC"}});
        assert_eq!(get_operation_symbol(&op), "mock|BTC");
    }

    #[test]
    fn place_order_unknown_when_both_missing() {
        let op = json!({"action": "placeOrder", "contract": {}});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }

    #[test]
    fn close_position_uses_symbol() {
        let op = json!({"action": "closePosition", "contract": {"symbol": "MSFT"}});
        assert_eq!(get_operation_symbol(&op), "MSFT");
    }

    #[test]
    fn modify_order_is_always_unknown() {
        let op = json!({"action": "modifyOrder", "orderId": "x", "changes": {}});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }

    #[test]
    fn cancel_order_is_always_unknown() {
        let op = json!({"action": "cancelOrder", "orderId": "x"});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }

    #[test]
    fn sync_orders_is_always_unknown() {
        let op = json!({"action": "syncOrders"});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }
}
