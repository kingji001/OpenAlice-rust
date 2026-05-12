//! napi bindings for TradingCore — feature-gated entrypoint for the
//! TypeScript host. All types are explicitly napi-typed (no Value).

pub mod events;
pub mod panic;
pub mod trading_core;
pub mod types;

pub use trading_core::TradingCore;
