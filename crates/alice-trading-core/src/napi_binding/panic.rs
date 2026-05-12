//! Panic wrapper for napi FFI boundary.
//!
//! `catch_unwind_napi` wraps any closure that returns a `napi::Result<R>`.
//! A Rust panic inside the closure is caught and converted into a
//! `RUST_PANIC: <message>` napi error rather than aborting the Node.js process.

use napi::{Error, Status};
use std::panic::AssertUnwindSafe;

/// Wrap a synchronous closure, converting any Rust panic into a typed
/// `RUST_PANIC:` napi error. The `account_id` is included in the log.
pub fn catch_unwind_napi<F, R>(account_id: &str, f: F) -> napi::Result<R>
where
    F: FnOnce() -> napi::Result<R>,
{
    match std::panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("(non-string panic payload)");
            tracing::error!(
                target: "napi",
                account = %account_id,
                panic = %msg,
                "Rust panic at FFI boundary"
            );
            Err(Error::new(
                Status::GenericFailure,
                format!("RUST_PANIC: {}", msg),
            ))
        }
    }
}
