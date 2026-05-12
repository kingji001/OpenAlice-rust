//! Guard registry — resolve named guard configs into Guard instances.
//!
//! Mirrors TS resolveGuards at src/domain/trading/guards/registry.ts.
//! Unknown guard types emit a warning and are skipped (matches TS
//! console.warn behavior).

use crate::guards::cooldown::CooldownGuard;
use crate::guards::max_position_size::MaxPositionSizeGuard;
use crate::guards::symbol_whitelist::SymbolWhitelistGuard;
use crate::guards::traits::Guard;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct GuardConfig {
    #[serde(rename = "type")]
    pub guard_type: String,
    #[serde(default)]
    pub options: Value,
}

/// Resolve a list of GuardConfig entries into Guard instances.
/// Unknown guard types or config parse errors emit warnings and
/// are silently skipped (matches TS registry.ts behavior).
pub fn resolve_guards(configs: &[GuardConfig]) -> Vec<Box<dyn Guard>> {
    let mut out: Vec<Box<dyn Guard>> = Vec::new();
    for cfg in configs {
        match cfg.guard_type.as_str() {
            "cooldown" => match CooldownGuard::from_options(&cfg.options) {
                Ok(g) => out.push(Box::new(g)),
                Err(e) => tracing::warn!(
                    target = "guards", guard = "cooldown",
                    error = %e, "config parse failed; skipped",
                ),
            },
            "max-position-size" => match MaxPositionSizeGuard::from_options(&cfg.options) {
                Ok(g) => out.push(Box::new(g)),
                Err(e) => tracing::warn!(
                    target = "guards", guard = "max-position-size",
                    error = %e, "config parse failed; skipped",
                ),
            },
            "symbol-whitelist" => match SymbolWhitelistGuard::from_options(&cfg.options) {
                Ok(g) => out.push(Box::new(g)),
                Err(e) => tracing::warn!(
                    target = "guards", guard = "symbol-whitelist",
                    error = %e, "config parse failed; skipped",
                ),
            },
            other => {
                tracing::warn!(
                    target = "guards",
                    "unknown guard type \"{}\", skipped",
                    other
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_three_builtin_types() {
        let configs: Vec<GuardConfig> = serde_json::from_value(json!([
            {"type": "cooldown", "options": {"minIntervalMs": 1000}},
            {"type": "max-position-size", "options": {"maxPercentOfEquity": 25}},
            {"type": "symbol-whitelist", "options": {"symbols": ["AAPL"]}},
        ]))
        .unwrap();
        let guards = resolve_guards(&configs);
        assert_eq!(guards.len(), 3);
        assert_eq!(guards[0].name(), "cooldown");
        assert_eq!(guards[1].name(), "max-position-size");
        assert_eq!(guards[2].name(), "symbol-whitelist");
    }

    #[test]
    fn unknown_type_skipped_without_error() {
        let configs: Vec<GuardConfig> = serde_json::from_value(json!([
            {"type": "cooldown", "options": {"minIntervalMs": 1000}},
            {"type": "bogus-guard", "options": {}},
            {"type": "symbol-whitelist", "options": {"symbols": ["AAPL"]}},
        ]))
        .unwrap();
        let guards = resolve_guards(&configs);
        assert_eq!(guards.len(), 2); // cooldown + symbol-whitelist; bogus-guard skipped
    }

    #[test]
    fn invalid_config_skipped() {
        // symbol-whitelist requires non-empty symbols — invalid config
        let configs: Vec<GuardConfig> = serde_json::from_value(json!([
            {"type": "symbol-whitelist", "options": {"symbols": []}},
        ]))
        .unwrap();
        let guards = resolve_guards(&configs);
        assert_eq!(guards.len(), 0);
    }
}
