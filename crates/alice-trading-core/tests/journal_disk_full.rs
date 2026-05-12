//! Phase 4e Task D — disk-full propagation.

use alice_trading_core::brokers::error::BrokerErrorCode;
use alice_trading_core::journal::{ExecutionIntent, ExecutionJournal};
use alice_trading_core::types::Operation;
use serde_json::json;
use tempfile::TempDir;

#[cfg(unix)]
#[tokio::test]
async fn record_intent_returns_network_error_on_readonly_dir() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().unwrap();
    let acct_dir = dir.path().join("trading/readonly-test/executing");
    std::fs::create_dir_all(&acct_dir).unwrap();
    // Make the directory read-only
    let mut perms = std::fs::metadata(&acct_dir).unwrap().permissions();
    perms.set_mode(0o555);
    std::fs::set_permissions(&acct_dir, perms).unwrap();

    let journal = ExecutionJournal::new("readonly-test", dir.path());
    let op: Operation = serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10"},
    }))
    .unwrap();
    let intent = ExecutionIntent {
        commit_hash: "readonly1".to_string(),
        client_order_ids: vec!["cli-1".to_string()],
        operations: vec![op],
        started_at: "2026-01-01T00:00:00.000Z".to_string(),
        broker_id: "mock-paper".to_string(),
    };
    let result = journal.record_intent(intent).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, BrokerErrorCode::Network);

    // Restore permissions so TempDir can be cleaned up
    let mut perms = std::fs::metadata(&acct_dir).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&acct_dir, perms).unwrap();
}
