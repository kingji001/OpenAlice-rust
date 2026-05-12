# Phase 4c — Rust Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 3 TS guards (`CooldownGuard`, `MaxPositionSizeGuard`, `SymbolWhitelistGuard`) + `createGuardPipeline` factory to Rust. Establish per-op pre-fetch parity (`[positions, account]` fetched inside the per-op closure, not once per push). 60+ scenario fixture corpus.

**Architecture:** New `crates/alice-trading-core/src/guards/` module. Pure Rust — no napi exposure (Phase 4d). `async_trait` for `dyn`-compat. CooldownGuard mutates internal `HashMap<String, Instant>` via `&mut self`; actor model serializes calls. Pipeline factory uses `Arc<Mutex<Vec<Box<dyn Guard>>>>` for closure capture. `Operation` is `&serde_json::Value` passthrough (Phase 3 §6.2 pattern).

**Tech Stack:** Rust 2021, `async_trait`, `bigdecimal`, `tokio`, `tracing`. `futures = "0.3"` added in Task C for `BoxFuture`.

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-4c-rust-guards-design.md`](../specs/2026-05-12-phase-4c-rust-guards-design.md) (commit `d864678`).

**4 sub-tasks, strictly sequential:** A → B → C → D.

---

## Pre-flight

- [ ] **Working tree clean**

```bash
git status --short                    # empty
git log -1 --oneline                  # confirm Phase 4c spec (d864678) is the latest
```

- [ ] **Baseline test counts**

```bash
pnpm test 2>&1 | grep -E "Tests" | tail -1               # 2241 baseline
source $HOME/.cargo/env
cargo test -p alice-trading-core 2>&1 | grep -E "test result" | head -1   # ~65 baseline
```

- [ ] **Confirm prior phases**

```bash
ls crates/alice-trading-core/src/brokers/   # Phase 4b — error.rs, mock.rs, mod.rs, traits.rs, types.rs
ls crates/alice-trading-core/src/guards/ 2>/dev/null   # NOT present yet — Task A creates it
```

---

## Task A: Guard trait + GuardContext + util.rs

**Goal:** Create the `guards/` submodule skeleton with the trait, context type, and the `get_operation_symbol` helper. Lib.rs wired up.

**Files:**
- Create: `crates/alice-trading-core/src/guards/mod.rs`
- Create: `crates/alice-trading-core/src/guards/traits.rs`
- Create: `crates/alice-trading-core/src/guards/util.rs`
- Modify: `crates/alice-trading-core/src/lib.rs` (add `pub mod guards;`)

### Step 1: Create `guards/traits.rs`

```rust
//! Guard trait + GuardContext.
//!
//! Mirrors src/domain/trading/guards/types.ts. Operation is a
//! &serde_json::Value passthrough per v4 §6.2 (broker-shape inputs
//! are rehydrated in the TS proxy layer, not in Rust).

use async_trait::async_trait;
use serde_json::Value;
use crate::brokers::types::{AccountInfo, Position};

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
```

### Step 2: Create `guards/util.rs` with get_operation_symbol

```rust
//! Helpers shared across guards.

use serde_json::Value;

/// Mirrors TS getOperationSymbol at src/domain/trading/git/types.ts:225-233.
/// For placeOrder/closePosition: contract.symbol → contract.aliceId → "unknown".
/// For modifyOrder/cancelOrder/syncOrders: always "unknown".
pub fn get_operation_symbol(op: &Value) -> String {
    let action = op.get("action").and_then(|v| v.as_str()).unwrap_or("unknown");
    match action {
        "placeOrder" | "closePosition" => {
            let contract = op.get("contract");
            contract
                .and_then(|c| c.get("symbol").and_then(|v| v.as_str()))
                .or_else(|| contract.and_then(|c| c.get("aliceId").and_then(|v| v.as_str())))
                .map(String::from)
                .unwrap_or_else(|| "unknown".into())
        }
        _ => "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn place_order_uses_symbol() {
        let op = json!({"action": "placeOrder", "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL"}});
        assert_eq!(get_operation_symbol(&op), "AAPL");
    }

    #[test]
    fn place_order_falls_back_to_alice_id_when_symbol_missing() {
        let op = json!({"action": "placeOrder", "contract": {"aliceId": "mock|BTC"}});
        assert_eq!(get_operation_symbol(&op), "mock|BTC");
    }

    #[test]
    fn place_order_unknown_when_both_missing() {
        let op = json!({"action": "placeOrder", "contract": {}});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }

    #[test]
    fn close_position_uses_symbol() {
        let op = json!({"action": "closePosition", "contract": {"symbol": "MSFT"}});
        assert_eq!(get_operation_symbol(&op), "MSFT");
    }

    #[test]
    fn modify_order_is_always_unknown() {
        let op = json!({"action": "modifyOrder", "orderId": "x", "changes": {}});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }

    #[test]
    fn cancel_order_is_always_unknown() {
        let op = json!({"action": "cancelOrder", "orderId": "x"});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }

    #[test]
    fn sync_orders_is_always_unknown() {
        let op = json!({"action": "syncOrders"});
        assert_eq!(get_operation_symbol(&op), "unknown");
    }
}
```

### Step 3: Create `guards/mod.rs` (skeleton — will grow in Tasks B+C)

```rust
//! Guard pipeline.
//!
//! Phase 4c deliverable. Pure Rust — napi exposure is Phase 4d.
//! Phase 4d's UtaActor will consume `Vec<Box<dyn Guard>>`.

pub mod traits;
pub mod util;

pub use traits::{Guard, GuardContext};
pub use util::get_operation_symbol;
```

### Step 4: Wire into lib.rs

Edit `crates/alice-trading-core/src/lib.rs`. Find the `pub mod` declarations (after `#![deny(clippy::all)]`). Add:

```rust
pub mod guards;
```

Place alphabetically with other modules.

### Step 5: Build + run util tests

```bash
source $HOME/.cargo/env
cargo build -p alice-trading-core 2>&1 | tail -3
cargo test -p alice-trading-core guards::util 2>&1 | tail -10
```

Expected: build clean; 7 util tests pass.

### Step 6: clippy + fmt sanity

```bash
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
```

Expected: clean.

### Step 7: Commit

```bash
git add crates/alice-trading-core/src/lib.rs crates/alice-trading-core/src/guards/
git commit -m "feat(rust): Guard trait + GuardContext + util scaffold (Phase 4c Task A)

New crates/alice-trading-core/src/guards/ module:
- traits.rs: async Guard trait via async_trait (Send-bound for dyn).
  &mut self on check() because CooldownGuard mutates internal state.
- util.rs: get_operation_symbol helper mirroring TS at
  src/domain/trading/git/types.ts:225-233 — placeOrder/closePosition
  use contract.symbol → aliceId → 'unknown'; all other actions
  unconditionally return 'unknown'.
- mod.rs: re-exports

7 util tests pass: 3 placeOrder paths, 1 closePosition, 3 unknown
paths (modifyOrder/cancelOrder/syncOrders).

Spec: docs/superpowers/specs/2026-05-12-phase-4c-rust-guards-design.md"
```

---

## Task B: 3 guard implementations

**Goal:** Port `CooldownGuard`, `MaxPositionSizeGuard`, `SymbolWhitelistGuard`. Each guard's `from_options` parses its config via serde with `#[serde(flatten)] extras: HashMap<String, Value>` + `tracing::warn!` per unknown field.

**Files:**
- Create: `crates/alice-trading-core/src/guards/cooldown.rs`
- Create: `crates/alice-trading-core/src/guards/max_position_size.rs`
- Create: `crates/alice-trading-core/src/guards/symbol_whitelist.rs`
- Create: `crates/alice-trading-core/tests/guards_unit.rs`
- Modify: `crates/alice-trading-core/src/guards/mod.rs` (add `pub mod ...` + re-exports)

### Step 1: Create `guards/cooldown.rs`

```rust
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
    #[serde(default = "default_min_interval", alias = "min_interval_ms")]
    min_interval_ms: u64,
    #[serde(flatten)]
    extras: HashMap<String, Value>,
}

fn default_min_interval() -> u64 { DEFAULT_MIN_INTERVAL_MS }

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
            tracing::warn!(target = "guards", guard = "cooldown", key = %key, "unknown config field");
        }
        Ok(Self {
            min_interval: Duration::from_millis(parsed.min_interval_ms),
            last_trade_time: HashMap::new(),
        })
    }
}

#[async_trait]
impl Guard for CooldownGuard {
    fn name(&self) -> &str { "cooldown" }

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
                let remaining_secs = (remaining_ms + 999) / 1000;
                return Some(format!("Cooldown active for {}: {}s remaining", symbol, remaining_secs));
            }
        }

        self.last_trade_time.insert(symbol, now);
        None
    }
}
```

NOTE: TS uses `options.minIntervalMs` (camelCase). serde camelCase default would produce `minIntervalMs` from `min_interval_ms`. We also add `alias = "min_interval_ms"` so both forms parse. The `default` ensures missing field uses 60_000.

NOTE: `(remaining_ms + 999) / 1000` is the integer-arithmetic `ceil`. TS uses `Math.ceil((interval - elapsed) / 1000)` where elapsed/interval are integers. Same semantics.

NOTE: serde rejects camelCase by default for snake_case fields. We need `#[serde(rename = "minIntervalMs", alias = "min_interval_ms")]` instead of the `default` approach. Let me fix:

```rust
#[derive(Debug, Deserialize)]
struct CooldownOptions {
    #[serde(rename = "minIntervalMs", alias = "min_interval_ms", default = "default_min_interval")]
    min_interval_ms: u64,
    #[serde(flatten)]
    extras: HashMap<String, Value>,
}
```

Use THIS version of `CooldownOptions` — `rename` for the primary camelCase form (matches TS), `alias` for snake_case backward-compat, `default` for missing.

### Step 2: Create `guards/max_position_size.rs`

```rust
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
    #[serde(rename = "maxPercentOfEquity", alias = "max_percent_of_equity", default = "default_max_percent")]
    max_percent_of_equity: f64,
    #[serde(flatten)]
    extras: HashMap<String, Value>,
}

fn default_max_percent() -> f64 { DEFAULT_MAX_PERCENT }

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
            tracing::warn!(target = "guards", guard = "max-position-size", key = %key, "unknown config field");
        }
        Ok(Self {
            max_percent: BigDecimal::from_str(&parsed.max_percent_of_equity.to_string()).unwrap(),
        })
    }
}

#[async_trait]
impl Guard for MaxPositionSizeGuard {
    fn name(&self) -> &str { "max-position-size" }

    async fn check(&mut self, ctx: &GuardContext<'_>) -> Option<String> {
        let action = ctx.operation.get("action").and_then(|v| v.as_str())?;
        if action != "placeOrder" {
            return None;
        }

        let contract = ctx.operation.get("contract")?;
        let order = ctx.operation.get("order")?;
        let symbol = contract.get("symbol").and_then(|v| v.as_str())?;

        let existing = ctx.positions.iter().find(|p| {
            p.contract.get("symbol").and_then(|v| v.as_str()) == Some(symbol)
        });

        let current_value = existing
            .map(|p| BigDecimal::from_str(&p.market_value).unwrap_or_default())
            .unwrap_or_else(|| BigDecimal::from(0));

        let cash_qty = parse_decimal_field(order, "cashQty");
        let total_qty = parse_decimal_field(order, "totalQuantity");

        let added_value = if let Some(cq) = &cash_qty {
            if cq > &BigDecimal::from(0) { cq.clone() } else { BigDecimal::from(0) }
        } else if let (Some(q), Some(p)) = (total_qty.as_ref(), existing) {
            let market_price = BigDecimal::from_str(&p.market_price).unwrap_or_default();
            q * &market_price
        } else {
            BigDecimal::from(0)
        };

        if added_value == BigDecimal::from(0) {
            return None;
        }

        let projected = &current_value + &added_value;
        let net_liq = BigDecimal::from_str(&ctx.account.net_liquidation).unwrap_or_default();
        if net_liq <= BigDecimal::from(0) {
            return None;
        }

        let percent = &projected / &net_liq * BigDecimal::from(100);
        if percent > self.max_percent {
            return Some(format!(
                "Position for {} would be {}% of equity (limit: {}%)",
                symbol,
                format_percent(&percent),
                format_percent(&self.max_percent),
            ));
        }
        None
    }
}

/// Parse a Decimal-string field, filtering UNSET_DECIMAL sentinel.
/// TS stores Decimal fields as strings ("100.5") or as the sentinel
/// "1.70141183460469231731687303715884105727e+38" (UNSET_DECIMAL).
fn parse_decimal_field(order: &Value, key: &str) -> Option<BigDecimal> {
    let v = order.get(key)?;
    let s = v.as_str()?;
    let bd = BigDecimal::from_str(s).ok()?;
    let unset = BigDecimal::from_str(UNSET_DECIMAL_STR).unwrap();
    if bd == unset { None } else { Some(bd) }
}

/// Mirror TS `percent.toFixed(1)`. Uses f64 conversion which matches
/// JS Number's round-half-to-even behavior in the common range.
fn format_percent(bd: &BigDecimal) -> String {
    format!("{:.1}", bd.to_f64().unwrap_or(0.0))
}
```

### Step 3: Create `guards/symbol_whitelist.rs`

```rust
//! SymbolWhitelistGuard — rejects ops whose symbol is not in the allowed set.
//! Symbols of "unknown" pass through unrejected (matches TS behavior).

use std::collections::{HashMap, HashSet};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use crate::guards::traits::{Guard, GuardContext};
use crate::guards::util::get_operation_symbol;

#[derive(Debug, Deserialize)]
struct SymbolWhitelistOptions {
    symbols: Vec<String>,
    #[serde(flatten)]
    extras: HashMap<String, Value>,
}

pub struct SymbolWhitelistGuard {
    allowed: HashSet<String>,
}

#[derive(Debug)]
pub struct SymbolWhitelistConfigError(pub String);

impl std::fmt::Display for SymbolWhitelistConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SymbolWhitelistConfigError {}

impl SymbolWhitelistGuard {
    pub fn from_options(opts: &Value) -> Result<Self, SymbolWhitelistConfigError> {
        let parsed: SymbolWhitelistOptions = serde_json::from_value(opts.clone())
            .map_err(|e| SymbolWhitelistConfigError(format!("symbol-whitelist: {}", e)))?;
        if parsed.symbols.is_empty() {
            return Err(SymbolWhitelistConfigError(
                "symbol-whitelist guard requires a non-empty \"symbols\" array in options".into()
            ));
        }
        for key in parsed.extras.keys() {
            tracing::warn!(target = "guards", guard = "symbol-whitelist", key = %key, "unknown config field");
        }
        Ok(Self { allowed: parsed.symbols.into_iter().collect() })
    }
}

#[async_trait]
impl Guard for SymbolWhitelistGuard {
    fn name(&self) -> &str { "symbol-whitelist" }

    async fn check(&mut self, ctx: &GuardContext<'_>) -> Option<String> {
        let symbol = get_operation_symbol(ctx.operation);
        if symbol == "unknown" {
            return None;
        }
        if !self.allowed.contains(&symbol) {
            return Some(format!("Symbol {} is not in the allowed list", symbol));
        }
        None
    }
}
```

### Step 4: Update mod.rs with re-exports

```rust
//! Guard pipeline.
//!
//! Phase 4c deliverable. Pure Rust — napi exposure is Phase 4d.
//! Phase 4d's UtaActor will consume `Vec<Box<dyn Guard>>`.

pub mod cooldown;
pub mod max_position_size;
pub mod symbol_whitelist;
pub mod traits;
pub mod util;

pub use cooldown::CooldownGuard;
pub use max_position_size::MaxPositionSizeGuard;
pub use symbol_whitelist::{SymbolWhitelistConfigError, SymbolWhitelistGuard};
pub use traits::{Guard, GuardContext};
pub use util::get_operation_symbol;
```

### Step 5: Build sanity

```bash
cargo build -p alice-trading-core 2>&1 | tail -3
```

Expected: clean.

### Step 6: Create `tests/guards_unit.rs` — per-guard tests

```rust
//! Per-guard unit tests with exact rejection-string parity to TS.

use alice_trading_core::brokers::types::{AccountInfo, Position, PositionSide};
use alice_trading_core::guards::{
    CooldownGuard, Guard, GuardContext, MaxPositionSizeGuard, SymbolWhitelistGuard,
};
use serde_json::json;

fn empty_positions() -> Vec<Position> { vec![] }

fn default_account() -> AccountInfo {
    AccountInfo {
        base_currency: "USD".into(),
        net_liquidation: "100000".into(),
        total_cash_value: "100000".into(),
        unrealized_pn_l: "0".into(),
        realized_pn_l: Some("0".into()),
        buying_power: None,
        init_margin_req: None,
        maint_margin_req: None,
        day_trades_remaining: None,
    }
}

fn position_for(symbol: &str, qty: &str, avg_cost: &str, market_value: &str, market_price: &str) -> Position {
    Position {
        contract: json!({"symbol": symbol, "aliceId": format!("mock|{}", symbol)}),
        currency: "USD".into(),
        side: PositionSide::Long,
        quantity: qty.into(),
        avg_cost: avg_cost.into(),
        market_price: market_price.into(),
        market_value: market_value.into(),
        unrealized_pn_l: "0".into(),
        realized_pn_l: "0".into(),
        multiplier: None,
    }
}

// ============================================================================
// CooldownGuard tests
// ============================================================================

#[tokio::test]
async fn cooldown_allows_non_place_order() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 100})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "modifyOrder", "orderId": "x", "changes": {}});
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn cooldown_allows_first_trade() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 60000})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn cooldown_rejects_within_interval() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 60000})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    let _ = g.check(&ctx).await;  // first call — allow + record
    let rejection = g.check(&ctx).await;
    assert!(rejection.is_some());
    let msg = rejection.unwrap();
    assert!(msg.starts_with("Cooldown active for AAPL: "), "got: {}", msg);
    assert!(msg.ends_with("s remaining"), "got: {}", msg);
}

#[tokio::test]
async fn cooldown_independent_per_symbol() {
    let mut g = CooldownGuard::from_options(&json!({"minIntervalMs": 60000})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op_aapl = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let op_msft = json!({"action": "placeOrder", "contract": {"symbol": "MSFT"}, "order": {}});
    let ctx_a = GuardContext { operation: &op_aapl, positions: &positions, account: &account };
    let ctx_m = GuardContext { operation: &op_msft, positions: &positions, account: &account };
    let _ = g.check(&ctx_a).await;
    // MSFT should still be allowed even after AAPL set its cooldown
    assert_eq!(g.check(&ctx_m).await, None);
}

#[tokio::test]
async fn cooldown_warns_on_unknown_field() {
    // Just confirm it doesn't error; tracing::warn output isn't asserted here.
    let g = CooldownGuard::from_options(&json!({"minIntervalMs": 100, "bogus": "field"}));
    assert!(g.is_ok());
}

// ============================================================================
// MaxPositionSizeGuard tests
// ============================================================================

#[tokio::test]
async fn max_position_size_allows_under_limit() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = vec![position_for("AAPL", "10", "100", "1000", "100")];
    let account = default_account();   // netLiq 100000, so 1000 → 1%
    let op = json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL"},
        "order": {"cashQty": "5000", "totalQuantity": "170141183460469231731687303715884105727"},  // cashQty=5000, totalQty=UNSET
    });
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    // existing 1000 + added 5000 = 6000; 6% of 100000 < 25%
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn max_position_size_rejects_over_limit() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = vec![position_for("AAPL", "10", "100", "20000", "100")];
    let account = default_account();
    let op = json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL"},
        "order": {"cashQty": "10000", "totalQuantity": "170141183460469231731687303715884105727"},
    });
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    // existing 20000 + added 10000 = 30000; 30% of 100000 > 25%
    let rejection = g.check(&ctx).await;
    assert!(rejection.is_some());
    let msg = rejection.unwrap();
    assert_eq!(
        msg,
        "Position for AAPL would be 30.0% of equity (limit: 25.0%)",
        "rejection string must match TS exact format",
    );
}

#[tokio::test]
async fn max_position_size_unset_decimal_does_not_count() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({
        "action": "placeOrder",
        "contract": {"symbol": "AAPL"},
        "order": {
            "cashQty": "170141183460469231731687303715884105727",   // UNSET
            "totalQuantity": "170141183460469231731687303715884105727",  // UNSET
        },
    });
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    // Both fields filtered → added_value = 0 → allow
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn max_position_size_non_place_order_allows() {
    let mut g = MaxPositionSizeGuard::from_options(&json!({"maxPercentOfEquity": 25})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "cancelOrder", "orderId": "x"});
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    assert_eq!(g.check(&ctx).await, None);
}

// ============================================================================
// SymbolWhitelistGuard tests
// ============================================================================

#[tokio::test]
async fn symbol_whitelist_allows_known() {
    let mut g = SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL", "MSFT"]})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}, "order": {}});
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn symbol_whitelist_rejects_unknown() {
    let mut g = SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "placeOrder", "contract": {"symbol": "GME"}, "order": {}});
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    let rejection = g.check(&ctx).await;
    assert_eq!(rejection.as_deref(), Some("Symbol GME is not in the allowed list"));
}

#[tokio::test]
async fn symbol_whitelist_unknown_symbol_passes() {
    let mut g = SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap();
    let positions = empty_positions();
    let account = default_account();
    let op = json!({"action": "cancelOrder", "orderId": "x"});  // symbol resolves to "unknown"
    let ctx = GuardContext { operation: &op, positions: &positions, account: &account };
    assert_eq!(g.check(&ctx).await, None);
}

#[tokio::test]
async fn symbol_whitelist_requires_non_empty() {
    let g = SymbolWhitelistGuard::from_options(&json!({"symbols": []}));
    assert!(g.is_err());
    let err = g.err().unwrap();
    assert!(err.to_string().contains("non-empty"), "got: {}", err);
}
```

### Step 7: Run unit tests

```bash
cargo test -p alice-trading-core --test guards_unit 2>&1 | tail -10
```

Expected: 12 tests pass (5 cooldown + 4 max-position + 4 symbol-whitelist). Actually 4 cooldown shown; let me recount: 5 cooldown + 4 max-pos + 4 symbol-whitelist = 13. The test count should match.

### Step 8: clippy + fmt + full suite

```bash
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
cargo test -p alice-trading-core 2>&1 | tail -5
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: clean; ~78+ cargo tests (65 baseline + 7 util + 13 guards_unit); 2241 TS unchanged.

### Step 9: Commit

```bash
git add crates/alice-trading-core/src/guards/ crates/alice-trading-core/tests/guards_unit.rs
git commit -m "feat(rust): 3 guards (cooldown, max-position-size, symbol-whitelist) (Phase 4c Task B)

- CooldownGuard: stateful HashMap<symbol, Instant>; mutates via
  &mut self. Rejection string format matches TS exactly:
  'Cooldown active for {symbol}: {n}s remaining' where n uses
  integer ceil division of milliseconds.
- MaxPositionSizeGuard: BigDecimal arithmetic for value/percent
  calculation. UNSET_DECIMAL (2^127-1) sentinel filter on cashQty
  and totalQuantity. format!('{:.1}') matches TS percent.toFixed(1).
- SymbolWhitelistGuard: HashSet<String>. 'unknown' symbol passes
  through (matches TS getOperationSymbol behavior). Empty symbols
  list at construction → error.

Every guard's from_options uses #[serde(flatten)] extras +
tracing::warn! on unknown fields (v4 §6.8 warn-only window).

13 unit tests pinning exact rejection-string parity to TS."
```

---

## Task C: Pipeline + registry + per-op pre-fetch test

**Goal:** Implement `create_guard_pipeline` factory with `Arc<Mutex<Vec<Box<dyn Guard>>>>` closure-capture pattern + `tokio::try_join!` per-op pre-fetch. Plus the load-bearing per-op pre-fetch test. Plus registry with warn-on-unknown-type.

**Files:**
- Create: `crates/alice-trading-core/src/guards/pipeline.rs`
- Create: `crates/alice-trading-core/src/guards/registry.rs`
- Create: `crates/alice-trading-core/tests/guard_pipeline_per_op_prefetch.rs`
- Modify: `crates/alice-trading-core/src/guards/mod.rs` (re-export pipeline + registry)
- Modify: `crates/alice-trading-core/Cargo.toml` (add `futures = "0.3"`)

### Step 1: Add `futures` dep

Edit `crates/alice-trading-core/Cargo.toml`. In `[dependencies]`:

```toml
futures = "0.3"
```

Run:

```bash
source $HOME/.cargo/env
cargo build -p alice-trading-core 2>&1 | tail -3
```

Expected: clean (futures already may be transitive; pinning explicit).

### Step 2: Create `guards/pipeline.rs`

```rust
//! Guard pipeline factory.
//!
//! Mirrors TS createGuardPipeline at guard-pipeline.ts:13-37.
//! Pre-fetch is per-op (NOT per-push) — same as TS. v4 §4c
//! mandates this; optimizing to per-push would silently change
//! semantics for guards depending on intra-push position changes.

use std::sync::Arc;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio::sync::Mutex;
use crate::brokers::error::BrokerError;
use crate::brokers::traits::Broker;
use crate::guards::traits::{Guard, GuardContext};

pub type Dispatcher = Arc<
    dyn Fn(Value) -> BoxFuture<'static, Result<Value, BrokerError>> + Send + Sync,
>;

pub type Pipeline = Arc<
    dyn Fn(Value) -> BoxFuture<'static, Result<Value, BrokerError>> + Send + Sync,
>;

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
```

### Step 3: Create `guards/registry.rs`

```rust
//! Guard registry — resolve named guard configs into Guard instances.
//!
//! Mirrors TS resolveGuards at src/domain/trading/guards/registry.ts.
//! Unknown guard types emit a warning and are skipped (matches TS
//! console.warn behavior).

use serde::Deserialize;
use serde_json::Value;
use crate::guards::cooldown::CooldownGuard;
use crate::guards::max_position_size::MaxPositionSizeGuard;
use crate::guards::symbol_whitelist::SymbolWhitelistGuard;
use crate::guards::traits::Guard;

#[derive(Debug, Deserialize)]
pub struct GuardConfig {
    #[serde(rename = "type")]
    pub guard_type: String,
    #[serde(default)]
    pub options: Value,
}

/// Resolve a list of GuardConfig entries into Guard instances.
/// Unknown guard types or config parse errors emit warnings and
/// are silently skipped (matches TS registry.ts behavior).
pub fn resolve_guards(configs: &[GuardConfig]) -> Vec<Box<dyn Guard>> {
    let mut out: Vec<Box<dyn Guard>> = Vec::new();
    for cfg in configs {
        match cfg.guard_type.as_str() {
            "cooldown" => match CooldownGuard::from_options(&cfg.options) {
                Ok(g) => out.push(Box::new(g)),
                Err(e) => tracing::warn!(
                    target = "guards", guard = "cooldown",
                    error = %e, "config parse failed; skipped",
                ),
            },
            "max-position-size" => match MaxPositionSizeGuard::from_options(&cfg.options) {
                Ok(g) => out.push(Box::new(g)),
                Err(e) => tracing::warn!(
                    target = "guards", guard = "max-position-size",
                    error = %e, "config parse failed; skipped",
                ),
            },
            "symbol-whitelist" => match SymbolWhitelistGuard::from_options(&cfg.options) {
                Ok(g) => out.push(Box::new(g)),
                Err(e) => tracing::warn!(
                    target = "guards", guard = "symbol-whitelist",
                    error = %e, "config parse failed; skipped",
                ),
            },
            other => {
                tracing::warn!(target = "guards", "unknown guard type \"{}\", skipped", other);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_three_builtin_types() {
        let configs: Vec<GuardConfig> = serde_json::from_value(json!([
            {"type": "cooldown", "options": {"minIntervalMs": 1000}},
            {"type": "max-position-size", "options": {"maxPercentOfEquity": 25}},
            {"type": "symbol-whitelist", "options": {"symbols": ["AAPL"]}},
        ])).unwrap();
        let guards = resolve_guards(&configs);
        assert_eq!(guards.len(), 3);
        assert_eq!(guards[0].name(), "cooldown");
        assert_eq!(guards[1].name(), "max-position-size");
        assert_eq!(guards[2].name(), "symbol-whitelist");
    }

    #[test]
    fn unknown_type_skipped_without_error() {
        let configs: Vec<GuardConfig> = serde_json::from_value(json!([
            {"type": "cooldown", "options": {"minIntervalMs": 1000}},
            {"type": "bogus-guard", "options": {}},
            {"type": "symbol-whitelist", "options": {"symbols": ["AAPL"]}},
        ])).unwrap();
        let guards = resolve_guards(&configs);
        assert_eq!(guards.len(), 2);   // cooldown + symbol-whitelist; bogus-guard skipped
    }

    #[test]
    fn invalid_config_skipped() {
        // symbol-whitelist requires non-empty symbols — invalid config
        let configs: Vec<GuardConfig> = serde_json::from_value(json!([
            {"type": "symbol-whitelist", "options": {"symbols": []}},
        ])).unwrap();
        let guards = resolve_guards(&configs);
        assert_eq!(guards.len(), 0);
    }
}
```

### Step 4: Update mod.rs

```rust
//! Guard pipeline.
//!
//! Phase 4c deliverable. Pure Rust — napi exposure is Phase 4d.
//! Phase 4d's UtaActor will consume `Vec<Box<dyn Guard>>`.

pub mod cooldown;
pub mod max_position_size;
pub mod pipeline;
pub mod registry;
pub mod symbol_whitelist;
pub mod traits;
pub mod util;

pub use cooldown::CooldownGuard;
pub use max_position_size::MaxPositionSizeGuard;
pub use pipeline::{create_guard_pipeline, Dispatcher, Pipeline};
pub use registry::{resolve_guards, GuardConfig};
pub use symbol_whitelist::{SymbolWhitelistConfigError, SymbolWhitelistGuard};
pub use traits::{Guard, GuardContext};
pub use util::get_operation_symbol;
```

### Step 5: Build sanity

```bash
cargo build -p alice-trading-core 2>&1 | tail -5
```

Expected: clean. If lifetime errors appear on the closure, the `Arc<Mutex<...>>` capture should resolve them — verify the cloned arcs are captured by `move`, then re-cloned inside the closure for each future.

### Step 6: Create the load-bearing per-op pre-fetch test

Create `crates/alice-trading-core/tests/guard_pipeline_per_op_prefetch.rs`:

```rust
//! Load-bearing parity assertion: pre-fetch must be PER-OP, not per-push.
//!
//! v4 §4c: "Do NOT optimize to per-push during the port — it would
//! silently change guard semantics if a guard depends on positions
//! changing between ops."
//!
//! Test: a 5-op push must call broker.getPositions() 5 times and
//! broker.getAccount() 5 times (NOT 1 each).

use std::sync::Arc;
use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::traits::Broker;
use alice_trading_core::guards::pipeline::Dispatcher;
use alice_trading_core::guards::{create_guard_pipeline, Guard, SymbolWhitelistGuard};
use serde_json::json;

#[tokio::test]
async fn pre_fetch_is_per_op_not_per_push() {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    broker.set_quote("AAPL", 100.0);

    let guards: Vec<Box<dyn Guard>> = vec![Box::new(
        SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap(),
    )];

    let dispatcher: Dispatcher = Arc::new(|_op| {
        Box::pin(async move { Ok(json!({"success": true})) })
    });

    let broker_for_pipeline: Arc<dyn Broker> = broker.clone();
    let pipeline = create_guard_pipeline(dispatcher, broker_for_pipeline, guards);

    // Simulate a 5-op push
    for _ in 0..5 {
        pipeline(json!({
            "action": "placeOrder",
            "contract": {"symbol": "AAPL"},
            "order": {},
        })).await.unwrap();
    }

    assert_eq!(
        broker.call_count("getPositions"), 5,
        "pre-fetch MUST be per-op (5 calls), not per-push (1 call). v4 §4c.",
    );
    assert_eq!(
        broker.call_count("getAccount"), 5,
        "pre-fetch MUST be per-op (5 calls), not per-push (1 call). v4 §4c.",
    );
}

#[tokio::test]
async fn pipeline_passes_through_when_no_guards() {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let dispatcher: Dispatcher = Arc::new(|_op| {
        Box::pin(async move { Ok(json!({"success": true, "from_dispatcher": true})) })
    });
    let broker_for_pipeline: Arc<dyn Broker> = broker.clone();
    let pipeline = create_guard_pipeline(dispatcher, broker_for_pipeline, vec![]);

    let result = pipeline(json!({"action": "placeOrder", "contract": {"symbol": "ZZZ"}, "order": {}}))
        .await
        .unwrap();
    assert_eq!(result.get("from_dispatcher"), Some(&json!(true)));

    // With no guards, broker should not be queried at all
    assert_eq!(broker.call_count("getPositions"), 0);
    assert_eq!(broker.call_count("getAccount"), 0);
}

#[tokio::test]
async fn pipeline_rejection_format_matches_ts() {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    let dispatcher: Dispatcher = Arc::new(|_op| {
        Box::pin(async move { Ok(json!({"success": true})) })
    });
    let broker_for_pipeline: Arc<dyn Broker> = broker.clone();
    let guards: Vec<Box<dyn Guard>> = vec![Box::new(
        SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap(),
    )];
    let pipeline = create_guard_pipeline(dispatcher, broker_for_pipeline, guards);

    let result = pipeline(json!({
        "action": "placeOrder",
        "contract": {"symbol": "GME"},
        "order": {},
    })).await.unwrap();

    // Rejection envelope matches TS: { success: false, error: "[guard:name] reason" }
    assert_eq!(result.get("success"), Some(&json!(false)));
    let err = result.get("error").and_then(|v| v.as_str()).unwrap();
    assert!(err.starts_with("[guard:symbol-whitelist]"), "got: {}", err);
    assert!(err.contains("Symbol GME is not in the allowed list"), "got: {}", err);
}
```

### Step 7: Run the pre-fetch test

```bash
cargo test -p alice-trading-core --test guard_pipeline_per_op_prefetch 2>&1 | tail -10
```

Expected: 3 tests pass.

**If `pre_fetch_is_per_op_not_per_push` fails**: the pipeline closure pulled the `tokio::try_join!` outside the per-op `Box::pin(async move { ... })`. The `try_join!` MUST be inside the future returned for each op. Diagnosis: print `broker.call_count("getPositions")` after each pipeline call — it should be 1, 2, 3, 4, 5. If it's 1 after all 5 calls, the pre-fetch was hoisted.

### Step 8: Run all guards tests + clippy + fmt

```bash
cargo test -p alice-trading-core guards 2>&1 | tail -5
cargo test -p alice-trading-core --test guards_unit 2>&1 | tail -3
cargo test -p alice-trading-core --test guard_pipeline_per_op_prefetch 2>&1 | tail -3
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
pnpm test 2>&1 | grep "Tests" | tail -1
```

Expected: ~85 cargo tests pass (65 baseline + 7 util + 13 guards_unit + 3 prefetch + 3 registry unit tests). clippy + fmt clean. TS unchanged.

### Step 9: Commit

```bash
git add Cargo.lock crates/alice-trading-core/Cargo.toml \
        crates/alice-trading-core/src/guards/ \
        crates/alice-trading-core/tests/guard_pipeline_per_op_prefetch.rs
git commit -m "feat(rust): guard pipeline + registry + per-op pre-fetch test (Phase 4c Task C)

- pipeline.rs: create_guard_pipeline factory mirroring TS at
  guard-pipeline.ts:13-37. Arc<Mutex<Vec<Box<dyn Guard>>>> closure
  capture for lifetime; tokio::try_join! per-op pre-fetch of
  [positions, account]. Empty-guards shortcut returns dispatcher
  unchanged. Rejection envelope { success: false, error: '[guard:N] R' }
  matches TS.
- registry.rs: GuardConfig + resolve_guards. Unknown guard types
  emit tracing::warn! and are skipped (matches TS registry.ts
  console.warn behavior). Invalid configs also skipped with warn.
- futures = '0.3' added to Cargo.toml for BoxFuture types.

Load-bearing test: pre_fetch_is_per_op_not_per_push verifies a 5-op
push calls broker.getPositions 5× and broker.getAccount 5× (NOT
once each). v4 §4c mandates per-op timing — silently optimizing to
per-push would break guards depending on intra-push position changes.

6 new tests (3 pipeline + 3 registry) plus the existing 13 guards_unit
all pass. Suite ~85 cargo / 2241 TS."
```

---

## Task D: Parity fixtures + check-guards.ts + DoD

**Goal:** Build the ~60 parity scenario JSON corpus. Create `parity/check-guards.ts` that runs every scenario through the TS guard pipeline and asserts the actual outcomes match the fixture's `expected[]`. Final DoD verification.

**Files:**
- Create: `parity/fixtures/guards/cooldown/` directory with ~18 JSON files
- Create: `parity/fixtures/guards/max-position-size/` directory with ~18 JSON files
- Create: `parity/fixtures/guards/symbol-whitelist/` directory with ~18 JSON files
- Create: `parity/fixtures/guards/mixed/` directory with ~6 JSON files
- Create: `parity/check-guards.ts`

### Step 1: Define the fixture schema

A fixture is a single JSON file with this shape:

```json
{
  "description": "human-readable scenario description",
  "guards": [
    {"type": "cooldown", "options": {"minIntervalMs": 60000}}
  ],
  "broker_state": {
    "positions": [],
    "account": {
      "baseCurrency": "USD",
      "netLiquidation": "100000",
      "totalCashValue": "100000",
      "unrealizedPnL": "0",
      "realizedPnL": "0"
    }
  },
  "ops": [
    {"step": "op", "op": {"action": "placeOrder", "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL"}, "order": {"action": "BUY", "totalQuantity": "10", "orderType": "MKT"}}},
    {"step": "delay", "ms": 100},
    {"step": "op", "op": {"action": "placeOrder", "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL"}, "order": {"action": "BUY", "totalQuantity": "10", "orderType": "MKT"}}}
  ],
  "expected": [
    {"success": true},
    {"success": false, "errorContains": "[guard:cooldown]"}
  ]
}
```

The harness walks `ops`: `{step: "op"}` runs through the pipeline; `{step: "delay"}` sleeps. The `expected[]` array has one entry per `op` step (not per overall step).

### Step 2: Create 3 sample fixtures (one per guard) to lock the schema

Create `parity/fixtures/guards/cooldown/01-allows-first-trade.json`:

```json
{
  "description": "cooldown: first trade of any symbol is allowed",
  "guards": [{"type": "cooldown", "options": {"minIntervalMs": 60000}}],
  "broker_state": {
    "positions": [],
    "account": {"baseCurrency": "USD", "netLiquidation": "100000", "totalCashValue": "100000", "unrealizedPnL": "0", "realizedPnL": "0"}
  },
  "ops": [
    {"step": "op", "op": {"action": "placeOrder", "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL"}, "order": {"action": "BUY", "totalQuantity": "10", "orderType": "MKT"}}}
  ],
  "expected": [{"success": true}]
}
```

Create `parity/fixtures/guards/max-position-size/01-allows-small-cash-qty.json`:

```json
{
  "description": "max-position-size: 1% cashQty allowed under 25% limit",
  "guards": [{"type": "max-position-size", "options": {"maxPercentOfEquity": 25}}],
  "broker_state": {
    "positions": [],
    "account": {"baseCurrency": "USD", "netLiquidation": "100000", "totalCashValue": "100000", "unrealizedPnL": "0", "realizedPnL": "0"}
  },
  "ops": [
    {"step": "op", "op": {
      "action": "placeOrder",
      "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL"},
      "order": {"action": "BUY", "cashQty": "1000", "totalQuantity": "170141183460469231731687303715884105727", "orderType": "MKT"}
    }}
  ],
  "expected": [{"success": true}]
}
```

Create `parity/fixtures/guards/symbol-whitelist/01-allows-known-symbol.json`:

```json
{
  "description": "symbol-whitelist: AAPL in [AAPL, MSFT] is allowed",
  "guards": [{"type": "symbol-whitelist", "options": {"symbols": ["AAPL", "MSFT"]}}],
  "broker_state": {
    "positions": [],
    "account": {"baseCurrency": "USD", "netLiquidation": "100000", "totalCashValue": "100000", "unrealizedPnL": "0", "realizedPnL": "0"}
  },
  "ops": [
    {"step": "op", "op": {"action": "placeOrder", "contract": {"symbol": "AAPL", "aliceId": "mock|AAPL"}, "order": {"action": "BUY", "totalQuantity": "10", "orderType": "MKT"}}}
  ],
  "expected": [{"success": true}]
}
```

### Step 3: Create `parity/check-guards.ts`

```typescript
#!/usr/bin/env tsx
/**
 * parity/check-guards.ts
 *
 * Walks every JSON scenario in parity/fixtures/guards/. For each:
 *   1. Resolve guards via TS registry
 *   2. Build a stub broker reflecting broker_state
 *   3. Drive the TS guard pipeline through each op (with delay steps)
 *   4. Assert actual outcomes match expected[] (success + optional errorContains)
 *
 * Phase 4f will add Rust-side parity via napi binding. Phase 4c only
 * locks the TS truth: every fixture's expected[] is achievable.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Contract, Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { createGuardPipeline, resolveGuards } from '../src/domain/trading/guards/index.js'
import type { Operation } from '../src/domain/trading/git/types.js'
import type { Position, AccountInfo, IBroker } from '../src/domain/trading/brokers/types.js'

interface Step {
  step: 'op' | 'delay'
  op?: Record<string, unknown>
  ms?: number
}

interface Expected {
  success: boolean
  errorContains?: string
}

interface Scenario {
  description: string
  guards: Array<{ type: string; options?: Record<string, unknown> }>
  broker_state: {
    positions: Array<Record<string, unknown>>
    account: Record<string, unknown>
  }
  ops: Step[]
  expected: Expected[]
}

const FIXTURES_ROOT = resolve('parity/fixtures/guards')

function buildContract(raw: Record<string, unknown>): Contract {
  const c = new Contract()
  c.aliceId = String(raw.aliceId ?? '')
  c.symbol = String(raw.symbol ?? '')
  c.secType = String(raw.secType ?? 'STK')
  c.exchange = String(raw.exchange ?? 'MOCK')
  c.currency = String(raw.currency ?? 'USD')
  return c
}

function buildOrder(raw: Record<string, unknown>): Order {
  const o = new Order()
  o.action = String(raw.action ?? 'BUY') as 'BUY' | 'SELL'
  o.orderType = String(raw.orderType ?? 'MKT')
  o.totalQuantity = raw.totalQuantity
    ? new Decimal(String(raw.totalQuantity))
    : UNSET_DECIMAL
  o.cashQty = raw.cashQty ? new Decimal(String(raw.cashQty)) : UNSET_DECIMAL
  o.lmtPrice = raw.lmtPrice ? new Decimal(String(raw.lmtPrice)) : UNSET_DECIMAL
  return o
}

function buildOperation(raw: Record<string, unknown>): Operation {
  const action = String(raw.action)
  if (action === 'placeOrder') {
    return {
      action: 'placeOrder',
      contract: buildContract(raw.contract as Record<string, unknown>),
      order: buildOrder(raw.order as Record<string, unknown>),
    }
  }
  if (action === 'closePosition') {
    return {
      action: 'closePosition',
      contract: buildContract(raw.contract as Record<string, unknown>),
    }
  }
  if (action === 'modifyOrder') {
    return { action: 'modifyOrder', orderId: String(raw.orderId), changes: {} }
  }
  if (action === 'cancelOrder') {
    return { action: 'cancelOrder', orderId: String(raw.orderId) }
  }
  if (action === 'syncOrders') {
    return { action: 'syncOrders' }
  }
  throw new Error(`unknown action: ${action}`)
}

function buildPositions(raws: Array<Record<string, unknown>>): Position[] {
  return raws.map((r) => ({
    contract: buildContract(r.contract as Record<string, unknown>),
    currency: String(r.currency ?? 'USD'),
    side: (r.side ?? 'long') as 'long' | 'short',
    quantity: new Decimal(String(r.quantity ?? '0')),
    avgCost: String(r.avgCost ?? '0'),
    marketPrice: String(r.marketPrice ?? '0'),
    marketValue: String(r.marketValue ?? '0'),
    unrealizedPnL: String(r.unrealizedPnL ?? '0'),
    realizedPnL: String(r.realizedPnL ?? '0'),
  }))
}

function buildBroker(state: Scenario['broker_state']): IBroker {
  const positions = buildPositions(state.positions)
  const account = state.account as unknown as AccountInfo
  return {
    async getPositions() { return positions },
    async getAccount() { return account },
  } as IBroker
}

async function runScenario(file: string, scenario: Scenario): Promise<{ pass: boolean; report: string }> {
  const guards = resolveGuards(scenario.guards)
  const broker = buildBroker(scenario.broker_state)
  const dispatcher = async (_op: Operation): Promise<unknown> => ({ success: true })
  const pipeline = createGuardPipeline(dispatcher, broker, guards)

  const actuals: Expected[] = []
  let expectedIdx = 0

  for (const step of scenario.ops) {
    if (step.step === 'delay') {
      await new Promise((r) => setTimeout(r, step.ms ?? 0))
      continue
    }
    const op = buildOperation(step.op as Record<string, unknown>)
    const result = (await pipeline(op)) as { success: boolean; error?: string }
    actuals.push({ success: result.success, errorContains: result.error })

    const exp = scenario.expected[expectedIdx]
    expectedIdx++
    if (exp === undefined) {
      return { pass: false, report: `${file}: op ${expectedIdx} has no expected entry` }
    }
    if (result.success !== exp.success) {
      return {
        pass: false,
        report: `${file}: op ${expectedIdx} expected success=${exp.success}, got success=${result.success} (error: ${result.error})`,
      }
    }
    if (exp.errorContains !== undefined) {
      if (!result.error || !result.error.includes(exp.errorContains)) {
        return {
          pass: false,
          report: `${file}: op ${expectedIdx} expected error containing "${exp.errorContains}", got "${result.error ?? '(none)'}"`,
        }
      }
    }
  }

  if (expectedIdx !== scenario.expected.length) {
    return {
      pass: false,
      report: `${file}: expected ${scenario.expected.length} outcomes, but only ${expectedIdx} ops ran`,
    }
  }

  return { pass: true, report: `${file}: ${expectedIdx} ops, all match` }
}

function walkFixtures(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      out.push(...walkFixtures(full))
    } else if (s.isFile() && entry.endsWith('.json')) {
      out.push(full)
    }
  }
  return out
}

async function main(): Promise<void> {
  if (!statSync(FIXTURES_ROOT).isDirectory()) {
    console.log(`No fixtures directory at ${FIXTURES_ROOT}`)
    return
  }
  const files = walkFixtures(FIXTURES_ROOT)
  if (files.length === 0) {
    console.log('No fixture files found.')
    process.exit(1)
  }

  let pass = 0
  let fail = 0
  for (const f of files.sort()) {
    const scenario: Scenario = JSON.parse(readFileSync(f, 'utf-8'))
    const { pass: ok, report } = await runScenario(f.replace(FIXTURES_ROOT + '/', ''), scenario)
    if (ok) { pass++; console.log(`  OK  ${report}`) }
    else { fail++; console.error(`  FAIL  ${report}`) }
  }
  console.log(`\nResults: ${pass} pass, ${fail} fail (${pass + fail} total)`)
  if (fail > 0) process.exit(1)
  console.log('All Phase 4c parity scenarios match expected outcomes.')
}

main().catch((e) => { console.error(e); process.exit(1) })
```

### Step 4: Run the 3 sample fixtures

```bash
pnpm tsx parity/check-guards.ts 2>&1 | tail -10
```

Expected: 3 fixtures pass.

### Step 5: Build the cooldown fixture corpus (~18 scenarios)

Create fixtures in `parity/fixtures/guards/cooldown/`. Naming convention: `NN-description.json`. Scenarios to cover:

1. `01-allows-first-trade.json` (done in Step 2)
2. `02-allows-non-place-order.json` — modifyOrder/cancelOrder bypass
3. `03-rejects-second-trade-within-interval.json` — BUY AAPL, immediate BUY AAPL → reject
4. `04-allows-second-trade-after-interval.json` — BUY AAPL, delay 100ms, BUY AAPL with minIntervalMs=50
5. `05-independent-per-symbol-aapl-then-msft.json` — BUY AAPL, BUY MSFT → both allowed
6. `06-default-interval-60s.json` — no options → minIntervalMs defaults to 60000
7. `07-close-position-bypasses.json` — closePosition action doesn't trigger cooldown record
8. `08-zero-interval-allows-everything.json` — minIntervalMs=0
9. `09-rejection-message-format-1s.json` — assert exact "Cooldown active for AAPL: 1s remaining" or similar
10. `10-rejection-message-format-60s.json` — assert exact 60s remaining
11. `11-mixed-actions-only-place-counts.json` — modifyOrder between two BUYs doesn't reset cooldown
12. `12-unknown-symbol-bypass.json` — modifyOrder symbol resolves to "unknown" — bypass
13. `13-large-interval-rejects-after-99s.json` — minIntervalMs=100000, 99ms delay
14. `14-alias-snake-case-config.json` — `min_interval_ms` snake_case key still works
15. `15-warn-only-unknown-field.json` — extra `unknownField` in config, parses successfully
16. `16-empty-options-uses-default.json` — `options: {}` → minIntervalMs = 60000
17. `17-camelcase-explicit.json` — `minIntervalMs` camelCase key works
18. `18-three-symbols-sequential.json` — AAPL, MSFT, NVDA all allowed back-to-back

NOTE: writing 18 individual JSON files is mechanical. The implementer can do them in batch — use a small helper script if helpful (e.g., `parity/build-cooldown-fixtures.ts` that emits all 18 files, then delete the helper after).

Run after each batch of fixtures:

```bash
pnpm tsx parity/check-guards.ts 2>&1 | tail -25
```

Expected: each batch's fixtures pass.

### Step 6: Build the max-position-size fixture corpus (~18 scenarios)

Create fixtures in `parity/fixtures/guards/max-position-size/`. Scenarios:

1. `01-allows-small-cash-qty.json` (done in Step 2)
2. `02-rejects-large-cash-qty.json` — cashQty=30000, netLiq=100000 → 30% > 25% → reject. Assert exact rejection format.
3. `03-allows-at-exact-limit.json` — cashQty exactly at 25% — TS uses `gt` (strict greater) so allow
4. `04-allows-just-over-limit.json` — actually verify: TS rejects when `percent.gt(maxPercent)`, so exactly 25.0000 is allowed; 25.0001 is rejected
5. `05-rejects-totalqty-times-marketprice.json` — existing position, totalQty * marketPrice exceeds limit
6. `06-allows-new-symbol-no-cashqty.json` — new symbol + UNSET_DECIMAL cashQty + totalQty=10 (no existing position to multiply against) → allow (TS comment: "if we can't estimate, allow")
7. `07-unset-decimal-cashqty-and-qty.json` — both UNSET → added_value=0 → allow
8. `08-non-place-order-allows.json` — closePosition/modifyOrder/cancelOrder bypass
9. `09-zero-netliq-allows.json` — netLiq=0 → percent = 0 → allow
10. `10-existing-plus-new-cash.json` — existing 10000, cashQty=20000, netLiq=100000 → 30% reject
11. `11-existing-but-cash-zero.json` — existing 5000, cashQty=0, totalQty=UNSET → 0 added → allow
12. `12-large-percent-cap.json` — maxPercentOfEquity=90, cashQty=50000 → 50% < 90 → allow
13. `13-rejection-format-30-0-percent.json` — exact rejection: "Position for AAPL would be 30.0% of equity (limit: 25.0%)"
14. `14-rejection-format-49-9-percent.json` — exact rejection format for 49.9% / 25.0% pair
15. `15-default-25-percent-cap.json` — no options → maxPercentOfEquity = 25
16. `16-decimal-precision-edge.json` — cashQty=25000.0001 (just over 25%)
17. `17-warn-only-unknown-field.json` — extra `bogus` in config parses
18. `18-multi-position-existing-marketvalue.json` — multiple positions, only AAPL's marketValue counted

NOTE on assertion #4 boundary: TS uses `percent.gt(this.maxPercent)`. `Decimal.gt` is strict — `25.0.gt(25.0) === false`. So exactly 25% should ALLOW. Verify by writing the test fixture explicitly.

### Step 7: Build the symbol-whitelist fixture corpus (~18 scenarios)

Create fixtures in `parity/fixtures/guards/symbol-whitelist/`. Scenarios:

1. `01-allows-known-symbol.json` (done in Step 2)
2. `02-rejects-unknown-symbol.json` — GME not in [AAPL] → reject, exact format "Symbol GME is not in the allowed list"
3. `03-empty-symbols-array-rejected-at-construction.json` — Special: the fixture's `guards` config is invalid; we expect resolveGuards to skip it (via `console.warn`). Test that all ops then have NO guards applied → all succeed. The fixture's `expected[]` reflects this.
4. `04-modify-order-bypasses-as-unknown.json` — modifyOrder symbol → "unknown" → bypass
5. `05-cancel-order-bypasses-as-unknown.json` — cancelOrder bypass
6. `06-sync-orders-bypasses-as-unknown.json` — syncOrders bypass
7. `07-close-position-uses-contract-symbol.json` — closePosition with contract.symbol=AAPL in whitelist → allow
8. `08-multiple-symbols-whitelist.json` — `symbols: [AAPL, MSFT, NVDA]`, op for NVDA → allow
9. `09-large-whitelist-100-symbols.json` — 100-symbol whitelist, op for one → allow
10. `10-falls-back-to-aliceid.json` — contract.symbol missing, aliceId="mock|TSLA" in whitelist → allow
11. `11-case-sensitive.json` — whitelist [AAPL], op for "aapl" → REJECT (HashSet exact match)
12. `12-whitespace-strict.json` — whitelist ["AAPL"], op for "AAPL " (trailing space) → reject
13. `13-warn-only-unknown-field.json` — extra `bogus` in options parses
14. `14-rejection-format.json` — exact rejection string for symbol "GME"
15. `15-rejection-format-with-special-chars.json` — symbol "BTC/USD" → exact rejection
16. `16-place-order-known-after-rejection.json` — first op rejected (GME), second allowed (AAPL)
17. `17-three-ops-mixed.json` — AAPL allow, GME reject, MSFT allow
18. `18-only-place-order-matters.json` — placeOrder for unknown symbol rejected; modifyOrder for same allowed

### Step 8: Build the mixed-guard corpus (~6 scenarios)

Create fixtures in `parity/fixtures/guards/mixed/`. Scenarios:

1. `01-symbol-whitelist-rejects-first.json` — whitelist + max-position-size; symbol not in whitelist → rejected by whitelist (first-rejection wins)
2. `02-max-position-size-rejects-with-whitelist-allow.json` — symbol IS in whitelist but cashQty > 25% → max-position rejects
3. `03-cooldown-rejects-second-trade.json` — whitelist + cooldown; first BUY allow, second BUY → cooldown rejects (whitelist passed)
4. `04-all-three-guards-allow.json` — all 3 guards configured, op satisfies all → allow
5. `05-empty-guards-list-bypass.json` — guards: [] → no rejection possible; dispatcher result returned
6. `06-unknown-guard-type-skipped.json` — guards includes `{type: "nonexistent"}` plus a valid cooldown; only cooldown applies

### Step 9: Verify fixture totals + run full parity script

```bash
ls parity/fixtures/guards/cooldown/*.json | wc -l                # 18
ls parity/fixtures/guards/max-position-size/*.json | wc -l       # 18
ls parity/fixtures/guards/symbol-whitelist/*.json | wc -l        # 18
ls parity/fixtures/guards/mixed/*.json | wc -l                   # 6
ls parity/fixtures/guards/**/*.json | wc -l                      # 60
pnpm tsx parity/check-guards.ts 2>&1 | tail -10
```

Expected: 60 fixtures, all pass. Last line: "All Phase 4c parity scenarios match expected outcomes."

### Step 10: Run all DoD gates

```bash
echo "=== cargo test guards ==="
source $HOME/.cargo/env
cargo test -p alice-trading-core guards 2>&1 | tail -3

echo "=== cargo test --test guards_unit ==="
cargo test -p alice-trading-core --test guards_unit 2>&1 | tail -3

echo "=== cargo test --test guard_pipeline_per_op_prefetch ==="
cargo test -p alice-trading-core --test guard_pipeline_per_op_prefetch 2>&1 | tail -3

echo "=== cargo clippy ==="
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3

echo "=== cargo fmt ==="
cargo fmt -p alice-trading-core --check 2>&1 | tail -3

echo "=== parity/check-guards.ts ==="
pnpm tsx parity/check-guards.ts 2>&1 | tail -5

echo "=== npx tsc --noEmit ==="
npx tsc --noEmit 2>&1 | tail -3

echo "=== full TS suite ==="
pnpm test 2>&1 | grep -E "Tests" | tail -1
```

Expected: all green.

### Step 11: Commit

```bash
git add parity/check-guards.ts parity/fixtures/guards/
git commit -m "test(parity): 60 guard-pipeline scenarios + TS-side checker (Phase 4c Task D)

Closes Phase 4c.

- parity/check-guards.ts: walks parity/fixtures/guards/**/*.json,
  drives the TS guard pipeline through each scenario's ops (with
  optional delay steps for cooldown timing), asserts actual outcomes
  match expected[] (success + optional errorContains).
- parity/fixtures/guards/ — 60 JSON scenarios:
  - 18 cooldown (allow/reject/per-symbol/timing/format/aliases)
  - 18 max-position-size (cashQty/totalQty/sentinel/boundary/format)
  - 18 symbol-whitelist (allow/reject/aliceId/case-sensitivity/format)
  - 6 mixed (multi-guard ordering, first-rejection-wins, empty guards,
    unknown guard type skip)

Phase 4f wires the Rust side via napi binding; Phase 4c locks the
TS-side truth via expected[] outcomes. Every scenario's expected
array is achievable by the TS pipeline.

DoD gates all green: cargo test guards (~85), clippy + fmt clean,
parity/check-guards.ts 60/60 pass, npx tsc clean, pnpm test 2241 pass.

Phase 4c complete. Guards module ready for Phase 4d to wire
Vec<Box<dyn Guard>> into the Rust UtaActor."
```

---

## Self-Review

**Spec coverage:**
- Spec §Deliverable 1 (Guard trait + GuardContext) → Task A Steps 1-3
- Spec §Deliverable 2 (3 guards) → Task B Steps 1-3
- Spec §Deliverable 3 (pipeline factory) → Task C Step 2
- Spec §Deliverable 4 (per-op pre-fetch test) → Task C Step 6
- Spec §Deliverable 5 (parity fixture corpus + checker) → Task D Steps 1-9
- Spec §Deliverable 6 (registry + warn-on-unknown) → Task C Step 3 + Task B's per-guard from_options
- Spec §DoD → Task D Step 10
- Spec §Cutover gate → load-bearing per-op pre-fetch test + 60 fixtures

**Placeholder scan:** None. The plan's verbatim code blocks are complete; the fixture-writing steps (5-8) describe each scenario by name and expected behavior so the implementer has a definite spec for each file (no "TODO: write 17 more").

**Type consistency:**
- `Guard`, `GuardContext`, `get_operation_symbol`, `CooldownGuard`, `MaxPositionSizeGuard`, `SymbolWhitelistGuard`, `create_guard_pipeline`, `Dispatcher`, `Pipeline`, `GuardConfig`, `resolve_guards` consistent across all 4 tasks.
- TS side: `createGuardPipeline`, `resolveGuards`, `OperationGuard` consistent with imports in `parity/check-guards.ts`.

**Execution notes:**
- Strict A → B → C → D. Task D's fixture-writing is the bulkiest; can be split into smaller commits per guard type if review prefers (~18 cooldown + ~18 max-position + ~18 whitelist + ~6 mixed = 4 sub-commits within Task D).
- The fixture-writing in Steps 5-8 is genuinely mechanical — could be parallelized via a small one-off `parity/build-guard-fixtures.ts` helper (then deleted post-fixture-write, following the pattern from Phase 2 Task H).
- The load-bearing assertion is Task C Step 6's `pre_fetch_is_per_op_not_per_push`. If it fails, the closure was hoisted — fix in `pipeline.rs` before continuing.
- Phase 4f will add Rust-side parity comparison; Phase 4c only verifies the TS-side truth.
