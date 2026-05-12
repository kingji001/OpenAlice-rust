//! Phase 4d Task B — HealthState transitions + recovery loop lifecycle.

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::types::BrokerHealth;
use alice_trading_core::uta::{UtaActor, UtaState};
use std::sync::Arc;
use tempfile::TempDir;

fn fresh_state(account_id: &str, dir: &TempDir) -> UtaState {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    UtaState::new(
        account_id.to_string(),
        broker,
        vec![],
        dir.path().to_path_buf(),
    )
}

#[tokio::test]
async fn default_health_is_healthy() {
    let dir = TempDir::new().unwrap();
    let state = fresh_state("h1", &dir);
    let (handle, _join) = UtaActor::spawn(state, 16);
    let info = handle.get_health().await.unwrap();
    assert_eq!(info.status, BrokerHealth::Healthy);
    assert_eq!(info.consecutive_failures, Some(0));
}

#[tokio::test]
async fn degraded_threshold_3_failures() {
    // Test the threshold directly on HealthState since Task D wires the
    // failure injection through handle_push (not yet implemented in Task B).
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    assert_eq!(h.health(), BrokerHealth::Healthy);
    h.on_failure(&err);
    h.on_failure(&err);
    assert_eq!(h.health(), BrokerHealth::Healthy); // 2 < 3
    h.on_failure(&err);
    assert_eq!(h.health(), BrokerHealth::Unhealthy); // 3 >= 3
}

#[tokio::test]
async fn offline_threshold_6_failures() {
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    for _ in 0..6 {
        h.on_failure(&err);
    }
    assert_eq!(h.health(), BrokerHealth::Offline);
    assert_eq!(h.consecutive_failures, 6);
}

#[tokio::test]
async fn permanent_error_disables_account() {
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Config, "bad config".to_string());
    h.on_failure(&err);
    assert!(h.disabled);
    assert_eq!(h.health(), BrokerHealth::Offline);
}

#[tokio::test]
async fn on_success_resets_failures() {
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::health::HealthState;

    let mut h = HealthState::default();
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    for _ in 0..5 {
        h.on_failure(&err);
    }
    assert_eq!(h.consecutive_failures, 5);
    h.on_success();
    assert_eq!(h.consecutive_failures, 0);
    assert_eq!(h.health(), BrokerHealth::Healthy);
    assert!(h.last_success_at.is_some());
}

#[tokio::test]
async fn drop_aborts_recovery_task() {
    // Allocate a HealthState, start a recovery task that would otherwise
    // sleep for 5s, drop the state, verify no panic + task is aborted.
    use alice_trading_core::brokers::error::{BrokerError, BrokerErrorCode};
    use alice_trading_core::uta::command::RecoverySignal;
    use alice_trading_core::uta::health::HealthState;
    use tokio::sync::mpsc;

    let mut h = HealthState::default();
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let (sig_tx, _sig_rx) = mpsc::channel::<RecoverySignal>(8);
    // Force 6 failures so health is offline
    let err = BrokerError::new(BrokerErrorCode::Network, "test".to_string());
    for _ in 0..6 {
        h.on_failure(&err);
    }
    h.start_recovery(broker, sig_tx);
    assert!(h.recovering);
    // Drop the state — should abort the recovery task cleanly.
    drop(h);
    // Sleep briefly to give the runtime time to process the abort
    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    // No panic = test passes
}
