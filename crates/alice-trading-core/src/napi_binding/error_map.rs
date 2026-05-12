//! BrokerError → napi::Error conversion.
//!
//! Encodes a `BrokerError` as a `BROKER_ERROR:{json}` napi error so that the
//! TypeScript host can reliably detect and reconstruct typed `BrokerError`
//! objects (via the `BROKER_ERROR:` prefix + JSON parse in `RustUtaProxy._call`).

use crate::brokers::error::BrokerError;

/// Convert a `BrokerError` into a `napi::Error` with an encoded payload.
///
/// The error message has the form:
/// ```text
/// BROKER_ERROR:{"code":"NETWORK","message":"...","permanent":false,"broker":null,"details_json":null}
/// ```
///
/// `code` uses the canonical serde representation (`SCREAMING_SNAKE_CASE`, matching
/// `BrokerErrorCode`'s `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`), NOT the
/// Debug format. This ensures TS-side reconstruction (`setPrototypeOf`) sees
/// "NETWORK" rather than "Network".
///
/// `broker` and `details_json` are Phase 4f stubs emitted as `null`. Phase 6
/// will plumb the source broker name and a structured details payload.
///
/// The TypeScript `RustUtaProxy._call()` strips the prefix, parses the JSON,
/// and uses `Object.setPrototypeOf` to reconstruct a `BrokerError` instance.
pub fn broker_error_to_napi(e: BrokerError) -> napi::Error {
    let code_str = serde_json::to_value(e.code)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| format!("{:?}", e.code)); // fallback only
    let encoded = serde_json::json!({
        "code": code_str,
        "message": e.message,
        "permanent": e.permanent,
        "broker": Option::<String>::None,        // null — Phase 6 will plumb source broker
        "details_json": Option::<String>::None,  // null — reserved for future details payload
    });
    napi::Error::new(
        napi::Status::GenericFailure,
        format!("BROKER_ERROR:{}", encoded),
    )
}

/// Convert a `String` error (from Add/Commit which return `Result<_, String>`)
/// into a napi `GenericFailure` error.
pub fn string_error_to_napi(e: String) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, e)
}

/// Convert a JSON parse error into a napi `InvalidArg` error.
pub fn json_parse_error_to_napi(field: &str, e: serde_json::Error) -> napi::Error {
    napi::Error::new(
        napi::Status::InvalidArg,
        format!("failed to parse {}: {}", field, e),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brokers::error::{BrokerError, BrokerErrorCode};

    #[test]
    fn broker_error_encodes_prefix() {
        let e = BrokerError::new(BrokerErrorCode::Network, "connection refused");
        let napi_err = broker_error_to_napi(e);
        let msg = napi_err.reason;
        assert!(msg.starts_with("BROKER_ERROR:"), "got: {}", msg);
    }

    #[test]
    fn broker_error_json_is_valid() {
        let e = BrokerError::new(BrokerErrorCode::Config, "disabled");
        let napi_err = broker_error_to_napi(e);
        let msg = napi_err.reason;
        let json_str = msg.strip_prefix("BROKER_ERROR:").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_str).expect("valid JSON");
        // code must use serde SCREAMING_SNAKE_CASE, not Debug PascalCase
        assert_eq!(parsed["code"], "CONFIG");
        assert_eq!(parsed["message"], "disabled");
        assert_eq!(parsed["permanent"], true);
        // Phase 4f stubs: broker and details_json must be present and null
        assert!(parsed["broker"].is_null(), "broker should be null");
        assert!(
            parsed["details_json"].is_null(),
            "details_json should be null"
        );
    }

    #[test]
    fn broker_error_network_is_not_permanent() {
        let e = BrokerError::new(BrokerErrorCode::Network, "timeout");
        let napi_err = broker_error_to_napi(e);
        let json_str = napi_err.reason.strip_prefix("BROKER_ERROR:").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["permanent"], false);
        // SCREAMING_SNAKE_CASE for Network
        assert_eq!(parsed["code"], "NETWORK");
        // Stubs present and null
        assert!(parsed["broker"].is_null());
        assert!(parsed["details_json"].is_null());
    }

    #[test]
    fn broker_error_market_closed_code_is_screaming_snake_case() {
        let e = BrokerError::new(BrokerErrorCode::MarketClosed, "closed");
        let napi_err = broker_error_to_napi(e);
        let json_str = napi_err.reason.strip_prefix("BROKER_ERROR:").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["code"], "MARKET_CLOSED");
    }

    #[test]
    fn string_error_wraps_message() {
        let err = string_error_to_napi("actor stopped".to_string());
        assert_eq!(err.reason, "actor stopped");
    }

    #[test]
    fn json_parse_error_includes_field_name() {
        let parse_err = serde_json::from_str::<serde_json::Value>("not json").unwrap_err();
        let napi_err = json_parse_error_to_napi("contract_json", parse_err);
        assert!(
            napi_err.reason.contains("contract_json"),
            "got: {}",
            napi_err.reason
        );
    }
}
