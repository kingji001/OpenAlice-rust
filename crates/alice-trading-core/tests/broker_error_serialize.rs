//! Mandatory parity test. Guards against the v2 `rename_all = "UPPERCASE"`
//! bug where MarketClosed would serialize to "MARKETCLOSED" (no underscore).
//!
//! These 6 strings MUST match TS BrokerErrorCode at brokers/types.ts:16.

use alice_trading_core::brokers::BrokerErrorCode;

#[test]
fn broker_error_codes_serialize_to_exact_ts_strings() {
    use BrokerErrorCode::*;
    assert_eq!(serde_json::to_string(&Config).unwrap(), "\"CONFIG\"");
    assert_eq!(serde_json::to_string(&Auth).unwrap(), "\"AUTH\"");
    assert_eq!(serde_json::to_string(&Network).unwrap(), "\"NETWORK\"");
    assert_eq!(serde_json::to_string(&Exchange).unwrap(), "\"EXCHANGE\"");
    assert_eq!(
        serde_json::to_string(&MarketClosed).unwrap(),
        "\"MARKET_CLOSED\""
    );
    assert_eq!(serde_json::to_string(&Unknown).unwrap(), "\"UNKNOWN\"");
}

#[test]
fn broker_error_codes_deserialize_from_exact_ts_strings() {
    use BrokerErrorCode::*;
    assert_eq!(
        serde_json::from_str::<BrokerErrorCode>("\"CONFIG\"").unwrap(),
        Config
    );
    assert_eq!(
        serde_json::from_str::<BrokerErrorCode>("\"AUTH\"").unwrap(),
        Auth
    );
    assert_eq!(
        serde_json::from_str::<BrokerErrorCode>("\"NETWORK\"").unwrap(),
        Network
    );
    assert_eq!(
        serde_json::from_str::<BrokerErrorCode>("\"EXCHANGE\"").unwrap(),
        Exchange
    );
    assert_eq!(
        serde_json::from_str::<BrokerErrorCode>("\"MARKET_CLOSED\"").unwrap(),
        MarketClosed
    );
    assert_eq!(
        serde_json::from_str::<BrokerErrorCode>("\"UNKNOWN\"").unwrap(),
        Unknown
    );
}

use alice_trading_core::brokers::classify_message;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Case {
    input: String,
    expected: Option<String>,
}

fn fixtures_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("parity/fixtures/broker-classify-messages/cases.json")
}

#[test]
fn classify_message_matches_fixture_corpus() {
    let json = fs::read_to_string(fixtures_path()).expect("fixture missing");
    let cases: Vec<Case> = serde_json::from_str(&json).expect("malformed fixture");
    assert!(cases.len() >= 30, "expected ≥30 cases, got {}", cases.len());

    let mut failures = Vec::new();
    for c in &cases {
        let actual = classify_message(&c.input);
        let actual_str = actual.map(|c| {
            serde_json::to_value(c)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        });
        if actual_str.as_deref() != c.expected.as_deref() {
            failures.push(format!(
                "input={:?} expected={:?} got={:?}",
                c.input, c.expected, actual_str,
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "Rust classify mismatches:\n{:#?}",
        failures
    );
}
