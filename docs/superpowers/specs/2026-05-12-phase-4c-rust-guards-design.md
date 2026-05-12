# Phase 4c — Rust guards + parity

**Status:** approved 2026-05-12.
**Source:** [`docs/RUST_MIGRATION_PLAN.v4.md:898-918`](../../RUST_MIGRATION_PLAN.v4.md) Phase 4c, expanded with the design decisions below.

## Resolved decisions

| # | Decision |
|---|----------|
| 1 | **Follow v4 warn-on-unknown-field handling.** `#[serde(flatten)] extras: HashMap<String, Value>` on each guard's config; iterate `extras` and emit `tracing::warn!` per leftover. TS doesn't have this behavior — Rust adds a log line. Operationally identical to TS for parity testing (logs don't affect outcomes). |
| 2 | **async `Guard` trait** via `async_trait` crate. TS allows `Promise<...> | string | null`; Rust uniform on async. The async return covers both sync (return immediately) and future async guards. |
| 3 | **`&mut self` on `Guard::check`** because CooldownGuard mutates `HashMap<symbol, Instant>`. Actor model from Phase 4d serializes guard calls, so `&mut` is always available at the call site. Stateless guards (MaxPositionSize, SymbolWhitelist) just don't mutate. |
| 4 | **`Operation = &serde_json::Value` passthrough** (Phase 3 §6.2 pattern). Rust doesn't reach into IBKR Order/Contract; symbol extraction via `get_operation_symbol(op)` helper that mirrors TS at `git/types.ts:225-233`. |
| 5 | **Pure Rust scope.** No napi exposure in Phase 4c — Phase 4d wires `Vec<Box<dyn Guard>>` into the Rust UtaActor. |

## Goal

Port the 3 TS guards (`CooldownGuard`, `MaxPositionSizeGuard`, `SymbolWhitelistGuard`) + the `createGuardPipeline` factory to Rust. Establish per-op pre-fetch parity: `[positions, account]` fetched **inside** the per-op closure (not once per push). 60+ scenario fixture corpus comparing TS↔Rust byte-identical outcomes. Rust crate stays dead code at the end of Phase 4c.

Phase 4c is independent of Phase 4d/4e/4f but is a prerequisite for Phase 4d (the Rust UtaActor will hold `Vec<Box<dyn Guard>>`).

## Architecture

New module tree under `crates/alice-trading-core/src/guards/`. Pure Rust — no napi exposure in this phase. Internal consumers: Phase 4d's UtaActor.

```
crates/alice-trading-core/src/guards/
├── mod.rs                  # re-exports + module docs
├── traits.rs               # Guard trait + GuardContext
├── pipeline.rs             # create_guard_pipeline
├── registry.rs             # resolve_guards + GuardConfig
├── util.rs                 # get_operation_symbol helper
├── cooldown.rs             # CooldownGuard (stateful)
├── max_position_size.rs    # MaxPositionSizeGuard (stateless)
└── symbol_whitelist.rs     # SymbolWhitelistGuard (stateless)
```

**Tech stack additions** in `crates/alice-trading-core/Cargo.toml`:
- `futures = "0.3"` — for `BoxFuture` in pipeline factory signatures

All other deps (async_trait, serde, serde_json, bigdecimal, tokio, tracing, thiserror) already in scope from Phases 3+4b.

## Deliverable 1: Guard trait + GuardContext

```rust
// crates/alice-trading-core/src/guards/traits.rs

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

`&mut self` matters because `CooldownGuard` mutates `HashMap<String, Instant>`. The actor model (Phase 4d) serializes guard calls, so `&mut` is always available.

## Deliverable 2: 3 Guards

### CooldownGuard

```rust
// crates/alice-trading-core/src/guards/cooldown.rs
use std::collections::HashMap;
use std::time::{Duration, Instant};
use crate::guards::util::get_operation_symbol;

const DEFAULT_MIN_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Deserialize)]
struct CooldownOptions {
    #[serde(default = "default_min_interval")]
    min_interval_ms: u64,
    #[serde(flatten)]
    extras: HashMap<String, serde_json::Value>,
}

fn default_min_interval() -> u64 { DEFAULT_MIN_INTERVAL_MS }

pub struct CooldownGuard {
    min_interval: Duration,
    last_trade_time: HashMap<String, Instant>,
}

impl CooldownGuard {
    pub fn from_options(opts: &serde_json::Value) -> Result<Self, serde_json::Error> {
        let parsed: CooldownOptions = serde_json::from_value(opts.clone())?;
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
        if action != "placeOrder" { return None; }

        let symbol = get_operation_symbol(ctx.operation);
        let now = Instant::now();
        if let Some(&last) = self.last_trade_time.get(&symbol) {
            let elapsed = now.saturating_duration_since(last);
            if elapsed < self.min_interval {
                let remaining = (self.min_interval - elapsed).as_secs().max(1);
                return Some(format!("Cooldown active for {}: {}s remaining", symbol, remaining));
            }
        }
        self.last_trade_time.insert(symbol, now);
        None
    }
}
```

NOTE on timing: TS uses `Date.now()` (wall clock); Rust uses `Instant` (monotonic). For unit tests, time is real wall clock in both — the cooldown delta calculation gives identical *relative* behavior. Parity tests can either:
- Mock both clocks
- Use very small intervals (e.g., 10ms) and `sleep(20ms)` between ops to exercise the boundary deterministically

The parity-fixture format includes a `delay_ms_after_op` step so the harness can sleep between operations.

### MaxPositionSizeGuard

```rust
// crates/alice-trading-core/src/guards/max_position_size.rs
use bigdecimal::BigDecimal;
use std::str::FromStr;

const DEFAULT_MAX_PERCENT: f64 = 25.0;

#[derive(Debug, Deserialize)]
struct MaxPositionSizeOptions {
    #[serde(default = "default_max_percent", alias = "maxPercentOfEquity")]
    max_percent_of_equity: f64,
    #[serde(flatten)]
    extras: HashMap<String, serde_json::Value>,
}

fn default_max_percent() -> f64 { DEFAULT_MAX_PERCENT }

pub struct MaxPositionSizeGuard {
    max_percent: BigDecimal,
}

impl MaxPositionSizeGuard {
    pub fn from_options(opts: &serde_json::Value) -> Result<Self, serde_json::Error> {
        let parsed: MaxPositionSizeOptions = serde_json::from_value(opts.clone())?;
        for key in parsed.extras.keys() {
            tracing::warn!(target = "guards", guard = "max-position-size", key = %key, "unknown config field");
        }
        Ok(Self { max_percent: BigDecimal::from_str(&parsed.max_percent_of_equity.to_string()).unwrap() })
    }
}

#[async_trait]
impl Guard for MaxPositionSizeGuard {
    fn name(&self) -> &str { "max-position-size" }
    async fn check(&mut self, ctx: &GuardContext<'_>) -> Option<String> {
        let action = ctx.operation.get("action").and_then(|v| v.as_str())?;
        if action != "placeOrder" { return None; }

        let contract = ctx.operation.get("contract")?;
        let order = ctx.operation.get("order")?;
        let symbol = contract.get("symbol").and_then(|v| v.as_str())?;

        let existing = ctx.positions.iter().find(|p| {
            p.contract.get("symbol").and_then(|v| v.as_str()) == Some(symbol)
        });
        let current_value = existing
            .map(|p| BigDecimal::from_str(&p.market_value).unwrap_or_default())
            .unwrap_or_default();

        let cash_qty = parse_decimal_field(order, "cashQty");
        let qty = parse_decimal_field(order, "totalQuantity");

        let added_value = if let Some(cq) = &cash_qty {
            if cq > &BigDecimal::from(0) { cq.clone() } else { BigDecimal::from(0) }
        } else if let (Some(q), Some(p)) = (qty.as_ref(), existing) {
            let market_price = BigDecimal::from_str(&p.market_price).unwrap_or_default();
            q * &market_price
        } else {
            BigDecimal::from(0)
        };

        if added_value == BigDecimal::from(0) { return None; }

        let projected = &current_value + &added_value;
        let net_liq = BigDecimal::from_str(&ctx.account.net_liquidation).unwrap_or_default();
        if net_liq == BigDecimal::from(0) { return None; }

        let percent = &projected / &net_liq * BigDecimal::from(100);
        if percent > self.max_percent {
            return Some(format!(
                "Position for {} would be {}% of equity (limit: {}%)",
                symbol, format_percent(&percent), format_percent(&self.max_percent),
            ));
        }
        None
    }
}

fn parse_decimal_field(order: &serde_json::Value, key: &str) -> Option<BigDecimal> {
    let v = order.get(key)?;
    let s = v.as_str().or_else(|| v.as_object().and_then(|_| None))?;  // handle string OR sentinel object
    let bd = BigDecimal::from_str(s).ok()?;
    // UNSET_DECIMAL sentinel = 2^127 - 1 = 170141183460469231731687303715884105727
    let unset = BigDecimal::from_str("170141183460469231731687303715884105727").unwrap();
    if bd == unset { None } else { Some(bd) }
}

fn format_percent(bd: &BigDecimal) -> String {
    // Matches TS percent.toFixed(1)
    format!("{:.1}", bd.to_f64().unwrap_or(0.0))
}
```

### SymbolWhitelistGuard

```rust
// crates/alice-trading-core/src/guards/symbol_whitelist.rs
use std::collections::{HashMap, HashSet};
use crate::guards::util::get_operation_symbol;

#[derive(Debug, Deserialize)]
struct SymbolWhitelistOptions {
    symbols: Vec<String>,
    #[serde(flatten)]
    extras: HashMap<String, serde_json::Value>,
}

pub struct SymbolWhitelistGuard {
    allowed: HashSet<String>,
}

impl SymbolWhitelistGuard {
    pub fn from_options(opts: &serde_json::Value) -> Result<Self, String> {
        let parsed: SymbolWhitelistOptions = serde_json::from_value(opts.clone())
            .map_err(|e| format!("symbol-whitelist: {}", e))?;
        if parsed.symbols.is_empty() {
            return Err("symbol-whitelist guard requires a non-empty \"symbols\" array in options".into());
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
        if symbol == "unknown" { return None; }
        if !self.allowed.contains(&symbol) {
            return Some(format!("Symbol {} is not in the allowed list", symbol));
        }
        None
    }
}
```

### get_operation_symbol helper

```rust
// crates/alice-trading-core/src/guards/util.rs
use serde_json::Value;

/// Mirrors TS getOperationSymbol at git/types.ts:225-233.
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
        _ => "unknown".into(),  // modifyOrder, cancelOrder, syncOrders
    }
}
```

## Deliverable 3: Pipeline factory

```rust
// crates/alice-trading-core/src/guards/pipeline.rs
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::brokers::Broker;
use crate::brokers::error::BrokerError;
use crate::guards::traits::{Guard, GuardContext};

pub type Dispatcher = Arc<
    dyn Fn(&Value) -> futures::future::BoxFuture<'static, Result<Value, BrokerError>>
        + Send + Sync,
>;

/// Returns an Fn(&Value) -> BoxFuture wrapper. Pre-fetch is per-op,
/// matching TS guard-pipeline.ts:13-37 exactly.
pub fn create_guard_pipeline(
    dispatcher: Dispatcher,
    broker: Arc<dyn Broker>,
    guards: Vec<Box<dyn Guard>>,
) -> Arc<dyn Fn(Value) -> futures::future::BoxFuture<'static, Result<Value, BrokerError>> + Send + Sync> {
    if guards.is_empty() {
        let d = dispatcher.clone();
        return Arc::new(move |op| d(&op));
    }

    let guards = Arc::new(Mutex::new(guards));
    Arc::new(move |op: Value| {
        let dispatcher = dispatcher.clone();
        let broker = broker.clone();
        let guards = guards.clone();
        Box::pin(async move {
            // PER-OP pre-fetch — same as TS Promise.all([getPositions, getAccount])
            let (positions, account) = tokio::try_join!(broker.get_positions(), broker.get_account())?;
            let mut guards = guards.lock().await;
            let ctx = GuardContext { operation: &op, positions: &positions, account: &account };

            for guard in guards.iter_mut() {
                if let Some(reason) = guard.check(&ctx).await {
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": format!("[guard:{}] {}", guard.name(), reason),
                    }));
                }
            }
            drop(guards);  // release lock before dispatcher to allow re-entry
            dispatcher(&op).await
        })
    })
}
```

NOTE on closure lifetimes: the returned function owns `Vec<Box<dyn Guard>>` behind `Arc<Mutex>` so the closure can capture by clone and the `&mut self` on `Guard::check` is satisfied via the Mutex guard. This adds Mutex overhead but is the cleanest way to satisfy Rust's borrow checker for repeated closure invocations. Phase 4d's actor model serializes calls externally; the Mutex is uncontended.

## Deliverable 4: Per-op pre-fetch parity test

```rust
// crates/alice-trading-core/tests/guard_pipeline_per_op_prefetch.rs
use std::sync::Arc;
use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::guards::{create_guard_pipeline, Guard};
use alice_trading_core::guards::symbol_whitelist::SymbolWhitelistGuard;
use serde_json::json;

#[tokio::test]
async fn pre_fetch_is_per_op_not_per_push() {
    let broker = Arc::new(MockBroker::new(MockBrokerOptions::default()));
    broker.set_quote("AAPL", 100.0);

    let guards: Vec<Box<dyn Guard>> = vec![
        Box::new(SymbolWhitelistGuard::from_options(&json!({"symbols": ["AAPL"]})).unwrap()),
    ];
    let dispatcher: alice_trading_core::guards::pipeline::Dispatcher = Arc::new(|_op| {
        Box::pin(async { Ok(json!({"success": true})) })
    });
    let pipeline = create_guard_pipeline(dispatcher, broker.clone(), guards);

    // 5-op push
    for _ in 0..5 {
        pipeline(json!({"action": "placeOrder", "contract": {"symbol": "AAPL"}})).await.unwrap();
    }

    assert_eq!(
        broker.call_count("getPositions"), 5,
        "pre-fetch must be per-op (5 calls), not per-push (1 call)"
    );
    assert_eq!(broker.call_count("getAccount"), 5);
}
```

The load-bearing assertion: if Rust ever optimizes pre-fetch to per-push, this test fails immediately. Phase 4d's actor wiring must preserve this invariant.

## Deliverable 5: Parity fixture corpus

`parity/fixtures/guards/` — ~60 scenario JSON files. Distribution:
- ~18 cooldown scenarios (allow, reject within interval, reset after interval, multi-symbol independence)
- ~18 max-position-size scenarios (allow, reject, edge cases: cashQty, totalQuantity, new symbol, sentinel UNSET_DECIMAL)
- ~18 symbol-whitelist scenarios (allow, reject, "unknown" symbol passes, modifyOrder bypass)
- ~6 mixed-guard scenarios (multiple guards, ordering, first-rejection wins)

Schema:

```json
{
  "description": "human-readable",
  "guards": [{"type": "cooldown", "options": {"minIntervalMs": 60000}}],
  "broker_state": {
    "positions": [...],
    "account": {"netLiquidation": "100000", ...}
  },
  "ops": [
    {"action": "placeOrder", "contract": {...}, "order": {...}},
    {"delay_ms": 100},
    {"action": "placeOrder", ...}
  ],
  "expected": [
    {"success": true},
    {"success": false, "errorContains": "[guard:cooldown]"}
  ]
}
```

`{"delay_ms": N}` is a special step type the harness recognizes (sleeps N ms before processing the next op). Used for cooldown timing tests.

`parity/check-guards.ts` walks all scenarios, runs through both TS and Rust pipelines, asserts byte-equal canonical-JSON of the `expected[]` array. Phase 4f wires the Rust side via napi binding; Phase 4c's parity test runs TS-only against an expected-outcomes fixture (each scenario's `expected` is the TS truth, validated by running through real TS guards).

## Deliverable 6: Registry + warn-on-unknown-field

```rust
// crates/alice-trading-core/src/guards/registry.rs
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct GuardConfig {
    #[serde(rename = "type")]
    pub guard_type: String,
    #[serde(default)]
    pub options: Value,
}

pub fn resolve_guards(configs: &[GuardConfig]) -> Vec<Box<dyn Guard>> {
    let mut out: Vec<Box<dyn Guard>> = Vec::new();
    for cfg in configs {
        match cfg.guard_type.as_str() {
            "cooldown" => match CooldownGuard::from_options(&cfg.options) {
                Ok(g) => out.push(Box::new(g)),
                Err(e) => tracing::warn!(target = "guards", guard = "cooldown", error = %e, "config parse failed; skipped"),
            },
            "max-position-size" => match MaxPositionSizeGuard::from_options(&cfg.options) { /* same */ },
            "symbol-whitelist" => match SymbolWhitelistGuard::from_options(&cfg.options) { /* same */ },
            other => tracing::warn!(target = "guards", "unknown guard type \"{}\", skipped", other),
        }
    }
    out
}
```

Unknown guard types skip with a warning (matches TS `registry.ts` behavior).

## Files

**New Rust:**
- `crates/alice-trading-core/src/guards/mod.rs` (~30 lines)
- `crates/alice-trading-core/src/guards/traits.rs` (~30 lines)
- `crates/alice-trading-core/src/guards/pipeline.rs` (~80 lines)
- `crates/alice-trading-core/src/guards/registry.rs` (~50 lines)
- `crates/alice-trading-core/src/guards/util.rs` (~30 lines)
- `crates/alice-trading-core/src/guards/cooldown.rs` (~70 lines)
- `crates/alice-trading-core/src/guards/max_position_size.rs` (~120 lines)
- `crates/alice-trading-core/src/guards/symbol_whitelist.rs` (~60 lines)
- `crates/alice-trading-core/tests/guard_pipeline_per_op_prefetch.rs` (~50 lines)
- `crates/alice-trading-core/tests/guards_unit.rs` (~250 lines — per-guard unit tests)

**New parity:**
- `parity/check-guards.ts` (~150 lines)
- `parity/fixtures/guards/` — ~60 JSON files, ~700-900 total lines

**Modify:**
- `crates/alice-trading-core/src/lib.rs` (add `pub mod guards;`)
- `crates/alice-trading-core/Cargo.toml` (add `futures = "0.3"`)

## DoD

```bash
cargo test -p alice-trading-core guards::
cargo test -p alice-trading-core --test guard_pipeline_per_op_prefetch    # load-bearing
cargo test -p alice-trading-core --test guards_unit
cargo clippy -p alice-trading-core --all-targets -- -D warnings
cargo fmt -p alice-trading-core --check
pnpm tsx parity/check-guards.ts                                            # 60+ scenarios TS-side green
npx tsc --noEmit
pnpm test                                                                  # 2241+ TS tests
```

## Cutover gate

- Per-op pre-fetch test: 5-op push → `getPositions` called 5×, `getAccount` called 5×
- 60+ parity scenarios all pass TS-side (Phase 4f adds Rust-side comparison)
- Unknown-field warn emits `tracing::warn!` but parses successfully
- All 3 guards (cooldown, max-position-size, symbol-whitelist) byte-match TS rejection-reason strings

## Rollback

`git revert`. Rust guards module is dead code (no live consumer until Phase 4d).

## Estimated effort

2-3 eng-days:
- Day 1: Guard trait + 3 guards + per-guard unit tests + util.rs
- Day 2: Pipeline + per-op pre-fetch test + registry + warn-window
- Day 2-3: Parity fixtures (~60 scenarios) + TS parity script

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Closure lifetime in `create_guard_pipeline` doesn't compile (returning a closure that captures `Vec<Box<dyn Guard>>` and produces a future) | Medium | Medium | `Arc<Mutex<Vec<Box<dyn Guard>>>>` wrapping resolves the borrow checker; Phase 4d's actor model means uncontended Mutex |
| `Instant` vs `Date.now()` drift in cooldown tests | Low | Low | Tests use the parity harness's `delay_ms` step type; deterministic relative timing |
| Rejection string mismatch (TS `${remaining}s` vs Rust formatting) | Medium | High | Per-guard unit tests assert exact rejection strings against TS-output fixtures |
| MaxPositionSize percent formatting (`toFixed(1)` vs Rust `{:.1}`) produces different rounding | Medium | High | Fixture corpus includes boundary cases (e.g., 24.94% → "24.9%", 24.95% → "25.0%"); unit test pins exact string output |
| `parse_decimal_field` mishandles UNSET_DECIMAL stored as exponent form ("1.70...e+38") | Low | Medium | Mirror Phase 4b sentinel handling; compare numerically via BigDecimal, not string equality |

## Out of scope

- **napi exposure of Guard trait.** Phase 4d wires `Vec<Box<dyn Guard>>` into the Rust UtaActor.
- **Custom guards beyond the 3 built-ins.** Registry supports it via `tracing::warn!` on unknown types; no new types added.
- **Tightening warn-window to hard error.** Post-Phase-7 cleanup.
- **Removing `Operation = serde_json::Value` passthrough.** Would require porting IBKR Order/Contract classes to Rust; out of scope per v4 §6.2.
- **Multi-guard ordering optimizations.** Sequential evaluation matches TS exactly; no reordering.
