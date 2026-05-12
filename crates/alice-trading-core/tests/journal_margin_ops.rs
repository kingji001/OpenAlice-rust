//! P7 — journal round-trip and serde tests for the three new margin-trading
//! Operation variants: Borrow, Repay, TransferFunding.
//!
//! Lifecycle (5-step recipe) tests against MockBroker are deferred to P8 once
//! BinanceMarginBroker implements the real borrow/repay/transfer dispatch. For
//! now we verify:
//!   1. Each variant serializes to the expected JSON shape (tagged `"action"`).
//!   2. Round-trip: serialize → deserialize produces the original value.
//!   3. `client_order_id` is omitted from JSON when `None` and present when `Some`.
//!   4. `action_name()` returns the correct string for each variant.
//!   5. ExecutionJournal persists and restores an intent containing each variant.

use alice_trading_core::journal::{EntryState, ExecutionIntent, ExecutionJournal};
use alice_trading_core::types::Operation;
use serde_json::json;
use tempfile::TempDir;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

fn borrow_op(cli_id: Option<&str>) -> Operation {
    Operation::Borrow {
        asset: "USDT".to_string(),
        amount: "1000".to_string(),
        client_order_id: cli_id.map(str::to_string),
    }
}

fn repay_op(cli_id: Option<&str>) -> Operation {
    Operation::Repay {
        asset: "USDT".to_string(),
        amount: "500".to_string(),
        client_order_id: cli_id.map(str::to_string),
    }
}

fn transfer_op(cli_id: Option<&str>) -> Operation {
    Operation::TransferFunding {
        transfer_type: "SPOT_TO_CROSS_MARGIN".to_string(),
        asset: "BTC".to_string(),
        amount: "0.1".to_string(),
        client_order_id: cli_id.map(str::to_string),
    }
}

fn make_intent(hash: &str, op: Operation) -> ExecutionIntent {
    ExecutionIntent {
        commit_hash: hash.to_string(),
        client_order_ids: vec!["cli-1".to_string()],
        operations: vec![op],
        started_at: "2026-05-13T00:00:00.000Z".to_string(),
        broker_id: "binance-margin".to_string(),
    }
}

// ──────────────────────────────────────────────
// Serde shape tests
// ──────────────────────────────────────────────

#[test]
fn borrow_serializes_with_action_tag() {
    let op = borrow_op(Some("cli-1"));
    let v = serde_json::to_value(&op).unwrap();
    assert_eq!(v["action"], "borrow");
    assert_eq!(v["asset"], "USDT");
    assert_eq!(v["amount"], "1000");
    assert_eq!(v["clientOrderId"], "cli-1");
}

#[test]
fn borrow_client_order_id_omitted_when_none() {
    let op = borrow_op(None);
    let v = serde_json::to_value(&op).unwrap();
    assert_eq!(v["action"], "borrow");
    assert!(!v.as_object().unwrap().contains_key("clientOrderId"));
}

#[test]
fn borrow_roundtrip() {
    let op = borrow_op(Some("cli-42"));
    let json = serde_json::to_string(&op).unwrap();
    let decoded: Operation = serde_json::from_str(&json).unwrap();
    assert_eq!(op, decoded);
}

#[test]
fn repay_serializes_with_action_tag() {
    let op = repay_op(Some("cli-2"));
    let v = serde_json::to_value(&op).unwrap();
    assert_eq!(v["action"], "repay");
    assert_eq!(v["asset"], "USDT");
    assert_eq!(v["amount"], "500");
    assert_eq!(v["clientOrderId"], "cli-2");
}

#[test]
fn repay_client_order_id_omitted_when_none() {
    let op = repay_op(None);
    let v = serde_json::to_value(&op).unwrap();
    assert!(!v.as_object().unwrap().contains_key("clientOrderId"));
}

#[test]
fn repay_roundtrip() {
    let op = repay_op(Some("cli-99"));
    let json = serde_json::to_string(&op).unwrap();
    let decoded: Operation = serde_json::from_str(&json).unwrap();
    assert_eq!(op, decoded);
}

#[test]
fn transfer_funding_serializes_with_action_tag() {
    let op = transfer_op(Some("cli-3"));
    let v = serde_json::to_value(&op).unwrap();
    assert_eq!(v["action"], "transferFunding");
    assert_eq!(v["transferType"], "SPOT_TO_CROSS_MARGIN");
    assert_eq!(v["asset"], "BTC");
    assert_eq!(v["amount"], "0.1");
    assert_eq!(v["clientOrderId"], "cli-3");
}

#[test]
fn transfer_funding_client_order_id_omitted_when_none() {
    let op = transfer_op(None);
    let v = serde_json::to_value(&op).unwrap();
    assert!(!v.as_object().unwrap().contains_key("clientOrderId"));
}

#[test]
fn transfer_funding_roundtrip() {
    let op = transfer_op(Some("cli-7"));
    let json = serde_json::to_string(&op).unwrap();
    let decoded: Operation = serde_json::from_str(&json).unwrap();
    assert_eq!(op, decoded);
}

#[test]
fn borrow_deserialize_from_json() {
    let v = json!({
        "action": "borrow",
        "asset": "USDT",
        "amount": "1000",
        "clientOrderId": "cli-abc"
    });
    let op: Operation = serde_json::from_value(v).unwrap();
    assert_eq!(op, borrow_op(Some("cli-abc")));
}

#[test]
fn repay_deserialize_from_json() {
    let v = json!({
        "action": "repay",
        "asset": "USDT",
        "amount": "500",
        "clientOrderId": "cli-def"
    });
    let op: Operation = serde_json::from_value(v).unwrap();
    assert_eq!(
        op,
        Operation::Repay {
            asset: "USDT".to_string(),
            amount: "500".to_string(),
            client_order_id: Some("cli-def".to_string()),
        }
    );
}

#[test]
fn transfer_funding_deserialize_from_json() {
    let v = json!({
        "action": "transferFunding",
        "transferType": "CROSS_MARGIN_TO_SPOT",
        "asset": "ETH",
        "amount": "2.5",
    });
    let op: Operation = serde_json::from_value(v).unwrap();
    assert_eq!(
        op,
        Operation::TransferFunding {
            transfer_type: "CROSS_MARGIN_TO_SPOT".to_string(),
            asset: "ETH".to_string(),
            amount: "2.5".to_string(),
            client_order_id: None,
        }
    );
}

// ──────────────────────────────────────────────
// action_name() tests
// ──────────────────────────────────────────────

#[test]
fn borrow_action_name() {
    assert_eq!(borrow_op(None).action_name(), "borrow");
}

#[test]
fn repay_action_name() {
    assert_eq!(repay_op(None).action_name(), "repay");
}

#[test]
fn transfer_funding_action_name() {
    assert_eq!(transfer_op(None).action_name(), "transferFunding");
}

// ──────────────────────────────────────────────
// Journal persistence tests
// ──────────────────────────────────────────────

#[tokio::test]
async fn journal_records_borrow_intent() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("margin-borrow", dir.path());
    let intent = make_intent("borrow1111", borrow_op(Some("cli-1")));
    let handle = journal.record_intent(intent.clone()).await.unwrap();
    assert_eq!(handle.commit_hash, "borrow1111");

    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, EntryState::Executing);
    assert_eq!(pending[0].intent.operations.len(), 1);
    // Verify round-trip preserves the operation correctly
    assert_eq!(pending[0].intent.operations[0], borrow_op(Some("cli-1")));
}

#[tokio::test]
async fn journal_records_repay_intent() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("margin-repay", dir.path());
    let intent = make_intent("repay2222", repay_op(Some("cli-2")));
    let handle = journal.record_intent(intent.clone()).await.unwrap();
    assert_eq!(handle.commit_hash, "repay2222");

    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, EntryState::Executing);
    assert_eq!(pending[0].intent.operations[0], repay_op(Some("cli-2")));
}

#[tokio::test]
async fn journal_records_transfer_funding_intent() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("margin-transfer", dir.path());
    let intent = make_intent("transfer3333", transfer_op(Some("cli-3")));
    let handle = journal.record_intent(intent.clone()).await.unwrap();
    assert_eq!(handle.commit_hash, "transfer3333");

    let pending = journal.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, EntryState::Executing);
    assert_eq!(pending[0].intent.operations[0], transfer_op(Some("cli-3")));
}

#[tokio::test]
async fn journal_borrow_intent_survives_disk_round_trip() {
    let dir = TempDir::new().unwrap();
    let journal = ExecutionJournal::new("margin-rt", dir.path());
    let op = borrow_op(Some("cli-rt-1"));
    let intent = make_intent("borrow-rt-1111", op.clone());
    journal.record_intent(intent).await.unwrap();

    // Re-open: create a new ExecutionJournal pointing at the same dir,
    // simulating a process restart.
    let journal2 = ExecutionJournal::new("margin-rt", dir.path());
    let pending = journal2.list_pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].intent.commit_hash, "borrow-rt-1111");
    assert_eq!(pending[0].intent.operations[0], op);
}
