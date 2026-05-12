//! Phase 4e Task B — Broker trait extension tests.

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::traits::Broker;
use serde_json::json;

#[tokio::test]
async fn allocate_client_order_id_monotonic() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    let id1 = broker.allocate_client_order_id();
    let id2 = broker.allocate_client_order_id();
    let id3 = broker.allocate_client_order_id();
    assert_eq!(id1, "mock-cli-1");
    assert_eq!(id2, "mock-cli-2");
    assert_eq!(id3, "mock-cli-3");
}

#[tokio::test]
async fn lookup_returns_none_for_unknown_id() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    let result = broker
        .lookup_by_client_order_id("non-existent")
        .await
        .unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn lookup_finds_order_after_place() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("mock|AAPL", 100.0);
    let cli_id = broker.allocate_client_order_id();
    let contract = json!({
        "aliceId": "mock|AAPL", "symbol": "AAPL", "secType": "STK",
        "exchange": "MOCK", "currency": "USD",
    });
    let order = json!({
        "action": "BUY", "orderType": "MKT", "totalQuantity": "10",
        "clientOrderId": cli_id,
    });
    broker.place_order(&contract, &order, None).await.unwrap();
    let found = broker.lookup_by_client_order_id(&cli_id).await.unwrap();
    assert!(
        found.is_some(),
        "lookup should find the order by client_order_id"
    );
    let open_order = found.unwrap();
    let stored_cli_id = open_order
        .order
        .get("clientOrderId")
        .and_then(|v| v.as_str());
    assert_eq!(stored_cli_id, Some(cli_id.as_str()));
}
