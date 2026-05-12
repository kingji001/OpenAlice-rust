//! Rust mirrors of TS broker types from src/domain/trading/brokers/types.ts.
//!
//! Broker-shape inputs (Contract, Order, OrderState, OrderCancel,
//! ContractDescription, ContractDetails, TpSlParams) are serde_json::Value
//! passthroughs — rehydration of IBKR classes lives in the TS proxy layer
//! per v4 §6.2.
//!
//! Pure-Rust outputs (Position, AccountInfo, Quote, OpenOrder, MarketClock,
//! BrokerHealth, BrokerCapabilities, etc.) are typed Rust structs.

use bitflags::bitflags;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---- Position ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub contract: Value,
    pub currency: String,
    pub side: PositionSide,
    pub quantity: String, // Decimal as canonical string
    pub avg_cost: String,
    pub market_price: String,
    pub market_value: String,
    #[serde(rename = "unrealizedPnL")]
    pub unrealized_pn_l: String,
    #[serde(rename = "realizedPnL")]
    pub realized_pn_l: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiplier: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PositionSide {
    Long,
    Short,
}

// ---- AccountInfo ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub base_currency: String,
    pub net_liquidation: String,
    pub total_cash_value: String,
    #[serde(rename = "unrealizedPnL")]
    pub unrealized_pn_l: String,
    #[serde(rename = "realizedPnL", skip_serializing_if = "Option::is_none")]
    pub realized_pn_l: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buying_power: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_margin_req: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maint_margin_req: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_trades_remaining: Option<u32>,
}

// ---- Quote ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub contract: Value,
    pub last: String,
    pub bid: String,
    pub ask: String,
    pub volume: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low: Option<String>,
    pub timestamp: String, // ISO-8601 string (Date serializes as string via JSON.stringify)
}

// ---- OpenOrder ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrder {
    pub contract: Value,
    pub order: Value,
    pub order_state: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_fill_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tpsl: Option<Value>,
}

// ---- PlaceOrderResult ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceOrderResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_state: Option<Value>,
}

// ---- MarketClock ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketClock {
    pub is_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_open: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_close: Option<String>,
}

// ---- AccountCapabilities (the EXISTING per-broker capability declaration) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCapabilities {
    pub supported_sec_types: Vec<String>,
    pub supported_order_types: Vec<String>,
}

// ---- BrokerHealth ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrokerHealth {
    Healthy,
    Unhealthy,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerHealthInfo {
    pub status: BrokerHealth,
    pub last_check: String, // ISO-8601 timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consecutive_failures: Option<u32>,
}

// ---- BrokerCapabilities (Phase 4b forward-compat extension for §4.4) ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerCapabilities {
    pub close_mode: CloseMode,
    pub order_types: OrderTypeFlags,
    pub signing_scheme: SigningScheme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseMode {
    Partial,
    WholePosition,
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct OrderTypeFlags: u8 {
        const MARKET  = 0b0001;
        const LIMIT   = 0b0010;
        const STOP    = 0b0100;
        const BRACKET = 0b1000;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigningScheme {
    None,
    Eip712,
}

impl Default for BrokerCapabilities {
    fn default() -> Self {
        Self {
            close_mode: CloseMode::Partial,
            order_types: OrderTypeFlags::MARKET
                | OrderTypeFlags::LIMIT
                | OrderTypeFlags::STOP
                | OrderTypeFlags::BRACKET,
            signing_scheme: SigningScheme::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_serializes_camelcase_with_pnl_overrides() {
        let p = Position {
            contract: serde_json::json!({}),
            currency: "USD".into(),
            side: PositionSide::Long,
            quantity: "10".into(),
            avg_cost: "100".into(),
            market_price: "105".into(),
            market_value: "1050".into(),
            unrealized_pn_l: "50".into(),
            realized_pn_l: "0".into(),
            multiplier: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"avgCost\":\"100\""));
        assert!(s.contains("\"unrealizedPnL\":\"50\""));
        assert!(s.contains("\"realizedPnL\":\"0\""));
        assert!(!s.contains("multiplier")); // skipped when None
    }

    #[test]
    fn account_info_round_trips() {
        let info = AccountInfo {
            base_currency: "USD".into(),
            net_liquidation: "100000".into(),
            total_cash_value: "50000".into(),
            unrealized_pn_l: "0".into(),
            realized_pn_l: Some("100".into()),
            buying_power: Some("200000".into()),
            init_margin_req: None,
            maint_margin_req: None,
            day_trades_remaining: None,
        };
        let s = serde_json::to_string(&info).unwrap();
        let back: AccountInfo = serde_json::from_str(&s).unwrap();
        assert_eq!(back.base_currency, "USD");
        assert_eq!(back.realized_pn_l, Some("100".into()));
    }

    #[test]
    fn broker_health_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&BrokerHealth::Healthy).unwrap(),
            "\"healthy\""
        );
        assert_eq!(
            serde_json::to_string(&BrokerHealth::Unhealthy).unwrap(),
            "\"unhealthy\""
        );
        assert_eq!(
            serde_json::to_string(&BrokerHealth::Offline).unwrap(),
            "\"offline\""
        );
    }

    #[test]
    fn default_capabilities_includes_all_basic_order_types() {
        let caps = BrokerCapabilities::default();
        assert_eq!(caps.close_mode, CloseMode::Partial);
        assert_eq!(caps.signing_scheme, SigningScheme::None);
        assert!(caps.order_types.contains(OrderTypeFlags::MARKET));
        assert!(caps.order_types.contains(OrderTypeFlags::LIMIT));
        assert!(caps.order_types.contains(OrderTypeFlags::STOP));
        assert!(caps.order_types.contains(OrderTypeFlags::BRACKET));
    }
}
