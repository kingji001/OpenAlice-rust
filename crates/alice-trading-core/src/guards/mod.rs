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
