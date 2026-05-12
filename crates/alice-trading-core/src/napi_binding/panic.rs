//! Panic wrapper for napi FFI boundary.
//!
//! `catch_unwind_napi` wraps any closure that returns a `napi::Result<R>`.
//! `async_catch_unwind_napi` wraps any future that returns a `napi::Result<R>`.
//! A Rust panic inside either wrapper is caught and converted into a
//! `RUST_PANIC: <message>` napi error rather than aborting the Node.js process.

use napi::{Error, Status};
use std::panic::AssertUnwindSafe;

/// Convert a panic payload box into a human-readable string.
fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .copied()
        .map(String::from)
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(non-string panic payload)".to_string())
}

/// Wrap a synchronous closure, converting any Rust panic into a typed
/// `RUST_PANIC:` napi error. The `account_id` is included in the log.
pub fn catch_unwind_napi<F, R>(account_id: &str, f: F) -> napi::Result<R>
where
    F: FnOnce() -> napi::Result<R>,
{
    match std::panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => {
            let msg = panic_payload_message(payload);
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

/// Wrap an async future, converting any Rust panic into a typed
/// `RUST_PANIC:` napi error. The `account_id` is included in the log.
pub async fn async_catch_unwind_napi<F, R>(account_id: &str, fut: F) -> napi::Result<R>
where
    F: std::future::Future<Output = napi::Result<R>>,
{
    use futures::FutureExt;
    let fut = AssertUnwindSafe(fut);
    match fut.catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            let msg = panic_payload_message(payload);
            tracing::error!(
                target: "napi",
                account = %account_id,
                panic = %msg,
                "Rust panic at FFI boundary (async)"
            );
            Err(Error::new(
                Status::GenericFailure,
                format!("RUST_PANIC: {}", msg),
            ))
        }
    }
}
