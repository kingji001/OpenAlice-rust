//! Per-UTA actor — owns TradingGit, broker, guards, health state.
//!
//! Phase 4d deliverable. Pure Rust internally — napi exposure is Phase 4f.

pub mod actor;
pub mod command;
pub mod health;
pub mod persist;
pub mod reconciler;
pub mod state;

pub use actor::{UtaActor, UtaHandle};
pub use command::{RecoverySignal, UtaCommand, UtaEvent};
pub use persist::{commit_path, legacy_commit_path, load_git_state, persist_commit_atomic};
pub use reconciler::{find_missing_snapshots, MissingSnapshotReport};
pub use state::UtaState;
