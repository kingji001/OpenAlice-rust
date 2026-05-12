//! alice-trading-core — Rust port of v2 hashing + TradingGit state machine.
//!
//! Phase 3 deliverable. Dead code until Phase 4d wires it into UnifiedTradingAccount.

#![deny(clippy::all)]

pub mod brokers;
pub mod canonical;
pub mod decimal;
pub mod git;
pub mod guards;
pub mod hash_v2;
pub mod journal;
pub mod operation_wire;
pub mod persisted_commit;
pub mod types;
pub mod uta;
pub mod wire_schema;

#[cfg(feature = "napi-binding")]
#[macro_use]
extern crate napi_derive;

#[cfg(feature = "napi-binding")]
pub mod napi_binding;

/// Smoke-test entry point. Returns a static string so Phase 3(d)'s parity script
/// can confirm the binding loaded.
#[cfg_attr(feature = "napi-binding", napi)]
pub fn ping() -> String {
    "alice-trading-core v0.1.0".to_string()
}

#[cfg(feature = "napi-binding")]
#[allow(dead_code)] // napi macros generate the public surface; Rust analysis misses it
mod napi_surface {
    use crate::canonical::canonical_json;
    use crate::decimal::to_canonical_decimal_string;
    use crate::git::{TradingGit as RustTradingGit, TradingGitConfig};
    use crate::types::{GitExportState, Operation, OperationResult, OperationStatus};
    use bigdecimal::BigDecimal;
    use napi::bindgen_prelude::*;
    use serde_json::Value;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    // -----------------------------------------------------------------------
    // verifyCanonicalHash — takes a canonical_json_input string + expected hash,
    // returns {matches: bool, actual: string}
    // -----------------------------------------------------------------------

    #[napi(object)]
    pub struct VerifyCanonicalHashRequest {
        pub canonical_json_input: String,
        pub expected_intent_full_hash: String,
    }

    #[napi(object)]
    pub struct VerifyCanonicalHashResult {
        pub matches: bool,
        pub actual: String,
    }

    #[napi]
    pub fn verify_canonical_hash(
        req: VerifyCanonicalHashRequest,
    ) -> Result<VerifyCanonicalHashResult> {
        use sha2::{Digest, Sha256};
        let actual = hex::encode(Sha256::digest(req.canonical_json_input.as_bytes()));
        Ok(VerifyCanonicalHashResult {
            matches: actual == req.expected_intent_full_hash,
            actual,
        })
    }

    // -----------------------------------------------------------------------
    // canonicalizeDecimal — takes input string, returns canonical decimal string
    // -----------------------------------------------------------------------

    #[napi(object)]
    pub struct CanonicalizeDecimalRequest {
        pub input: String,
    }

    #[napi(object)]
    pub struct CanonicalizeDecimalResult {
        pub canonical: String,
    }

    #[napi]
    pub fn canonicalize_decimal(
        req: CanonicalizeDecimalRequest,
    ) -> Result<CanonicalizeDecimalResult> {
        let bd = BigDecimal::from_str(&req.input).map_err(|e| {
            napi::Error::new(napi::Status::InvalidArg, format!("invalid decimal: {e}"))
        })?;
        let canonical = to_canonical_decimal_string(&bd).map_err(|e| {
            napi::Error::new(napi::Status::InvalidArg, format!("canonicalize error: {e}"))
        })?;
        Ok(CanonicalizeDecimalResult { canonical })
    }

    // -----------------------------------------------------------------------
    // TradingGit napi class — wraps Rust TradingGit behind a Mutex.
    //
    // Scripted stub results are stored in a shared Arc that the execute_operation
    // closure captures. Before calling push(), the caller calls set_stub_results()
    // to load scripted results into the shared buffer; the closure drains them.
    //
    // All Operation/result types are JSON strings — full typed napi structs
    // deferred to Phase 4d.
    // -----------------------------------------------------------------------

    fn stub_git_state() -> crate::types::GitState {
        crate::types::GitState {
            net_liquidation: "100000".to_string(),
            total_cash_value: "100000".to_string(),
            unrealized_pn_l: "0".to_string(),
            realized_pn_l: "0".to_string(),
            positions: vec![],
            pending_orders: vec![],
        }
    }

    fn make_config(
        scripted: Arc<Mutex<Vec<OperationResult>>>,
        idx: Arc<AtomicUsize>,
    ) -> TradingGitConfig {
        TradingGitConfig {
            execute_operation: Box::new(move |_op| {
                let i = idx.fetch_add(1, Ordering::SeqCst);
                let locked = scripted.lock().unwrap();
                locked.get(i).cloned().unwrap_or_else(|| {
                    // Default stub when scripted results are exhausted or empty.
                    OperationResult {
                        action: _op.action_name().to_string(),
                        success: true,
                        order_id: Some("stub-order-1".to_string()),
                        status: OperationStatus::Submitted,
                        execution: None,
                        order_state: None,
                        filled_qty: None,
                        filled_price: None,
                        error: None,
                        raw: None,
                    }
                })
            }),
            get_git_state: Box::new(stub_git_state),
            on_commit: None,
            hash_version: 2,
        }
    }

    #[napi]
    pub struct TradingGit {
        inner: Mutex<RustTradingGit>,
        /// Shared scripted results buffer. The execute_operation closure reads
        /// from this. Call set_stub_results() before push() to inject scripted
        /// results for the upcoming push.
        scripted: Arc<Mutex<Vec<OperationResult>>>,
        /// Index tracking next scripted result to consume.
        scripted_idx: Arc<AtomicUsize>,
    }

    #[napi]
    impl TradingGit {
        /// Create a new TradingGit with default stub config (hash_version=2).
        #[napi(factory)]
        pub fn create() -> Self {
            let scripted: Arc<Mutex<Vec<OperationResult>>> = Arc::new(Mutex::new(vec![]));
            let idx = Arc::new(AtomicUsize::new(0));
            let git = RustTradingGit::new(make_config(scripted.clone(), idx.clone()));
            TradingGit {
                inner: Mutex::new(git),
                scripted,
                scripted_idx: idx,
            }
        }

        /// Restore from a previously exported state JSON string.
        #[napi(factory)]
        pub fn restore(state_json: String) -> Result<Self> {
            let state: GitExportState = serde_json::from_str(&state_json).map_err(|e| {
                napi::Error::new(napi::Status::InvalidArg, format!("invalid state JSON: {e}"))
            })?;
            let scripted: Arc<Mutex<Vec<OperationResult>>> = Arc::new(Mutex::new(vec![]));
            let idx = Arc::new(AtomicUsize::new(0));
            let git = RustTradingGit::restore(state, make_config(scripted.clone(), idx.clone()));
            Ok(TradingGit {
                inner: Mutex::new(git),
                scripted,
                scripted_idx: idx,
            })
        }

        /// Stage an operation. operation_json is JSON of the Operation (serde_json
        /// tagged enum). Returns JSON of AddResult.
        #[napi]
        pub fn add(&self, operation_json: String) -> Result<String> {
            let op: Operation = serde_json::from_str(&operation_json).map_err(|e| {
                napi::Error::new(
                    napi::Status::InvalidArg,
                    format!("invalid operation JSON: {e}"),
                )
            })?;
            let mut g = self.inner.lock().unwrap();
            let result = g.add(op);
            serde_json::to_string(&result).map_err(|e| {
                napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
            })
        }

        /// Prepare a commit. Returns JSON of CommitPrepareResult.
        #[napi]
        pub fn commit(&self, message: String) -> Result<String> {
            let mut g = self.inner.lock().unwrap();
            let result = g
                .commit(message)
                .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))?;
            serde_json::to_string(&result).map_err(|e| {
                napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
            })
        }

        /// Execute staged operations.
        ///
        /// stub_results_json: optional JSON array of OperationResult to use as
        /// scripted responses. When provided, they are loaded into the shared
        /// buffer and consumed in order by the execute_operation closure.
        /// An empty array (or None) causes the closure to use a default stub.
        ///
        /// Returns JSON of PushResult.
        #[napi]
        pub fn push(&self, stub_results_json: Option<String>) -> Result<String> {
            // Load scripted results if provided.
            if let Some(json) = stub_results_json {
                let results: Vec<OperationResult> = serde_json::from_str(&json).map_err(|e| {
                    napi::Error::new(
                        napi::Status::InvalidArg,
                        format!("invalid stub_results JSON: {e}"),
                    )
                })?;
                *self.scripted.lock().unwrap() = results;
                self.scripted_idx.store(0, Ordering::SeqCst);
            }

            let mut g = self.inner.lock().unwrap();
            let result = g
                .push()
                .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))?;
            serde_json::to_string(&result).map_err(|e| {
                napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
            })
        }

        /// Reject the pending commit. Returns JSON of RejectResult.
        #[napi]
        pub fn reject(&self, reason: Option<String>) -> Result<String> {
            let mut g = self.inner.lock().unwrap();
            let result = g
                .reject(reason)
                .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))?;
            serde_json::to_string(&result).map_err(|e| {
                napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
            })
        }

        /// Export the current state as JSON string (GitExportState).
        #[napi]
        pub fn export_state(&self) -> Result<String> {
            let g = self.inner.lock().unwrap();
            let state = g.export_state();
            serde_json::to_string(&state).map_err(|e| {
                napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
            })
        }

        /// Show a commit by hash. Returns JSON of GitCommit or null.
        #[napi]
        pub fn show(&self, hash: String) -> Result<Option<String>> {
            let g = self.inner.lock().unwrap();
            match g.show(&hash) {
                Some(commit) => {
                    let json = serde_json::to_string(&commit).map_err(|e| {
                        napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
                    })?;
                    Ok(Some(json))
                }
                None => Ok(None),
            }
        }

        /// Get current status as JSON string (GitStatus).
        #[napi]
        pub fn status(&self) -> Result<String> {
            let g = self.inner.lock().unwrap();
            let status = g.status();
            serde_json::to_string(&status).map_err(|e| {
                napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
            })
        }

        /// Get canonical JSON of the export state (pretty=true matches TS canonicalJson).
        #[napi]
        pub fn canonical_export_state(&self) -> Result<String> {
            let g = self.inner.lock().unwrap();
            let state = g.export_state();
            let value: Value = serde_json::to_value(&state).map_err(|e| {
                napi::Error::new(napi::Status::GenericFailure, format!("serialize: {e}"))
            })?;
            Ok(canonical_json(&value, true))
        }
    }
}
