//! Broker abstraction layer.
//!
//! Phase 4b deliverable. Pure Rust internally — napi exposure is Phase 4f.
//! Phase 4d's UtaActor will consume `Box<dyn Broker>`.

pub mod error;
pub mod mock;
pub mod traits;
pub mod types;

pub use error::{classify_message, BrokerError, BrokerErrorCode};
pub use mock::{CallRecord, MockBroker, MockBrokerOptions};
pub use traits::Broker;
pub use types::{
    AccountCapabilities, AccountInfo, BrokerCapabilities, BrokerHealth, BrokerHealthInfo,
    CloseMode, MarketClock, OpenOrder, OrderTypeFlags, PlaceOrderResult, Position, PositionSide,
    Quote, SigningScheme,
};
