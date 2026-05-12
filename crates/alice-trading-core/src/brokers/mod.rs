//! Broker abstraction layer.
//!
//! Phase 4b deliverable. Pure Rust internally — napi exposure is Phase 4f.
//! Phase 4d's UtaActor will consume `Box<dyn Broker>`.

pub mod error;

pub use error::{classify_message, BrokerError, BrokerErrorCode};
