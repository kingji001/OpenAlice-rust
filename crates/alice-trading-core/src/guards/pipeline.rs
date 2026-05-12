//! Guard pipeline factory.
//!
//! Mirrors TS createGuardPipeline at guard-pipeline.ts:13-37.
//! Pre-fetch is per-op (NOT per-push) — same as TS. v4 §4c
//! mandates this; optimizing to per-push would silently change
//! semantics for guards depending on intra-push position changes.

use crate::brokers::error::BrokerError;
use crate::brokers::traits::Broker;
use crate::guards::traits::{Guard, GuardContext};
use futures::future::BoxFuture;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

pub type Dispatcher =
    Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, BrokerError>> + Send + Sync>;

pub type Pipeline =
    Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, BrokerError>> + Send + Sync>;

/// Build a pipeline that runs the given guards before invoking dispatcher.
/// Pre-fetch ([positions, account]) happens INSIDE the per-op closure.
pub fn create_guard_pipeline(
    dispatcher: Dispatcher,
    broker: Arc<dyn Broker>,
    guards: Vec<Box<dyn Guard>>,
) -> Pipeline {
    if guards.is_empty() {
        return dispatcher;
    }

    let guards = Arc::new(Mutex::new(guards));
    Arc::new(move |op: Value| {
        let dispatcher = dispatcher.clone();
        let broker = broker.clone();
        let guards = guards.clone();
        Box::pin(async move {
            // PER-OP pre-fetch. v4 §4c: do not optimize to per-push.
            let (positions, account) =
                tokio::try_join!(broker.get_positions(), broker.get_account())?;

            let mut guards = guards.lock().await;
            for guard in guards.iter_mut() {
                let ctx = GuardContext {
                    operation: &op,
                    positions: &positions,
                    account: &account,
                };
                if let Some(reason) = guard.check(&ctx).await {
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": format!("[guard:{}] {}", guard.name(), reason),
                    }));
                }
            }
            drop(guards);
            dispatcher(op).await
        })
    })
}
