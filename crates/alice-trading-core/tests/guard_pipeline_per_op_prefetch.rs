//! Load-bearing parity assertion: pre-fetch must be PER-OP, not per-push.
//!
//! v4 §4c: "Do NOT optimize to per-push during the port — it would
//! silently change guard semantics if a guard depends on positions
//! changing between ops."
//!
//! Test: a 5-op push must call broker.getPositions() 5 times and
//! broker.getAccount() 5 times (NOT 1 each).

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::traits::Broker;
use alice_trading_core::guards::pipeline::Dispatcher;
use alice_trading_core::guards::{create_guard_pipeline, Guard, SymbolWhitelistGuard};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn pre_fetch_is_per_op_not_per_push() {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    broker.set_quote("AAPL", 100.0);

    let guards: Vec<Box<dyn Guard>> = vec![Box::new(
        SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap(),
    )];

    let dispatcher: Dispatcher =
        Arc::new(|_op| Box::pin(async move { Ok(json!({"success": true})) }));

    let broker_for_pipeline: Arc<dyn Broker> = broker.clone();
    let pipeline = create_guard_pipeline(dispatcher, broker_for_pipeline, guards);

    // Simulate a 5-op push
    for _ in 0..5 {
        pipeline(json!({
            "action": "placeOrder",
            "contract": {"symbol": "AAPL"},
            "order": {},
        }))
        .await
        .unwrap();
    }

    assert_eq!(
        broker.call_count("getPositions"),
        5,
        "pre-fetch MUST be per-op (5 calls), not per-push (1 call). v4 §4c.",
    );
    assert_eq!(
        broker.call_count("getAccount"),
        5,
        "pre-fetch MUST be per-op (5 calls), not per-push (1 call). v4 §4c.",
    );
}

#[tokio::test]
async fn pipeline_passes_through_when_no_guards() {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let dispatcher: Dispatcher = Arc::new(|_op| {
        Box::pin(async move { Ok(json!({"success": true, "from_dispatcher": true})) })
    });
    let broker_for_pipeline: Arc<dyn Broker> = broker.clone();
    let pipeline = create_guard_pipeline(dispatcher, broker_for_pipeline, vec![]);

    let result =
        pipeline(json!({"action": "placeOrder", "contract": {"symbol": "ZZZ"}, "order": {}}))
            .await
            .unwrap();
    assert_eq!(result.get("from_dispatcher"), Some(&json!(true)));

    // With no guards, broker should not be queried at all
    assert_eq!(broker.call_count("getPositions"), 0);
    assert_eq!(broker.call_count("getAccount"), 0);
}

#[tokio::test]
async fn pipeline_rejection_format_matches_ts() {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let dispatcher: Dispatcher =
        Arc::new(|_op| Box::pin(async move { Ok(json!({"success": true})) }));
    let broker_for_pipeline: Arc<dyn Broker> = broker.clone();
    let guards: Vec<Box<dyn Guard>> = vec![Box::new(
        SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap(),
    )];
    let pipeline = create_guard_pipeline(dispatcher, broker_for_pipeline, guards);

    let result = pipeline(json!({
        "action": "placeOrder",
        "contract": {"symbol": "GME"},
        "order": {},
    }))
    .await
    .unwrap();

    // Rejection envelope matches TS: { success: false, error: "[guard:name] reason" }
    assert_eq!(result.get("success"), Some(&json!(false)));
    let err = result.get("error").and_then(|v| v.as_str()).unwrap();
    assert!(err.starts_with("[guard:symbol-whitelist]"), "got: {}", err);
    assert!(
        err.contains("Symbol GME is not in the allowed list"),
        "got: {}",
        err
    );
}
