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
/// The TypeScript `RustUtaProxy._call()` strips the prefix, parses the JSON,
/// and uses `Object.setPrototypeOf` to reconstruct a `BrokerError` instance.
pub fn broker_error_to_napi(e: BrokerError) -> napi::Error {
    let encoded = serde_json::json!({
        "code": format!("{:?}", e.code),
        "message": e.message,
        "permanent": e.permanent,
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
        assert_eq!(parsed["code"], "Config");
        assert_eq!(parsed["message"], "disabled");
        assert_eq!(parsed["permanent"], true);
    }

    #[test]
    fn broker_error_network_is_not_permanent() {
        let e = BrokerError::new(BrokerErrorCode::Network, "timeout");
        let napi_err = broker_error_to_napi(e);
        let json_str = napi_err.reason.strip_prefix("BROKER_ERROR:").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["permanent"], false);
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
