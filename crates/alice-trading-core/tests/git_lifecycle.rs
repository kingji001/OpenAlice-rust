//! End-to-end TradingGit lifecycle + invariant tests.

use alice_trading_core::git::{TradingGit, TradingGitConfig};
use alice_trading_core::types::*;
use serde_json::json;

fn buy_op() -> Operation {
    Operation::PlaceOrder {
        contract: json!({
            "symbol": "AAPL",
            "secType": "STK",
            "exchange": "SMART",
            "currency": "USD",
            "conId": 0,
            "strike": f64::MAX,
        }),
        order: json!({
            "action": "BUY",
            "orderType": "MKT",
            "totalQuantity": "10",
            "lmtPrice": "1.70141183460469231731687303715884105727e+38",
            "auxPrice": "1.70141183460469231731687303715884105727e+38",
            "orderId": 0,
        }),
        tpsl: None,
    }
}

#[test]
fn add_commit_push_lifecycle() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    let prep = git.commit("test commit".to_string()).unwrap();
    assert_eq!(prep.hash.len(), 8);
    assert!(prep.prepared);
    assert_eq!(prep.operation_count, 1);
    let push = git.push().unwrap();
    assert_eq!(push.operation_count, 1);
    assert_eq!(push.submitted.len(), 1);
    assert_eq!(push.rejected.len(), 0);

    let log = git.log(None);
    assert_eq!(log.len(), 1);
    let commit = git.show(&log[0].hash).unwrap();
    assert_eq!(commit.hash_version, Some(2));
    assert!(commit.intent_full_hash.is_some());
    assert!(commit.hash_input_timestamp.is_some());
    // INVARIANT 2: timestamp == hash_input_timestamp for v2.
    assert_eq!(
        commit.timestamp,
        commit.hash_input_timestamp.clone().unwrap()
    );
}

#[test]
fn v1_fallback_emits_no_v2_fields() {
    let mut config = TradingGitConfig::stub();
    config.hash_version = 1;
    let mut git = TradingGit::new(config);
    let _ = git.add(buy_op());
    git.commit("v1 test".to_string()).unwrap();
    git.push().unwrap();
    let log = git.log(None);
    let commit = git.show(&log[0].hash).unwrap();
    // INVARIANT 1: v1 commits MUST have NO hashVersion field.
    assert_eq!(commit.hash_version, None);
    assert_eq!(commit.intent_full_hash, None);
    assert_eq!(commit.hash_input_timestamp, None);

    // Confirm absence in serialized JSON, not just None in Rust.
    let json = serde_json::to_value(&commit).unwrap();
    assert!(json.get("hashVersion").is_none());
    assert!(json.get("intentFullHash").is_none());
    assert!(json.get("hashInputTimestamp").is_none());
}

#[test]
fn pending_v2_cleared_after_push() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    git.commit("first".to_string()).unwrap();
    git.push().unwrap();
    // INVARIANT 3: status should show no pending state.
    let status = git.status();
    assert_eq!(status.pending_hash, None);
    assert_eq!(status.pending_message, None);
    assert!(status.staged.is_empty());
    assert_eq!(status.commit_count, 1);
}

#[test]
fn pending_v2_cleared_after_reject() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    git.commit("first".to_string()).unwrap();
    git.reject(Some("nope".to_string())).unwrap();
    // INVARIANT 3: status should show no pending state after reject.
    let status = git.status();
    assert_eq!(status.pending_hash, None);
    assert_eq!(status.pending_message, None);
    assert!(status.staged.is_empty());
    assert_eq!(status.commit_count, 1);
}

#[test]
fn reject_recomputes_v2_hash_with_rejected_message() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    git.commit("original".to_string()).unwrap();
    let prep_hash = git.status().pending_hash.clone().unwrap();
    let reject = git.reject(Some("test reason".to_string())).unwrap();
    // INVARIANT 5: hash MUST differ from pending_hash because the message
    // is now "[rejected] original — test reason".
    assert_ne!(reject.hash, prep_hash);
    let commit = git.show(&reject.hash).unwrap();
    assert!(commit.message.starts_with("[rejected] original"));
    assert!(commit.message.contains("test reason"));
    // The persisted hash must verify against the persisted message.
    assert_eq!(commit.hash_version, Some(2));
    let intent = commit.intent_full_hash.as_ref().unwrap();
    assert!(intent.starts_with(&commit.hash));
}

#[test]
fn reject_without_reason_uses_default_message() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    git.commit("original".to_string()).unwrap();
    let r = git.reject(None).unwrap();
    let commit = git.show(&r.hash).unwrap();
    assert_eq!(commit.message, "[rejected] original");
}

#[test]
fn sync_does_not_touch_pending_v2() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    git.commit("pending".to_string()).unwrap();
    let pending_before = git.status().pending_hash.clone();
    let pending_msg_before = git.status().pending_message.clone();
    let staged_before = git.status().staged.len();

    let stub_state = (TradingGitConfig::stub().get_git_state)();
    git.sync(
        vec![OrderStatusUpdate {
            order_id: "x".to_string(),
            symbol: "AAPL".to_string(),
            previous_status: OperationStatus::Submitted,
            current_status: OperationStatus::Filled,
            filled_price: Some("100".to_string()),
            filled_qty: Some("10".to_string()),
        }],
        stub_state,
    )
    .unwrap();

    // INVARIANT 4: pending state unchanged.
    assert_eq!(git.status().pending_hash, pending_before);
    assert_eq!(git.status().pending_message, pending_msg_before);
    assert_eq!(git.status().staged.len(), staged_before);
}

#[test]
fn sync_with_empty_updates_returns_head() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let r = git
        .sync(vec![], (TradingGitConfig::stub().get_git_state)())
        .unwrap();
    assert_eq!(r.hash, "");
    assert_eq!(r.updated_count, 0);
}

#[test]
fn sync_v2_commit_has_v2_fields() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let stub_state = (TradingGitConfig::stub().get_git_state)();
    git.sync(
        vec![OrderStatusUpdate {
            order_id: "y".to_string(),
            symbol: "ETH".to_string(),
            previous_status: OperationStatus::Submitted,
            current_status: OperationStatus::Filled,
            filled_price: Some("3000".to_string()),
            filled_qty: Some("1".to_string()),
        }],
        stub_state,
    )
    .unwrap();

    let log = git.log(None);
    assert_eq!(log.len(), 1);
    let commit = git.show(&log[0].hash).unwrap();
    assert_eq!(commit.hash_version, Some(2));
    // INVARIANT 2: timestamp == hash_input_timestamp for v2 syncs too.
    assert_eq!(
        commit.timestamp,
        commit.hash_input_timestamp.clone().unwrap()
    );
}

#[test]
fn sync_v1_emits_no_v2_fields() {
    let mut config = TradingGitConfig::stub();
    config.hash_version = 1;
    let mut git = TradingGit::new(config);
    let stub_state = (TradingGitConfig::stub().get_git_state)();
    git.sync(
        vec![OrderStatusUpdate {
            order_id: "y".to_string(),
            symbol: "BTC".to_string(),
            previous_status: OperationStatus::Submitted,
            current_status: OperationStatus::Filled,
            filled_price: Some("60000".to_string()),
            filled_qty: Some("0.001".to_string()),
        }],
        stub_state,
    )
    .unwrap();

    let log = git.log(None);
    let commit = git.show(&log[0].hash).unwrap();
    // INVARIANT 1: v1 syncs have NO hashVersion field.
    assert_eq!(commit.hash_version, None);
    assert_eq!(commit.intent_full_hash, None);
    assert_eq!(commit.hash_input_timestamp, None);

    let json = serde_json::to_value(&commit).unwrap();
    assert!(json.get("hashVersion").is_none());
}

#[test]
fn add_increments_index() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let r1 = git.add(buy_op());
    let r2 = git.add(buy_op());
    assert_eq!(r1.index, 0);
    assert_eq!(r2.index, 1);
    assert_eq!(git.status().staged.len(), 2);
}

#[test]
fn commit_empty_staging_errors() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    assert!(git.commit("nope".to_string()).is_err());
}

#[test]
fn push_without_commit_errors() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    // staging non-empty but no commit → "please commit first"
    assert!(git.push().is_err());
}

#[test]
fn push_empty_staging_errors() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    assert!(git.push().is_err());
}

#[test]
fn export_then_restore_preserves_state() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    git.commit("first".to_string()).unwrap();
    git.push().unwrap();
    let exported = git.export_state();

    let restored = TradingGit::restore(exported.clone(), TradingGitConfig::stub());
    let restored_export = restored.export_state();
    assert_eq!(restored_export.commits.len(), exported.commits.len());
    assert_eq!(restored_export.head, exported.head);
}

#[test]
fn set_current_round_attaches_to_commits() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    git.set_current_round(42);
    let _ = git.add(buy_op());
    git.commit("round-42 commit".to_string()).unwrap();
    git.push().unwrap();
    let log = git.log(None);
    let commit = git.show(&log[0].hash).unwrap();
    assert_eq!(commit.round, Some(42));
}

#[test]
fn parent_hash_chains_across_commits() {
    let mut git = TradingGit::new(TradingGitConfig::stub());
    let _ = git.add(buy_op());
    git.commit("first".to_string()).unwrap();
    let push1 = git.push().unwrap();

    let _ = git.add(buy_op());
    git.commit("second".to_string()).unwrap();
    let push2 = git.push().unwrap();

    let c2 = git.show(&push2.hash).unwrap();
    assert_eq!(c2.parent_hash.as_deref(), Some(push1.hash.as_str()));
}
