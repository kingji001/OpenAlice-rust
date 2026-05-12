//! PersistedCommit decoder — Rust mirror of src/domain/trading/git/persisted-commit.ts.
//!
//! V1Opaque carries the raw serde_json::Value; v1 commits are NEVER
//! re-canonicalized or re-hashed (v4 §6.2). This is the ONLY place a
//! serde_json::Value appears in the public Rust API surface.

use crate::canonical::canonical_json;
use crate::operation_wire::operation_to_wire;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub enum PersistedCommit {
    V1Opaque(Value),
    V2(Value),
}

impl PersistedCommit {
    /// Classify a raw commit JSON. hashVersion === 2 → V2, else → V1Opaque.
    pub fn classify(raw: Value) -> Self {
        match raw.get("hashVersion").and_then(|v| v.as_i64()) {
            Some(2) => PersistedCommit::V2(raw),
            _ => PersistedCommit::V1Opaque(raw),
        }
    }

    /// Round-trip serialize. Returns the raw value verbatim.
    pub fn serialize(self) -> Value {
        match self {
            PersistedCommit::V1Opaque(v) | PersistedCommit::V2(v) => v,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyKind {
    Verified,
    Mismatch,
    Skipped,
}

pub struct VerifyResult {
    pub kind: VerifyKind,
    pub hash: String,
    pub expected_intent_full_hash: Option<String>,
    pub actual_intent_full_hash: Option<String>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct VerifyOptions {
    pub strict: bool,
}

pub fn verify_commit(
    persisted: &PersistedCommit,
    opts: &VerifyOptions,
) -> Result<VerifyResult, String> {
    match persisted {
        PersistedCommit::V1Opaque(raw) => Ok(VerifyResult {
            kind: VerifyKind::Skipped,
            hash: raw
                .get("hash")
                .and_then(|h| h.as_str())
                .unwrap_or("")
                .to_string(),
            expected_intent_full_hash: None,
            actual_intent_full_hash: None,
            message: None,
        }),
        PersistedCommit::V2(c) => verify_v2(c, opts),
    }
}

fn verify_v2(c: &Value, opts: &VerifyOptions) -> Result<VerifyResult, String> {
    let hash = c
        .get("hash")
        .and_then(|h| h.as_str())
        .unwrap_or("")
        .to_string();
    let intent_full_hash = c.get("intentFullHash").and_then(|h| h.as_str());
    let hash_input_ts = c.get("hashInputTimestamp").and_then(|t| t.as_str());

    let (intent_full_hash, hash_input_ts) = match (intent_full_hash, hash_input_ts) {
        (Some(h), Some(t)) => (h, t),
        _ => {
            let msg = format!(
                "v2 commit {} is missing intentFullHash or hashInputTimestamp",
                hash
            );
            if opts.strict {
                return Err(msg);
            }
            return Ok(VerifyResult {
                kind: VerifyKind::Mismatch,
                hash,
                expected_intent_full_hash: None,
                actual_intent_full_hash: None,
                message: Some(msg),
            });
        }
    };

    let parent_hash = c.get("parentHash").and_then(|p| p.as_str());
    let message_str = c.get("message").and_then(|m| m.as_str()).unwrap_or("");
    let empty_ops = vec![];
    let operations = c
        .get("operations")
        .and_then(|o| o.as_array())
        .unwrap_or(&empty_ops);
    let wire_ops: Vec<Value> = operations.iter().map(operation_to_wire).collect();
    let canonical = canonical_json(
        &json!({
            "hashVersion": 2,
            "parentHash": parent_hash,
            "message": message_str,
            "operations": wire_ops,
            "hashInputTimestamp": hash_input_ts,
        }),
        false,
    );
    let actual = hex::encode(Sha256::digest(canonical.as_bytes()));

    if actual != intent_full_hash {
        let msg = format!(
            "v2 commit {}: intentFullHash mismatch (expected {}…, got {}…)",
            hash,
            &intent_full_hash[..8],
            &actual[..8],
        );
        if opts.strict {
            return Err(msg);
        }
        return Ok(VerifyResult {
            kind: VerifyKind::Mismatch,
            hash,
            expected_intent_full_hash: Some(intent_full_hash.to_string()),
            actual_intent_full_hash: Some(actual),
            message: Some(msg),
        });
    }

    Ok(VerifyResult {
        kind: VerifyKind::Verified,
        hash,
        expected_intent_full_hash: Some(intent_full_hash.to_string()),
        actual_intent_full_hash: Some(actual),
        message: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_v2() {
        let raw = json!({ "hashVersion": 2, "hash": "abc12345" });
        assert!(matches!(
            PersistedCommit::classify(raw),
            PersistedCommit::V2(_)
        ));
    }

    #[test]
    fn classify_v1_when_absent() {
        let raw = json!({ "hash": "abc12345" });
        assert!(matches!(
            PersistedCommit::classify(raw),
            PersistedCommit::V1Opaque(_)
        ));
    }

    #[test]
    fn classify_v1_explicit() {
        let raw = json!({ "hashVersion": 1, "hash": "abc12345" });
        assert!(matches!(
            PersistedCommit::classify(raw),
            PersistedCommit::V1Opaque(_)
        ));
    }

    #[test]
    fn verify_v1_skipped() {
        let raw = json!({ "hash": "abc12345" });
        let p = PersistedCommit::classify(raw);
        let r = verify_commit(&p, &VerifyOptions::default()).unwrap();
        assert_eq!(r.kind, VerifyKind::Skipped);
    }

    #[test]
    fn verify_v2_missing_fields_mismatch() {
        let raw = json!({ "hashVersion": 2, "hash": "abc12345" });
        let p = PersistedCommit::classify(raw);
        let r = verify_commit(&p, &VerifyOptions::default()).unwrap();
        assert_eq!(r.kind, VerifyKind::Mismatch);
        assert!(r.message.unwrap().contains("missing"));
    }

    #[test]
    fn strict_mode_throws_on_missing_fields() {
        let raw = json!({ "hashVersion": 2, "hash": "abc12345" });
        let p = PersistedCommit::classify(raw);
        let opts = VerifyOptions { strict: true };
        assert!(verify_commit(&p, &opts).is_err());
    }

    #[test]
    fn serialize_roundtrip_v1() {
        let raw = json!({ "hash": "abc12345" });
        let p = PersistedCommit::classify(raw.clone());
        assert_eq!(p.serialize(), raw);
    }

    #[test]
    fn serialize_roundtrip_v2() {
        let raw = json!({ "hashVersion": 2, "hash": "abc12345" });
        let p = PersistedCommit::classify(raw.clone());
        assert_eq!(p.serialize(), raw);
    }
}
