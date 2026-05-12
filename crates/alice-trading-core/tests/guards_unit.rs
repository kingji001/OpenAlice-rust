//! Per-guard unit tests with exact rejection-string parity to TS.

use alice_trading_core::brokers::types::{AccountInfo, Position, PositionSide};
use alice_trading_core::guards::{
    CooldownGuard, Guard, GuardContext, MaxPositionSizeGuard, SymbolWhitelistGuard,
};
use serde_json::json;

fn empty_positions() -> Vec<Position> {
    vec![]
}

fn default_account() -> AccountInfo {
    AccountInfo {
        base_currency: "USD".into(),
        net_liquidation: "100000".into(),
        total_cash_value: "100000".into(),
        unrealized_pn_l: "0".into(),
        realized_pn_l: Some("0".into()),
        buying_power: None,
        init_margin_req: None,
        maint_margin_req: None,
        day_trades_remaining: None,
    }
}

fn position_for(
    symbol: &str,
    qty: &str,
    avg_cost: &str,
    market_value: &str,
    market_price: &str,
) -> Position {
    Position {
        contract: json!({"symbol": symbol, "aliceId": format!("mock|{}", symbol)}),
        currency: "USD".into(),
        side: PositionSide::Long,
        quantity: qty.into(),
        avg_cost: avg_cost.into(),
        market_price: market_price.into(),
        market_value: market_value.into(),
        unrealized_pn_l: "0".into(),
        realized_pn_l: "0".into(),
        multiplier: None,
    }
}

// ============================================================================
// CooldownGuard tests
// ============================================================================

#[tokio::test]
async fn cooldown_allows_non_place_order() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 100})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "modifyOrder", "orderId": "x", "changes": {}});
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn cooldown_allows_first_trade() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 60000})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn cooldown_rejects_within_interval() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 60000})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    let _ = g.check(&ctx).await; // first call — allow + record
    let rejection = g.check(&ctx).await;
    assert!(rejection.is_some());
    let msg = rejection.unwrap();
    assert!(
        msg.starts_with("Cooldown active for AAPL: "),
        "got: {}",
        msg
    );
    assert!(msg.ends_with("s remaining"), "got: {}", msg);
}

#[tokio::test]
async fn cooldown_independent_per_symbol() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 60000})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op_aapl = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let op_msft = json!({"action": "placeOrder", "contract": {"symbol": "MSFT"}, "order": {}});
    let ctx_a = GuardContext {
        operation: &op_aapl,
        positions: &positions,
        account: &account,
    };
    let ctx_m = GuardContext {
        operation: &op_msft,
        positions: &positions,
        account: &account,
    };
    let _ = g.check(&ctx_a).await;
    // MSFT should still be allowed even after AAPL set its cooldown
    assert_eq!(g.check(&ctx_m).await, None);
}

#[tokio::test]
async fn cooldown_warns_on_unknown_field() {
    // Just confirm it doesn't error; tracing::warn output isn't asserted here.
    let g = CooldownGuard::from_options(&json!({"minIntervalMs": 100, "bogus": "field"}));
    assert!(g.is_ok());
}

// ============================================================================
// MaxPositionSizeGuard tests
// ============================================================================

#[tokio::test]
async fn max_position_size_allows_under_limit() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = vec![position_for("AAPL", "10", "100", "1000", "100")];
    let account = default_account(); // netLiq 100000, so 1000 → 1%
    let op = json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL"},
        "order": {
            "cashQty": "5000",
            "totalQuantity": "170141183460469231731687303715884105727",  // cashQty=5000, totalQty=UNSET
        },
    });
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    // existing 1000 + added 5000 = 6000; 6% of 100000 < 25%
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn max_position_size_rejects_over_limit() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = vec![position_for("AAPL", "10", "100", "20000", "100")];
    let account = default_account();
    let op = json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL"},
        "order": {
            "cashQty": "10000",
            "totalQuantity": "170141183460469231731687303715884105727",
        },
    });
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    // existing 20000 + added 10000 = 30000; 30% of 100000 > 25%
    let rejection = g.check(&ctx).await;
    assert!(rejection.is_some());
    let msg = rejection.unwrap();
    // TS template literal renders integer 25 as "25" (no decimal),
    // unlike toFixed(1) which forces "30.0" for the percent.
    assert_eq!(
        msg, "Position for AAPL would be 30.0% of equity (limit: 25%)",
        "rejection string must match TS exact format",
    );
}

#[tokio::test]
async fn max_position_size_unset_decimal_does_not_count() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL"},
        "order": {
            "cashQty": "170141183460469231731687303715884105727",      // UNSET
            "totalQuantity": "170141183460469231731687303715884105727", // UNSET
        },
    });
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    // Both fields filtered → added_value = 0 → allow
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn max_position_size_non_place_order_allows() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "cancelOrder", "orderId": "x"});
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    assert_eq!(g.check(&ctx).await, None);
}

// ============================================================================
// SymbolWhitelistGuard tests
// ============================================================================

#[tokio::test]
async fn symbol_whitelist_allows_known() {
    let mut g = SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL", "MSFT"]})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn symbol_whitelist_rejects_unknown() {
    let mut g = SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "GME"}, "order": {}});
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    let rejection = g.check(&ctx).await;
    assert_eq!(
        rejection.as_deref(),
        Some("Symbol GME is not in the allowed list")
    );
}

#[tokio::test]
async fn symbol_whitelist_unknown_symbol_passes() {
    let mut g = SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "cancelOrder", "orderId": "x"}); // symbol resolves to "unknown"
    let ctx = GuardContext {
        operation: &op,
        positions: &positions,
        account: &account,
    };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn symbol_whitelist_requires_non_empty() {
    let g = SymbolWhitelistGuard::from_options(&json!({"symbols": []}));
    assert!(g.is_err());
    let err = g.err().unwrap();
    assert!(err.to_string().contains("non-empty"), "got: {}", err);
}
