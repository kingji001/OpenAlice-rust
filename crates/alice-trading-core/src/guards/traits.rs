//! Guard trait + GuardContext.
//!
//! Mirrors src/domain/trading/guards/types.ts. Operation is a
//! &serde_json::Value passthrough per v4 §6.2 (broker-shape inputs
//! are rehydrated in the TS proxy layer, not in Rust).

use crate::brokers::types::{AccountInfo, Position};
use async_trait::async_trait;
use serde_json::Value;

pub struct GuardContext<'a> {
    pub operation: &'a Value,
    pub positions: &'a [Position],
    pub account: &'a AccountInfo,
}

#[async_trait]
pub trait Guard: Send {
    fn name(&self) -> &str;
    /// Returns Some(reason) to reject, None to allow.
    async fn check(&mut self, ctx: &GuardContext<'_>) -> Option<String>;
}
