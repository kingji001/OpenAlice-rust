//! Broker trait — async interface matching TS IBroker.
//!
//! Uses async_trait crate for dyn-compat (Phase 4d's UtaActor will hold
//! Box<dyn Broker>). Native AFIT would force generics-only and complicate
//! runtime broker selection.

use async_trait::async_trait;
use serde_json::Value;

use crate::brokers::error::BrokerError;
use crate::brokers::types::{
    AccountCapabilities, AccountInfo, BrokerCapabilities, BrokerHealth, BrokerHealthInfo,
    MarketClock, OpenOrder, PlaceOrderResult, Position, Quote,
};

#[async_trait]
pub trait Broker: Send + Sync {
    // ---- Lifecycle ----
    async fn init(&self) -> Result<(), BrokerError>;
    async fn close(&self) -> Result<(), BrokerError>;
    async fn wait_for_connect(&self) -> Result<(), BrokerError>;

    // ---- Account + positions ----
    async fn get_account(&self) -> Result<AccountInfo, BrokerError>;
    async fn get_positions(&self) -> Result<Vec<Position>, BrokerError>;
    async fn get_orders(&self, order_ids: &[String]) -> Result<Vec<OpenOrder>, BrokerError>;
    async fn get_order(&self, order_id: &str) -> Result<Option<OpenOrder>, BrokerError>;

    // ---- Order placement ----
    /// `contract`, `order`, `tpsl` are serde_json::Value passthroughs
    /// (broker-shape IBKR class instances; rehydration happens in TS).
    async fn place_order(
        &self,
        contract: &Value,
        order: &Value,
        tpsl: Option<&Value>,
    ) -> Result<PlaceOrderResult, BrokerError>;

    async fn modify_order(
        &self,
        order_id: &str,
        changes: &Value,
    ) -> Result<PlaceOrderResult, BrokerError>;

    async fn cancel_order(&self, order_id: &str) -> Result<PlaceOrderResult, BrokerError>;

    async fn close_position(
        &self,
        contract: &Value,
        quantity: Option<&str>,
    ) -> Result<PlaceOrderResult, BrokerError>;

    // ---- Market data ----
    async fn get_quote(&self, contract: &Value) -> Result<Quote, BrokerError>;
    async fn get_market_clock(&self) -> Result<MarketClock, BrokerError>;
    async fn search_contracts(&self, pattern: &str) -> Result<Vec<Value>, BrokerError>;
    async fn get_contract_details(&self, query: &Value) -> Result<Option<Value>, BrokerError>;
    async fn refresh_catalog(&self) -> Result<(), BrokerError>;

    // ---- Synchronous introspection ----
    fn get_capabilities(&self) -> AccountCapabilities;
    fn get_health(&self) -> BrokerHealth;
    fn get_health_info(&self) -> BrokerHealthInfo;

    /// Forward-compat extension. Default impl satisfies all current
    /// brokers (Mock, Alpaca, IBKR, CCXT). Override only if §4.4 flips.
    fn capabilities(&self) -> BrokerCapabilities {
        BrokerCapabilities::default()
    }

    /// Allocate a unique client-order-id for the next broker call.
    /// Per-broker strategy: Mock uses a monotonic counter; IBKR derives from
    /// nextValidId; Alpaca uses commit-hash-suffixed strings. Used by Phase 4e
    /// journal to record what was sent to the broker before the call.
    fn allocate_client_order_id(&self) -> String;

    /// Look up an order by its client-order-id. Used by restart reconciliation
    /// to determine whether an in-flight order was actually accepted.
    /// Returns None if no order matches.
    async fn lookup_by_client_order_id(&self, id: &str) -> Result<Option<OpenOrder>, BrokerError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time check: Box<dyn Broker> + Send + Sync compiles.
    /// If async_trait macro generates non-Send code, this fails to compile.
    /// (No runtime assertion needed — just compile.)
    #[allow(dead_code)]
    fn assert_dyn_compat() {
        fn takes_dyn_broker(_: Box<dyn Broker + Send + Sync>) {}
        // We can't construct a dyn Broker without an impl, but the function
        // signature itself proves dyn-compat at type-check time.
        let _ = takes_dyn_broker;
    }
}
