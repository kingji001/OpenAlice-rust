//! Canonical JSON serializer.
//!
//! Mirrors src/domain/trading/canonical-json.ts:
//!   - Sort object keys recursively (alphabetical, ASCII).
//!   - Arrays preserve order (semantic).
//!   - No whitespace by default; pretty option mirrors JSON.stringify(., ., 2).
//!
//! The caller is responsible for converting Decimals to canonical strings
//! BEFORE calling this — canonical_json operates on serde_json::Value only.

use serde_json::{Map, Value};

/// Serialize a serde_json::Value to canonical JSON.
///
/// `pretty = true` emits 2-space indentation matching JSON.stringify(., ., 2).
pub fn canonical_json(value: &Value, pretty: bool) -> String {
    let sorted = sort_keys_recursive(value);
    if pretty {
        serde_json::to_string_pretty(&sorted).expect("serialize never fails on Value")
    } else {
        serde_json::to_string(&sorted).expect("serialize never fails on Value")
    }
}

fn sort_keys_recursive(value: &Value) -> Value {
    match value {
        Value::Object(m) => {
            // BTreeMap-equivalent: collect keys, sort ASCII, rebuild.
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut sorted = Map::new();
            for k in keys {
                sorted.insert(k.clone(), sort_keys_recursive(&m[k]));
            }
            Value::Object(sorted)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sort_keys_recursive).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_keys_sorted() {
        let v = json!({ "b": 1, "a": 2, "c": 3 });
        assert_eq!(canonical_json(&v, false), r#"{"a":2,"b":1,"c":3}"#);
    }

    #[test]
    fn nested_objects_sorted() {
        let v = json!({ "outer": { "z": 1, "a": 2 }, "alpha": "x" });
        assert_eq!(
            canonical_json(&v, false),
            r#"{"alpha":"x","outer":{"a":2,"z":1}}"#
        );
    }

    #[test]
    fn arrays_preserve_order() {
        let v = json!([3, 1, 2]);
        assert_eq!(canonical_json(&v, false), "[3,1,2]");
    }

    #[test]
    fn pretty_format() {
        let v = json!({ "b": 1, "a": 2 });
        let pretty = canonical_json(&v, true);
        assert_eq!(pretty, "{\n  \"a\": 2,\n  \"b\": 1\n}");
    }
}
