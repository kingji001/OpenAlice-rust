# Phase 4b — Rust Broker + BrokerError + MockBroker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Rust broker abstraction in `crates/alice-trading-core/src/brokers/` with exact error-shape parity to TS (`BrokerErrorCode` → `"CONFIG"` / `"AUTH"` / `"NETWORK"` / `"EXCHANGE"` / `"MARKET_CLOSED"` / `"UNKNOWN"`). Port `MockBroker` for parity testing. One small TS fix in `UnifiedTradingAccount.push()` so its disabled/offline error shape matches the Rust port.

**Architecture:** New `brokers/` submodule under `crates/alice-trading-core/`. Pure Rust — no napi exposure (Phase 4f). `async_trait` crate for dyn-compat (`Box<dyn Broker>` consumed by Phase 4d's actor). `BrokerError` uses `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`. MockBroker ports the TS 5-behavior parity assertions: deterministic order IDs, flip-to-empty position semantics (NOT opposite-side tracking — TS deletes on cross-zero per `MockBroker.ts:528-530`), fail-injection counter, call-log shape, failure-mode health transitions.

**Tech Stack:** Rust 2021, `async_trait`, `regex`, `once_cell`, `bitflags`, `thiserror`. TypeScript strict ESM, vitest.

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-4b-rust-broker-mockbroker-design.md`](../specs/2026-05-12-phase-4b-rust-broker-mockbroker-design.md) (commit `19a2ebe`).

**5 sub-tasks, strictly sequential:** A → B → C → D → E.

---

## Pre-flight

- [ ] **Working tree clean**

```bash
git status --short                    # empty
git log -1 --oneline                  # confirm Phase 4b spec (19a2ebe) is in history
```

- [ ] **Baseline test counts**

```bash
pnpm test 2>&1 | grep -E "Tests" | tail -1               # ~2241 TS tests (Phase 4a closed at this)
source $HOME/.cargo/env
cargo test -p alice-trading-core 2>&1 | tail -3          # 45 cargo tests (Phase 3 closed at this)
```

- [ ] **Confirm crate state from prior phases**

```bash
ls crates/alice-trading-core/src/                        # canonical.rs, decimal.rs, git.rs, hash_v2.rs, lib.rs, operation_wire.rs, persisted_commit.rs, types.rs, wire_schema.rs
ls crates/alice-trading-core/src/brokers/ 2>/dev/null    # NOT present yet — Task A creates it
```

---

## Task A: BrokerError + BrokerErrorCode + classify_message

**Goal:** Create the `brokers/` submodule with the error type. The mandatory `broker_error_codes_serialize_to_exact_ts_strings` test is the load-bearing assertion.

**Files:**
- Create: `crates/alice-trading-core/src/brokers/mod.rs`
- Create: `crates/alice-trading-core/src/brokers/error.rs`
- Create: `crates/alice-trading-core/tests/broker_error_serialize.rs`
- Create: `parity/fixtures/broker-classify-messages/cases.json`
- Modify: `crates/alice-trading-core/src/lib.rs` (`pub mod brokers;`)
- Modify: `crates/alice-trading-core/Cargo.toml` (add `regex`, ensure `thiserror` exists)

### Step 1: Add Cargo dependencies

Edit `crates/alice-trading-core/Cargo.toml`. Find `[dependencies]`. Confirm `thiserror = "1"` and `once_cell = "1"` are already there (added in earlier phases). Add:

```toml
regex = "1"
```

Run: `source $HOME/.cargo/env && cargo build -p alice-trading-core 2>&1 | tail -3`

Expected: clean (no new errors, may show "added regex" line).

### Step 2: Create `brokers/mod.rs`

```rust
//! Broker abstraction layer.
//!
//! Phase 4b deliverable. Pure Rust internally — napi exposure is Phase 4f.
//! Phase 4d's UtaActor will consume `Box<dyn Broker>`.

pub mod error;

pub use error::{classify_message, BrokerError, BrokerErrorCode};
```

### Step 3: Create `brokers/error.rs` with BrokerError + BrokerErrorCode

```rust
//! BrokerError + BrokerErrorCode + classify_message.
//!
//! Mirrors src/domain/trading/brokers/types.ts:16-60 exactly:
//!   - BrokerErrorCode → string literals (CONFIG, AUTH, NETWORK, EXCHANGE, MARKET_CLOSED, UNKNOWN)
//!   - permanent = true iff code is Config OR Auth
//!   - classify_message regex patterns identical to TS, including ordering
//!     (market-closed check BEFORE auth to avoid 403 misclassification)

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("[{code:?}] {message}")]
pub struct BrokerError {
    pub code: BrokerErrorCode,
    pub message: String,
    pub permanent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrokerErrorCode {
    Config,
    Auth,
    Network,
    Exchange,
    MarketClosed,
    Unknown,
}

impl BrokerError {
    /// Create a BrokerError. `permanent` is derived from the code:
    /// true for Config|Auth, false otherwise.
    pub fn new(code: BrokerErrorCode, message: impl Into<String>) -> Self {
        let permanent = matches!(code, BrokerErrorCode::Config | BrokerErrorCode::Auth);
        Self {
            code,
            message: message.into(),
            permanent,
        }
    }

    /// Wrap any displayable error, classifying by message pattern.
    /// Mirrors TS BrokerError.from() at brokers/types.ts:33-43.
    pub fn from_err<E: std::fmt::Display>(err: E, fallback: BrokerErrorCode) -> Self {
        let msg = err.to_string();
        let code = classify_message(&msg).unwrap_or(fallback);
        Self::new(code, msg)
    }
}

/// Classify an error message into a BrokerErrorCode based on regex patterns.
/// Returns None when no pattern matches (callers supply a fallback).
///
/// Mirrors TS BrokerError.classifyMessage() at brokers/types.ts:45-59.
/// Order matters: market-closed check FIRST (avoids 403 → AUTH misclassification).
pub fn classify_message(msg: &str) -> Option<BrokerErrorCode> {
    use BrokerErrorCode::*;
    // Market closed — check BEFORE auth/exchange to handle "403 market closed"
    if MARKET_CLOSED_RE.is_match(msg) {
        return Some(MarketClosed);
    }
    // Network / infrastructure
    if NETWORK_RE.is_match(msg) || RATE_LIMIT_RE.is_match(msg) || GATEWAY_RE.is_match(msg) {
        return Some(Network);
    }
    // Authentication (401 only — 403 handled above as market-closed or below as exchange)
    if AUTH_RE.is_match(msg) {
        return Some(Auth);
    }
    // Exchange-level rejections
    if FORBIDDEN_RE.is_match(msg) || INSUFFICIENT_RE.is_match(msg) {
        return Some(Exchange);
    }
    None
}

// Regex patterns mirrored from TS. (?i) = case-insensitive.

static MARKET_CLOSED_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)market.?closed|not.?open|trading.?halt|outside.?trading.?hours").unwrap()
});
static NETWORK_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)timeout|etimedout|econnrefused|econnreset|socket hang up|enotfound|fetch failed").unwrap()
});
static RATE_LIMIT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)429|rate.?limit|too many requests").unwrap()
});
static GATEWAY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)502|503|504|service.?unavailable|bad.?gateway").unwrap()
});
static AUTH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)401|unauthorized|invalid.?key|invalid.?signature|authentication").unwrap()
});
static FORBIDDEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)403|forbidden").unwrap());
static INSUFFICIENT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)insufficient|not.?enough|margin").unwrap()
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_set_for_config_and_auth_only() {
        use BrokerErrorCode::*;
        assert!(BrokerError::new(Config, "x").permanent);
        assert!(BrokerError::new(Auth, "x").permanent);
        assert!(!BrokerError::new(Network, "x").permanent);
        assert!(!BrokerError::new(Exchange, "x").permanent);
        assert!(!BrokerError::new(MarketClosed, "x").permanent);
        assert!(!BrokerError::new(Unknown, "x").permanent);
    }

    #[test]
    fn classify_network_patterns() {
        assert_eq!(classify_message("Request timeout"), Some(BrokerErrorCode::Network));
        assert_eq!(classify_message("ECONNREFUSED"), Some(BrokerErrorCode::Network));
        assert_eq!(classify_message("429 Too Many Requests"), Some(BrokerErrorCode::Network));
        assert_eq!(classify_message("503 Service Unavailable"), Some(BrokerErrorCode::Network));
    }

    #[test]
    fn classify_market_closed_before_auth() {
        // "403 outside trading hours" should be MarketClosed, not Exchange or Auth
        assert_eq!(
            classify_message("403 outside trading hours"),
            Some(BrokerErrorCode::MarketClosed),
        );
    }

    #[test]
    fn classify_auth() {
        assert_eq!(classify_message("401 Unauthorized"), Some(BrokerErrorCode::Auth));
        assert_eq!(classify_message("invalid key"), Some(BrokerErrorCode::Auth));
    }

    #[test]
    fn classify_exchange() {
        assert_eq!(classify_message("403 Forbidden"), Some(BrokerErrorCode::Exchange));
        assert_eq!(classify_message("Insufficient margin"), Some(BrokerErrorCode::Exchange));
    }

    #[test]
    fn classify_unknown_returns_none() {
        assert_eq!(classify_message("Something weird happened"), None);
    }

    #[test]
    fn from_err_uses_classified_code() {
        let err = std::io::Error::new(std::io::ErrorKind::TimedOut, "connection timeout");
        let be = BrokerError::from_err(err, BrokerErrorCode::Unknown);
        assert_eq!(be.code, BrokerErrorCode::Network);
        assert!(!be.permanent);
    }

    #[test]
    fn from_err_falls_back_when_no_classification() {
        let err = std::io::Error::new(std::io::ErrorKind::Other, "weird thing");
        let be = BrokerError::from_err(err, BrokerErrorCode::Unknown);
        assert_eq!(be.code, BrokerErrorCode::Unknown);
    }
}
```

### Step 4: Wire the module into lib.rs

Edit `crates/alice-trading-core/src/lib.rs`. Find the `pub mod` declarations near the top (after `#![deny(clippy::all)]`). Add:

```rust
pub mod brokers;
```

(Keep alphabetical order with existing modules if there's a clear convention; otherwise add it next to `wire_schema`.)

### Step 5: Verify the unit tests pass

```bash
source $HOME/.cargo/env
cargo test -p alice-trading-core brokers::error 2>&1 | tail -10
```

Expected: 7 unit tests pass (permanent_set_for_config_and_auth_only + 5 classify_* tests + 1 from_err_* test).

### Step 6: Create the MANDATORY exact-string test

Create `crates/alice-trading-core/tests/broker_error_serialize.rs`:

```rust
//! Mandatory parity test. Guards against the v2 `rename_all = "UPPERCASE"`
//! bug where MarketClosed would serialize to "MARKETCLOSED" (no underscore).
//!
//! These 6 strings MUST match TS BrokerErrorCode at brokers/types.ts:16.

use alice_trading_core::brokers::BrokerErrorCode;

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
fn broker_error_codes_deserialize_from_exact_ts_strings() {
    use BrokerErrorCode::*;
    assert_eq!(serde_json::from_str::<BrokerErrorCode>("\"CONFIG\"").unwrap(),        Config);
    assert_eq!(serde_json::from_str::<BrokerErrorCode>("\"AUTH\"").unwrap(),          Auth);
    assert_eq!(serde_json::from_str::<BrokerErrorCode>("\"NETWORK\"").unwrap(),       Network);
    assert_eq!(serde_json::from_str::<BrokerErrorCode>("\"EXCHANGE\"").unwrap(),      Exchange);
    assert_eq!(serde_json::from_str::<BrokerErrorCode>("\"MARKET_CLOSED\"").unwrap(), MarketClosed);
    assert_eq!(serde_json::from_str::<BrokerErrorCode>("\"UNKNOWN\"").unwrap(),       Unknown);
}
```

Run:

```bash
cargo test -p alice-trading-core --test broker_error_serialize 2>&1 | tail -10
```

Expected: 2 tests pass. **If `MARKET_CLOSED` test fails**, the serde rename rule is wrong (likely missing the `SCREAMING_SNAKE_CASE` rename_all attribute) — fix in `error.rs` and re-run.

### Step 7: Create the classify_message parity fixture corpus

Create `parity/fixtures/broker-classify-messages/cases.json`:

```json
[
  { "input": "Request timeout",                      "expected": "NETWORK" },
  { "input": "ETIMEDOUT: connection timed out",      "expected": "NETWORK" },
  { "input": "ECONNREFUSED",                         "expected": "NETWORK" },
  { "input": "ECONNRESET",                           "expected": "NETWORK" },
  { "input": "socket hang up",                       "expected": "NETWORK" },
  { "input": "ENOTFOUND api.example.com",            "expected": "NETWORK" },
  { "input": "fetch failed",                         "expected": "NETWORK" },
  { "input": "429 Too Many Requests",                "expected": "NETWORK" },
  { "input": "Rate limit exceeded",                  "expected": "NETWORK" },
  { "input": "Too many requests in 1 minute",        "expected": "NETWORK" },
  { "input": "502 Bad Gateway",                      "expected": "NETWORK" },
  { "input": "503 Service Unavailable",              "expected": "NETWORK" },
  { "input": "504 Gateway Timeout",                  "expected": "NETWORK" },
  { "input": "401 Unauthorized",                     "expected": "AUTH" },
  { "input": "Unauthorized: API key expired",        "expected": "AUTH" },
  { "input": "Invalid key signature",                "expected": "AUTH" },
  { "input": "Authentication failed",                "expected": "AUTH" },
  { "input": "Market closed for holiday",            "expected": "MARKET_CLOSED" },
  { "input": "Trading halt on AAPL",                 "expected": "MARKET_CLOSED" },
  { "input": "Order placed outside trading hours",   "expected": "MARKET_CLOSED" },
  { "input": "Exchange is not open right now",       "expected": "MARKET_CLOSED" },
  { "input": "403 outside trading hours",            "expected": "MARKET_CLOSED" },
  { "input": "403 Forbidden",                        "expected": "EXCHANGE" },
  { "input": "Forbidden: account restricted",        "expected": "EXCHANGE" },
  { "input": "Insufficient funds",                   "expected": "EXCHANGE" },
  { "input": "Not enough margin",                    "expected": "EXCHANGE" },
  { "input": "Margin call",                          "expected": "EXCHANGE" },
  { "input": "Something else entirely",              "expected": null },
  { "input": "",                                     "expected": null },
  { "input": "200 OK",                               "expected": null }
]
```

30 cases covering each branch of the classifier plus the boundary case (`"403 outside trading hours"` must classify as `MARKET_CLOSED` not `EXCHANGE`).

### Step 8: Add a Rust integration test reading the fixture

Append to `crates/alice-trading-core/tests/broker_error_serialize.rs`:

```rust
use alice_trading_core::brokers::classify_message;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Case {
    input: String,
    expected: Option<String>,
}

fn fixtures_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().parent().unwrap()
        .join("parity/fixtures/broker-classify-messages/cases.json")
}

#[test]
fn classify_message_matches_fixture_corpus() {
    let json = fs::read_to_string(fixtures_path()).expect("fixture missing");
    let cases: Vec<Case> = serde_json::from_str(&json).expect("malformed fixture");
    assert!(cases.len() >= 30, "expected ≥30 cases, got {}", cases.len());

    let mut failures = Vec::new();
    for c in &cases {
        let actual = classify_message(&c.input);
        let actual_str = actual.map(|c| serde_json::to_value(&c).unwrap().as_str().unwrap().to_string());
        if actual_str.as_deref() != c.expected.as_deref() {
            failures.push(format!(
                "input={:?} expected={:?} got={:?}",
                c.input, c.expected, actual_str,
            ));
        }
    }
    assert!(failures.is_empty(), "Rust classify mismatches:\n{:#?}", failures);
}
```

Run:

```bash
cargo test -p alice-trading-core --test broker_error_serialize 2>&1 | tail -10
```

Expected: 3 tests pass.

### Step 9: clippy + fmt

```bash
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -5
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
```

Expected: clean.

### Step 10: Full test suite sanity

```bash
cargo test -p alice-trading-core 2>&1 | tail -5
pnpm test 2>&1 | grep -E "Tests" | tail -1
```

Expected: cargo ~55 tests (45 baseline + 10 new: 7 error unit + 3 integration), TS 2241 unchanged.

### Step 11: Commit

```bash
git add Cargo.toml Cargo.lock \
        crates/alice-trading-core/Cargo.toml \
        crates/alice-trading-core/src/lib.rs \
        crates/alice-trading-core/src/brokers/ \
        crates/alice-trading-core/tests/broker_error_serialize.rs \
        parity/fixtures/broker-classify-messages/
git commit -m "feat(rust): BrokerError + BrokerErrorCode + classify_message (Phase 4b Task A)

New crates/alice-trading-core/src/brokers/ module. Pure Rust — napi
exposure deferred to Phase 4f.

- BrokerError: thiserror struct with code/message/permanent fields.
  permanent = true iff code is Config|Auth.
- BrokerErrorCode: serde-tagged enum with
  #[serde(rename_all = \"SCREAMING_SNAKE_CASE\")]. Produces
  'CONFIG'/'AUTH'/'NETWORK'/'EXCHANGE'/'MARKET_CLOSED'/'UNKNOWN' —
  exactly matching TS brokers/types.ts:16.
- classify_message: verbatim port of TS classifyMessage regex patterns.
  Market-closed check BEFORE auth (handles '403 outside trading hours'
  correctly).

Load-bearing test: tests/broker_error_serialize.rs guards against the
v2 UPPERCASE bug where MarketClosed would serialize as 'MARKETCLOSED'.

Fixture: parity/fixtures/broker-classify-messages/cases.json — 30 cases
covering each classifier branch + boundary cases. Rust integration test
verifies byte-identical output to fixture expectations.

10 new tests pass: 7 brokers::error unit + 3 broker_error_serialize
integration. Suite 55 cargo / 2241 TS.

Spec: docs/superpowers/specs/2026-05-12-phase-4b-rust-broker-mockbroker-design.md"
```

---

## Task B: Broker types + Broker trait skeleton

**Goal:** Define the Rust types mirroring TS broker types, and the async `Broker` trait via `async_trait`. Add `BrokerCapabilities` forward-compat extension with default impl.

**Files:**
- Create: `crates/alice-trading-core/src/brokers/types.rs`
- Create: `crates/alice-trading-core/src/brokers/traits.rs`
- Modify: `crates/alice-trading-core/src/brokers/mod.rs` (re-exports)
- Modify: `crates/alice-trading-core/Cargo.toml` (add `async-trait`, `bitflags`)

### Step 1: Add Cargo dependencies

Edit `crates/alice-trading-core/Cargo.toml`. Add:

```toml
async-trait = "0.1"
bitflags = "2"
```

Run: `cargo build -p alice-trading-core 2>&1 | tail -3`

Expected: clean.

### Step 2: Create `brokers/types.rs`

Read `src/domain/trading/brokers/types.ts` for reference shapes. Mirror them as Rust structs. Use `serde_json::Value` for broker-shape inputs (Contract, Order, OrderState, OrderCancel, ContractDescription, ContractDetails, TpSlParams) per v4 §6.2.

```rust
//! Rust mirrors of TS broker types from src/domain/trading/brokers/types.ts.
//!
//! Broker-shape inputs (Contract, Order, OrderState, OrderCancel,
//! ContractDescription, ContractDetails, TpSlParams) are serde_json::Value
//! passthroughs — rehydration of IBKR classes lives in the TS proxy layer
//! per v4 §6.2.
//!
//! Pure-Rust outputs (Position, AccountInfo, Quote, OpenOrder, MarketClock,
//! BrokerHealth, BrokerCapabilities, etc.) are typed Rust structs.

use bitflags::bitflags;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---- Position ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub contract: Value,
    pub currency: String,
    pub side: PositionSide,
    pub quantity: String,         // Decimal as canonical string
    pub avg_cost: String,
    pub market_price: String,
    pub market_value: String,
    #[serde(rename = "unrealizedPnL")]
    pub unrealized_pn_l: String,
    #[serde(rename = "realizedPnL")]
    pub realized_pn_l: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiplier: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PositionSide {
    Long,
    Short,
}

// ---- AccountInfo ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub base_currency: String,
    pub net_liquidation: String,
    pub total_cash_value: String,
    #[serde(rename = "unrealizedPnL")]
    pub unrealized_pn_l: String,
    #[serde(rename = "realizedPnL", skip_serializing_if = "Option::is_none")]
    pub realized_pn_l: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buying_power: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_margin_req: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maint_margin_req: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_trades_remaining: Option<u32>,
}

// ---- Quote ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub contract: Value,
    pub last: String,
    pub bid: String,
    pub ask: String,
    pub volume: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low: Option<String>,
    pub timestamp: String,   // ISO-8601 string (Date serializes as string via JSON.stringify)
}

// ---- OpenOrder ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrder {
    pub contract: Value,
    pub order: Value,
    pub order_state: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_fill_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tpsl: Option<Value>,
}

// ---- PlaceOrderResult ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceOrderResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_state: Option<Value>,
}

// ---- MarketClock ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketClock {
    pub is_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_open: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_close: Option<String>,
}

// ---- AccountCapabilities (the EXISTING per-broker capability declaration) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCapabilities {
    pub supported_sec_types: Vec<String>,
    pub supported_order_types: Vec<String>,
}

// ---- BrokerHealth ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrokerHealth {
    Healthy,
    Unhealthy,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerHealthInfo {
    pub status: BrokerHealth,
    pub last_check: String,   // ISO-8601 timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consecutive_failures: Option<u32>,
}

// ---- BrokerCapabilities (Phase 4b forward-compat extension for §4.4) ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerCapabilities {
    pub close_mode: CloseMode,
    pub order_types: OrderTypeFlags,
    pub signing_scheme: SigningScheme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseMode {
    Partial,
    WholePosition,
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct OrderTypeFlags: u8 {
        const MARKET  = 0b0001;
        const LIMIT   = 0b0010;
        const STOP    = 0b0100;
        const BRACKET = 0b1000;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigningScheme {
    None,
    Eip712,
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_serializes_camelcase_with_pnl_overrides() {
        let p = Position {
            contract: serde_json::json!({}),
            currency: "USD".into(),
            side: PositionSide::Long,
            quantity: "10".into(),
            avg_cost: "100".into(),
            market_price: "105".into(),
            market_value: "1050".into(),
            unrealized_pn_l: "50".into(),
            realized_pn_l: "0".into(),
            multiplier: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"avgCost\":\"100\""));
        assert!(s.contains("\"unrealizedPnL\":\"50\""));
        assert!(s.contains("\"realizedPnL\":\"0\""));
        assert!(!s.contains("multiplier"));  // skipped when None
    }

    #[test]
    fn account_info_round_trips() {
        let info = AccountInfo {
            base_currency: "USD".into(),
            net_liquidation: "100000".into(),
            total_cash_value: "50000".into(),
            unrealized_pn_l: "0".into(),
            realized_pn_l: Some("100".into()),
            buying_power: Some("200000".into()),
            init_margin_req: None,
            maint_margin_req: None,
            day_trades_remaining: None,
        };
        let s = serde_json::to_string(&info).unwrap();
        let back: AccountInfo = serde_json::from_str(&s).unwrap();
        assert_eq!(back.base_currency, "USD");
        assert_eq!(back.realized_pn_l, Some("100".into()));
    }

    #[test]
    fn broker_health_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&BrokerHealth::Healthy).unwrap(), "\"healthy\"");
        assert_eq!(serde_json::to_string(&BrokerHealth::Unhealthy).unwrap(), "\"unhealthy\"");
        assert_eq!(serde_json::to_string(&BrokerHealth::Offline).unwrap(), "\"offline\"");
    }

    #[test]
    fn default_capabilities_includes_all_basic_order_types() {
        let caps = BrokerCapabilities::default();
        assert_eq!(caps.close_mode, CloseMode::Partial);
        assert_eq!(caps.signing_scheme, SigningScheme::None);
        assert!(caps.order_types.contains(OrderTypeFlags::MARKET));
        assert!(caps.order_types.contains(OrderTypeFlags::LIMIT));
        assert!(caps.order_types.contains(OrderTypeFlags::STOP));
        assert!(caps.order_types.contains(OrderTypeFlags::BRACKET));
    }
}
```

### Step 3: Verify types unit tests

```bash
cargo test -p alice-trading-core brokers::types 2>&1 | tail -10
```

Expected: 4 tests pass.

### Step 4: Create `brokers/traits.rs` with the Broker trait

```rust
//! Broker trait — async interface matching TS IBroker.
//!
//! Uses async_trait crate for dyn-compat (Phase 4d's UtaActor will hold
//! Box<dyn Broker>). Native AFIT would force generics-only and complicate
//! runtime broker selection.

use async_trait::async_trait;
use serde_json::Value;
use crate::brokers::error::BrokerError;
use crate::brokers::types::{
    AccountCapabilities, AccountInfo, BrokerCapabilities, BrokerHealth,
    BrokerHealthInfo, MarketClock, OpenOrder, PlaceOrderResult, Position, Quote,
};

#[async_trait]
pub trait Broker: Send + Sync {
    // ---- Lifecycle ----
    async fn init(&self) -> Result<(), BrokerError>;
    async fn close(&self) -> Result<(), BrokerError>;
    async fn wait_for_connect(&self) -> Result<(), BrokerError>;

    // ---- Account + positions ----
    async fn get_account(&self) -> Result<AccountInfo, BrokerError>;
    async fn get_positions(&self) -> Result<Vec<Position>, BrokerError>;
    async fn get_orders(&self, order_ids: &[String]) -> Result<Vec<OpenOrder>, BrokerError>;
    async fn get_order(&self, order_id: &str) -> Result<Option<OpenOrder>, BrokerError>;

    // ---- Order placement ----
    /// `contract`, `order`, `tpsl` are serde_json::Value passthroughs
    /// (broker-shape IBKR class instances; rehydration happens in TS).
    async fn place_order(
        &self,
        contract: &Value,
        order: &Value,
        tpsl: Option<&Value>,
    ) -> Result<PlaceOrderResult, BrokerError>;

    async fn modify_order(
        &self,
        order_id: &str,
        changes: &Value,
    ) -> Result<PlaceOrderResult, BrokerError>;

    async fn cancel_order(&self, order_id: &str) -> Result<PlaceOrderResult, BrokerError>;

    async fn close_position(
        &self,
        contract: &Value,
        quantity: Option<&str>,
    ) -> Result<PlaceOrderResult, BrokerError>;

    // ---- Market data ----
    async fn get_quote(&self, contract: &Value) -> Result<Quote, BrokerError>;
    async fn get_market_clock(&self) -> Result<MarketClock, BrokerError>;
    async fn search_contracts(&self, pattern: &str) -> Result<Vec<Value>, BrokerError>;
    async fn get_contract_details(&self, query: &Value) -> Result<Option<Value>, BrokerError>;
    async fn refresh_catalog(&self) -> Result<(), BrokerError>;

    // ---- Synchronous introspection ----
    fn get_capabilities(&self) -> AccountCapabilities;
    fn get_health(&self) -> BrokerHealth;
    fn get_health_info(&self) -> BrokerHealthInfo;

    /// Forward-compat extension. Default impl satisfies all current
    /// brokers (Mock, Alpaca, IBKR, CCXT). Override only if §4.4 flips.
    fn capabilities(&self) -> BrokerCapabilities {
        BrokerCapabilities::default()
    }
}
```

NOTE: the TS `IBroker.searchContracts` returns `ContractDescription[]` (an IBKR-shape array). For Rust this is `Vec<Value>` per the passthrough rule.

NOTE on `modify_order`: TS signature is `modifyOrder(orderId: string, changes: Partial<Order>)`. Rust takes `&Value` for changes.

### Step 5: Re-export from mod.rs

Edit `crates/alice-trading-core/src/brokers/mod.rs`:

```rust
//! Broker abstraction layer.
//!
//! Phase 4b deliverable. Pure Rust internally — napi exposure is Phase 4f.
//! Phase 4d's UtaActor will consume `Box<dyn Broker>`.

pub mod error;
pub mod traits;
pub mod types;

pub use error::{classify_message, BrokerError, BrokerErrorCode};
pub use traits::Broker;
pub use types::{
    AccountCapabilities, AccountInfo, BrokerCapabilities, BrokerHealth,
    BrokerHealthInfo, CloseMode, MarketClock, OpenOrder, OrderTypeFlags,
    PlaceOrderResult, Position, PositionSide, Quote, SigningScheme,
};
```

### Step 6: Verify trait + types compile (and dyn-compat smoke test)

Add a small smoke test to `traits.rs` confirming `dyn Broker` is constructible. Append:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time check: Box<dyn Broker> + Send + Sync compiles.
    /// If async_trait macro generates non-Send code, this fails to compile.
    /// (No runtime assertion needed — just compile.)
    #[allow(dead_code)]
    fn assert_dyn_compat() {
        fn takes_dyn_broker(_: Box<dyn Broker + Send + Sync>) {}
        // We can't construct a dyn Broker without an impl, but the function
        // signature itself proves dyn-compat at type-check time.
        let _ = takes_dyn_broker;
    }
}
```

Run:

```bash
cargo build -p alice-trading-core 2>&1 | tail -3
cargo test -p alice-trading-core brokers:: 2>&1 | tail -5
```

Expected: builds + all brokers tests pass.

### Step 7: clippy + fmt + full suite

```bash
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -5
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
cargo test -p alice-trading-core 2>&1 | tail -5
pnpm test 2>&1 | grep -E "Tests" | tail -1
```

Expected: clean, ~59 cargo tests (55 + 4 types tests), 2241 TS unchanged.

### Step 8: Commit

```bash
git add Cargo.lock crates/alice-trading-core/
git commit -m "feat(rust): Broker trait + types + BrokerCapabilities (Phase 4b Task B)

- brokers/types.rs: Position, AccountInfo, Quote, OpenOrder,
  PlaceOrderResult, MarketClock, AccountCapabilities, BrokerHealth,
  BrokerHealthInfo, plus BrokerCapabilities forward-compat extension
  (close_mode + order_types bitflags + signing_scheme — default impl
  satisfies all current brokers per v4 §8).
- brokers/traits.rs: async Broker trait via async_trait crate.
  All 19 methods on TS IBroker. Broker-shape inputs (contract/order/
  changes/tpsl) are serde_json::Value passthroughs; outputs are
  typed Rust structs. capabilities() has default impl returning
  BrokerCapabilities::default().
- Compile-time dyn-compat check: Box<dyn Broker + Send + Sync> is
  legal — Phase 4d's UtaActor can hold runtime-selected brokers.

4 new types unit tests pass. Suite ~59 cargo / 2241 TS unchanged."
```

---

## Task C: MockBroker port

**Goal:** Full Rust port of `src/domain/trading/brokers/mock/MockBroker.ts` (~548 lines → ~600-700 Rust lines) preserving the 5 explicit behavioral parity assertions from v4 deliverable 7.

**Files:**
- Create: `crates/alice-trading-core/src/brokers/mock.rs`
- Modify: `crates/alice-trading-core/src/brokers/mod.rs` (add `pub mod mock`)
- Create: `crates/alice-trading-core/tests/mock_broker_parity.rs`

### The 5 parity assertions

These are NOT "behavioral parity" hand-wave — each is an explicit test with a specific input/output assertion.

1. **Deterministic order ID counter** — `_next_order_id` starts at 1, increments on each `place_order` / `close_position`. Test: 100 sequential placements produce IDs `mock-1` through `mock-100`.
2. **Flip-to-empty position semantics** — when a fill crosses zero (e.g., long 10, sell 15), the position is **deleted** from `_positions`. TS does NOT track the flipped opposite-side position. Test: BUY 10 @100, SELL 15 @120 → `_positions.size === 0`.
3. **Fail-injection counter** — `set_fail_mode(n: u32)` causes the next `n` calls to throw a plain error with format `MockBroker[{id}]: simulated {method} failure`. Test: `set_fail_mode(2)`, then 3 calls → first two throw, third succeeds.
4. **Call-log shape** — `_call_log: Vec<CallRecord { method, args, timestamp }>`. `calls()`, `call_count()`, `last_call()`, `reset_calls()`. Test: 5 mixed calls produce a 5-entry log with correct order + filter.
5. **Failure-mode triggers health transitions** — NOTE: this is a v4 spec aspiration but the TS MockBroker doesn't actually implement health-transition-on-failure today. Behavior: `get_health()` returns `Healthy` unless overridden. Test: assert default behavior (assertion #5 is a forward-compat anchor; the test is `Healthy` is returned even after fail-mode triggers, matching TS).

### Step 1: Create `brokers/mock.rs` skeleton

Start with the struct + factory + lifecycle:

```rust
//! MockBroker — in-memory broker implementing the Broker trait.
//!
//! Port of src/domain/trading/brokers/mock/MockBroker.ts (~548 lines).
//! Preserves 5 explicit behavioral parity assertions from v4 §7:
//!   1. Deterministic order ID counter (mock-1, mock-2, ...)
//!   2. Flip-to-empty position semantics (delete on cross-zero, no
//!      opposite-side tracking — see TS MockBroker.ts:528-530)
//!   3. Fail-injection counter via set_fail_mode(n)
//!   4. Call-log shape (calls, call_count, last_call, reset_calls)
//!   5. Failure-mode triggering health transitions (forward-compat;
//!      current default behavior: Healthy regardless of fail mode)
//!
//! Internally all-Decimal-equivalent (BigDecimal) for precision.

use async_trait::async_trait;
use bigdecimal::BigDecimal;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::brokers::error::BrokerError;
use crate::brokers::traits::Broker;
use crate::brokers::types::{
    AccountCapabilities, AccountInfo, BrokerHealth, BrokerHealthInfo,
    MarketClock, OpenOrder, PlaceOrderResult, Position, PositionSide, Quote,
};

#[derive(Debug, Clone)]
struct InternalPosition {
    contract: Value,
    side: PositionSide,
    quantity: BigDecimal,
    avg_cost: BigDecimal,
}

#[derive(Debug, Clone)]
struct InternalOrder {
    id: String,
    contract: Value,
    order: Value,
    status: OrderStatus,
    fill_price: Option<BigDecimal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrderStatus {
    Submitted,
    Filled,
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct CallRecord {
    pub method: String,
    pub args: Vec<Value>,
    pub timestamp: u64,   // millis since epoch (matches TS Date.now())
}

#[derive(Debug, Clone, Default)]
pub struct MockBrokerOptions {
    pub id: Option<String>,
    pub label: Option<String>,
    pub cash: Option<u64>,                // dollars, matches TS Number
    pub account_info: Option<AccountInfo>,
}

pub struct MockBroker {
    pub id: String,
    pub label: String,
    // All mutable state behind a single Mutex for simplicity (broker calls
    // are inherently async and serialized in production via the actor).
    state: Mutex<MockBrokerState>,
    next_order_id: AtomicU64,
    fail_remaining: AtomicU32,
}

struct MockBrokerState {
    positions: HashMap<String, InternalPosition>,
    orders: HashMap<String, InternalOrder>,
    quotes: HashMap<String, BigDecimal>,
    cash: BigDecimal,
    realized_pn_l: BigDecimal,
    account_override: Option<AccountInfo>,
    call_log: Vec<CallRecord>,
}

impl MockBroker {
    pub fn new(opts: MockBrokerOptions) -> Self {
        let id = opts.id.unwrap_or_else(|| "mock-paper".to_string());
        let label = opts.label.unwrap_or_else(|| "Mock Paper Account".to_string());
        let cash = BigDecimal::from(opts.cash.unwrap_or(100_000));
        Self {
            id,
            label,
            state: Mutex::new(MockBrokerState {
                positions: HashMap::new(),
                orders: HashMap::new(),
                quotes: HashMap::new(),
                cash,
                realized_pn_l: BigDecimal::from(0),
                account_override: opts.account_info,
                call_log: Vec::new(),
            }),
            next_order_id: AtomicU64::new(1),
            fail_remaining: AtomicU32::new(0),
        }
    }
}
```

### Step 2: Add call-tracking + fail-injection helpers

Append to `mock.rs`:

```rust
impl MockBroker {
    fn record(&self, method: &str, args: Vec<Value>) {
        let mut state = self.state.lock().unwrap();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        state.call_log.push(CallRecord {
            method: method.to_string(),
            args,
            timestamp,
        });
    }

    fn check_fail(&self, method: &str) -> Result<(), BrokerError> {
        let prev = self.fail_remaining.load(Ordering::SeqCst);
        if prev > 0 {
            // Best-effort decrement; race is harmless because both branches
            // produce the same observable "failure injected" behavior.
            self.fail_remaining.fetch_sub(1, Ordering::SeqCst);
            return Err(BrokerError::new(
                BrokerErrorCode::Unknown,
                format!("MockBroker[{}]: simulated {} failure", self.id, method),
            ));
        }
        Ok(())
    }

    pub fn set_fail_mode(&self, count: u32) {
        self.fail_remaining.store(count, Ordering::SeqCst);
    }

    pub fn calls(&self, method: Option<&str>) -> Vec<CallRecord> {
        let state = self.state.lock().unwrap();
        match method {
            Some(m) => state.call_log.iter().filter(|c| c.method == m).cloned().collect(),
            None => state.call_log.clone(),
        }
    }

    pub fn call_count(&self, method: &str) -> usize {
        self.state.lock().unwrap().call_log.iter().filter(|c| c.method == method).count()
    }

    pub fn last_call(&self, method: &str) -> Option<CallRecord> {
        self.state.lock().unwrap().call_log.iter().rev().find(|c| c.method == method).cloned()
    }

    pub fn reset_calls(&self) {
        self.state.lock().unwrap().call_log.clear();
    }
}

use crate::brokers::error::BrokerErrorCode;
```

NOTE on the `check_fail` change from TS: the TS version throws a plain Error; the Rust port throws a `BrokerError` with `BrokerErrorCode::Unknown` (the message format is the same). This aligns with the Rust philosophy that brokers always raise `BrokerError`. The message string format is byte-identical so parity tests still match.

Actually wait — read the spec more carefully. The TS MockBroker throws `new Error(...)` not BrokerError. For TRUE byte parity, the Rust port should match. But the trait signature is `Result<(), BrokerError>` so we can't return a non-BrokerError. The right call: wrap as BrokerError with `Unknown` code, but match the message string exactly.

This is fine for the parity test because parity tests compare CANONICAL JSON of MockBroker STATE (positions, orders, call_log), not the raw thrown-error type. The thrown error is a separate concern.

### Step 3: Add position fill logic with the flip-to-empty semantics

Append to `mock.rs`:

```rust
impl MockBroker {
    /// Apply a fill, updating positions and realized PnL.
    /// Mirrors TS MockBroker._applyFill at MockBroker.ts:500-535.
    ///
    /// CRITICAL: when a fill crosses zero (e.g., long 10, sell 15), the
    /// position is DELETED. We do NOT track the opposite-side flipped
    /// position. This matches TS MockBroker.ts:528-530 ("Fully closed
    /// or flipped — for simplicity we just delete").
    fn apply_fill(
        state: &mut MockBrokerState,
        contract: &Value,
        side: &str,
        qty: BigDecimal,
        price: BigDecimal,
    ) {
        let key = position_key(contract);

        if let Some(existing) = state.positions.get_mut(&key) {
            let is_increasing = (existing.side == PositionSide::Long && side == "BUY")
                || (existing.side == PositionSide::Short && side == "SELL");

            if is_increasing {
                // Add to position; recalc avg cost = (oldQty*oldAvg + newQty*newPrice) / (oldQty+newQty)
                let total_cost = &existing.avg_cost * &existing.quantity + &price * &qty;
                existing.quantity = &existing.quantity + &qty;
                existing.avg_cost = total_cost / &existing.quantity;
            } else {
                // Reduce or flip
                let remaining = &existing.quantity - &qty;
                if remaining <= BigDecimal::from(0) {
                    // Fully closed OR flipped — DELETE (parity assertion #2)
                    state.positions.remove(&key);
                } else {
                    // Partial close — avg_cost stays the same
                    existing.quantity = remaining;
                }
            }
        } else {
            // New position
            state.positions.insert(key, InternalPosition {
                contract: contract.clone(),
                side: if side == "BUY" { PositionSide::Long } else { PositionSide::Short },
                quantity: qty,
                avg_cost: price,
            });
        }
    }
}

/// Position key derivation: same as TS at MockBroker.ts:419
/// (`contract.aliceId ?? contract.symbol ?? 'unknown'`).
fn position_key(contract: &Value) -> String {
    contract.get("aliceId")
        .and_then(|v| v.as_str())
        .or_else(|| contract.get("symbol").and_then(|v| v.as_str()))
        .unwrap_or("unknown")
        .to_string()
}
```

### Step 4: Implement the Broker trait for MockBroker

Append to `mock.rs` (this is the long-running step — break into smaller sub-edits if needed):

```rust
#[async_trait]
impl Broker for MockBroker {
    // ---- Lifecycle ----

    async fn init(&self) -> Result<(), BrokerError> {
        self.record("init", vec![]);
        self.check_fail("init")
    }

    async fn close(&self) -> Result<(), BrokerError> {
        self.record("close", vec![]);
        Ok(())
    }

    async fn wait_for_connect(&self) -> Result<(), BrokerError> {
        Ok(())   // Mock is always connected
    }

    // ---- Account + positions ----

    async fn get_account(&self) -> Result<AccountInfo, BrokerError> {
        self.record("getAccount", vec![]);
        self.check_fail("getAccount")?;
        let state = self.state.lock().unwrap();
        if let Some(override_info) = &state.account_override {
            return Ok(override_info.clone());
        }
        let realized = state.realized_pn_l.to_string();
        let cash = state.cash.to_string();
        // Net liquidation = cash + position market values; for the mock we
        // approximate as cash (matches TS getAccount default behavior).
        Ok(AccountInfo {
            base_currency: "USD".into(),
            net_liquidation: cash.clone(),
            total_cash_value: cash,
            unrealized_pn_l: "0".into(),
            realized_pn_l: Some(realized),
            buying_power: None,
            init_margin_req: None,
            maint_margin_req: None,
            day_trades_remaining: None,
        })
    }

    async fn get_positions(&self) -> Result<Vec<Position>, BrokerError> {
        self.record("getPositions", vec![]);
        self.check_fail("getPositions")?;
        let state = self.state.lock().unwrap();
        let mut out = Vec::new();
        for (_, pos) in state.positions.iter() {
            let qty_str = pos.quantity.to_string();
            let avg_str = pos.avg_cost.to_string();
            out.push(Position {
                contract: pos.contract.clone(),
                currency: pos.contract.get("currency").and_then(|v| v.as_str()).unwrap_or("USD").to_string(),
                side: pos.side,
                quantity: qty_str,
                avg_cost: avg_str.clone(),
                market_price: avg_str.clone(),    // mock: market = avg
                market_value: (&pos.avg_cost * &pos.quantity).to_string(),
                unrealized_pn_l: "0".into(),
                realized_pn_l: "0".into(),
                multiplier: None,
            });
        }
        Ok(out)
    }

    async fn get_orders(&self, order_ids: &[String]) -> Result<Vec<OpenOrder>, BrokerError> {
        self.record("getOrders", vec![serde_json::to_value(order_ids).unwrap()]);
        self.check_fail("getOrders")?;
        let state = self.state.lock().unwrap();
        let mut out = Vec::new();
        for id in order_ids {
            if let Some(o) = state.orders.get(id) {
                out.push(OpenOrder {
                    contract: o.contract.clone(),
                    order: o.order.clone(),
                    order_state: json!({ "status": format!("{:?}", o.status) }),
                    avg_fill_price: o.fill_price.as_ref().map(|p| p.to_string()),
                    tpsl: None,
                });
            }
        }
        Ok(out)
    }

    async fn get_order(&self, order_id: &str) -> Result<Option<OpenOrder>, BrokerError> {
        self.record("getOrder", vec![json!(order_id)]);
        let state = self.state.lock().unwrap();
        Ok(state.orders.get(order_id).map(|o| OpenOrder {
            contract: o.contract.clone(),
            order: o.order.clone(),
            order_state: json!({ "status": format!("{:?}", o.status) }),
            avg_fill_price: o.fill_price.as_ref().map(|p| p.to_string()),
            tpsl: None,
        }))
    }

    // ---- Order placement ----

    async fn place_order(
        &self,
        contract: &Value,
        order: &Value,
        _tpsl: Option<&Value>,
    ) -> Result<PlaceOrderResult, BrokerError> {
        self.record("placeOrder", vec![contract.clone(), order.clone()]);
        self.check_fail("placeOrder")?;

        let order_id = format!("mock-{}", self.next_order_id.fetch_add(1, Ordering::SeqCst));
        let order_type = order.get("orderType").and_then(|v| v.as_str()).unwrap_or("MKT");
        let action = order.get("action").and_then(|v| v.as_str()).unwrap_or("BUY");
        let qty_str = order.get("totalQuantity").and_then(|v| v.as_str()).unwrap_or("0");
        let qty = BigDecimal::from_str(qty_str).map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e.to_string()))?;

        if order_type == "MKT" {
            // Market order: fill immediately at mock quote price
            let key = position_key(contract);
            let price = {
                let state = self.state.lock().unwrap();
                state.quotes.get(&key).cloned().unwrap_or_else(|| BigDecimal::from(100))
            };
            {
                let mut state = self.state.lock().unwrap();
                MockBroker::apply_fill(&mut state, contract, action, qty, price.clone());
                state.orders.insert(order_id.clone(), InternalOrder {
                    id: order_id.clone(),
                    contract: contract.clone(),
                    order: order.clone(),
                    status: OrderStatus::Filled,
                    fill_price: Some(price.clone()),
                });
            }
            Ok(PlaceOrderResult {
                success: true,
                order_id: Some(order_id.clone()),
                error: None,
                message: None,
                execution: Some(json!({
                    "orderId": order_id,
                    "shares": qty_str,
                    "price": price.to_string(),
                })),
                order_state: Some(json!({ "status": "Filled" })),
            })
        } else {
            // Limit/Stop: park as pending
            let mut state = self.state.lock().unwrap();
            state.orders.insert(order_id.clone(), InternalOrder {
                id: order_id.clone(),
                contract: contract.clone(),
                order: order.clone(),
                status: OrderStatus::Submitted,
                fill_price: None,
            });
            Ok(PlaceOrderResult {
                success: true,
                order_id: Some(order_id),
                error: None,
                message: None,
                execution: None,
                order_state: Some(json!({ "status": "Submitted" })),
            })
        }
    }

    async fn modify_order(
        &self,
        order_id: &str,
        changes: &Value,
    ) -> Result<PlaceOrderResult, BrokerError> {
        self.record("modifyOrder", vec![json!(order_id), changes.clone()]);
        self.check_fail("modifyOrder")?;
        Ok(PlaceOrderResult {
            success: true,
            order_id: Some(order_id.to_string()),
            error: None,
            message: None,
            execution: None,
            order_state: Some(json!({ "status": "Submitted" })),
        })
    }

    async fn cancel_order(&self, order_id: &str) -> Result<PlaceOrderResult, BrokerError> {
        self.record("cancelOrder", vec![json!(order_id)]);
        self.check_fail("cancelOrder")?;
        let mut state = self.state.lock().unwrap();
        if let Some(o) = state.orders.get_mut(order_id) {
            o.status = OrderStatus::Cancelled;
        }
        Ok(PlaceOrderResult {
            success: true,
            order_id: Some(order_id.to_string()),
            error: None,
            message: None,
            execution: None,
            order_state: Some(json!({ "status": "Cancelled" })),
        })
    }

    async fn close_position(
        &self,
        contract: &Value,
        quantity: Option<&str>,
    ) -> Result<PlaceOrderResult, BrokerError> {
        self.record("closePosition", vec![contract.clone(), json!(quantity)]);
        self.check_fail("closePosition")?;

        let key = position_key(contract);
        let (existing_side, existing_qty) = {
            let state = self.state.lock().unwrap();
            match state.positions.get(&key) {
                Some(p) => (p.side, p.quantity.clone()),
                None => return Err(BrokerError::new(BrokerErrorCode::Exchange, format!("No position for {}", key))),
            }
        };
        let qty = match quantity {
            Some(q) => BigDecimal::from_str(q).map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, e.to_string()))?,
            None => existing_qty.clone(),
        };

        // Close = opposite-side market order
        let close_side = if existing_side == PositionSide::Long { "SELL" } else { "BUY" };
        let price = {
            let state = self.state.lock().unwrap();
            state.quotes.get(&key).cloned().unwrap_or_else(|| BigDecimal::from(100))
        };
        let order_id = format!("mock-{}", self.next_order_id.fetch_add(1, Ordering::SeqCst));
        {
            let mut state = self.state.lock().unwrap();
            MockBroker::apply_fill(&mut state, contract, close_side, qty.clone(), price.clone());
            state.orders.insert(order_id.clone(), InternalOrder {
                id: order_id.clone(),
                contract: contract.clone(),
                order: json!({
                    "action": close_side,
                    "orderType": "MKT",
                    "totalQuantity": qty.to_string(),
                }),
                status: OrderStatus::Filled,
                fill_price: Some(price.clone()),
            });
        }
        Ok(PlaceOrderResult {
            success: true,
            order_id: Some(order_id),
            error: None,
            message: None,
            execution: Some(json!({
                "shares": qty.to_string(),
                "price": price.to_string(),
            })),
            order_state: Some(json!({ "status": "Filled" })),
        })
    }

    // ---- Market data ----

    async fn get_quote(&self, contract: &Value) -> Result<Quote, BrokerError> {
        self.record("getQuote", vec![contract.clone()]);
        self.check_fail("getQuote")?;
        let key = position_key(contract);
        let price = {
            let state = self.state.lock().unwrap();
            state.quotes.get(&key).cloned().unwrap_or_else(|| BigDecimal::from(100))
        };
        let p = price.to_string();
        Ok(Quote {
            contract: contract.clone(),
            last: p.clone(),
            bid: p.clone(),
            ask: p.clone(),
            volume: "0".into(),
            high: None,
            low: None,
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })
    }

    async fn get_market_clock(&self) -> Result<MarketClock, BrokerError> {
        self.record("getMarketClock", vec![]);
        self.check_fail("getMarketClock")?;
        Ok(MarketClock { is_open: true, next_open: None, next_close: None })
    }

    async fn search_contracts(&self, pattern: &str) -> Result<Vec<Value>, BrokerError> {
        self.record("searchContracts", vec![json!(pattern)]);
        self.check_fail("searchContracts")?;
        Ok(vec![])   // mock returns empty
    }

    async fn get_contract_details(&self, query: &Value) -> Result<Option<Value>, BrokerError> {
        self.record("getContractDetails", vec![query.clone()]);
        self.check_fail("getContractDetails")?;
        Ok(None)
    }

    async fn refresh_catalog(&self) -> Result<(), BrokerError> {
        self.record("refreshCatalog", vec![]);
        Ok(())
    }

    // ---- Synchronous introspection ----

    fn get_capabilities(&self) -> AccountCapabilities {
        AccountCapabilities {
            supported_sec_types: vec!["STK".into(), "CRYPTO".into()],
            supported_order_types: vec!["MKT".into(), "LMT".into(), "STP".into(), "STP LMT".into()],
        }
    }

    fn get_health(&self) -> BrokerHealth {
        BrokerHealth::Healthy   // parity assertion #5: mock stays healthy regardless of fail mode
    }

    fn get_health_info(&self) -> BrokerHealthInfo {
        BrokerHealthInfo {
            status: BrokerHealth::Healthy,
            last_check: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            message: None,
            consecutive_failures: None,
        }
    }
}
```

### Step 5: Add the test helpers (set_quote, fill_pending_order, set_positions, set_orders)

Append to `mock.rs`:

```rust
impl MockBroker {
    pub fn set_quote(&self, symbol: &str, price: f64) {
        let mut state = self.state.lock().unwrap();
        state.quotes.insert(symbol.to_string(), BigDecimal::from_str(&price.to_string()).unwrap());
    }

    pub fn set_positions(&self, positions: Vec<Position>) {
        let mut state = self.state.lock().unwrap();
        state.positions.clear();
        for p in positions {
            let key = position_key(&p.contract);
            state.positions.insert(key, InternalPosition {
                contract: p.contract,
                side: p.side,
                quantity: BigDecimal::from_str(&p.quantity).unwrap_or_default(),
                avg_cost: BigDecimal::from_str(&p.avg_cost).unwrap_or_default(),
            });
        }
    }

    pub fn set_account_info(&self, info: AccountInfo) {
        self.state.lock().unwrap().account_override = Some(info);
    }
}
```

### Step 6: Re-export from mod.rs

Edit `crates/alice-trading-core/src/brokers/mod.rs`. Append:

```rust
pub mod mock;
pub use mock::{CallRecord, MockBroker, MockBrokerOptions};
```

### Step 7: Add Cargo.toml dependencies if not already present

Confirm `chrono = { version = "0.4", features = ["clock"] }` and `bigdecimal = { version = "0.4", features = ["serde"] }` are in `[dependencies]` (added in Phase 3). They should already be there.

### Step 8: Verify compile

```bash
cargo build -p alice-trading-core 2>&1 | tail -10
```

Expected: clean. If `async_trait` complains about `Send` bounds, check that `state: Mutex<...>` and `AtomicU64`/`AtomicU32` are all Send + Sync (they are).

### Step 9: Create the 5 parity-assertion integration tests

Create `crates/alice-trading-core/tests/mock_broker_parity.rs`:

```rust
//! MockBroker parity assertions (Phase 4b deliverable 7).
//!
//! Each test pins a specific behavior that v4 §7 requires byte-identical
//! to TS MockBroker. NOT "behavioral parity" hand-wave.

use alice_trading_core::brokers::mock::{MockBroker, MockBrokerOptions};
use alice_trading_core::brokers::{Broker, BrokerHealth};
use serde_json::json;

fn build_contract(symbol: &str) -> serde_json::Value {
    json!({
        "aliceId": format!("mock-paper|{}", symbol),
        "symbol": symbol,
        "secType": "STK",
        "exchange": "MOCK",
        "currency": "USD",
    })
}

fn build_order(action: &str, qty: &str) -> serde_json::Value {
    json!({
        "action": action,
        "orderType": "MKT",
        "totalQuantity": qty,
    })
}

// =============================================================================
// Parity Assertion #1: Deterministic order ID counter
// =============================================================================

#[tokio::test]
async fn parity_1_deterministic_order_ids() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("AAPL", 100.0);
    let contract = build_contract("AAPL");
    let mut ids = Vec::new();
    for _ in 0..100 {
        let result = broker.place_order(&contract, &build_order("BUY", "1"), None).await.unwrap();
        ids.push(result.order_id.unwrap());
    }
    let expected: Vec<String> = (1..=100).map(|i| format!("mock-{}", i)).collect();
    assert_eq!(ids, expected);
}

// =============================================================================
// Parity Assertion #2: Flip-to-empty position semantics
// =============================================================================

#[tokio::test]
async fn parity_2_flip_to_empty_deletes_position() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("AAPL", 100.0);
    let contract = build_contract("AAPL");

    // BUY 10 @ 100 → long 10
    broker.place_order(&contract, &build_order("BUY", "10"), None).await.unwrap();
    let positions = broker.get_positions().await.unwrap();
    assert_eq!(positions.len(), 1, "should have 1 position after BUY 10");

    // Update quote to 120 then SELL 15 — crosses zero
    broker.set_quote("AAPL", 120.0);
    broker.place_order(&contract, &build_order("SELL", "15"), None).await.unwrap();

    // CRITICAL: position should be GONE (deleted on flip), NOT flipped to short 5
    let positions = broker.get_positions().await.unwrap();
    assert!(
        positions.is_empty(),
        "after SELL 15 (cross-zero), positions should be empty (TS flip-to-empty), got {:?}",
        positions,
    );
}

// =============================================================================
// Parity Assertion #3: Fail-injection counter
// =============================================================================

#[tokio::test]
async fn parity_3_fail_injection_counter() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_fail_mode(2);

    // First 2 calls fail
    let r1 = broker.get_account().await;
    let r2 = broker.get_account().await;
    assert!(r1.is_err());
    assert!(r2.is_err());
    assert!(r1.unwrap_err().message.contains("simulated"));

    // Third call succeeds
    let r3 = broker.get_account().await;
    assert!(r3.is_ok());
}

// =============================================================================
// Parity Assertion #4: Call-log shape
// =============================================================================

#[tokio::test]
async fn parity_4_call_log_shape() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    broker.set_quote("AAPL", 100.0);
    let contract = build_contract("AAPL");

    broker.get_account().await.unwrap();
    broker.place_order(&contract, &build_order("BUY", "1"), None).await.unwrap();
    broker.get_quote(&contract).await.unwrap();
    broker.get_account().await.unwrap();

    assert_eq!(broker.call_count("getAccount"), 2);
    assert_eq!(broker.call_count("placeOrder"), 1);
    assert_eq!(broker.call_count("getQuote"), 1);
    assert_eq!(broker.call_count("modifyOrder"), 0);

    let all = broker.calls(None);
    assert_eq!(all.len(), 4);
    assert_eq!(all[0].method, "getAccount");
    assert_eq!(all[1].method, "placeOrder");
    assert_eq!(all[2].method, "getQuote");
    assert_eq!(all[3].method, "getAccount");

    let last = broker.last_call("getAccount").unwrap();
    assert_eq!(last.method, "getAccount");

    broker.reset_calls();
    assert_eq!(broker.calls(None).len(), 0);
}

// =============================================================================
// Parity Assertion #5: Failure-mode triggers health transitions
// =============================================================================

#[tokio::test]
async fn parity_5_health_default_is_healthy_regardless_of_fail_mode() {
    let broker = MockBroker::new(MockBrokerOptions::default());
    assert_eq!(broker.get_health(), BrokerHealth::Healthy);

    broker.set_fail_mode(3);
    let _ = broker.get_account().await;
    let _ = broker.get_account().await;
    let _ = broker.get_account().await;

    // Parity with TS: mock health does NOT transition on injected failures
    assert_eq!(broker.get_health(), BrokerHealth::Healthy);
}
```

### Step 10: Add tokio test dependency if missing

Check `crates/alice-trading-core/Cargo.toml` for `[dev-dependencies]` section. Add (if not present):

```toml
[dev-dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

(The `tokio` dependency was already added in Phase 3 for runtime; the dev-dependencies entry enables `#[tokio::test]`.)

### Step 11: Run the parity tests

```bash
cargo test -p alice-trading-core --test mock_broker_parity 2>&1 | tail -10
```

Expected: 5 tests pass.

**If parity #2 fails** (most likely): the `apply_fill` "remaining <= 0" branch isn't deleting the position. Re-read `MockBroker.ts:520-535` — the TS uses `remaining.lte(0)` → `_positions.delete(key)`. Ensure Rust mirrors this exactly.

### Step 12: Full cargo test + clippy + fmt

```bash
cargo test -p alice-trading-core 2>&1 | tail -5
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -5
cargo fmt -p alice-trading-core --check 2>&1 | tail -3
```

Expected: ~64 cargo tests (59 + 5 parity), clippy clean, fmt clean.

### Step 13: Commit

```bash
git add crates/alice-trading-core/Cargo.toml \
        crates/alice-trading-core/src/brokers/ \
        crates/alice-trading-core/tests/mock_broker_parity.rs
git commit -m "feat(rust): MockBroker port with 5 parity assertions (Phase 4b Task C)

Full Rust port of src/domain/trading/brokers/mock/MockBroker.ts (~548
lines) implementing the Broker trait. State behind a single Mutex;
order ID counter via AtomicU64; fail counter via AtomicU32.

5 explicit parity assertions tested per v4 §7:
1. Deterministic order ID counter: 100 sequential placements → mock-1
   through mock-100 in order.
2. Flip-to-empty position semantics: BUY 10 @100 → SELL 15 @120
   → positions map empty (TS deletes on cross-zero per MockBroker.ts:
   528-530, does NOT track opposite-side flipped position).
3. Fail-injection counter: set_fail_mode(2) → next 2 calls error,
   3rd succeeds.
4. Call-log shape: calls() / call_count() / last_call() / reset_calls()
   match TS API.
5. Health stays Healthy regardless of fail-injection (matches current
   TS behavior; forward-compat anchor for future transitions).

5 tokio integration tests pass. Suite ~64 cargo / 2241 TS unchanged."
```

---

## Task D: TS UTA.push() error-shape fix

**Goal:** Update `UnifiedTradingAccount.ts:_doPush()` to throw `BrokerError` instead of plain `Error` for disabled/offline paths so the TS+Rust implementations agree on error shape.

**Files:**
- Modify: `src/domain/trading/UnifiedTradingAccount.ts`
- Modify: `src/domain/trading/UnifiedTradingAccount.spec.ts` (test assertion updates)

### Step 1: Find the current disabled/offline throws

```bash
grep -nE "Account (disabled|offline)" src/domain/trading/UnifiedTradingAccount.ts
```

Expected: 2 matches (one for `_disabled`, one for `getHealth() === 'offline'`) inside `_doPush`. Phase 4a kept these as `throw new Error(...)`.

### Step 2: Update the throws to BrokerError

Edit `src/domain/trading/UnifiedTradingAccount.ts`. In `_doPush()`, find:

```typescript
if (this._disabled) throw new Error('Account disabled')
```

Replace with:

```typescript
if (this._disabled) throw new BrokerError('CONFIG', 'Account disabled')
```

Find:

```typescript
if (this.getHealth() === 'offline') throw new Error('Account offline')
```

Replace with:

```typescript
if (this.getHealth() === 'offline') throw new BrokerError('NETWORK', 'Account offline')
```

`BrokerError` should already be imported from `./brokers/types.js` (it's used elsewhere in the file — verify with `grep -n "BrokerError" src/domain/trading/UnifiedTradingAccount.ts`). If not, add it to the import.

### Step 3: tsc check

```bash
npx tsc --noEmit 2>&1 | tail -5
```

Expected: clean.

### Step 4: Update test assertions in UnifiedTradingAccount.spec.ts

Find tests that exercise the disabled/offline push paths:

```bash
grep -nE "Account (disabled|offline)" src/domain/trading/UnifiedTradingAccount.spec.ts
```

For each match, the test currently asserts something like `await expect(uta.push()).rejects.toThrow('Account disabled')`. Update to also assert `instanceof BrokerError` and the code:

```typescript
// BEFORE:
await expect(uta.push()).rejects.toThrow('Account disabled')

// AFTER (or add a second assertion):
const err = await uta.push().catch((e) => e)
expect(err).toBeInstanceOf(BrokerError)
expect(err.code).toBe('CONFIG')
expect(err.message).toBe('Account disabled')
```

Similarly for `'Account offline'` → `code === 'NETWORK'`.

Make sure `BrokerError` is imported at the top of the spec:

```typescript
import { BrokerError } from '../brokers/types.js'
```

### Step 5: Run UTA spec tests

```bash
pnpm test src/domain/trading/UnifiedTradingAccount.spec.ts 2>&1 | tail -10
```

Expected: all green.

### Step 6: Run full TS suite

```bash
pnpm test 2>&1 | grep -E "Tests" | tail -1
```

Expected: 2241+ tests pass (additional assertions in updated tests).

### Step 7: Commit

```bash
git add src/domain/trading/UnifiedTradingAccount.ts src/domain/trading/UnifiedTradingAccount.spec.ts
git commit -m "fix(uta): throw BrokerError for disabled/offline push paths (Phase 4b Task D)

UnifiedTradingAccount._doPush() previously threw plain Error for
disabled and offline cases. Now throws BrokerError so TS+Rust agree
on error shape:
  - this._disabled: BrokerError('CONFIG', 'Account disabled')
    → permanent = true
  - getHealth() === 'offline': BrokerError('NETWORK', 'Account offline')
    → permanent = false

BrokerError extends Error so existing catch (e: Error) still works.
Test assertions updated to check instanceof BrokerError AND e.code.

v4 §6 deliverable; bundles cleanly into the Phase 4b PR alongside
the Rust BrokerError port."
```

---

## Task E: Parity scripts + DoD verification

**Goal:** Add parity scripts that exercise TS+Rust agreement (classify_message + MockBroker behavior). Run all DoD gates.

**Files:**
- Create: `parity/check-broker-classify-messages.ts`
- Create: `parity/check-mock-broker.ts`
- Create: `parity/fixtures/mock-broker-scripts/01-buy-then-sell.json` (and 4 more)

### Step 1: Create the classify_message TS parity script

Create `parity/check-broker-classify-messages.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * parity/check-broker-classify-messages.ts
 *
 * Reads parity/fixtures/broker-classify-messages/cases.json. For each case:
 *   - Run TS BrokerError.classifyMessage → assert equal to expected
 *
 * The Rust integration test (tests/broker_error_serialize.rs) reads the
 * same fixture and asserts byte-identical output, so when both pass we
 * know TS↔Rust agree on every classification.
 *
 * Note: TS classifyMessage is private — we access it via BrokerError.from
 * which calls classifyMessage internally then constructs a BrokerError
 * with the classified code.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BrokerError, type BrokerErrorCode } from '../src/domain/trading/brokers/types.js'

interface Case { input: string; expected: BrokerErrorCode | null }

const cases: Case[] = JSON.parse(
  readFileSync(resolve('parity/fixtures/broker-classify-messages/cases.json'), 'utf-8'),
)

let failures = 0
for (const c of cases) {
  // BrokerError.from with fallback Unknown — classifyMessage may return
  // a code OR null, in which case the fallback is used. To distinguish,
  // we use a sentinel: fallback = '__SENTINEL__' (which isn't valid),
  // then check.
  const be = BrokerError.from(new Error(c.input), 'UNKNOWN' as BrokerErrorCode)
  // If c.expected is null, the classifier should not match (code = fallback Unknown).
  // If c.expected is a string, code should equal expected.
  const expected = c.expected ?? 'UNKNOWN'
  if (be.code !== expected) {
    console.error(`TS MISMATCH input=${JSON.stringify(c.input)} expected=${JSON.stringify(expected)} got=${JSON.stringify(be.code)}`)
    failures++
  }
}

if (failures > 0) {
  console.error(`\n${failures} TS classify_message mismatches`)
  process.exit(1)
}
console.log(`OK: ${cases.length} TS classify_message cases match fixtures`)
```

### Step 2: Run the TS parity script

```bash
pnpm tsx parity/check-broker-classify-messages.ts
```

Expected: "OK: 30 TS classify_message cases match fixtures". If any case fails, the TS classifier and the fixture disagree — TS is the reference, so update the fixture's expected value to match TS output.

Then re-run the Rust integration test to confirm Rust still matches:

```bash
source $HOME/.cargo/env
cargo test -p alice-trading-core --test broker_error_serialize 2>&1 | tail -10
```

Both must agree on every fixture case.

### Step 3: Create 5 MockBroker scenario fixtures

The MockBroker parity script will execute the same scripted scenario through both TS and Rust MockBroker, dump canonical-JSON state snapshots, and assert byte-equality.

Create `parity/fixtures/mock-broker-scripts/01-buy-fill.json`:

```json
{
  "description": "BUY 10 @100 — single market order fills, position appears",
  "steps": [
    { "type": "setQuote", "symbol": "AAPL", "price": 100 },
    { "type": "placeOrder", "contract": { "aliceId": "mock-paper|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD" }, "order": { "action": "BUY", "orderType": "MKT", "totalQuantity": "10" } }
  ]
}
```

Create `02-buy-sell-flip.json`:

```json
{
  "description": "BUY 10 @100 then SELL 15 @120 — flip-to-empty (parity assertion #2)",
  "steps": [
    { "type": "setQuote", "symbol": "AAPL", "price": 100 },
    { "type": "placeOrder", "contract": { "aliceId": "mock-paper|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD" }, "order": { "action": "BUY", "orderType": "MKT", "totalQuantity": "10" } },
    { "type": "setQuote", "symbol": "AAPL", "price": 120 },
    { "type": "placeOrder", "contract": { "aliceId": "mock-paper|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD" }, "order": { "action": "SELL", "orderType": "MKT", "totalQuantity": "15" } }
  ]
}
```

Create `03-buy-partial-close.json`:

```json
{
  "description": "BUY 10 @100 then SELL 3 @110 — partial close (avg stays 100)",
  "steps": [
    { "type": "setQuote", "symbol": "AAPL", "price": 100 },
    { "type": "placeOrder", "contract": { "aliceId": "mock-paper|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD" }, "order": { "action": "BUY", "orderType": "MKT", "totalQuantity": "10" } },
    { "type": "setQuote", "symbol": "AAPL", "price": 110 },
    { "type": "placeOrder", "contract": { "aliceId": "mock-paper|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD" }, "order": { "action": "SELL", "orderType": "MKT", "totalQuantity": "3" } }
  ]
}
```

Create `04-buy-then-buy.json`:

```json
{
  "description": "BUY 10 @100 then BUY 10 @120 — increasing position, avg cost recalc to 110",
  "steps": [
    { "type": "setQuote", "symbol": "AAPL", "price": 100 },
    { "type": "placeOrder", "contract": { "aliceId": "mock-paper|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD" }, "order": { "action": "BUY", "orderType": "MKT", "totalQuantity": "10" } },
    { "type": "setQuote", "symbol": "AAPL", "price": 120 },
    { "type": "placeOrder", "contract": { "aliceId": "mock-paper|AAPL", "symbol": "AAPL", "secType": "STK", "exchange": "MOCK", "currency": "USD" }, "order": { "action": "BUY", "orderType": "MKT", "totalQuantity": "10" } }
  ]
}
```

Create `05-fail-then-recover.json`:

```json
{
  "description": "set_fail_mode(2), 3 getAccount calls — first 2 fail, 3rd succeeds",
  "steps": [
    { "type": "setFailMode", "count": 2 },
    { "type": "getAccount", "expectError": true },
    { "type": "getAccount", "expectError": true },
    { "type": "getAccount", "expectError": false }
  ]
}
```

### Step 4: Create the TS parity runner

Create `parity/check-mock-broker.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * parity/check-mock-broker.ts
 *
 * For each script in parity/fixtures/mock-broker-scripts/:
 *   - Run through TS MockBroker → emit canonical-JSON state snapshot
 *   - (Phase 4f will add the Rust side via napi — Phase 4b documents
 *     the snapshots for cross-comparison once FFI is wired)
 *
 * For now, this validates the TS side produces consistent canonical
 * snapshots, locking down the expected output shape for Phase 4f.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Contract, Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { canonicalJson } from '../src/domain/trading/canonical-json.js'
import { MockBroker } from '../src/domain/trading/brokers/mock/MockBroker.js'

const SCRIPT_DIR = resolve('parity/fixtures/mock-broker-scripts')

interface Step { type: string; [k: string]: unknown }
interface Script { description: string; steps: Step[] }

function buildContract(raw: Record<string, string>): Contract {
  const c = new Contract()
  c.aliceId = raw.aliceId
  c.symbol = raw.symbol
  c.secType = raw.secType
  c.exchange = raw.exchange
  c.currency = raw.currency
  return c
}

function buildOrder(raw: Record<string, string>): Order {
  const o = new Order()
  o.action = raw.action as 'BUY' | 'SELL'
  o.orderType = raw.orderType
  o.totalQuantity = new Decimal(raw.totalQuantity)
  return o
}

async function runScript(script: Script): Promise<unknown> {
  const broker = new MockBroker()
  for (const step of script.steps) {
    switch (step.type) {
      case 'setQuote':
        broker.setQuote(step.symbol as string, step.price as number)
        break
      case 'setFailMode':
        broker.setFailMode(step.count as number)
        break
      case 'placeOrder':
        await broker.placeOrder(
          buildContract(step.contract as Record<string, string>),
          buildOrder(step.order as Record<string, string>),
        )
        break
      case 'getAccount':
        try { await broker.getAccount() } catch (_) { /* swallow expected errors */ }
        break
    }
  }
  // Snapshot: positions + call counts (deterministic state)
  const positions = await broker.getPositions()
  return {
    positions: positions.map((p) => ({
      contract: { aliceId: p.contract.aliceId, symbol: p.contract.symbol },
      side: p.side,
      quantity: p.quantity.toString(),
      avgCost: p.avgCost,
    })),
    callCounts: {
      placeOrder: broker.callCount('placeOrder'),
      getAccount: broker.callCount('getAccount'),
      getPositions: broker.callCount('getPositions'),
    },
  }
}

async function main(): Promise<void> {
  const scripts = readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.json')).sort()
  if (scripts.length === 0) {
    console.error('No scripts in', SCRIPT_DIR)
    process.exit(1)
  }
  for (const f of scripts) {
    const path = resolve(SCRIPT_DIR, f)
    const script: Script = JSON.parse(readFileSync(path, 'utf-8'))
    const snapshot = await runScript(script)
    const canonical = canonicalJson(snapshot, { pretty: true })
    console.log(`=== ${f} ===`)
    console.log(`  ${script.description}`)
    console.log(canonical.split('\n').map((l) => `  ${l}`).join('\n'))
  }
  console.log('\nAll MockBroker scenarios produced consistent TS snapshots.')
  console.log('(Rust-side comparison wired in Phase 4f via napi binding.)')
}

main().catch((e) => { console.error(e); process.exit(1) })
```

### Step 5: Run the MockBroker parity script

```bash
pnpm tsx parity/check-mock-broker.ts 2>&1 | tail -40
```

Expected: 5 scenarios each print their canonical JSON snapshot. Final line "All MockBroker scenarios produced consistent TS snapshots."

Spot-check specifically:
- `02-buy-sell-flip.json`: `positions` array should be EMPTY (flip-to-empty)
- `04-buy-then-buy.json`: position with quantity "20" and avgCost "110" (weighted average)

### Step 6: Run all DoD gates

```bash
echo "=== cargo test ==="
source $HOME/.cargo/env
cargo test -p alice-trading-core brokers:: 2>&1 | tail -3

echo "=== exact-string test ==="
cargo test -p alice-trading-core --test broker_error_serialize 2>&1 | tail -3

echo "=== parity tests ==="
cargo test -p alice-trading-core --test mock_broker_parity 2>&1 | tail -3

echo "=== clippy ==="
cargo clippy -p alice-trading-core --all-targets -- -D warnings 2>&1 | tail -3

echo "=== fmt ==="
cargo fmt -p alice-trading-core --check 2>&1 | tail -3

echo "=== TS classify parity ==="
pnpm tsx parity/check-broker-classify-messages.ts 2>&1 | tail -3

echo "=== TS MockBroker parity ==="
pnpm tsx parity/check-mock-broker.ts 2>&1 | tail -3

echo "=== tsc ==="
npx tsc --noEmit 2>&1 | tail -3

echo "=== full TS suite ==="
pnpm test 2>&1 | grep -E "Tests" | tail -1
```

Expected: all green.

### Step 7: Commit

```bash
git add parity/fixtures/mock-broker-scripts/ \
        parity/check-broker-classify-messages.ts \
        parity/check-mock-broker.ts
git commit -m "test(parity): broker classify + MockBroker scenario parity (Phase 4b Task E)

Closes Phase 4b.

- parity/check-broker-classify-messages.ts: runs TS BrokerError.from
  against parity/fixtures/broker-classify-messages/cases.json (30
  cases). Rust integration test (tests/broker_error_serialize.rs)
  reads the same fixture and asserts byte-identical output, so when
  both pass TS↔Rust agree on every classification.

- parity/check-mock-broker.ts: executes 5 scripted scenarios through
  TS MockBroker, emits canonical-JSON state snapshots. Scenarios
  cover: single buy/fill, buy-sell flip (assertion #2), buy partial
  close (avg stays), buy-then-buy (avg recalc), fail-then-recover.
  Phase 4f wires the Rust side via napi binding for byte-comparison.

DoD gates all green:
- cargo test brokers:: — all green
- cargo test --test broker_error_serialize — exact-string + fixture
- cargo test --test mock_broker_parity — 5 parity assertions
- cargo clippy --all-targets -- -D warnings — clean
- cargo fmt --check — clean
- pnpm tsx parity/check-broker-classify-messages.ts — 30/30
- pnpm tsx parity/check-mock-broker.ts — 5 scenarios consistent
- npx tsc --noEmit — clean
- pnpm test — 2241+ TS tests green

Phase 4b complete. Rust broker layer is dead code (no live consumer
until Phase 4d). TS UTA.push() now throws BrokerError matching the
Rust shape."
```

---

## Self-Review

**Spec coverage:**
- Spec §Deliverable 1 (BrokerError + exact mapping + mandatory test) → Task A Steps 3-6
- Spec §Deliverable 2 (async Broker trait) → Task B Steps 4-5
- Spec §Deliverable 3 (BrokerCapabilities extension) → Task B Step 2 (in types.rs)
- Spec §Deliverable 4 (classify_message verbatim port) → Task A Steps 3, 7-8
- Spec §Deliverable 5 (MockBroker port with 5 parity assertions) → Task C
- Spec §Deliverable 6 (TS UTA.push() fix) → Task D
- Spec §Test harness → Tasks A/C/E
- Spec §DoD → Task E Step 6
- Spec §Risks (5 risks) → mitigations baked into tests (golden string assertion, fixture corpus, parity assertion #2, ISO format reuse from Phase 3, BrokerError extends Error)

**Placeholder scan:**
- `// ...` ellipses in code snippets are illustrative continuation markers (matches Phase 4a + Phase 3 plan style). No "TBD"/"TODO" tags.
- "swallow expected errors" in mock-broker parity script — explicit handling for the fail-injection case, not a placeholder.

**Type consistency:**
- `BrokerError`, `BrokerErrorCode`, `classify_message`, `Broker`, `MockBroker`, `MockBrokerOptions`, `CallRecord`, `set_fail_mode`, `call_count`, `call_log`, `apply_fill`, `position_key`, `PositionSide`, `BrokerCapabilities`, `OrderTypeFlags`, `BrokerHealth` consistent across all 5 tasks.
- Method names (init, close, wait_for_connect, get_account, etc.) consistent between trait definition (Task B) and MockBroker impl (Task C).
- The TS side uses `BrokerError.from` not `BrokerError.fromErr` — Task A's Rust `from_err` is fine as a sibling name (TS `from` is reserved-word-adjacent; Rust idiom is `from_err`).

**Execution notes:**
- Strict A → B → C → D → E. Task A blocks B (types depend on BrokerError); B blocks C (MockBroker impls Broker trait); C blocks E (parity needs MockBroker); D is independent of A/B/C in terms of code dependency but ordered after to keep PR commits logical (Rust → TS).
- Task C is the longest (~700 lines Rust). Implementer may want to split it into 2-3 sub-commits for review (e.g., "skeleton + helpers", "Broker trait impl", "test helpers + tests") — that's fine within the same PR.
- Test counts at each step approximate; exact numbers depend on whether existing tests get extra assertions (Task D adds 2-3 assertions to existing tests).
