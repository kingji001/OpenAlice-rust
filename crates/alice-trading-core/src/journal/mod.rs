//! Broker-execution journal — Phase 4e deliverable.

pub mod reconcile;
pub mod store;
pub mod types;

pub use reconcile::{reconcile_journal, ReconcileAction, ReconciliationOutcome};
pub use store::ExecutionJournal;
pub use types::{EntryState, ExecutionIntent, ExecutionResult, JournalEntry, JournalHandle};
