//! Canonical decimal string + wire-form discriminated unions.
//!
//! Mirrors src/domain/trading/canonical-decimal.ts and src/domain/trading/wire-types.ts.
//! Byte-parity against TS verified by tests/canonical_decimal_parity.rs.

use bigdecimal::{BigDecimal, Zero};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CanonicalDecimalError {
    #[error("NaN is not representable")]
    NaN,
    #[error("Infinity is not representable")]
    Infinity,
    #[error("invalid decimal string: {0}")]
    Parse(String),
}

/// Canonical decimal string. The wrapped string conforms to TS rules:
///   - no exponent notation
///   - no leading '+'
///   - no trailing decimal point
///   - canonical zero = "0" (never "-0", "0.0", "0e0")
///   - negative sign only on nonzero
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DecimalString(pub String);

impl DecimalString {
    pub fn new(s: impl Into<String>) -> Result<Self, CanonicalDecimalError> {
        let s: String = s.into();
        let bd =
            BigDecimal::from_str(&s).map_err(|e| CanonicalDecimalError::Parse(e.to_string()))?;
        Ok(Self(to_canonical_decimal_string(&bd)?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Convert a BigDecimal to its canonical TS string form.
///
/// Mirrors src/domain/trading/canonical-decimal.ts::toCanonicalDecimalString.
/// Implementation rules:
///   - reject NaN/Infinity (BigDecimal can't actually represent these but defend anyway)
///   - canonical zero = "0"
///   - strip trailing zeros after decimal point
///   - strip the decimal point itself if no fractional part remains
///   - negative sign only for nonzero
///   - no exponent notation (BigDecimal::to_string can emit exponent — we strip)
pub fn to_canonical_decimal_string(d: &BigDecimal) -> Result<String, CanonicalDecimalError> {
    // Canonical zero: "-0" → "0", "0" stays "0", "0.0" → "0".
    if d.is_zero() {
        return Ok("0".to_string());
    }

    // Get the plain (non-exponent) string form. BigDecimal::to_string()
    // produces e.g. "1.23E+5" for some inputs — we need plain "123000".
    // The bigdecimal crate has `.to_plain_string()` for this.
    let mut s = d.to_plain_string();

    // Strip trailing zeros after decimal point.
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }

    // BigDecimal doesn't emit leading '+' so no need to strip.
    Ok(s)
}

// ============================================================================
// Wire-form discriminated unions — mirror src/domain/trading/wire-types.ts
// ============================================================================

/// Decimal field on the wire. Sentinel UNSET_DECIMAL = 2^127-1 → Unset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WireDecimal {
    Unset,
    Value { value: DecimalString },
}

/// Floating-point field on the wire. Sentinel UNSET_DOUBLE = f64::MAX → Unset.
/// Real values are string-encoded (DecimalString) to avoid IEEE-754 drift.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WireDouble {
    Unset,
    Value { value: DecimalString },
}

/// Integer field on the wire. Sentinel UNSET_INTEGER = 2^31-1 → Unset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WireInteger {
    Unset,
    Value { value: i64 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_zero() {
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("0").unwrap()).unwrap(),
            "0"
        );
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("-0").unwrap()).unwrap(),
            "0"
        );
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("0.0").unwrap()).unwrap(),
            "0"
        );
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("0.00000").unwrap()).unwrap(),
            "0"
        );
    }

    #[test]
    fn strip_trailing_zeros() {
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("150.50").unwrap()).unwrap(),
            "150.5"
        );
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("1.000").unwrap()).unwrap(),
            "1"
        );
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("100.000").unwrap()).unwrap(),
            "100"
        );
    }

    #[test]
    fn negative_nonzero() {
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("-1.5").unwrap()).unwrap(),
            "-1.5"
        );
        assert_eq!(
            to_canonical_decimal_string(&BigDecimal::from_str("-100").unwrap()).unwrap(),
            "-100"
        );
    }

    #[test]
    fn no_exponent_notation() {
        // Large numbers should NOT become "1E+38"
        let big = BigDecimal::from_str("100000000000000000000000000000000000000").unwrap();
        let s = to_canonical_decimal_string(&big).unwrap();
        assert!(!s.contains('E') && !s.contains('e'), "got: {}", s);
    }
}
