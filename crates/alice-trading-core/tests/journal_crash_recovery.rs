//! Phase 4e Task D — crash-recovery integration tests.
//!
//! For each of 5 crash points in the 5-step recipe, simulate a crash by
//! manually constructing the journal/commit.json state that would exist
//! after a partial completion. Then spawn a fresh UtaActor and verify the
//! reconciler produces the expected ReconcileAction.

use std::sync::Arc;

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::traits::Broker;
use alice_trading_core::journal::{
    reconcile_journal, ExecutionIntent, ExecutionJournal, ExecutionResult, JournalHandle,
    ReconcileAction,
};
use alice_trading_core::types::{Operation, OperationResult, OperationStatus};
use serde_json::json;
use tempfile::TempDir;

fn buy_op_with_cli(cli_id: &str) -> Operation {
    serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10", "clientOrderId": cli_id},
    }))
    .unwrap()
}

async fn write_executing_entry(journal: &ExecutionJournal, commit_hash: &str, cli_id: &str) {
    let intent = ExecutionIntent {
        commit_hash: commit_hash.to_string(),
        client_order_ids: vec![cli_id.to_string()],
        operations: vec![buy_op_with_cli(cli_id)],
        started_at: "2026-01-01T00:00:00.000Z".to_string(),
        broker_id: "mock-paper".to_string(),
    };
    journal.record_intent(intent).await.unwrap();
}

#[tokio::test]
async fn crash_after_step1_marks_failed() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-1", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    // Crash after step 1: entry is 'executing'; broker has no record
    write_executing_entry(&journal, "aaaa1111", "mock-cli-1").await;

    let mut git =
        alice_trading_core::git::TradingGit::new(alice_trading_core::git::TradingGitConfig::stub());
    let outcomes = reconcile_journal(&journal, &broker, &mut git, "crash-1", dir.path())
        .await
        .unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].commit_hash, "aaaa1111");
    assert_eq!(outcomes[0].action, ReconcileAction::MarkedFailed);
}

#[tokio::test]
async fn crash_after_step2_emits_sync_commit() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-2", dir.path());
    let broker_concrete = MockBroker::new(MockBrokerOptions::default());
    broker_concrete.set_quote("mock|AAPL", 100.0);

    // Place the order at the broker (simulates step 2 completed)
    let cli_id = "mock-cli-1".to_string();
    let contract = json!({"aliceId": "mock|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"});
    let order = json!({"action": "BUY", "orderType": "MKT", "totalQuantity": "10", "clientOrderId": cli_id});
    broker_concrete
        .place_order(&contract, &order, None)
        .await
        .unwrap();

    let broker: Arc<dyn Broker> = Arc::new(broker_concrete);

    // Crash after step 2: entry is 'executing', broker has the order
    write_executing_entry(&journal, "bbbb2222", &cli_id).await;

    let mut git =
        alice_trading_core::git::TradingGit::new(alice_trading_core::git::TradingGitConfig::stub());
    let outcomes = reconcile_journal(&journal, &broker, &mut git, "crash-2", dir.path())
        .await
        .unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, ReconcileAction::SyncCommitEmitted);
}

#[tokio::test]
async fn crash_after_step3_completion_recorded() {
    // Entry in state 'completed' but commit.json doesn't have the hash → emit sync
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-3", dir.path());
    let broker_concrete = MockBroker::new(MockBrokerOptions::default());
    broker_concrete.set_quote("mock|AAPL", 100.0);
    let cli_id = "mock-cli-1".to_string();
    let contract = json!({"aliceId": "mock|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"});
    let order = json!({"action": "BUY", "orderType": "MKT", "totalQuantity": "10", "clientOrderId": cli_id});
    broker_concrete
        .place_order(&contract, &order, None)
        .await
        .unwrap();
    let broker: Arc<dyn Broker> = Arc::new(broker_concrete);

    // Write entry in 'completed' state but commit.json doesn't reflect it
    write_executing_entry(&journal, "cccc3333", &cli_id).await;
    let handle = JournalHandle {
        commit_hash: "cccc3333".to_string(),
    };
    let result = ExecutionResult {
        commit_hash: "cccc3333".to_string(),
        completed_at: "2026-01-01T00:00:01.000Z".to_string(),
        results: vec![OperationResult {
            action: "placeOrder".to_string(),
            success: true,
            order_id: Some("mock-1".to_string()),
            status: OperationStatus::Submitted,
            execution: None,
            order_state: None,
            filled_qty: None,
            filled_price: None,
            error: None,
            raw: None,
        }],
        success: true,
    };
    journal.record_completion(&handle, result).await.unwrap();

    let mut git =
        alice_trading_core::git::TradingGit::new(alice_trading_core::git::TradingGitConfig::stub());
    let outcomes = reconcile_journal(&journal, &broker, &mut git, "crash-3", dir.path())
        .await
        .unwrap();

    // commit.json doesn't have cccc3333 → broker lookup finds the order → SyncCommitEmitted
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, ReconcileAction::SyncCommitEmitted);
}

#[tokio::test]
async fn crash_after_step4_already_committed() {
    // Entry is 'completed' AND commit.json has the hash → AlreadyCommitted
    use alice_trading_core::types::{GitCommit, GitExportState, GitState};
    use alice_trading_core::uta::persist::persist_commit_atomic;

    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-4", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    // Write commit.json with the hash
    let state = GitExportState {
        commits: vec![GitCommit {
            hash: "dddd4444".to_string(),
            parent_hash: None,
            message: "test".to_string(),
            operations: vec![],
            results: vec![],
            state_after: GitState {
                net_liquidation: "0".into(),
                total_cash_value: "0".into(),
                unrealized_pn_l: "0".into(),
                realized_pn_l: "0".into(),
                positions: vec![],
                pending_orders: vec![],
            },
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            round: None,
            hash_version: Some(2),
            intent_full_hash: Some("d".repeat(64)),
            hash_input_timestamp: Some("2026-01-01T00:00:00.000Z".to_string()),
            entry_hash_version: None,
            entry_full_hash: None,
        }],
        head: Some("dddd4444".to_string()),
    };
    persist_commit_atomic("crash-4", &state, dir.path())
        .await
        .unwrap();

    // Write entry in 'completed' state
    write_executing_entry(&journal, "dddd4444", "mock-cli-1").await;
    let handle = JournalHandle {
        commit_hash: "dddd4444".to_string(),
    };
    let result = ExecutionResult {
        commit_hash: "dddd4444".to_string(),
        completed_at: "2026-01-01T00:00:01.000Z".to_string(),
        results: vec![],
        success: true,
    };
    journal.record_completion(&handle, result).await.unwrap();

    let mut git =
        alice_trading_core::git::TradingGit::new(alice_trading_core::git::TradingGitConfig::stub());
    let outcomes = reconcile_journal(&journal, &broker, &mut git, "crash-4", dir.path())
        .await
        .unwrap();

    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, ReconcileAction::AlreadyCommitted);
}

#[tokio::test]
async fn crash_after_step5_no_pending_entries() {
    // All entries already closed → reconciler returns empty
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("crash-5", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    // No journal entries — clean slate
    let mut git =
        alice_trading_core::git::TradingGit::new(alice_trading_core::git::TradingGitConfig::stub());
    let outcomes = reconcile_journal(&journal, &broker, &mut git, "crash-5", dir.path())
        .await
        .unwrap();

    assert!(outcomes.is_empty());
}

#[tokio::test]
async fn reconciler_idempotent_on_rerun() {
    // Run reconciler twice — second run should produce empty outcomes (entries closed)
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("idempotent", dir.path());
    let broker: Arc<dyn Broker> = Arc::new(MockBroker::new(MockBrokerOptions::default()));

    write_executing_entry(&journal, "abcd1234", "mock-cli-1").await;

    let mut git =
        alice_trading_core::git::TradingGit::new(alice_trading_core::git::TradingGitConfig::stub());
    let first = reconcile_journal(&journal, &broker, &mut git, "idempotent", dir.path())
        .await
        .unwrap();
    assert_eq!(first.len(), 1);

    let second = reconcile_journal(&journal, &broker, &mut git, "idempotent", dir.path())
        .await
        .unwrap();
    assert!(
        second.is_empty(),
        "second reconcile run should find no pending entries"
    );
}
