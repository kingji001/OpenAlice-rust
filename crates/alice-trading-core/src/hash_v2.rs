//! Hash v2 algorithm — canonical SHA-256 over wire-form commit intent.
//!
//! Mirrors src/domain/trading/git/hash-v2.ts.

use crate::canonical::canonical_json;
use crate::operation_wire::operation_to_wire;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub struct HashV2Input<'a> {
    pub parent_hash: Option<&'a str>,
    pub message: &'a str,
    pub operations: &'a [Value],
    pub hash_input_timestamp: &'a str,
}

pub struct HashV2Output {
    pub intent_full_hash: String,
    pub short_hash: String,
}

pub fn generate_intent_hash_v2(input: HashV2Input) -> HashV2Output {
    let wire_ops: Vec<Value> = input.operations.iter().map(operation_to_wire).collect();
    let canonical = canonical_json(
        &json!({
            "hashVersion": 2,
            "parentHash": input.parent_hash,
            "message": input.message,
            "operations": wire_ops,
            "hashInputTimestamp": input.hash_input_timestamp,
        }),
        false,
    );
    let intent_full_hash = hex::encode(Sha256::digest(canonical.as_bytes()));
    let short_hash = intent_full_hash[..8].to_string();
    HashV2Output {
        intent_full_hash,
        short_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_operations_produces_64_char_hex() {
        let out = generate_intent_hash_v2(HashV2Input {
            parent_hash: None,
            message: "test",
            operations: &[],
            hash_input_timestamp: "2026-01-01T00:00:00.000Z",
        });
        assert_eq!(out.intent_full_hash.len(), 64);
        assert!(out.intent_full_hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(out.short_hash, &out.intent_full_hash[..8]);
    }

    #[test]
    fn deterministic() {
        let make = || {
            generate_intent_hash_v2(HashV2Input {
                parent_hash: None,
                message: "test",
                operations: &[],
                hash_input_timestamp: "2026-01-01T00:00:00.000Z",
            })
        };
        assert_eq!(make().intent_full_hash, make().intent_full_hash);
    }

    #[test]
    fn different_timestamps_diverge() {
        let a = generate_intent_hash_v2(HashV2Input {
            parent_hash: None,
            message: "x",
            operations: &[],
            hash_input_timestamp: "2026-01-01T00:00:00.000Z",
        });
        let b = generate_intent_hash_v2(HashV2Input {
            parent_hash: None,
            message: "x",
            operations: &[],
            hash_input_timestamp: "2026-01-02T00:00:00.000Z",
        });
        assert_ne!(a.intent_full_hash, b.intent_full_hash);
    }
}
