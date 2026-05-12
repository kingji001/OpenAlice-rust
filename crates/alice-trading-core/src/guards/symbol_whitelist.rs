//! SymbolWhitelistGuard — rejects ops whose symbol is not in the allowed set.
//! Symbols of "unknown" pass through unrejected (matches TS behavior).

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

use crate::guards::traits::{Guard, GuardContext};
use crate::guards::util::get_operation_symbol;

#[derive(Debug, Deserialize)]
struct SymbolWhitelistOptions {
    symbols: Vec<String>,
    #[serde(flatten)]
    extras: HashMap<String, Value>,
}

pub struct SymbolWhitelistGuard {
    allowed: HashSet<String>,
}

#[derive(Debug)]
pub struct SymbolWhitelistConfigError(pub String);

impl std::fmt::Display for SymbolWhitelistConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SymbolWhitelistConfigError {}

impl SymbolWhitelistGuard {
    pub fn from_options(opts: &Value) -> Result<Self, SymbolWhitelistConfigError> {
        let parsed: SymbolWhitelistOptions = serde_json::from_value(opts.clone())
            .map_err(|e| SymbolWhitelistConfigError(format!("symbol-whitelist: {}", e)))?;
        if parsed.symbols.is_empty() {
            return Err(SymbolWhitelistConfigError(
                "symbol-whitelist guard requires a non-empty \"symbols\" array in options".into(),
            ));
        }
        for key in parsed.extras.keys() {
            tracing::warn!(target: "guards", guard = "symbol-whitelist", key = %key, "unknown config field");
        }
        Ok(Self {
            allowed: parsed.symbols.into_iter().collect(),
        })
    }
}

#[async_trait]
impl Guard for SymbolWhitelistGuard {
    fn name(&self) -> &str {
        "symbol-whitelist"
    }

    async fn check(&mut self, ctx: &GuardContext<'_>) -> Option<String> {
        let symbol = get_operation_symbol(ctx.operation);
        if symbol == "unknown" {
            return None;
        }
        if !self.allowed.contains(&symbol) {
            return Some(format!("Symbol {} is not in the allowed list", symbol));
        }
        None
    }
}
