//! Per-UTA actor — owns TradingGit, broker, guards, health state.
//!
//! Phase 4d deliverable. Pure Rust internally — napi exposure is Phase 4f.

pub mod actor;
pub mod command;
pub mod health;
pub mod state;

pub use actor::{UtaActor, UtaHandle};
pub use command::{UtaCommand, UtaEvent};
pub use state::UtaState;
