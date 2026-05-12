//! MockBroker — in-memory broker implementing the Broker trait.
//!
//! Port of src/domain/trading/brokers/mock/MockBroker.ts (~548 lines).
//! Preserves 5 explicit behavioral parity assertions from v4 §7:
//!   1. Deterministic order ID counter (mock-1, mock-2, ...)
//!   2. Flip-to-empty position semantics (delete on cross-zero, no
//!      opposite-side tracking — see TS MockBroker.ts:528-530)
//!   3. Fail-injection counter via set_fail_mode(n)
//!   4. Call-log shape (calls, call_count, last_call, reset_calls)
//!   5. Failure-mode triggering health transitions (forward-compat;
//!      current default behavior: Healthy regardless of fail mode)
//!
//! Internally all-BigDecimal for precision. State behind a single Mutex;
//! order ID counter via AtomicU64; fail counter via AtomicU32.

use async_trait::async_trait;
use bigdecimal::BigDecimal;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;

use crate::brokers::error::{BrokerError, BrokerErrorCode};
use crate::brokers::traits::Broker;
use crate::brokers::types::{
    AccountCapabilities, AccountInfo, BrokerHealth, BrokerHealthInfo, MarketClock, OpenOrder,
    PlaceOrderResult, Position, PositionSide, Quote,
};

// ==================== Internal types ====================

#[derive(Debug, Clone)]
struct InternalPosition {
    contract: Value,
    side: PositionSide,
    quantity: BigDecimal,
    avg_cost: BigDecimal,
}

#[derive(Debug, Clone)]
struct InternalOrder {
    #[allow(dead_code)]
    id: String,
    contract: Value,
    order: Value,
    status: OrderStatus,
    fill_price: Option<BigDecimal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrderStatus {
    Submitted,
    Filled,
    Cancelled,
}

// ==================== Public types ====================

/// A record of a single broker method invocation.
#[derive(Debug, Clone)]
pub struct CallRecord {
    pub method: String,
    pub args: Vec<Value>,
    pub timestamp: u64, // millis since epoch (matches TS Date.now())
}

/// Options for constructing a MockBroker.
#[derive(Debug, Clone, Default)]
pub struct MockBrokerOptions {
    pub id: Option<String>,
    pub label: Option<String>,
    /// Initial cash balance in whole dollars. Default: 100_000.
    pub cash: Option<u64>,
    pub account_info: Option<AccountInfo>,
}

// ==================== State ====================

struct MockBrokerState {
    positions: HashMap<String, InternalPosition>,
    orders: HashMap<String, InternalOrder>,
    quotes: HashMap<String, BigDecimal>,
    cash: BigDecimal,
    realized_pn_l: BigDecimal,
    account_override: Option<AccountInfo>,
    call_log: Vec<CallRecord>,
}

// ==================== MockBroker ====================

/// In-memory broker for testing. Implements the Broker trait with exact
/// behavioral parity to TS MockBroker.
pub struct MockBroker {
    pub id: String,
    pub label: String,
    // All mutable state behind a single Mutex (broker calls are inherently
    // async and serialized in production via the actor).
    state: Mutex<MockBrokerState>,
    next_order_id: AtomicU64,
    next_client_order_id: AtomicU64,
    fail_remaining: AtomicU32,
}

impl MockBroker {
    pub fn new(opts: MockBrokerOptions) -> Self {
        let id = opts.id.unwrap_or_else(|| "mock-paper".to_string());
        let label = opts
            .label
            .unwrap_or_else(|| "Mock Paper Account".to_string());
        let cash = BigDecimal::from(opts.cash.unwrap_or(100_000));
        Self {
            id,
            label,
            state: Mutex::new(MockBrokerState {
                positions: HashMap::new(),
                orders: HashMap::new(),
                quotes: HashMap::new(),
                cash,
                realized_pn_l: BigDecimal::from(0),
                account_override: opts.account_info,
                call_log: Vec::new(),
            }),
            next_order_id: AtomicU64::new(1),
            next_client_order_id: AtomicU64::new(1),
            fail_remaining: AtomicU32::new(0),
        }
    }
}

// ==================== Call tracking + fail injection ====================

impl MockBroker {
    fn record(&self, method: &str, args: Vec<Value>) {
        let mut state = self.state.lock().unwrap();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        state.call_log.push(CallRecord {
            method: method.to_string(),
            args,
            timestamp,
        });
    }

    fn check_fail(&self, method: &str) -> Result<(), BrokerError> {
        let prev = self.fail_remaining.load(Ordering::SeqCst);
        if prev > 0 {
            self.fail_remaining.fetch_sub(1, Ordering::SeqCst);
            return Err(BrokerError::new(
                BrokerErrorCode::Unknown,
                format!("MockBroker[{}]: simulated {} failure", self.id, method),
            ));
        }
        Ok(())
    }

    /// Make the next `count` broker calls return an error (fail-injection).
    /// Parity assertion #3: set_fail_mode(2) → next 2 calls error, 3rd succeeds.
    pub fn set_fail_mode(&self, count: u32) {
        self.fail_remaining.store(count, Ordering::SeqCst);
    }

    /// Get all calls, optionally filtered by method name.
    pub fn calls(&self, method: Option<&str>) -> Vec<CallRecord> {
        let state = self.state.lock().unwrap();
        match method {
            Some(m) => state
                .call_log
                .iter()
                .filter(|c| c.method == m)
                .cloned()
                .collect(),
            None => state.call_log.clone(),
        }
    }

    /// Count calls to a specific method.
    pub fn call_count(&self, method: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .call_log
            .iter()
            .filter(|c| c.method == method)
            .count()
    }

    /// Get the last call to a specific method, or None.
    pub fn last_call(&self, method: &str) -> Option<CallRecord> {
        self.state
            .lock()
            .unwrap()
            .call_log
            .iter()
            .rev()
            .find(|c| c.method == method)
            .cloned()
    }

    /// Clear the call log.
    pub fn reset_calls(&self) {
        self.state.lock().unwrap().call_log.clear();
    }
}

// ==================== Position fill logic ====================

impl MockBroker {
    /// Apply a fill, updating positions.
    /// Mirrors TS MockBroker._applyFill at MockBroker.ts:500-535.
    ///
    /// CRITICAL: when a fill crosses zero (e.g., long 10, sell 15), the
    /// position is DELETED. We do NOT track the opposite-side flipped
    /// position. This matches TS MockBroker.ts:528-530 ("Fully closed
    /// or flipped — for simplicity we just delete").
    fn apply_fill(
        state: &mut MockBrokerState,
        contract: &Value,
        side: &str,
        qty: BigDecimal,
        price: BigDecimal,
    ) {
        let key = position_key(contract);

        if let Some(existing) = state.positions.get_mut(&key) {
            let is_increasing = (existing.side == PositionSide::Long && side == "BUY")
                || (existing.side == PositionSide::Short && side == "SELL");

            if is_increasing {
                // Add to position; recalc avg cost = (oldQty*oldAvg + newQty*newPrice) / (oldQty+newQty)
                let total_cost = &existing.avg_cost * &existing.quantity + &price * &qty;
                existing.quantity = &existing.quantity + &qty;
                existing.avg_cost = total_cost / &existing.quantity;
            } else {
                // Reduce or flip
                let remaining = &existing.quantity - &qty;
                if remaining <= 0 {
                    // Fully closed OR flipped — DELETE (parity assertion #2)
                    state.positions.remove(&key);
                } else {
                    // Partial close — avg_cost stays the same
                    existing.quantity = remaining;
                }
            }
        } else {
            // New position
            state.positions.insert(
                key,
                InternalPosition {
                    contract: contract.clone(),
                    side: if side == "BUY" {
                        PositionSide::Long
                    } else {
                        PositionSide::Short
                    },
                    quantity: qty,
                    avg_cost: price,
                },
            );
        }
    }
}

/// Position key derivation: same as TS at MockBroker.ts:419
/// (`contract.aliceId ?? contract.symbol ?? 'unknown'`).
fn position_key(contract: &Value) -> String {
    contract
        .get("aliceId")
        .and_then(|v| v.as_str())
        .or_else(|| contract.get("symbol").and_then(|v| v.as_str()))
        .unwrap_or("unknown")
        .to_string()
}

// ==================== Broker trait implementation ====================

#[async_trait]
impl Broker for MockBroker {
    // ---- Lifecycle ----

    async fn init(&self) -> Result<(), BrokerError> {
        self.record("init", vec![]);
        self.check_fail("init")
    }

    async fn close(&self) -> Result<(), BrokerError> {
        self.record("close", vec![]);
        Ok(())
    }

    async fn wait_for_connect(&self) -> Result<(), BrokerError> {
        Ok(()) // Mock is always connected
    }

    // ---- Account + positions ----

    async fn get_account(&self) -> Result<AccountInfo, BrokerError> {
        self.record("getAccount", vec![]);
        self.check_fail("getAccount")?;
        let state = self.state.lock().unwrap();
        if let Some(override_info) = &state.account_override {
            return Ok(override_info.clone());
        }
        let realized = state.realized_pn_l.to_string();
        let cash = state.cash.to_string();
        // Net liquidation = cash + position market values; for the mock we
        // approximate as cash (matches TS getAccount default behavior).
        Ok(AccountInfo {
            base_currency: "USD".into(),
            net_liquidation: cash.clone(),
            total_cash_value: cash,
            unrealized_pn_l: "0".into(),
            realized_pn_l: Some(realized),
            buying_power: None,
            init_margin_req: None,
            maint_margin_req: None,
            day_trades_remaining: None,
        })
    }

    async fn get_positions(&self) -> Result<Vec<Position>, BrokerError> {
        self.record("getPositions", vec![]);
        self.check_fail("getPositions")?;
        let state = self.state.lock().unwrap();
        let mut out = Vec::new();
        for pos in state.positions.values() {
            let qty_str = pos.quantity.to_string();
            let avg_str = pos.avg_cost.to_string();
            out.push(Position {
                contract: pos.contract.clone(),
                currency: pos
                    .contract
                    .get("currency")
                    .and_then(|v| v.as_str())
                    .unwrap_or("USD")
                    .to_string(),
                side: pos.side,
                quantity: qty_str,
                avg_cost: avg_str.clone(),
                market_price: avg_str.clone(), // mock: market = avg
                market_value: (&pos.avg_cost * &pos.quantity).to_string(),
                unrealized_pn_l: "0".into(),
                realized_pn_l: "0".into(),
                multiplier: None,
            });
        }
        Ok(out)
    }

    async fn get_orders(&self, order_ids: &[String]) -> Result<Vec<OpenOrder>, BrokerError> {
        self.record(
            "getOrders",
            vec![serde_json::to_value(order_ids).unwrap_or(Value::Null)],
        );
        self.check_fail("getOrders")?;
        let state = self.state.lock().unwrap();
        let mut out = Vec::new();
        for id in order_ids {
            if let Some(o) = state.orders.get(id) {
                out.push(OpenOrder {
                    contract: o.contract.clone(),
                    order: o.order.clone(),
                    order_state: json!({ "status": order_status_str(o.status) }),
                    avg_fill_price: o.fill_price.as_ref().map(|p| p.to_string()),
                    tpsl: None,
                });
            }
        }
        Ok(out)
    }

    async fn get_order(&self, order_id: &str) -> Result<Option<OpenOrder>, BrokerError> {
        self.record("getOrder", vec![json!(order_id)]);
        let state = self.state.lock().unwrap();
        Ok(state.orders.get(order_id).map(|o| OpenOrder {
            contract: o.contract.clone(),
            order: o.order.clone(),
            order_state: json!({ "status": order_status_str(o.status) }),
            avg_fill_price: o.fill_price.as_ref().map(|p| p.to_string()),
            tpsl: None,
        }))
    }

    // ---- Order placement ----

    async fn place_order(
        &self,
        contract: &Value,
        order: &Value,
        _tpsl: Option<&Value>,
    ) -> Result<PlaceOrderResult, BrokerError> {
        self.record("placeOrder", vec![contract.clone(), order.clone()]);
        self.check_fail("placeOrder")?;

        let order_id = format!("mock-{}", self.next_order_id.fetch_add(1, Ordering::SeqCst));
        let order_type = order
            .get("orderType")
            .and_then(|v| v.as_str())
            .unwrap_or("MKT");
        let action = order
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("BUY");
        let qty_str = order
            .get("totalQuantity")
            .and_then(|v| v.as_str())
            .unwrap_or("0");
        let qty = BigDecimal::from_str(qty_str)
            .map_err(|e| BrokerError::new(BrokerErrorCode::Unknown, format!("invalid qty: {e}")))?;

        if order_type == "MKT" {
            // Market order: fill immediately at mock quote price
            let key = position_key(contract);
            let price = {
                let state = self.state.lock().unwrap();
                state
                    .quotes
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| BigDecimal::from(100))
            };
            {
                let mut state = self.state.lock().unwrap();
                MockBroker::apply_fill(&mut state, contract, action, qty, price.clone());
                state.orders.insert(
                    order_id.clone(),
                    InternalOrder {
                        id: order_id.clone(),
                        contract: contract.clone(),
                        order: order.clone(),
                        status: OrderStatus::Filled,
                        fill_price: Some(price.clone()),
                    },
                );
            }
            Ok(PlaceOrderResult {
                success: true,
                order_id: Some(order_id.clone()),
                error: None,
                message: None,
                execution: Some(json!({
                    "orderId": order_id,
                    "shares": qty_str,
                    "price": price.to_string(),
                })),
                order_state: Some(json!({ "status": "Filled" })),
            })
        } else {
            // Limit/Stop: park as pending
            let mut state = self.state.lock().unwrap();
            state.orders.insert(
                order_id.clone(),
                InternalOrder {
                    id: order_id.clone(),
                    contract: contract.clone(),
                    order: order.clone(),
                    status: OrderStatus::Submitted,
                    fill_price: None,
                },
            );
            Ok(PlaceOrderResult {
                success: true,
                order_id: Some(order_id),
                error: None,
                message: None,
                execution: None,
                order_state: Some(json!({ "status": "Submitted" })),
            })
        }
    }

    async fn modify_order(
        &self,
        order_id: &str,
        changes: &Value,
    ) -> Result<PlaceOrderResult, BrokerError> {
        self.record("modifyOrder", vec![json!(order_id), changes.clone()]);
        self.check_fail("modifyOrder")?;
        Ok(PlaceOrderResult {
            success: true,
            order_id: Some(order_id.to_string()),
            error: None,
            message: None,
            execution: None,
            order_state: Some(json!({ "status": "Submitted" })),
        })
    }

    async fn cancel_order(&self, order_id: &str) -> Result<PlaceOrderResult, BrokerError> {
        self.record("cancelOrder", vec![json!(order_id)]);
        self.check_fail("cancelOrder")?;
        let mut state = self.state.lock().unwrap();
        if let Some(o) = state.orders.get_mut(order_id) {
            o.status = OrderStatus::Cancelled;
        }
        Ok(PlaceOrderResult {
            success: true,
            order_id: Some(order_id.to_string()),
            error: None,
            message: None,
            execution: None,
            order_state: Some(json!({ "status": "Cancelled" })),
        })
    }

    async fn close_position(
        &self,
        contract: &Value,
        quantity: Option<&str>,
    ) -> Result<PlaceOrderResult, BrokerError> {
        self.record("closePosition", vec![contract.clone(), json!(quantity)]);
        self.check_fail("closePosition")?;

        let key = position_key(contract);
        let (existing_side, existing_qty) = {
            let state = self.state.lock().unwrap();
            match state.positions.get(&key) {
                Some(p) => (p.side, p.quantity.clone()),
                None => {
                    return Err(BrokerError::new(
                        BrokerErrorCode::Exchange,
                        format!("No position for {key}"),
                    ))
                }
            }
        };
        let qty = match quantity {
            Some(q) => BigDecimal::from_str(q).map_err(|e| {
                BrokerError::new(BrokerErrorCode::Unknown, format!("invalid qty: {e}"))
            })?,
            None => existing_qty,
        };

        // Close = opposite-side market order
        let close_side = if existing_side == PositionSide::Long {
            "SELL"
        } else {
            "BUY"
        };
        let price = {
            let state = self.state.lock().unwrap();
            state
                .quotes
                .get(&key)
                .cloned()
                .unwrap_or_else(|| BigDecimal::from(100))
        };
        let order_id = format!("mock-{}", self.next_order_id.fetch_add(1, Ordering::SeqCst));
        {
            let mut state = self.state.lock().unwrap();
            MockBroker::apply_fill(&mut state, contract, close_side, qty.clone(), price.clone());
            state.orders.insert(
                order_id.clone(),
                InternalOrder {
                    id: order_id.clone(),
                    contract: contract.clone(),
                    order: json!({
                        "action": close_side,
                        "orderType": "MKT",
                        "totalQuantity": qty.to_string(),
                    }),
                    status: OrderStatus::Filled,
                    fill_price: Some(price.clone()),
                },
            );
        }
        Ok(PlaceOrderResult {
            success: true,
            order_id: Some(order_id),
            error: None,
            message: None,
            execution: Some(json!({
                "shares": qty.to_string(),
                "price": price.to_string(),
            })),
            order_state: Some(json!({ "status": "Filled" })),
        })
    }

    // ---- Market data ----

    async fn get_quote(&self, contract: &Value) -> Result<Quote, BrokerError> {
        self.record("getQuote", vec![contract.clone()]);
        self.check_fail("getQuote")?;
        let key = position_key(contract);
        let price = {
            let state = self.state.lock().unwrap();
            state
                .quotes
                .get(&key)
                .cloned()
                .unwrap_or_else(|| BigDecimal::from(100))
        };
        let p = price.to_string();
        Ok(Quote {
            contract: contract.clone(),
            last: p.clone(),
            bid: p.clone(),
            ask: p.clone(),
            volume: "0".into(),
            high: None,
            low: None,
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })
    }

    async fn get_market_clock(&self) -> Result<MarketClock, BrokerError> {
        self.record("getMarketClock", vec![]);
        self.check_fail("getMarketClock")?;
        Ok(MarketClock {
            is_open: true,
            next_open: None,
            next_close: None,
        })
    }

    async fn search_contracts(&self, pattern: &str) -> Result<Vec<Value>, BrokerError> {
        self.record("searchContracts", vec![json!(pattern)]);
        self.check_fail("searchContracts")?;
        Ok(vec![]) // mock returns empty
    }

    async fn get_contract_details(&self, query: &Value) -> Result<Option<Value>, BrokerError> {
        self.record("getContractDetails", vec![query.clone()]);
        self.check_fail("getContractDetails")?;
        Ok(None)
    }

    async fn refresh_catalog(&self) -> Result<(), BrokerError> {
        self.record("refreshCatalog", vec![]);
        Ok(())
    }

    // ---- Synchronous introspection ----

    fn get_capabilities(&self) -> AccountCapabilities {
        AccountCapabilities {
            supported_sec_types: vec!["STK".into(), "CRYPTO".into()],
            supported_order_types: vec!["MKT".into(), "LMT".into(), "STP".into(), "STP LMT".into()],
        }
    }

    /// Parity assertion #5: mock stays Healthy regardless of fail mode.
    fn get_health(&self) -> BrokerHealth {
        BrokerHealth::Healthy
    }

    fn get_health_info(&self) -> BrokerHealthInfo {
        BrokerHealthInfo {
            status: BrokerHealth::Healthy,
            last_check: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            message: None,
            consecutive_failures: None,
        }
    }

    fn allocate_client_order_id(&self) -> String {
        let n = self.next_client_order_id.fetch_add(1, Ordering::SeqCst);
        format!("mock-cli-{}", n)
    }

    async fn lookup_by_client_order_id(&self, id: &str) -> Result<Option<OpenOrder>, BrokerError> {
        self.record("lookupByClientOrderId", vec![json!(id)]);
        self.check_fail("lookupByClientOrderId")?;
        let state = self.state.lock().unwrap();
        for (_, internal_order) in state.orders.iter() {
            // Check if the order's `clientOrderId` field matches
            if internal_order
                .order
                .get("clientOrderId")
                .and_then(|v| v.as_str())
                == Some(id)
            {
                return Ok(Some(OpenOrder {
                    contract: internal_order.contract.clone(),
                    order: internal_order.order.clone(),
                    order_state: json!({ "status": format!("{:?}", internal_order.status) }),
                    avg_fill_price: internal_order.fill_price.as_ref().map(|p| p.to_string()),
                    tpsl: None,
                }));
            }
        }
        Ok(None)
    }
}

// ==================== Test helpers ====================

impl MockBroker {
    /// Inject a quote for a symbol. Used to control fill prices for market orders.
    pub fn set_quote(&self, symbol: &str, price: f64) {
        let mut state = self.state.lock().unwrap();
        state.quotes.insert(
            symbol.to_string(),
            BigDecimal::from_str(&price.to_string()).unwrap_or_else(|_| BigDecimal::from(100)),
        );
    }

    /// Override positions directly (for legacy test compatibility).
    pub fn set_positions(&self, positions: Vec<Position>) {
        let mut state = self.state.lock().unwrap();
        state.positions.clear();
        for p in positions {
            let key = position_key(&p.contract);
            state.positions.insert(
                key,
                InternalPosition {
                    contract: p.contract,
                    side: p.side,
                    quantity: BigDecimal::from_str(&p.quantity).unwrap_or_default(),
                    avg_cost: BigDecimal::from_str(&p.avg_cost).unwrap_or_default(),
                },
            );
        }
    }

    /// Override account info directly. Bypasses computed values from positions.
    pub fn set_account_info(&self, info: AccountInfo) {
        self.state.lock().unwrap().account_override = Some(info);
    }

    /// Manually fill a pending limit order at the given price.
    pub fn fill_pending_order(&self, order_id: &str, price: f64) {
        let price_dec =
            BigDecimal::from_str(&price.to_string()).unwrap_or_else(|_| BigDecimal::from(100));
        let mut state = self.state.lock().unwrap();
        if let Some(o) = state.orders.get_mut(order_id) {
            if o.status != OrderStatus::Submitted {
                return;
            }
            o.status = OrderStatus::Filled;
            o.fill_price = Some(price_dec.clone());
            let contract = o.contract.clone();
            let action = o
                .order
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("BUY")
                .to_string();
            let qty_str = o
                .order
                .get("totalQuantity")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            if let Ok(qty) = BigDecimal::from_str(&qty_str) {
                MockBroker::apply_fill(&mut state, &contract, &action, qty, price_dec);
            }
        }
    }
}

// ==================== Helpers ====================

fn order_status_str(status: OrderStatus) -> &'static str {
    match status {
        OrderStatus::Submitted => "Submitted",
        OrderStatus::Filled => "Filled",
        OrderStatus::Cancelled => "Cancelled",
    }
}
