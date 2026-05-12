//! Phase 5 D3 — WireDecimal UNSET_DECIMAL round-trip tests.
//!
//! Pins Rust-side handling of the IBKR sentinel value (2^127 - 1).
//! Mirrors what Phase 1b verified on the TS side (canonical-decimal.ts).
//!
//! v4 §6.1: `WireDecimal::Unset` encodes UNSET_DECIMAL; `WireDecimal::Value`
//! holds any real decimal in canonical string form.

use alice_trading_core::decimal::{
    to_canonical_decimal_string, CanonicalDecimalError, DecimalString, WireDecimal,
};
use bigdecimal::BigDecimal;
use std::str::FromStr;

// The canonical plain-integer form of 2^127 - 1.
const UNSET_DECIMAL_PLAIN: &str = "170141183460469231731687303715884105727";

// ---------------------------------------------------------------------------
// Test 1: WireDecimal::Unset round-trips cleanly via the canonical wire format
// ---------------------------------------------------------------------------

#[test]
fn wire_decimal_unset_round_trips() {
    let original = WireDecimal::Unset;

    // Serialize to JSON string (the "canonical wire format" for transport).
    let json_str = serde_json::to_string(&original).expect("serialize Unset");

    // Deserialize back.
    let recovered: WireDecimal = serde_json::from_str(&json_str).expect("deserialize Unset");

    assert_eq!(
        recovered, original,
        "WireDecimal::Unset must round-trip via JSON exactly: got {:?}",
        recovered
    );

    // Also confirm the JSON shape matches the discriminated-union contract.
    // serde with tag = "kind", rename_all = "lowercase" → {"kind":"unset"}
    assert_eq!(
        json_str, r#"{"kind":"unset"}"#,
        "WireDecimal::Unset must serialize to {{\"kind\":\"unset\"}}"
    );
}

// ---------------------------------------------------------------------------
// Test 2: WireDecimal::Value round-trips for a small and a large value
// ---------------------------------------------------------------------------

#[test]
fn wire_decimal_value_round_trips() {
    // Small value: 1.5e-30 — far away from the UNSET_DECIMAL sentinel.
    let small_str = "0.0000000000000000000000000000015"; // 1.5e-30 in plain form
    let small_ds = DecimalString::new(small_str).expect("DecimalString for small value");
    let small_original = WireDecimal::Value { value: small_ds };

    let small_json = serde_json::to_string(&small_original).expect("serialize small value");
    let small_recovered: WireDecimal =
        serde_json::from_str(&small_json).expect("deserialize small value");
    assert_eq!(
        small_recovered, small_original,
        "small WireDecimal::Value must round-trip; json was: {}",
        small_json
    );

    // Large value: a 38-digit integer that is NOT the unset sentinel.
    // 2^126 = 85070591730234615865843651857942052864
    let large_str = "85070591730234615865843651857942052864";
    let large_ds = DecimalString::new(large_str).expect("DecimalString for large value");
    let large_original = WireDecimal::Value { value: large_ds };

    let large_json = serde_json::to_string(&large_original).expect("serialize large value");
    let large_recovered: WireDecimal =
        serde_json::from_str(&large_json).expect("deserialize large value");
    assert_eq!(
        large_recovered, large_original,
        "large WireDecimal::Value must round-trip; json was: {}",
        large_json
    );

    // Confirm shape: {"kind":"value","value":"<canonical>"}
    assert!(
        large_json.contains(r#""kind":"value""#),
        "WireDecimal::Value JSON must contain kind:value; got: {}",
        large_json
    );
    assert!(
        large_json.contains(large_str),
        "WireDecimal::Value JSON must contain the canonical decimal string; got: {}",
        large_json
    );
}

// ---------------------------------------------------------------------------
// Test 3: Unset and Value(UNSET_DECIMAL_PLAIN) are distinct
// ---------------------------------------------------------------------------

#[test]
fn wire_decimal_unset_is_distinct_from_max_value() {
    // WireDecimal::Unset — the sentinel meaning "not set".
    let unset = WireDecimal::Unset;

    // WireDecimal::Value carrying the numeric value of 2^127-1 as a plain
    // decimal string.  This is legal to hold in a Value (it IS a number), but
    // must serialize differently from Unset and must not deserialize back as
    // Unset.
    let max_ds =
        DecimalString::new(UNSET_DECIMAL_PLAIN).expect("DecimalString for 2^127-1 plain integer");
    let max_value = WireDecimal::Value { value: max_ds };

    // They must compare unequal.
    assert_ne!(
        unset, max_value,
        "WireDecimal::Unset and WireDecimal::Value(2^127-1) must be distinct"
    );

    // Their JSON serializations must differ.
    let unset_json = serde_json::to_string(&unset).unwrap();
    let max_json = serde_json::to_string(&max_value).unwrap();
    assert_ne!(
        unset_json, max_json,
        "Unset and Value(2^127-1) must serialize differently.\n  unset: {}\n  value: {}",
        unset_json, max_json
    );

    // Deserializing the Unset JSON must NOT produce a Value.
    let from_unset_json: WireDecimal = serde_json::from_str(&unset_json).unwrap();
    assert!(
        matches!(from_unset_json, WireDecimal::Unset),
        "JSON {:?} must deserialize back to Unset, got {:?}",
        unset_json,
        from_unset_json
    );

    // Deserializing the Value(2^127-1) JSON must NOT produce Unset.
    let from_max_json: WireDecimal = serde_json::from_str(&max_json).unwrap();
    assert!(
        matches!(from_max_json, WireDecimal::Value { .. }),
        "JSON {:?} must deserialize back to Value, got {:?}",
        max_json,
        from_max_json
    );
}

// ---------------------------------------------------------------------------
// Test 4: to_canonical_decimal_string rejects NaN / Infinity
//
// BigDecimal cannot represent NaN or Infinity — attempting to parse those
// strings returns a parse error before reaching to_canonical_decimal_string.
// The function signature accepts &BigDecimal and can only return
// CanonicalDecimalError::NaN or CanonicalDecimalError::Infinity as
// defensive guards; since the type system makes the inputs impossible in
// practice, we document and test the parse-level rejection here.
// ---------------------------------------------------------------------------

#[test]
fn to_canonical_decimal_string_rejects_nan_infinity() {
    // The type system prevents constructing a BigDecimal for "NaN" or "Infinity".
    // We verify that parsing those strings fails (i.e., the type-system guarantee
    // matches our expectation), and that to_canonical_decimal_string is never
    // called with such values.

    let nan_parse = BigDecimal::from_str("NaN");
    assert!(
        nan_parse.is_err(),
        "BigDecimal must not parse 'NaN' — type system prevents NaN from reaching \
         to_canonical_decimal_string"
    );

    let inf_parse = BigDecimal::from_str("Infinity");
    assert!(
        inf_parse.is_err(),
        "BigDecimal must not parse 'Infinity' — type system prevents Infinity from reaching \
         to_canonical_decimal_string"
    );

    let neg_inf_parse = BigDecimal::from_str("-Infinity");
    assert!(
        neg_inf_parse.is_err(),
        "BigDecimal must not parse '-Infinity' — type system prevents -Infinity from reaching \
         to_canonical_decimal_string"
    );

    // For completeness: verify the error variants exist (so the defensive code
    // path compiles even if unreachable from well-typed callers).
    let _nan_err: CanonicalDecimalError = CanonicalDecimalError::NaN;
    let _inf_err: CanonicalDecimalError = CanonicalDecimalError::Infinity;
    // If the above lines compile, the variants are present in the public API.

    // Positive assertion: well-formed decimals still work.
    let bd = BigDecimal::from_str("3.14").unwrap();
    assert_eq!(
        to_canonical_decimal_string(&bd).unwrap(),
        "3.14",
        "to_canonical_decimal_string must still accept well-formed BigDecimal"
    );
}
