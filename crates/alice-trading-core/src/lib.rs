//! alice-trading-core — Rust port of v2 hashing + TradingGit state machine.
//!
//! Phase 3 deliverable. Dead code until Phase 4d wires it into UnifiedTradingAccount.

#![deny(clippy::all)]

pub mod canonical;
pub mod decimal;

#[cfg(feature = "napi-binding")]
#[macro_use]
extern crate napi_derive;

/// Smoke-test entry point. Returns a static string so Phase 3(d)'s parity script
/// can confirm the binding loaded.
#[cfg_attr(feature = "napi-binding", napi)]
pub fn ping() -> String {
    "alice-trading-core v0.1.0".to_string()
}
