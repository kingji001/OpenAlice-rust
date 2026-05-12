//! Verifies Rust `to_canonical_decimal_string` produces byte-identical
//! output to TS `toCanonicalDecimalString` for every case in the shared
//! fixture corpus.

use alice_trading_core::decimal::to_canonical_decimal_string;
use bigdecimal::BigDecimal;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Deserialize)]
struct Case {
    input: String,
    expected: String,
}

fn fixtures_path() -> PathBuf {
    // CARGO_MANIFEST_DIR is crates/alice-trading-core; parity/ is at repo root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("parity/fixtures/canonical-decimal/cases.json")
}

#[test]
fn rust_matches_canonical_decimal_fixtures() {
    let json = fs::read_to_string(fixtures_path()).expect("fixture missing");
    let cases: Vec<Case> = serde_json::from_str(&json).expect("malformed fixture");
    assert!(!cases.is_empty(), "fixture corpus is empty");

    let mut failures = Vec::new();
    for c in &cases {
        let bd = BigDecimal::from_str(&c.input).expect("input parse");
        let actual = to_canonical_decimal_string(&bd).expect("canonical");
        if actual != c.expected {
            failures.push(format!(
                "input={} expected={} got={}",
                c.input, c.expected, actual
            ));
        }
    }
    assert!(failures.is_empty(), "Rust mismatches: {:#?}", failures);
}
