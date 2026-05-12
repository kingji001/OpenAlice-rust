//! Phase 4e Task A — ExecutionJournal lifecycle tests.

use alice_trading_core::journal::{
    EntryState, ExecutionIntent, ExecutionJournal, ExecutionResult, JournalHandle,
};
use alice_trading_core::types::{Operation, OperationResult, OperationStatus};
use serde_json::json;
use tempfile::TempDir;

fn fake_intent(hash: &str) -> ExecutionIntent {
    let op: Operation = serde_json::from_value(json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD"},
        "order": {"action": "BUY", "orderType": "MKT", "totalQuantity": "10"},
    })).unwrap();
    ExecutionIntent {
        commit_hash: hash.to_string(),
        client_order_ids: vec!["cli-1".to_string()],
        operations: vec![op],
        started_at: "2026-01-01T00:00:00.000Z".to_string(),
        broker_id: "mock-paper".to_string(),
    }
}

fn fake_result(hash: &str, success: bool) -> ExecutionResult {
    ExecutionResult {
        commit_hash: hash.to_string(),
        completed_at: "2026-01-01T00:00:01.000Z".to_string(),
        results: vec![OperationResult {
            action: "placeOrder".to_string(),
            success,
            order_id: if success {
                Some("mock-1".to_string())
            } else {
                None
            },
            status: if success {
                OperationStatus::Submitted
            } else {
                OperationStatus::Rejected
            },
            execution: None,
            order_state: None,
            filled_qty: None,
            filled_price: None,
            error: if success {
                None
            } else {
                Some("test fail".to_string())
            },
            raw: None,
        }],
        success,
    }
}

#[tokio::test]
async fn record_intent_creates_executing_entry() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-1", dir.path());
    let handle = journal
        .record_intent(fake_intent("aaaa1111"))
        .await
        .unwrap();
    assert_eq!(handle.commit_hash, "aaaa1111");
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, EntryState::Executing);
    assert!(pending[0].result.is_none());
}

#[tokio::test]
async fn record_completion_transitions_state() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-2", dir.path());
    let handle = journal
        .record_intent(fake_intent("bbbb2222"))
        .await
        .unwrap();
    journal
        .record_completion(&handle, fake_result("bbbb2222", true))
        .await
        .unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending[0].state, EntryState::Completed);
    assert!(pending[0].result.is_some());
}

#[tokio::test]
async fn record_completion_failed_for_unsuccessful_result() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-3", dir.path());
    let handle = journal
        .record_intent(fake_intent("cccc3333"))
        .await
        .unwrap();
    journal
        .record_completion(&handle, fake_result("cccc3333", false))
        .await
        .unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending[0].state, EntryState::Failed);
}

#[tokio::test]
async fn close_moves_entry_to_done() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-4", dir.path());
    let handle = journal
        .record_intent(fake_intent("dddd4444"))
        .await
        .unwrap();
    journal
        .record_completion(&handle, fake_result("dddd4444", true))
        .await
        .unwrap();
    let handle_for_close = JournalHandle {
        commit_hash: "dddd4444".to_string(),
    };
    journal.close(handle_for_close).await.unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert!(pending.is_empty());

    // Verify the file moved to done/
    let done_file = dir
        .path()
        .join("trading/acct-4/executing/done/dddd4444.json");
    assert!(done_file.exists());
}

#[tokio::test]
async fn list_pending_skips_done_subdir() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-5", dir.path());
    // Create two entries, close one
    let h1 = journal
        .record_intent(fake_intent("e1e1e1e1"))
        .await
        .unwrap();
    let h2 = journal
        .record_intent(fake_intent("e2e2e2e2"))
        .await
        .unwrap();
    journal
        .record_completion(&h1, fake_result("e1e1e1e1", true))
        .await
        .unwrap();
    journal
        .close(JournalHandle {
            commit_hash: h1.commit_hash,
        })
        .await
        .unwrap();
    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].intent.commit_hash, h2.commit_hash);
}

#[tokio::test]
async fn atomic_write_leaves_no_tmp_files() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-6", dir.path());
    journal
        .record_intent(fake_intent("f1f1f1f1"))
        .await
        .unwrap();

    let exec_dir = dir.path().join("trading/acct-6/executing");
    let names: Vec<String> = std::fs::read_dir(&exec_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["f1f1f1f1.json".to_string()]);
}

#[tokio::test]
async fn list_pending_returns_empty_when_no_dir() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("acct-empty", dir.path());
    let pending = journal.list_pending().await.unwrap();
    assert!(pending.is_empty());
}
