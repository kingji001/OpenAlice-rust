//! GOLDEN BYTES.
//!
//! Pins the SHA-256 produced by Rust generate_intent_hash_v2 for a fixed
//! input. The expected hex is captured from the TS implementation in Phase
//! 2 (src/domain/trading/__test__/hash-v2.spec.ts golden test).
//!
//! If this test fails, Rust diverged from TS — DO NOT update the hex
//! without first proving the TS output also changed (which would itself
//! be a Phase 2-breaking incident requiring a separate fix).

use alice_trading_core::hash_v2::{generate_intent_hash_v2, HashV2Input};

#[test]
fn rust_hash_matches_ts_phase_2_golden_bytes() {
    let out = generate_intent_hash_v2(HashV2Input {
        parent_hash: None,
        message: "golden test",
        operations: &[],
        hash_input_timestamp: "2026-01-01T00:00:00.000Z",
    });
    assert_eq!(
        out.intent_full_hash, "2a98a2d0ae18fa1bd6a744d5281b641a38296018aad9f73d7df9b209be23c97d",
        "Rust hash diverged from Phase 2 TS golden bytes"
    );
}
