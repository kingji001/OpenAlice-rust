//! MaxPositionSizeGuard — rejects placeOrder ops whose projected position
//! value exceeds maxPercentOfEquity of net liquidation.

use std::collections::HashMap;
use std::str::FromStr;

use async_trait::async_trait;
use bigdecimal::{BigDecimal, ToPrimitive};
use serde::Deserialize;
use serde_json::Value;

use crate::guards::traits::{Guard, GuardContext};

const DEFAULT_MAX_PERCENT: f64 = 25.0;
const UNSET_DECIMAL_STR: &str = "170141183460469231731687303715884105727";

#[derive(Debug, Deserialize)]
struct MaxPositionSizeOptions {
    #[serde(
        rename = "maxPercentOfEquity",
        alias = "max_percent_of_equity",
        default = "default_max_percent"
    )]
    max_percent_of_equity: f64,
    #[serde(flatten)]
    extras: HashMap<String, Value>,
}

fn default_max_percent() -> f64 {
    DEFAULT_MAX_PERCENT
}

pub struct MaxPositionSizeGuard {
    max_percent: BigDecimal,
}

impl MaxPositionSizeGuard {
    pub fn from_options(opts: &Value) -> Result<Self, serde_json::Error> {
        let parsed: MaxPositionSizeOptions = if opts.is_null() {
            serde_json::from_value(serde_json::json!({}))?
        } else {
            serde_json::from_value(opts.clone())?
        };
        for key in parsed.extras.keys() {
            tracing::warn!(target: "guards", guard = "max-position-size", key = %key, "unknown config field");
        }
        Ok(Self {
            max_percent: BigDecimal::from_str(&parsed.max_percent_of_equity.to_string()).unwrap(),
        })
    }
}

#[async_trait]
impl Guard for MaxPositionSizeGuard {
    fn name(&self) -> &str {
        "max-position-size"
    }

    async fn check(&mut self, ctx: &GuardContext<'_>) -> Option<String> {
        let action = ctx.operation.get("action").and_then(|v| v.as_str())?;
        if action != "placeOrder" {
            return None;
        }

        let contract = ctx.operation.get("contract")?;
        let order = ctx.operation.get("order")?;
        let symbol = contract.get("symbol").and_then(|v| v.as_str())?;

        let existing = ctx
            .positions
            .iter()
            .find(|p| p.contract.get("symbol").and_then(|v| v.as_str()) == Some(symbol));

        let current_value = existing
            .map(|p| BigDecimal::from_str(&p.market_value).unwrap_or_default())
            .unwrap_or_else(|| BigDecimal::from(0));

        let cash_qty = parse_decimal_field(order, "cashQty");
        let total_qty = parse_decimal_field(order, "totalQuantity");

        let added_value = if let Some(cq) = &cash_qty {
            if cq > &BigDecimal::from(0) {
                cq.clone()
            } else {
                BigDecimal::from(0)
            }
        } else if let (Some(q), Some(p)) = (total_qty.as_ref(), existing) {
            let market_price = BigDecimal::from_str(&p.market_price).unwrap_or_default();
            q * &market_price
        } else {
            BigDecimal::from(0)
        };

        if added_value == 0 {
            return None;
        }

        let projected = &current_value + &added_value;
        let net_liq = BigDecimal::from_str(&ctx.account.net_liquidation).unwrap_or_default();
        if net_liq <= 0 {
            return None;
        }

        let percent = &projected / &net_liq * BigDecimal::from(100);
        if percent > self.max_percent {
            return Some(format!(
                "Position for {} would be {}% of equity (limit: {}%)",
                symbol,
                format_percent(&percent),
                self.max_percent,
            ));
        }
        None
    }
}

/// Parse a Decimal-string field, filtering UNSET_DECIMAL sentinel.
/// TS stores Decimal fields as strings ("100.5") or as the sentinel
/// "170141183460469231731687303715884105727" (UNSET_DECIMAL = 2^127-1).
fn parse_decimal_field(order: &Value, key: &str) -> Option<BigDecimal> {
    let v = order.get(key)?;
    let s = v.as_str()?;
    let bd = BigDecimal::from_str(s).ok()?;
    let unset = BigDecimal::from_str(UNSET_DECIMAL_STR).unwrap();
    if bd == unset {
        None
    } else {
        Some(bd)
    }
}

/// Mirror TS `percent.toFixed(1)`. Uses f64 conversion which matches
/// JS Number's round-half-to-even behavior in the common range.
fn format_percent(bd: &BigDecimal) -> String {
    format!("{:.1}", bd.to_f64().unwrap_or(0.0))
}
