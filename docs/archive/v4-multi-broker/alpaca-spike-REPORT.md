# Phase 5 D1 — Alpaca Broker Port Feasibility (Offline Survey)

**Date:** 2026-05-13
**Phase:** 5 D1 (Spike — research only, no code changes)
**Author:** Claude Sonnet 4.6 (automated survey)
**Decision target:** Whether to spend ~5-7 eng-days porting the Alpaca broker to Rust in Phase 6
**Gold standard:** `src/domain/trading/brokers/alpaca/` (TS implementation)
**Rust target crate:** `apca` v0.30.0 (GPL-3.0-or-later)

---

## 1. Current TS Alpaca Implementation Footprint

### 1.1 File List and LOC

| File | LOC | Purpose |
|------|-----|---------|
| `AlpacaBroker.ts` | 531 | Main `IBroker` implementation — all business logic |
| `AlpacaBroker.spec.ts` | 729 | Unit tests (mocked SDK) |
| `alpaca-types.ts` | 77 | Raw wire-shape interfaces for Alpaca REST responses |
| `alpaca-contracts.ts` | 72 | Pure helper functions (`makeContract`, `resolveSymbol`, `makeOrderState`, `mapAlpacaOrderStatus`) |
| `index.ts` | 2 | Re-export barrel |
| **Total (non-test)** | **682** | |
| **Total (with tests)** | **1,411** | |

### 1.2 Public Methods Exposed (IBroker surface)

Every method in the `IBroker` interface is implemented. All are load-bearing:

| Method | Called by UTA? | Notes |
|--------|---------------|-------|
| `init()` | YES — lifecycle | Connects SDK, starts catalog refresh |
| `close()` | YES — lifecycle | No-op (Alpaca SDK has no close) |
| `searchContracts(pattern)` | YES — contract search panel | Fuzzy-ranks against local catalog |
| `getContractDetails(query)` | YES — order placement | Returns static STK/SMART details |
| `refreshCatalog()` | YES — 6h cron in main.ts | Pulls `/v2/assets?status=active` |
| `placeOrder(contract, order, tpsl?)` | YES — core trading | Supports MKT/LMT/STP/STP LMT/TRAIL + bracket |
| `modifyOrder(orderId, changes)` | YES — order management | Maps to `replaceOrder` |
| `cancelOrder(orderId)` | YES — order management | Maps to `cancelOrder` |
| `closePosition(contract, qty?)` | YES — position management | Full = native; partial = reverse-MKT |
| `getAccount()` | YES — account display | Aggregates unrealizedPnL via positions |
| `getPositions()` | YES — position display | Maps `AlpacaPositionRaw` |
| `getOrders(orderIds[])` | YES — sync polling | Loops `getOrder` per ID |
| `getOrder(orderId)` | YES — status polling | Includes bracket leg extraction |
| `getQuote(contract)` | YES — real-time price | Uses `getSnapshot` |
| `getMarketClock()` | YES — clock widget | Returns `is_open`, `next_open`, `next_close` |
| `getCapabilities()` | YES — guard pipeline | STK only; 5 order types |
| `getNativeKey(contract)` | YES — aliceId construction | Returns `contract.symbol` |
| `resolveNativeKey(nativeKey)` | YES — aliceId resolution | Calls `makeContract` |

**Dead code:** None. Every method is referenced in `AlpacaBroker.spec.ts` or the `IBroker` interface.
The TS `getAccountActivities` mock appears in the test mock setup but is **not** in the `IBroker`
interface and is never called — it is SDK surface only, not part of what needs porting.

### 1.3 Load-Bearing Internal Helpers

| Helper | LOC (approx.) | Must port? |
|--------|--------------|-----------|
| `ibkrOrderTypeToAlpaca()` | 12 | YES — order type mapping |
| `ibkrTifToAlpaca()` | 12 | YES — TIF mapping |
| `AlpacaBroker.fromConfig()` | 10 | YES — factory |
| `AlpacaBroker.configSchema/configFields` | 15 | YES — config registration |
| `AlpacaBroker._mapOpenOrder()` | 20 | YES — response mapping |
| `AlpacaBroker._extractTpSl()` | 20 | YES — bracket leg extraction |
| `makeContract()` (contracts.ts) | 10 | YES |
| `resolveSymbol()` (contracts.ts) | 10 | YES |
| `mapAlpacaOrderStatus()` (contracts.ts) | 20 | YES — 10-status mapping |
| `makeOrderState()` (contracts.ts) | 8 | YES |
| Retry logic in `init()` | 25 | YES — exponential backoff |
| Catalog local cache + `refreshCatalog()` | 30 | YES |

---

## 2. `apca` Crate API Survey

### 2.1 Crate Basics

| Attribute | Value |
|-----------|-------|
| Crate name | `apca` |
| Current version | 0.30.0 |
| License | **GPL-3.0-or-later** |
| Documentation coverage | 100% |
| Async runtime | tokio + hyper |
| WebSocket | tokio-tungstenite |
| Serialization | serde/serde_json |
| Numeric type | `num-decimal::Num` |
| `apca` currently in `Cargo.toml` | **NO** — not yet a dependency |
| Maintenance status | Active (current on docs.rs) |

**CRITICAL NOTE — GPL License:** `apca` is GPL-3.0-or-later. If `alice-trading-core` is ever
distributed as a binary or library, the GPL copyleft clause requires the entire containing work to
also be GPL-licensed. OpenAlice is currently a private application; if it stays that way, GPL linking
is a non-issue at runtime. However, if any part of the codebase is ever open-sourced or distributed
as a library, GPL contamination through `apca` would require the whole crate to be GPL.
**This is the single biggest legal/architectural risk of using `apca` directly.**

### 2.2 API Modules Available

| Module | Alpaca endpoint | TS usage |
|--------|----------------|----------|
| `apca::api::v2::account` | `/v2/account` | `getAccount()` |
| `apca::api::v2::order` | `/v2/orders/{id}` | `placeOrder()`, `modifyOrder()`, `getOrder()` |
| `apca::api::v2::orders` | `/v2/orders` | `getOrders()` |
| `apca::api::v2::position` | `/v2/positions/{sym}` | (TS uses list endpoint) |
| `apca::api::v2::positions` | `/v2/positions` | `getPositions()`, `closePosition()` |
| `apca::api::v2::asset` / `assets` | `/v2/assets` | `refreshCatalog()` |
| `apca::api::v2::clock` | `/v2/clock` | `getMarketClock()` |
| `apca::api::v2::updates` | WS `trade_updates` | Not used in TS |
| `apca::data::v2::last_quotes` | `/v2/stocks/quotes/latest` | `getQuote()` bid/ask |
| `apca::data::v2::bars` | `/v2/stocks/{sym}/bars` | `getQuote()` volume |

### 2.3 Configuration: Paper vs Live Switching

`apca` uses `ApiInfo` with explicit URL fields — no `paper: bool` shorthand:

```
ApiInfo::from_parts(base_url, key_id, secret)
//   paper → "https://paper-api.alpaca.markets"
//   live  → "https://api.alpaca.markets"
```

The Rust port must map `config.paper: bool → base_url: Url` in the factory. Trivial (one-line
match arm) but must be documented. Environment-variable path (`from_env`) reads
`APCA_API_BASE_URL`, `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`.

---

## 3. Field-by-Field Mapping Tables

### 3.1 Order Mapping

Comparing `AlpacaOrderRaw` (TS) vs `apca::api::v2::order::Order` (Rust target):

| TS field | TS type | Rust target field | Rust type | Decimal handling | Notes |
|---|---|---|---|---|---|
| `id` | `string` | `id` | `Id` (UUID wrapper) | N/A | Typed wrapper in Rust |
| `client_order_id` | `string \| null` | `client_order_id` | `String` | N/A | **Phase 4e journal field — present in apca** |
| `symbol` | `string` | `symbol` | `String` | N/A | Direct match |
| `side` | `string` | `side` | `Side` enum | N/A | `buy`/`sell` → typed enum |
| `type` | `string` | `type_` | `Type` enum | N/A | `type_` (Rust keyword avoidance) |
| `qty` | `string \| null` | `amount` | `Amount` enum | `Num` decimal | `Amount` unifies qty + notional |
| `notional` | `string \| null` | `amount` | `Amount` enum | `Num` decimal | Same `Amount` wrapper |
| `limit_price` | `string \| null` | `limit_price` | `Option<Num>` | `Num` decimal | Direct; no string→Decimal needed |
| `stop_price` | `string \| null` | `stop_price` | `Option<Num>` | `Num` decimal | Direct |
| `time_in_force` | `string` | `time_in_force` | `TimeInForce` enum | N/A | Enum handles case normalization |
| `extended_hours` | `boolean` | `extended_hours` | `bool` | N/A | Direct |
| `status` | `string` | `status` | `Status` enum | N/A | 17-variant enum vs 10 TS branches |
| `filled_avg_price` | `string \| null` | `average_fill_price` | `Option<Num>` | `Num` decimal | Field rename |
| `filled_qty` | `string \| null` | `filled_quantity` | `Num` | `Num` decimal | Non-optional in Rust |
| `filled_at` | `string \| null` | `filled_at` | `Option<DateTime<Utc>>` | N/A | Typed datetime |
| `created_at` | `string` | `created_at` | `DateTime<Utc>` | N/A | Typed datetime |
| `reject_reason` | `string \| null` | *(absent)* | — | N/A | **GAP** — not in `apca::Order` |
| `order_class` | `string?` | `class` | `Class` enum | N/A | Bracket/OCO/OTO typed |
| `legs` | `AlpacaOrderRaw[]?` | `legs` | `Vec<Order>` | N/A | Recursive; direct match |
| *(absent in TS)* | — | `trail_price` | `Option<Num>` | `Num` decimal | Available in Rust; not tracked in TS |
| *(absent in TS)* | — | `trail_percent` | `Option<Num>` | `Num` decimal | Available in Rust |

**Order Submission (`CreateReq`)** — `apca::api::v2::order::CreateReq`:

| TS `placeOrder` field | `apca::CreateReq` field | Notes |
|---|---|---|
| `symbol` | `symbol: Symbol` | Direct |
| `side` | `side: Side` | Enum |
| `type` | `type_: Type` | Enum |
| `time_in_force` | `time_in_force: TimeInForce` | Enum |
| `qty` / `notional` | `amount: Amount` | Unified |
| `limit_price` | `limit_price: Option<Num>` | Direct |
| `stop_price` | `stop_price: Option<Num>` | Direct |
| `trail_price` | `trail_price: Option<Num>` | Direct |
| `trail_percent` | `trail_percent: Option<Num>` | Direct |
| `take_profit` | `take_profit: Option<TakeProfit>` | Typed struct |
| `stop_loss` | `stop_loss: Option<StopLoss>` | Typed struct |
| `extended_hours` | `extended_hours: bool` | Direct |
| `order_class` | `class: Class` | Enum |
| *(absent in TS)* | `client_order_id: Option<String>` | **Must add in Phase 6 — journal requires this** |

The critical addition for Phase 6 is passing `client_order_id` — the TS implementation never sets
it (confirmed: 0 occurrences of `client_order_id`/`clientOrderId` in the Alpaca TS files).

### 3.2 Position Mapping

Comparing `AlpacaPositionRaw` (TS) vs `apca::api::v2::position::Position` (Rust target):

| TS field | TS type | Rust target field | Rust type | Notes |
|---|---|---|---|---|
| `symbol` | `string` | `symbol` | `String` | Direct |
| `side` | `string` | `side` | `Side` enum | `'long'`/`'short'` → typed |
| `qty` | `string` | `quantity` | `Num` | String→Num conversion |
| `avg_entry_price` | `string` | `average_entry_price` | `Num` | Field rename |
| `current_price` | `string` | `current_price` | `Option<Num>` | **Optional in Rust — must handle None** |
| `market_value` | `string` | `market_value` | `Option<Num>` | **Optional in Rust** |
| `unrealized_pl` | `string` | `unrealized_gain_total` | `Option<Num>` | Field rename; optional |
| `unrealized_plpc` | `string` | `unrealized_gain_total_percent` | `Option<Num>` | Field rename |
| `cost_basis` | `string` | `cost_basis` | `Num` | Direct |
| *(absent in TS)* | — | `asset_id` | `Id` | Extra — not currently surfaced |
| *(absent in TS)* | — | `exchange` | `Exchange` | Extra |
| *(absent in TS)* | — | `asset_class` | `Class` | Extra |
| *(absent in TS)* | — | `quantity_available` | `Num` | Useful for short-sale margin |
| *(absent in TS)* | — | `unrealized_gain_today` | `Option<Num>` | Day PnL — not surfaced in TS |
| *(absent in TS)* | — | `last_day_price` | `Option<Num>` | Not surfaced in TS |
| *(absent in TS)* | — | `change_today` | `Option<Num>` | Not surfaced in TS |

**Note:** `current_price` and `market_value` are `Option` in `apca`. The TS code accesses them
without null-checking (`new Decimal(p.current_price)`). The Rust port must add explicit `None`
handling — likely defaulting to `"0"` with a logged warning, or returning a `BrokerError`.

### 3.3 Asset/Contract Mapping

Comparing `AlpacaAssetRaw` (TS) vs `apca::api::v2::asset::Asset` (Rust target):

| TS field | TS type | Rust target field | Rust type | Notes |
|---|---|---|---|---|
| `symbol` | `string` | `symbol` | `String` | Direct |
| `name` | `string?` | *(absent)* | — | **GAP — apca Asset has no name field** |
| `class` | `string?` | `class` | `Class` enum | `'us_equity'`/`'crypto'` → typed |
| `exchange` | `string?` | `exchange` | `Exchange` enum | Typed |
| `tradable` | `boolean?` | `tradable` | `bool` | Non-optional in Rust |
| `status` | `string?` | `status` | `Status` enum | `'active'`/`'inactive'` → typed |
| *(absent in TS)* | — | `fractionable` | `bool` | Fractional share support flag |
| *(absent in TS)* | — | `marginable` | `bool` | Margin eligibility |
| *(absent in TS)* | — | `shortable` | `bool` | Short sale eligibility |
| *(absent in TS)* | — | `easy_to_borrow` | `bool` | Borrow availability |

**Key gap:** `apca::Asset` does not expose an asset `name` field. The TS broker stores `asset.name`
into `contract.description` for the search panel ("Apple Inc" alongside "AAPL"). The Rust port must
either: (A) make a raw `reqwest` call to `/v2/assets` with a local struct that includes `name` —
~30 LOC workaround, or (B) accept no display names in search results — breaking UX parity.

### 3.4 Quote Mapping

The TS `getQuote()` calls `client.getSnapshot(symbol)` — a single endpoint returning trade + quote +
bar in one payload. `apca` has no snapshot wrapper. The equivalent requires 2–3 separate calls:

| TS `AlpacaSnapshotRaw` field | Source | `apca` equivalent | Notes |
|---|---|---|---|
| `LatestTrade.Price` | `getSnapshot` | `data::v2::last_trades::Trade.price` | Separate call |
| `LatestTrade.Timestamp` | `getSnapshot` | `Trade.time` | Separate call |
| `LatestQuote.BidPrice` | `getSnapshot` | `data::v2::last_quotes::Quote.bid_price` | Separate call |
| `LatestQuote.AskPrice` | `getSnapshot` | `Quote.ask_price` | Separate call |
| `DailyBar.Volume` | `getSnapshot` | `data::v2::bars::Bar.volume` | Third call |

**Impact:** Use `tokio::join!` to parallelize — adds ~15 LOC overhead. Latency stays acceptable.

---

## 4. Gap Analysis

### 4.1 Feature Coverage Matrix

| Feature | In TS impl | In `apca` | Gap requires custom code | Notes |
|---------|-----------|-----------|--------------------------|-------|
| Market orders | YES | YES | NO | `Type::Market` |
| Limit orders | YES | YES | NO | `Type::Limit` |
| Stop orders | YES | YES | NO | `Type::Stop` |
| Stop-limit orders | YES | YES | NO | `Type::StopLimit` |
| Trailing stop orders | YES | YES | NO | `Type::TrailingStop` |
| **Bracket orders** | YES | YES | NO | `Class::Bracket` + `TakeProfit`/`StopLoss` structs |
| **OCO orders** | NO (not in TS) | YES | — | `Class::OneCancelsOther` — available if needed |
| OTO orders | NO (not in TS) | YES | — | `Class::OneTriggersOther` |
| Notional / cash-qty orders | YES | YES | NO | `Amount::Notional` |
| **Fractional shares** | YES (decimal qty) | YES | NO | `Asset.fractionable` flag; `Amount::Quantity(Num)` |
| Paper vs live switching | YES (`paper: bool`) | PARTIAL | MAYBE | Must map `paper → URL` — 2 LOC |
| DAY / GTC / IOC / FOK / OPG TIF | YES | YES | NO | All 5 exist in `apca::TimeInForce` |
| Extended hours trading | YES | YES | NO | `CreateReq.extended_hours = true` |
| Asset catalog / search | YES | PARTIAL | MAYBE | `assets::List` exists but **no `name` field** |
| Fuzzy contract search | YES | N/A | NO | Pure-Rust logic, no apca dependency |
| `getQuote` (snapshot) | YES | PARTIAL | YES | No snapshot API; 2–3 joined calls needed |
| Market clock | YES | YES | NO | `clock::Get` |
| Streaming market data | NO (not used) | YES | — | Not needed for Phase 6 |
| Order update streaming | NO (not used) | YES | — | `updates::OrderUpdates` — not needed |
| `client_order_id` on submission | **NO (TS gap)** | YES | NO | **Phase 6 must add** — `CreateReq.client_order_id` |
| Lookup by `client_order_id` | **NO (TS gap)** | YES | NO | `GetByClientId` endpoint — direct fit |
| Error classification | YES (regex) | PARTIAL | MAYBE | `apca` typed errors map to `BrokerErrorCode` |
| `reject_reason` on orders | YES (raw field) | **NO** | YES | Not in `apca::Order`; cosmetic only |
| Asset `name` for display | YES (catalog) | **NO** | **YES** | Must add raw reqwest call or lose display |
| modifyOrder (`replaceOrder`) | YES | YES | NO | `order::ChangeReq` |
| cancelOrder | YES | YES | NO | `order::Delete` |
| closePosition (full) | YES | YES | NO | `positions::Delete` |
| closePosition (partial) | YES | NO (by design) | YES | Reverse-MKT — TS already does this |
| `getPositions` | YES | YES | NO | `positions::List` |
| `getAccount` | YES | YES | NO | `account::Get` |
| `getOrders` | YES | YES | NO | `order::Get` per ID |
| `getOrder` | YES | YES | NO | `order::Get` |

### 4.2 Significant Gaps Detail

**GAP-1: Asset `name` field missing from `apca`.**
`apca::asset::Asset` has no `name` field. The TS implementation stores `asset.name` into
`contract.description` for the search UI. Mitigation: Option A — make a raw `reqwest` call to
`/v2/assets` deserializing with a local struct that adds `name` (~30 LOC). Option B — omit name
display in Rust (search panel shows ticker only). Option A is recommended.

**GAP-2: No `getSnapshot` equivalent.**
TS calls `client.getSnapshot(symbol)` for a one-shot trade+quote+bar payload. Use `tokio::join!`
across `last_trades`, `last_quotes`, and `bars` endpoints — adds ~15 LOC, no functional gap.

**GAP-3: `reject_reason` not in `apca::Order`.**
TS extracts `order.reject_reason` and forwards it to `OrderState.rejectReason`. `apca` does not
expose this in the order struct. The `updates` WebSocket stream carries reject reasons, but that is
significant infrastructure. For Phase 6: omit `rejectReason` — the field is cosmetic (UI display
only, not used in any guard logic or journal protocol).

**GAP-4: Partial `closePosition` requires a synthetic reverse-market order.**
The TS implementation already does this (not a native Alpaca API call). The Rust port replicates
the same approach. No `apca` gap.

**GAP-5: Paper vs live URL must be explicit.**
`apca` has no `paper: bool` shorthand. Config maps `paper: bool → base_url`. Trivial — 2 LOC.

---

## 5. Phase 4e Journal Protocol Fit

The Phase 4e journal protocol requires three things from each broker:
1. `allocate_client_order_id()` — generate a unique id before the broker call
2. Pass `client_order_id` to the broker on order submission
3. `lookup_by_client_order_id(id)` — post-crash restart can find the order

### 5.1 `client_order_id` on Submission

`apca::api::v2::order::CreateReq` has:
```
client_order_id: Option<String>   // documented max: 48 characters
```

The current Rust trait documents Alpaca as using "commit-hash-suffixed strings". A SHA-256 hex
digest is 64 characters — **this exceeds the 48-character limit**. The Rust port must truncate:
e.g., take the first 40 hex chars of the commit hash + a suffix like `-1` or `-ord1` to reach
47 characters. Example: `a3f9d2...ba1c-ord1` (40+5 = 45 chars — fits). This invariant must be
documented in the `allocate_client_order_id()` implementation and tested.

### 5.2 Lookup by `client_order_id`

`apca` provides `GetByClientId` which hits `/v2/orders:by_client_order_id`:
- Input: `String` (the client order ID)
- Output: `Order` struct (same as `Get`)
- Error: `GetByClientIdError` if no match

This maps directly to `Broker::lookup_by_client_order_id(&str)` in the Rust trait.
**Full coverage — no custom code needed.**

### 5.3 Crash Recovery Scenario

**Question:** If the process crashes after `POST /orders` succeeds but before the response is
processed, can a restart find the order via `client_order_id`?

**Answer: YES.** Alpaca stores `client_order_id` server-side. Even if the client crashes, the order
is visible via `GET /v2/orders:by_client_order_id?client_order_id={id}`. The reconciler in
`crates/alice-trading-core/src/journal/reconcile.rs` calls `broker.lookup_by_client_order_id()`
for each pending journal entry — this will find the order and trigger a sync commit.

**Constraint:** Alpaca requires `client_order_id` to be unique per account. The commit-hash-based
scheme is effectively unique. Truncation to 47 chars preserves uniqueness in practice (SHA-256
prefix collision probability is negligible for trading volumes).

### 5.4 Journal Protocol Verdict

`apca` fully supports the Phase 4e journal protocol. The **only action item** is ensuring
`client_order_id` is <= 48 characters (truncate commit hash to 40 chars + suffix).

The TS Alpaca implementation currently sets **no `client_order_id`** on any order submission. The
Rust port would close this correctness gap — a net reliability improvement over TS.

---

## 6. Effort Estimate

### 6.1 TS LOC Baseline

```
Non-test total:  682 LOC  (AlpacaBroker.ts + alpaca-types.ts + alpaca-contracts.ts + index.ts)
Test file:       729 LOC  (AlpacaBroker.spec.ts)
Grand total:   1,411 LOC
```

### 6.2 Reference: MockBroker Port Compression Ratio

The `MockBroker` port is the best reference data point:
- TS `MockBroker.ts`: ~548 LOC
- Rust `mock.rs`: 763 LOC (ratio: 1.39x larger in Rust)

The Alpaca broker is simpler than Mock (no internal state machine, delegates to SDK). Estimated
**ratio: ~1.0x** — roughly equal LOC because Rust saves on IBKR class plumbing but costs on
explicit type annotations and `async_trait` boilerplate.

### 6.3 Rust Port Estimate by Component

| Component | Estimated Rust LOC | Basis |
|-----------|-------------------|-------|
| `AlpacaBroker` struct + lifecycle + config + factory | 80 | TS lifecycle = ~80 LOC |
| Order placement (`place_order`, `modify_order`, `cancel_order`) | 110 | TS ~130 LOC; enum types reduce conditionals |
| Position + account queries (`get_positions`, `get_account`, `close_position`) | 90 | TS ~95 LOC |
| Order queries (`get_order`, `get_orders`, bracket extraction) | 50 | TS ~40 LOC + extraction |
| Market data (`get_quote` — 3 joined calls, `get_market_clock`) | 70 | TS ~45 LOC + join overhead |
| Contract search + catalog (`search_contracts`, `refresh_catalog`, fuzzy rank) | 70 | TS ~75 LOC |
| `allocate_client_order_id` + `lookup_by_client_order_id` | 30 | New — not in TS |
| Type mapping helpers (`ibkr_order_type_to_alpaca`, status map, etc.) | 50 | TS ~65 LOC; match arms shorter |
| Config/factory (`from_config`, `configSchema`) | 30 | TS ~25 LOC |
| Error mapping (apca errors → `BrokerErrorCode`) | 20 | Extend existing `error.rs` |
| GAP fixes (snapshot join, partial close, asset name raw call) | 60 | New custom code |
| **Implementation subtotal** | **660** | |
| Unit tests (parity with 729-line spec) | 280 | ~40% compression over TS |
| Integration test stubs | 60 | |
| **Test subtotal** | **340** | |
| **Grand total** | **~1,000 LOC** | |

### 6.4 Dependency Addition to `Cargo.toml`

```toml
# [dependencies] in crates/alice-trading-core/Cargo.toml
apca = "0.30"
```

Pulls in: `tokio`, `hyper`, `serde`, `serde_json`, `num-decimal`. All compatible with existing
deps. `num-decimal::Num` requires wrapping/converting to `bigdecimal::BigDecimal` (the project
standard) — ~10 LOC of conversion utilities. Compile time increase: moderate (+30-60s cold build).

### 6.5 Eng-Day Estimates

| Scenario | LOC | Eng-days | Assumptions |
|----------|-----|----------|-------------|
| **Low** (happy path, no asset names, no tests) | ~500 | **2.5 days** | Ship skeleton; skip name fix; port tests later |
| **Mid** (full parity + journal protocol + asset name fix) | ~1,000 | **4.5 days** | All gaps resolved; test suite complete |
| **High** (full parity + journal + names + streaming stubs) | ~1,200 | **6 days** | Add streaming order-update hooks for future phase |

**Recommended scenario: Mid (4.5 days).** Delivers production-ready behavior with journal protocol
fully wired and all TS behavioral parity maintained.

---

## 7. Recommendation

### 7.1 Evidence Summary

**For porting:**
- `apca` covers ~90% of the required API surface with typed, well-documented structs
- `client_order_id` is natively supported — Phase 4e journal protocol fits cleanly
- `lookup_by_client_order_id` is a first-class `apca` endpoint — crash recovery works
- All 5 order types (MKT/LMT/STP/STP LMT/TRAIL), bracket orders, and fractional shares present
- Rust's type system eliminates string-parsing overhead (the TS impl does 10+ raw string→Decimal
  conversions per `getPositions` call)
- The `MockBroker` precedent shows Rust broker ports in this codebase are straightforward
- The TS implementation currently sets **no `client_order_id`** — the Rust port closes a real
  correctness gap in crash recovery

**Against porting (or requiring attention):**
1. **GPL-3.0 license on `apca`**: If OpenAlice ever distributes the Rust crate or open-sources it,
   GPL contamination applies. For a private deployment this is acceptable; for anything
   public-facing it requires either a raw HTTP client (~+200 LOC, no apca) or accepting GPL.
2. **Asset `name` gap**: Search UI loses company name display unless a raw reqwest call is added
   (~30 LOC workaround — scoped into Mid estimate).
3. **No `getSnapshot` equivalent**: 2–3 parallel calls required — minor latency and code complexity.
4. **`reject_reason` gap**: Cosmetic only; acceptable to omit.
5. **48-char `client_order_id` limit**: Requires commit hash truncation — trivial but must be tested.

### 7.2 Verdict

**YES — porting Alpaca to Rust is worth it, at the Mid estimate of ~4.5 eng-days, subject to the
GPL license decision.**

The TS Alpaca implementation (682 non-test LOC) is the second-simplest broker in the codebase
(after Mock). It has no stateful connection (unlike IBKR), no exotic signing (unlike LeverUp), and
does not manage a WebSocket session. The `apca` crate covers all load-bearing operations. The Phase
4e journal protocol fits cleanly — `client_order_id` and `lookup_by_client_order_id` are both
first-class in `apca`, and the TS implementation has never set `client_order_id`, so the Rust port
would deliver a correctness improvement, not merely a migration.

**The one non-trivial blocker is the GPL license.** The user must decide:
- If OpenAlice remains a private application: use `apca` directly; accept GPL.
- If OpenAlice may be open-sourced or the crate distributed: write a thin raw-HTTP client (~200 LOC
  using `reqwest`, already transitively available). Effort rises to ~Mid+1 day (~5.5 days).

### 7.3 Unknowns the User Must Resolve (Live Half)

1. **GPL license acceptability**: Can `apca` (GPL-3.0) be added as a dependency? This is the
   gating decision for the implementation approach.
2. **Asset name in search UI**: Is it acceptable to omit company name from contract search results,
   or should the 30-LOC raw-HTTP workaround be included in scope? Affects UX parity.

---

## Appendix A: TS Method → Rust Trait Coverage Checklist

| IBroker method (TS) | Broker trait method (Rust) | apca coverage |
|---|---|---|
| `init()` | `init()` | `account::Get` — verifies credentials |
| `close()` | `close()` | No-op |
| *(n/a)* | `wait_for_connect()` | Instant — Alpaca is stateless |
| `searchContracts()` | `search_contracts()` | `assets::List` + fuzzy rank |
| `getContractDetails()` | `get_contract_details()` | Static response (same as TS) |
| `refreshCatalog()` | `refresh_catalog()` | `assets::List` |
| `placeOrder()` | `place_order()` | `order::Create` (with `client_order_id`) |
| `modifyOrder()` | `modify_order()` | `order::Change` |
| `cancelOrder()` | `cancel_order()` | `order::Delete` |
| `closePosition()` | `close_position()` | `positions::Delete` (full) + synthetic (partial) |
| `getAccount()` | `get_account()` | `account::Get` + `positions::List` |
| `getPositions()` | `get_positions()` | `positions::List` |
| `getOrders()` | `get_orders()` | `order::Get` per ID |
| `getOrder()` | `get_order()` | `order::Get` |
| `getQuote()` | `get_quote()` | `last_trades` + `last_quotes` + `bars` (joined) |
| `getMarketClock()` | `get_market_clock()` | `clock::Get` |
| `getCapabilities()` | `get_capabilities()` | Static |
| `getNativeKey()` | *(resolved via config)* | N/A |
| `resolveNativeKey()` | *(resolved via config)* | N/A |
| *(absent in TS)* | `allocate_client_order_id()` | Custom — commit hash prefix (max 47 chars) |
| *(absent in TS)* | `lookup_by_client_order_id()` | `order::GetByClientId` |

## Appendix B: `apca::Status` Enum → TS `mapAlpacaOrderStatus` Mapping

The TS implementation maps 10 status strings. `apca::Status` has 17 variants. The Rust port must
handle the additional 7 (all map naturally to `Submitted`):

| `apca::Status` variant | TS equivalent | Action in Rust |
|---|---|---|
| `New` | `Submitted` | Direct |
| `Accepted` | `Submitted` | Direct |
| `PendingNew` | `Submitted` | Direct |
| `AcceptedForBidding` | `Submitted` | Direct |
| `PartiallyFilled` | `Submitted` | Direct (still active) |
| `Filled` | `Filled` | Direct |
| `Canceled` | `Cancelled` | Direct |
| `Expired` | `Cancelled` | Direct |
| `Replaced` | `Cancelled` | Direct |
| `DoneForDay` | `Inactive` | Direct |
| `Suspended` | `Inactive` | Direct |
| `Rejected` | `Inactive` | Direct |
| `Stopped` | *(absent in TS)* | Map to `Submitted` |
| `PendingCancel` | *(absent in TS)* | Map to `Submitted` |
| `PendingReplace` | *(absent in TS)* | Map to `Submitted` |
| `Calculated` | *(absent in TS)* | Map to `Submitted` |
| `Held` | *(absent in TS)* | Map to `Submitted` (bracket leg awaiting activation) |

All 5 new statuses map to `Submitted` — the order is live, just in a transient state.
No behavioral gap. The Rust match arm must use `_ =>` since `apca::Status` is `#[non_exhaustive]`.

## Appendix C: Key Alpaca API Endpoints and `apca` Coverage

| Alpaca endpoint | TS raw call | `apca` module | Coverage |
|---|---|---|---|
| `GET /v2/account` | `client.getAccount()` | `api::v2::account::Get` | Full |
| `GET /v2/positions` | `client.getPositions()` | `api::v2::positions::List` | Full |
| `DELETE /v2/positions/{sym}` | `client.closePosition(sym)` | `api::v2::positions::Delete` | Full |
| `POST /v2/orders` | `client.createOrder(payload)` | `api::v2::order::Create` | Full |
| `PATCH /v2/orders/{id}` | `client.replaceOrder(id, patch)` | `api::v2::order::Change` | Full |
| `DELETE /v2/orders/{id}` | `client.cancelOrder(id)` | `api::v2::order::Delete` | Full |
| `GET /v2/orders/{id}` | `client.getOrder(id)` | `api::v2::order::Get` | Full |
| `GET /v2/orders:by_client_order_id` | *(absent in TS)* | `api::v2::order::GetByClientId` | Full |
| `GET /v2/assets?status=active` | `client.getAssets(...)` | `api::v2::assets::List` | Partial — no `name` |
| `GET /v2/clock` | `client.getClock()` | `api::v2::clock::Get` | Full |
| `GET /v2/stocks/{sym}/snapshots` | `client.getSnapshot(sym)` | *(no wrapper)* | Partial — 3 calls |
| `WS trade_updates` | *(not used in TS)* | `api::v2::updates::OrderUpdates` | Available if needed |

---

*End of Phase 5 D1 Offline Survey*
