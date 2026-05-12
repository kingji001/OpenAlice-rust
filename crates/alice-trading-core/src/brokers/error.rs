//! BrokerError + BrokerErrorCode + classify_message.
//!
//! Mirrors src/domain/trading/brokers/types.ts:16-60 exactly:
//!   - BrokerErrorCode → string literals (CONFIG, AUTH, NETWORK, EXCHANGE, MARKET_CLOSED, UNKNOWN)
//!   - permanent = true iff code is Config OR Auth
//!   - classify_message regex patterns identical to TS, including ordering
//!     (market-closed check BEFORE auth to avoid 403 misclassification)

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("[{code:?}] {message}")]
pub struct BrokerError {
    pub code: BrokerErrorCode,
    pub message: String,
    pub permanent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrokerErrorCode {
    Config,
    Auth,
    Network,
    Exchange,
    MarketClosed,
    Unknown,
}

impl BrokerError {
    /// Create a BrokerError. `permanent` is derived from the code:
    /// true for Config|Auth, false otherwise.
    pub fn new(code: BrokerErrorCode, message: impl Into<String>) -> Self {
        let permanent = matches!(code, BrokerErrorCode::Config | BrokerErrorCode::Auth);
        Self {
            code,
            message: message.into(),
            permanent,
        }
    }

    /// Wrap any displayable error, classifying by message pattern.
    /// Mirrors TS BrokerError.from() at brokers/types.ts:33-43.
    pub fn from_err<E: std::fmt::Display>(err: E, fallback: BrokerErrorCode) -> Self {
        let msg = err.to_string();
        let code = classify_message(&msg).unwrap_or(fallback);
        Self::new(code, msg)
    }
}

/// Classify an error message into a BrokerErrorCode based on regex patterns.
/// Returns None when no pattern matches (callers supply a fallback).
///
/// Mirrors TS BrokerError.classifyMessage() at brokers/types.ts:45-59.
/// Order matters: market-closed check FIRST (avoids 403 → AUTH misclassification).
pub fn classify_message(msg: &str) -> Option<BrokerErrorCode> {
    use BrokerErrorCode::*;
    // Market closed — check BEFORE auth/exchange to handle "403 market closed"
    if MARKET_CLOSED_RE.is_match(msg) {
        return Some(MarketClosed);
    }
    // Network / infrastructure
    if NETWORK_RE.is_match(msg) || RATE_LIMIT_RE.is_match(msg) || GATEWAY_RE.is_match(msg) {
        return Some(Network);
    }
    // Authentication (401 only — 403 handled above as market-closed or below as exchange)
    if AUTH_RE.is_match(msg) {
        return Some(Auth);
    }
    // Exchange-level rejections
    if FORBIDDEN_RE.is_match(msg) || INSUFFICIENT_RE.is_match(msg) {
        return Some(Exchange);
    }
    None
}

// Regex patterns mirrored from TS. (?i) = case-insensitive.

static MARKET_CLOSED_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)market.?closed|not.?open|trading.?halt|outside.?trading.?hours").unwrap()
});
static NETWORK_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)timeout|etimedout|econnrefused|econnreset|socket hang up|enotfound|fetch failed",
    )
    .unwrap()
});
static RATE_LIMIT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)429|rate.?limit|too many requests").unwrap());
static GATEWAY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)502|503|504|service.?unavailable|bad.?gateway").unwrap());
static AUTH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)401|unauthorized|invalid.?key|invalid.?signature|authentication").unwrap()
});
static FORBIDDEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)403|forbidden").unwrap());
static INSUFFICIENT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)insufficient|not.?enough|margin").unwrap());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_set_for_config_and_auth_only() {
        use BrokerErrorCode::*;
        assert!(BrokerError::new(Config, "x").permanent);
        assert!(BrokerError::new(Auth, "x").permanent);
        assert!(!BrokerError::new(Network, "x").permanent);
        assert!(!BrokerError::new(Exchange, "x").permanent);
        assert!(!BrokerError::new(MarketClosed, "x").permanent);
        assert!(!BrokerError::new(Unknown, "x").permanent);
    }

    #[test]
    fn classify_network_patterns() {
        assert_eq!(
            classify_message("Request timeout"),
            Some(BrokerErrorCode::Network)
        );
        assert_eq!(
            classify_message("ECONNREFUSED"),
            Some(BrokerErrorCode::Network)
        );
        assert_eq!(
            classify_message("429 Too Many Requests"),
            Some(BrokerErrorCode::Network)
        );
        assert_eq!(
            classify_message("503 Service Unavailable"),
            Some(BrokerErrorCode::Network)
        );
    }

    #[test]
    fn classify_market_closed_before_auth() {
        // "403 outside trading hours" should be MarketClosed, not Exchange or Auth
        assert_eq!(
            classify_message("403 outside trading hours"),
            Some(BrokerErrorCode::MarketClosed),
        );
    }

    #[test]
    fn classify_auth() {
        assert_eq!(
            classify_message("401 Unauthorized"),
            Some(BrokerErrorCode::Auth)
        );
        assert_eq!(classify_message("invalid key"), Some(BrokerErrorCode::Auth));
    }

    #[test]
    fn classify_exchange() {
        assert_eq!(
            classify_message("403 Forbidden"),
            Some(BrokerErrorCode::Exchange)
        );
        assert_eq!(
            classify_message("Insufficient margin"),
            Some(BrokerErrorCode::Exchange)
        );
    }

    #[test]
    fn classify_unknown_returns_none() {
        assert_eq!(classify_message("Something weird happened"), None);
    }

    #[test]
    fn from_err_uses_classified_code() {
        let err = std::io::Error::new(std::io::ErrorKind::TimedOut, "connection timeout");
        let be = BrokerError::from_err(err, BrokerErrorCode::Unknown);
        assert_eq!(be.code, BrokerErrorCode::Network);
        assert!(!be.permanent);
    }

    #[test]
    fn from_err_falls_back_when_no_classification() {
        let err = std::io::Error::other("weird thing");
        let be = BrokerError::from_err(err, BrokerErrorCode::Unknown);
        assert_eq!(be.code, BrokerErrorCode::Unknown);
    }
}
