//! MockBroker parity assertions (Phase 4b deliverable 7).
//!
//! Each test pins a specific behavior that v4 §7 requires byte-identical
//! to TS MockBroker. NOT "behavioral parity" hand-wave.

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::{Broker, BrokerHealth};
use serde_json::json;

fn build_contract(symbol: &str) -> serde_json::Value {
    json!({
        "aliceId": format!("mock-paper|{}", symbol),
        "symbol": symbol,
        "secType": "STK",
        "exchange": "MOCK",
        "currency": "USD",
    })
}

fn build_order(action: &str, qty: &str) -> serde_json::Value {
    json!({
        "action": action,
        "orderType": "MKT",
        "totalQuantity": qty,
    })
}

// =============================================================================
// Parity Assertion #1: Deterministic order ID counter
// =============================================================================

#[tokio::test]
async fn parity_1_deterministic_order_ids() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("AAPL", 100.0);
    let contract = build_contract("AAPL");
    let mut ids = Vec::new();
    for _ in 0..100 {
        let result = broker
            .place_order(&contract, &build_order("BUY", "1"), None)
            .await
            .unwrap();
        ids.push(result.order_id.unwrap());
    }
    let expected: Vec<String> = (1..=100).map(|i| format!("mock-{}", i)).collect();
    assert_eq!(ids, expected);
}

// =============================================================================
// Parity Assertion #2: Flip-to-empty position semantics
// =============================================================================

#[tokio::test]
async fn parity_2_flip_to_empty_deletes_position() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("AAPL", 100.0);
    let contract = build_contract("AAPL");

    // BUY 10 @ 100 → long 10
    broker
        .place_order(&contract, &build_order("BUY", "10"), None)
        .await
        .unwrap();
    let positions = broker.get_positions().await.unwrap();
    assert_eq!(positions.len(), 1, "should have 1 position after BUY 10");

    // Update quote to 120 then SELL 15 — crosses zero
    broker.set_quote("AAPL", 120.0);
    broker
        .place_order(&contract, &build_order("SELL", "15"), None)
        .await
        .unwrap();

    // CRITICAL: position should be GONE (deleted on flip), NOT flipped to short 5
    let positions = broker.get_positions().await.unwrap();
    assert!(
        positions.is_empty(),
        "after SELL 15 (cross-zero), positions should be empty (TS flip-to-empty), got {:?}",
        positions,
    );
}

// =============================================================================
// Parity Assertion #3: Fail-injection counter
// =============================================================================

#[tokio::test]
async fn parity_3_fail_injection_counter() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_fail_mode(2);

    // First 2 calls fail
    let r1 = broker.get_account().await;
    let r2 = broker.get_account().await;
    assert!(r1.is_err());
    assert!(r2.is_err());
    assert!(r1.unwrap_err().message.contains("simulated"));

    // Third call succeeds
    let r3 = broker.get_account().await;
    assert!(r3.is_ok());
}

// =============================================================================
// Parity Assertion #4: Call-log shape
// =============================================================================

#[tokio::test]
async fn parity_4_call_log_shape() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("AAPL", 100.0);
    let contract = build_contract("AAPL");

    broker.get_account().await.unwrap();
    broker
        .place_order(&contract, &build_order("BUY", "1"), None)
        .await
        .unwrap();
    broker.get_quote(&contract).await.unwrap();
    broker.get_account().await.unwrap();

    assert_eq!(broker.call_count("getAccount"), 2);
    assert_eq!(broker.call_count("placeOrder"), 1);
    assert_eq!(broker.call_count("getQuote"), 1);
    assert_eq!(broker.call_count("modifyOrder"), 0);

    let all = broker.calls(None);
    assert_eq!(all.len(), 4);
    assert_eq!(all[0].method, "getAccount");
    assert_eq!(all[1].method, "placeOrder");
    assert_eq!(all[2].method, "getQuote");
    assert_eq!(all[3].method, "getAccount");

    let last = broker.last_call("getAccount").unwrap();
    assert_eq!(last.method, "getAccount");

    broker.reset_calls();
    assert_eq!(broker.calls(None).len(), 0);
}

// =============================================================================
// Parity Assertion #5: Failure-mode triggers health transitions
// =============================================================================

#[tokio::test]
async fn parity_5_health_default_is_healthy_regardless_of_fail_mode() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    assert_eq!(broker.get_health(), BrokerHealth::Healthy);

    broker.set_fail_mode(3);
    let _ = broker.get_account().await;
    let _ = broker.get_account().await;
    let _ = broker.get_account().await;

    // Parity with TS: mock health does NOT transition on injected failures
    assert_eq!(broker.get_health(), BrokerHealth::Healthy);
}
