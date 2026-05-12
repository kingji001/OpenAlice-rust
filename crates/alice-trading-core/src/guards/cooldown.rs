//! CooldownGuard — rejects placeOrder ops within minIntervalMs of the last trade
//! for the same symbol.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

use crate::guards::traits::{Guard, GuardContext};
use crate::guards::util::get_operation_symbol;

const DEFAULT_MIN_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Deserialize)]
struct CooldownOptions {
    #[serde(
        rename = "minIntervalMs",
        alias = "min_interval_ms",
        default = "default_min_interval"
    )]
    min_interval_ms: u64,
    #[serde(flatten)]
    extras: HashMap<String, Value>,
}

fn default_min_interval() -> u64 {
    DEFAULT_MIN_INTERVAL_MS
}

pub struct CooldownGuard {
    min_interval: Duration,
    last_trade_time: HashMap<String, Instant>,
}

impl CooldownGuard {
    pub fn from_options(opts: &Value) -> Result<Self, serde_json::Error> {
        let parsed: CooldownOptions = if opts.is_null() {
            serde_json::from_value(serde_json::json!({}))?
        } else {
            serde_json::from_value(opts.clone())?
        };
        for key in parsed.extras.keys() {
            tracing::warn!(target: "guards", guard = "cooldown", key = %key, "unknown config field");
        }
        Ok(Self {
            min_interval: Duration::from_millis(parsed.min_interval_ms),
            last_trade_time: HashMap::new(),
        })
    }
}

#[async_trait]
impl Guard for CooldownGuard {
    fn name(&self) -> &str {
        "cooldown"
    }

    async fn check(&mut self, ctx: &GuardContext<'_>) -> Option<String> {
        let action = ctx.operation.get("action").and_then(|v| v.as_str())?;
        if action != "placeOrder" {
            return None;
        }

        let symbol = get_operation_symbol(ctx.operation);
        let now = Instant::now();

        if let Some(&last) = self.last_trade_time.get(&symbol) {
            let elapsed = now.saturating_duration_since(last);
            if elapsed < self.min_interval {
                let remaining_ms = self.min_interval.as_millis() - elapsed.as_millis();
                // Match TS: Math.ceil((minIntervalMs - elapsed) / 1000)
                let remaining_secs = remaining_ms.div_ceil(1000);
                return Some(format!(
                    "Cooldown active for {}: {}s remaining",
                    symbol, remaining_secs
                ));
            }
        }

        self.last_trade_time.insert(symbol, now);
        None
    }
}
