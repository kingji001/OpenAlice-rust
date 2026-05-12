# Phase 4b — Rust Broker trait + BrokerError + MockBroker

**Status:** approved 2026-05-12.
**Source:** [`docs/RUST_MIGRATION_PLAN.v4.md:811-925`](../../RUST_MIGRATION_PLAN.v4.md), expanded with the design decisions below.

## Resolved decisions

| # | Decision |
|---|----------|
| 1 | **`async_trait` crate** for the `Broker` trait. Gives `dyn`-compat so Phase 4d's actor can hold `Box<dyn Broker>` for runtime broker selection. Native AFIT (stable in 1.95) would force generics-only and complicate dyn dispatch. |
| 2 | **Include TS UTA.push() error-shape fix in Phase 4b** (v4 deliverable 6). 20-line TS change paired with the Rust BrokerError port keeps TS+Rust in lockstep on error shape. Phase 4a precedent (big-bang TS refit in one PR) applies. |
| 3 | **Pure Rust scope internally.** No napi exposure for the Broker trait in this phase — Phase 4f wires FFI. Internal Rust consumers only: Phase 4d's UtaActor + Phase 4c's guards. |
| 4 | **Full MockBroker port** with 5 explicit parity assertions (per v4 deliverable 7). Not "behavioral parity" hand-wave. |
| 5 | **Verbatim classify_message port** with fixture coverage. Revisit cleanup post-Phase-7. |
| 6 | **BrokerCapabilities extension point** added now (per v4 deliverable 8). Default impl satisfies current brokers; no behavior change. Forward-compat for §4.4. |

## Goal

Stand up the Rust broker abstraction layer in `crates/alice-trading-core/src/brokers/`. Establish exact error-shape parity to TS — `BrokerErrorCode` serializes to `"CONFIG"` / `"AUTH"` / `"NETWORK"` / `"EXCHANGE"` / `"MARKET_CLOSED"` / `"UNKNOWN"` matching `src/domain/trading/brokers/types.ts:16`. Port TS `MockBroker` (~548 lines) for parity testing. Plus one small TS fix in `UnifiedTradingAccount.push()` so its disabled/offline error shape matches the Rust port.

Phase 4b is independent of Phase 4a — both are prerequisites for Phase 4d (the cutover where Rust UtaActor replaces TS in live paths).

## Architecture

New module tree under `crates/alice-trading-core/src/brokers/`. Pure Rust — no napi exposure in this phase. Phase 4d's UtaActor will hold `Box<dyn Broker>`; Phase 4c's guards take `&dyn Broker`.

```
crates/alice-trading-core/src/brokers/
├── mod.rs            # re-exports + module docs
├── traits.rs         # Broker trait + BrokerCapabilities
├── error.rs          # BrokerError + BrokerErrorCode + classify_message
├── types.rs          # Position, AccountInfo, Quote, OpenOrder, MarketClock, BrokerHealth, etc.
└── mock.rs           # MockBroker port (~600-700 lines)
```

**Tech stack additions** in `crates/alice-trading-core/Cargo.toml`:
- `async_trait = "0.1"` — dyn-compat for the Broker trait
- `regex = "1"` — for `classify_message` regex patterns

Both small, well-maintained, no native deps.

## Deliverable 1: BrokerError exact mapping

```rust
// crates/alice-trading-core/src/brokers/error.rs

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("[{code:?}] {message}")]
pub struct BrokerError {
    pub code: BrokerErrorCode,
    pub message: String,
    pub permanent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrokerErrorCode {
    Config,        // → "CONFIG"
    Auth,          // → "AUTH"
    Network,       // → "NETWORK"
    Exchange,      // → "EXCHANGE"
    MarketClosed,  // → "MARKET_CLOSED"
    Unknown,       // → "UNKNOWN"
}

impl BrokerError {
    pub fn new(code: BrokerErrorCode, message: String) -> Self {
        let permanent = matches!(code, BrokerErrorCode::Config | BrokerErrorCode::Auth);
        Self { code, message, permanent }
    }

    /// Mirrors TS BrokerError.from() — wrap any error, classifying by message patterns.
    pub fn from_err<E: std::fmt::Display>(err: E, fallback: BrokerErrorCode) -> Self {
        let msg = err.to_string();
        let code = classify_message(&msg).unwrap_or(fallback);
        Self::new(code, msg)
    }
}
```

**Mandatory unit test** — guards against the v2 `rename_all = "UPPERCASE"` bug:

```rust
#[test]
fn broker_error_codes_serialize_to_exact_ts_strings() {
    use BrokerErrorCode::*;
    assert_eq!(serde_json::to_string(&Config).unwrap(),       "\"CONFIG\"");
    assert_eq!(serde_json::to_string(&Auth).unwrap(),         "\"AUTH\"");
    assert_eq!(serde_json::to_string(&Network).unwrap(),      "\"NETWORK\"");
    assert_eq!(serde_json::to_string(&Exchange).unwrap(),     "\"EXCHANGE\"");
    assert_eq!(serde_json::to_string(&MarketClosed).unwrap(), "\"MARKET_CLOSED\"");
    assert_eq!(serde_json::to_string(&Unknown).unwrap(),      "\"UNKNOWN\"");
}

#[test]
fn permanent_set_for_config_and_auth_only() {
    use BrokerErrorCode::*;
    assert!(BrokerError::new(Config, "x".into()).permanent);
    assert!(BrokerError::new(Auth, "x".into()).permanent);
    assert!(!BrokerError::new(Network, "x".into()).permanent);
    assert!(!BrokerError::new(Exchange, "x".into()).permanent);
    assert!(!BrokerError::new(MarketClosed, "x".into()).permanent);
    assert!(!BrokerError::new(Unknown, "x".into()).permanent);
}
```

## Deliverable 2: Broker trait

```rust
// crates/alice-trading-core/src/brokers/traits.rs

use async_trait::async_trait;

#[async_trait]
pub trait Broker: Send + Sync {
    // Lifecycle
    async fn connect(&self) -> Result<(), BrokerError>;
    async fn disconnect(&self) -> Result<(), BrokerError>;
    async fn wait_for_connect(&self) -> Result<(), BrokerError>;

    // Account + positions
    async fn get_account(&self) -> Result<AccountInfo, BrokerError>;
    async fn get_positions(&self) -> Result<Vec<Position>, BrokerError>;
    async fn get_open_orders(&self) -> Result<Vec<OpenOrder>, BrokerError>;

    // Orders
    async fn place_order(
        &self,
        contract: &Contract,
        order: &Order,
        tpsl: Option<&TpSlParams>,
    ) -> Result<PlaceOrderResult, BrokerError>;
    async fn modify_order(&self, contract: &Contract, order: &Order) -> Result<PlaceOrderResult, BrokerError>;
    async fn cancel_order(&self, order_id: &str, order_cancel: Option<&OrderCancel>) -> Result<(), BrokerError>;
    async fn close_position(&self, contract: &Contract, quantity: Option<&str>) -> Result<PlaceOrderResult, BrokerError>;

    // Quotes + market data
    async fn get_quote(&self, contract: &Contract) -> Result<Quote, BrokerError>;
    async fn get_order_state(&self, order_id: &str) -> Result<Option<OrderState>, BrokerError>;
    async fn get_market_clock(&self) -> Result<MarketClock, BrokerError>;
    async fn search_contracts(&self, pattern: &str) -> Result<Vec<ContractDescription>, BrokerError>;
    async fn refresh_catalog(&self) -> Result<(), BrokerError>;
    async fn get_contract_details(&self, query: &Contract) -> Result<Option<ContractDetails>, BrokerError>;

    // Sync introspection
    fn get_capabilities(&self) -> AccountCapabilities;
    fn get_health(&self) -> BrokerHealth;
    fn get_health_info(&self) -> BrokerHealthInfo;

    // Phase 4b forward-compat extension (default impl satisfies all current brokers)
    fn capabilities(&self) -> BrokerCapabilities {
        BrokerCapabilities::default()
    }
}
```

`Contract`, `Order`, `OrderState`, `OrderCancel`, `ContractDescription`, `ContractDetails`, `TpSlParams` are `serde_json::Value` passthroughs in Rust (same pattern as Phase 3 — broker-shape rehydration is the TS layer's concern per v4 §6.2).

## Deliverable 3: BrokerCapabilities (forward-compat for §4.4)

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerCapabilities {
    pub close_mode: CloseMode,
    pub order_types: OrderTypeFlags,
    pub signing_scheme: SigningScheme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseMode { Partial, WholePosition }

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct OrderTypeFlags: u8 {
        const MARKET  = 0b0001;
        const LIMIT   = 0b0010;
        const STOP    = 0b0100;
        const BRACKET = 0b1000;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigningScheme { None, Eip712 }

impl Default for BrokerCapabilities {
    fn default() -> Self {
        Self {
            close_mode: CloseMode::Partial,
            order_types: OrderTypeFlags::MARKET
                | OrderTypeFlags::LIMIT
                | OrderTypeFlags::STOP
                | OrderTypeFlags::BRACKET,
            signing_scheme: SigningScheme::None,
        }
    }
}
```

Add `bitflags = "2"` to Cargo.toml. No behavior change in Phase 4b — current brokers (IBKR, Alpaca, Mock) match the default. If §4.4 ever flips (e.g., LeverUp signed orders), the relevant broker overrides `capabilities()`.

## Deliverable 4: classify_message verbatim port

Port of `BrokerError.classifyMessage()` from `src/domain/trading/brokers/types.ts:45-59`. Same regex patterns, same ordering (market-closed before AUTH to avoid 403 misclassification), same return semantics:

```rust
pub fn classify_message(msg: &str) -> Option<BrokerErrorCode> {
    use BrokerErrorCode::*;
    // Market closed — check BEFORE auth to avoid 403 misclassification
    if MARKET_CLOSED_RE.is_match(msg) { return Some(MarketClosed); }
    // Network / infrastructure
    if NETWORK_RE.is_match(msg) { return Some(Network); }
    if RATE_LIMIT_RE.is_match(msg) { return Some(Network); }
    if GATEWAY_RE.is_match(msg) { return Some(Network); }
    // Authentication
    if AUTH_RE.is_match(msg) { return Some(Auth); }
    // Exchange-level rejections
    if FORBIDDEN_RE.is_match(msg) { return Some(Exchange); }
    if INSUFFICIENT_RE.is_match(msg) { return Some(Exchange); }
    None
}

static MARKET_CLOSED_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)market.?closed|not.?open|trading.?halt|outside.?trading.?hours").unwrap());
static NETWORK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)timeout|etimedout|econnrefused|econnreset|socket hang up|enotfound|fetch failed").unwrap());
static RATE_LIMIT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)429|rate.?limit|too many requests").unwrap());
static GATEWAY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)502|503|504|service.?unavailable|bad.?gateway").unwrap());
static AUTH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)401|unauthorized|invalid.?key|invalid.?signature|authentication").unwrap());
static FORBIDDEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)403|forbidden").unwrap());
static INSUFFICIENT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)insufficient|not.?enough|margin").unwrap());
```

**Fixture corpus:** `parity/fixtures/broker-classify-messages/cases.json` — ~30 cases covering each branch + boundary cases (e.g., "403 market closed" → MarketClosed not Exchange, ordering matters). Both TS + Rust read the same fixture and assert identical output.

## Deliverable 5: MockBroker port (with 5 parity assertions)

Full port of `src/domain/trading/brokers/mock/MockBroker.ts` (~548 lines → ~600-700 Rust lines). The 5 behaviors below are documented as **explicit parity assertions** in the test file — not "behavioral parity" hand-wave.

### Assertion 1: Deterministic order ID counter

```rust
pub struct MockBroker {
    next_order_id: AtomicU64,
    // ...
}

impl MockBroker {
    pub fn new() -> Self {
        Self { next_order_id: AtomicU64::new(1), /* ... */ }
    }
    fn allocate_order_id(&self) -> String {
        format!("mock-{}", self.next_order_id.fetch_add(1, Ordering::SeqCst))
    }
}
```

Test: 100 sequential `place_order` calls produce IDs `mock-1` through `mock-100` in order.

### Assertion 2: Avg-cost recalc semantics (including flipped-position simplification)

Port of `MockBroker.ts:497-538`. Key edge case at lines 527-529: when a fill crosses zero (e.g., long 5 → fill -10 → net short 5), the resulting position uses the FILL price as the new avg cost, NOT a fractional split of (realized PnL on closed portion + new opened portion). This is the "flipped position simplification."

Test fixture: scripted sequence `[BUY 10 @100, SELL 15 @120]`. Expected: net short 5 @ avg_cost 120 (NOT the realized-PnL-then-new-position decomposition).

### Assertion 3: Fail-injection machinery

```rust
#[derive(Debug, Clone, Copy)]
pub enum FailMode {
    None,
    NextCall { code: BrokerErrorCode, message: &'static str },
    EveryCall { code: BrokerErrorCode, message: &'static str },
}

impl MockBroker {
    pub fn set_fail_mode(&self, mode: FailMode) { /* ... */ }
}
```

Same enum variants as TS `MockBroker.setFailMode()`. Test: setting `NextCall` causes exactly one subsequent call to throw a matching `BrokerError`, then auto-reset to `None`.

### Assertion 4: Call-log shape

```rust
#[derive(Debug, Clone)]
pub struct MockBrokerCall {
    pub method: String,        // "placeOrder", "cancelOrder", etc.
    pub args: serde_json::Value,
    pub timestamp: String,     // ISO-8601, mirrors TS
}

impl MockBroker {
    pub fn calls(&self) -> Vec<MockBrokerCall> { /* ... */ }
    pub fn call_count(&self) -> usize { /* ... */ }
    pub fn last_call(&self) -> Option<MockBrokerCall> { /* ... */ }
}
```

Same struct shape as TS. Test asserts call log records every method invocation in order.

### Assertion 5: Failure-mode triggers health transitions

Mock's `get_health()` returns `Unhealthy` after 3 consecutive `Network` or `Exchange` failures. Test: inject 3 fails → health flips → next success → health recovers.

## Deliverable 6: TS-side UTA.push() error-shape fix

In `src/domain/trading/UnifiedTradingAccount.ts:_doPush()` (after Phase 4a refit, the body is in `_doPush`):

```typescript
// BEFORE:
if (this._disabled) throw new Error('Account disabled')
if (this.getHealth() === 'offline') throw new Error('Account offline')

// AFTER:
if (this._disabled) throw new BrokerError('CONFIG', 'Account disabled')
if (this.getHealth() === 'offline') throw new BrokerError('NETWORK', 'Account offline')
```

Plus existing tests updated:
- `UnifiedTradingAccount.spec.ts`: assertions on the disabled / offline push paths now check `err instanceof BrokerError === true` and `err.code === 'CONFIG'` / `'NETWORK'`.

No callers downstream change behavior (BrokerError extends Error, so existing `catch (e: Error)` still works).

## Files

**New:**
- `crates/alice-trading-core/src/brokers/mod.rs` (~30 lines)
- `crates/alice-trading-core/src/brokers/traits.rs` (~100 lines)
- `crates/alice-trading-core/src/brokers/error.rs` (~150 lines incl. classify_message)
- `crates/alice-trading-core/src/brokers/types.rs` (~200 lines — Position, AccountInfo, Quote, OpenOrder, MarketClock, BrokerHealth, BrokerCapabilities, etc.)
- `crates/alice-trading-core/src/brokers/mock.rs` (~600-700 lines)
- `crates/alice-trading-core/tests/broker_error_serialize.rs` (mandatory exact-string test)
- `crates/alice-trading-core/tests/mock_broker_parity.rs` (5 parity assertions as integration tests)
- `parity/fixtures/broker-classify-messages/cases.json` (~30 cases)
- `parity/check-broker-classify-messages.ts` (TS+Rust parity verifier)
- `parity/check-mock-broker.ts` (TS+Rust MockBroker behavioral parity — fixture-based, not napi-based; that's Phase 4d)
- `parity/fixtures/mock-broker-scripts/` (~5 scripted scenarios producing canonical-JSON state snapshots)

**Modified:**
- `crates/alice-trading-core/src/lib.rs` (add `pub mod brokers;`)
- `crates/alice-trading-core/Cargo.toml` (add `async_trait`, `regex`, `bitflags`)
- `src/domain/trading/UnifiedTradingAccount.ts` (BrokerError throws in `_doPush`)
- `src/domain/trading/UnifiedTradingAccount.spec.ts` (test assertions on instanceof BrokerError)

## DoD

```bash
cargo test -p alice-trading-core brokers::                          # all broker unit tests
cargo test -p alice-trading-core --test broker_error_serialize       # exact-string test
cargo test -p alice-trading-core --test mock_broker_parity           # 5 parity assertions
cargo clippy -p alice-trading-core --all-targets -- -D warnings
cargo fmt -p alice-trading-core --check
pnpm tsx parity/check-broker-classify-messages.ts                    # ~30 classify cases
pnpm tsx parity/check-mock-broker.ts                                 # MockBroker behavior parity
npx tsc --noEmit                                                     # TS BrokerError fix in UTA
pnpm test                                                            # 2241+ TS tests
```

## Cutover gate

- All 6 BrokerErrorCode strings serialize to exact TS values (the mandatory test)
- All 5 MockBroker parity assertions pass
- ~30 classify_message fixtures produce identical TS↔Rust output
- TS `UTA.push()` throws `BrokerError` instead of plain `Error` for disabled/offline paths; existing tests updated and pass

## Rollback

`git revert` the Phase 4b commits. Rust broker module is dead code (no live consumer until Phase 4d). TS `UnifiedTradingAccount.ts` change is small + reversible.

## Estimated effort

3-4 eng-days:
- Day 1: BrokerError + classify_message + types + fixtures
- Day 2: Broker trait + BrokerCapabilities + TS UTA fix
- Day 2-3: MockBroker port (largest piece — 5 behaviors, careful avg-cost recalc)
- Day 4: Parity scripts + integration tests + clippy/fmt polish

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| `async_trait` macro generates code with subtle Send/Sync issues for `Box<dyn Broker>` | Medium | Medium | Test from Phase 4d's perspective: Phase 4b includes a small smoke test that holds `Box<dyn Broker> = Box::new(MockBroker::new())` and calls every async method |
| Regex patterns in `classify_message` drift from TS (e.g., escape character differences) | Medium | High | ~30-case fixture corpus; TS+Rust read same fixture and assert identical output. Any regex bug surfaces on the first failing case |
| Avg-cost recalc edge cases (flipped position) differ from TS | Medium | High | Explicit parity assertion #2 with the specific BUY 10 / SELL 15 scenario; reviewer must verify the test asserts the simplification, not the realized-PnL split |
| MockBroker call-log timestamp format diverges from TS (e.g., precision) | Low | Low | Use `chrono::DateTime::<Utc>::to_rfc3339_opts(SecondsFormat::Millis, true)` — proven byte-identical to `new Date().toISOString()` in Phase 3 |
| TS BrokerError change breaks an external caller catching plain `Error` and inspecting `.message` | Low | Low | BrokerError extends Error; `.message` is preserved. `instanceof Error` still true |

## Out of scope

- **napi exposure of Broker trait.** Phase 4f handles FFI marshaling of BrokerError back into TS `instanceof BrokerError`.
- **Real-broker ports** (Alpaca, IBKR, CCXT). Later phases or never — they may stay TS via the FFI proxy.
- **TS BrokerError refactoring** beyond the offline-push fix.
- **Multi-account orchestration.** Phase 4d.
- **Per-broker BrokerCapabilities overrides.** Default impl is what all current brokers want; overrides come when §4.4 (LeverUp signed orders) flips.
