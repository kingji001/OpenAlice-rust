#!/usr/bin/env tsx
/**
 * parity/check-rust-panic.ts — Phase 4f Task E — SKIP STUB
 *
 * Phase 4f: Mock broker has no panic-injection mechanism exposed via the
 * napi boundary. The `async_catch_unwind_napi` Rust panic boundary is
 * tested at the Rust unit-test level (see
 * `crates/alice-trading-core/src/napi_binding/panic.rs`), but cannot be
 * exercised from TypeScript without modifying the Rust code to add a
 * test-only napi method.
 *
 * Options considered:
 *   a. SKIP in Phase 4f, defer to Phase 5/6 (chosen)
 *   b. Add a `#[cfg(feature = "test-panic-injection")]` method to Rust napi
 *      and a matching napi call in TS — expands scope beyond Phase 4f.
 *
 * The panic boundary is verified by the Rust-level test:
 *   cargo test --features napi-binding --lib -- panic
 *
 * This script exits 0 (skip is not a failure).
 *
 * Run: pnpm tsx parity/check-rust-panic.ts
 */

console.log('[skip] check-rust-panic.ts: Phase 4f skip stub')
console.log('       Mock broker has no panic injection via napi boundary.')
console.log('       async_catch_unwind_napi is tested at the Rust unit level.')
console.log('       Full panic boundary parity deferred to Phase 5/6.')
console.log('       See: crates/alice-trading-core/src/napi_binding/panic.rs')
process.exit(0)
