//! Guard pipeline.
//!
//! Phase 4c deliverable. Pure Rust — napi exposure is Phase 4d.
//! Phase 4d's UtaActor will consume `Vec<Box<dyn Guard>>`.

pub mod traits;
pub mod util;

pub use traits::{Guard, GuardContext};
pub use util::get_operation_symbol;
