//! Phase 4d Task A — basic actor lifecycle + simple commands.

use std::sync::Arc;

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::uta::{UtaActor, UtaState};
use serde_json::json;
use tempfile::TempDir;

fn make_state(account_id: &str, data_root: std::path::PathBuf) -> UtaState {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    UtaState::new(account_id.to_string(), broker, vec![], data_root)
}

fn buy_aapl_op() -> alice_trading_core::types::Operation {
    serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock-paper|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10"},
    }))
    .unwrap()
}

#[tokio::test]
async fn actor_spawn_and_shutdown() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-1", dir.path().to_path_buf());
    let (handle, join) = UtaActor::spawn(state, 16);
    handle.shutdown().await.unwrap();
    join.await.unwrap();
}

#[tokio::test]
async fn add_command_works() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-2", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    let result = handle.add(buy_aapl_op()).await.unwrap();
    assert_eq!(result.index, 0);
    assert!(result.staged);
}

#[tokio::test]
async fn commit_after_add_succeeds() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-3", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    handle.add(buy_aapl_op()).await.unwrap();
    let prep = handle.commit("test commit".to_string()).await.unwrap();
    assert!(prep.prepared);
    assert_eq!(prep.message, "test commit");
    assert_eq!(prep.operation_count, 1);
}

#[tokio::test]
async fn export_state_returns_committed_log() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-4", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    handle.add(buy_aapl_op()).await.unwrap();
    handle.commit("c1".to_string()).await.unwrap();
    let exported = handle.export_state().await.unwrap();
    // Note: commit() prepares but does NOT push, so commits[] is empty
    // until push runs. ExportState reflects only what's pushed.
    assert!(exported.commits.is_empty());
    assert!(exported.head.is_none());
}

#[tokio::test]
async fn handle_is_cloneable_and_works_serially() {
    let dir = TempDir::new().unwrap();
    let state = make_state("test-5", dir.path().to_path_buf());
    let (handle, _join) = UtaActor::spawn(state, 16);
    let h2 = handle.clone();
    let result_a = handle.add(buy_aapl_op()).await.unwrap();
    let result_b = h2.add(buy_aapl_op()).await.unwrap();
    assert_eq!(result_a.index, 0);
    assert_eq!(result_b.index, 1); // serial via mpsc
}
