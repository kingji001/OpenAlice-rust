//! Phase 4d Task D — full Mock-backed UTA lifecycle via the actor.

use std::sync::Arc;

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::types::BrokerHealth;
use alice_trading_core::types::Operation;
use alice_trading_core::uta::{load_git_state, UtaActor, UtaState};
use serde_json::json;
use tempfile::TempDir;

fn buy_op(symbol: &str) -> Operation {
    serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {
            "symbol": symbol,
            "aliceId": format!("mock|{}", symbol),
            "secType": "STK",
            "exchange": "MOCK",
            "currency": "USD",
        },
        "order": {
            "action": "BUY",
            "orderType": "MKT",
            "totalQuantity": "10",
        },
    }))
    .unwrap()
}

#[tokio::test]
async fn full_lifecycle_via_actor_persists_commit() {
    let dir = TempDir::new().unwrap();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    // Quote keyed on the contract's aliceId (matches position_key derivation).
    broker.set_quote("mock|AAPL", 100.0);

    let state = UtaState::new(
        "lifecycle-1".to_string(),
        broker.clone(),
        vec![],
        dir.path().to_path_buf(),
    );
    let (handle, _join) = UtaActor::spawn(state, 16);

    // Stage + commit + push
    handle.add(buy_op("AAPL")).await.unwrap();
    handle.commit("test buy".to_string()).await.unwrap();
    let push_result = handle.push().await.unwrap();
    assert_eq!(push_result.operation_count, 1);
    assert_eq!(push_result.submitted.len(), 1);
    assert_eq!(push_result.rejected.len(), 0);

    // Verify commit persisted on disk
    let loaded = load_git_state("lifecycle-1", dir.path()).await.unwrap();
    assert_eq!(loaded.commits.len(), 1);
    assert_eq!(loaded.commits[0].hash, push_result.hash);

    // Verify health
    let info = handle.get_health().await.unwrap();
    assert_eq!(info.status, BrokerHealth::Healthy);
}

#[tokio::test]
async fn push_fails_when_disabled() {
    use alice_trading_core::brokers::error::BrokerErrorCode;

    let dir = TempDir::new().unwrap();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let mut state = UtaState::new(
        "disabled-test".to_string(),
        broker,
        vec![],
        dir.path().to_path_buf(),
    );
    state.health.disabled = true;
    let (handle, _join) = UtaActor::spawn(state, 16);

    handle.add(buy_op("AAPL")).await.unwrap();
    handle.commit("c".to_string()).await.unwrap();
    let err = handle.push().await.unwrap_err();
    assert_eq!(err.code, BrokerErrorCode::Config);
    assert!(
        err.message.contains("disabled"),
        "expected 'disabled' in {:?}",
        err.message
    );
}

#[tokio::test]
async fn commit_emits_event_when_event_tx_set() {
    use alice_trading_core::uta::UtaEvent;
    use tokio::sync::mpsc;

    let dir = TempDir::new().unwrap();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    // Quote keyed on the contract's aliceId (matches position_key derivation).
    broker.set_quote("mock|AAPL", 100.0);
    let (event_tx, mut event_rx) = mpsc::channel::<UtaEvent>(16);

    let mut state = UtaState::new(
        "event-test".to_string(),
        broker,
        vec![],
        dir.path().to_path_buf(),
    );
    state.event_tx = Some(event_tx);
    let (handle, _join) = UtaActor::spawn(state, 16);

    handle.add(buy_op("AAPL")).await.unwrap();
    handle.commit("test".to_string()).await.unwrap();
    handle.push().await.unwrap();

    let event = tokio::time::timeout(tokio::time::Duration::from_millis(200), event_rx.recv())
        .await
        .expect("event never arrived")
        .expect("event channel closed");
    match event {
        UtaEvent::CommitNotify {
            account_id,
            commit_hash,
        } => {
            assert_eq!(account_id, "event-test");
            assert_eq!(commit_hash.len(), 8);
        }
        UtaEvent::HealthChange { .. } => panic!("expected CommitNotify, got HealthChange"),
    }
}
