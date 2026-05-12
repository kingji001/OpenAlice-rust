# Phase 5 D2 — IBKR Rust Port Feasibility Survey

**Date:** 2026-05-13
**Status:** DONE_WITH_CONCERNS
**Scope:** Offline spike — research only, no code changes.

---

## Executive Summary

The IBKR TypeScript implementation is large, well-structured, and dual-protocol
(legacy text + protobuf). The Rust port is feasible but the v4 estimate of
18-25 eng-days is probably **the floor, not the ceiling**. The three specific risks
that could push beyond 25 days are: (a) the dual-protocol message dispatch
architecture has no idiomatic 1:1 Rust analogue, (b) `WireDecimal` lacks a
`from_wire_field()` multi-sentinel parser needed at the IBKR wire layer, and
(c) the `nextValidId`/order-ID persistence model is incompatible with the
journal's current crash-safety guarantee without a persistence fix.

**Recommendation:** Port, but not before Phase 4f is complete and the
`nextValidId` persistence story is designed. Run a two-day TCP handshake spike
first to confirm byte-identical wire framing. If that confirms correctness,
green-light the full port. Scope to trading-relevant messages only (orders,
account/positions, quotes, contract search) to bring mid-estimate from 21.5 to
~14 eng-days.

---

## 1. TS IBKR Implementation Footprint

### Package structure (v4 Phase 1a split)

| Package | Role |
|---|---|
| `packages/ibkr/` | Re-export shim (14 LOC) — backward-compat only |
| `packages/ibkr-types/` | Pure DTO types, constants (2,421 LOC) |
| `packages/ibkr-client/` | I/O layer: connection, decoder, EClient (43,903 LOC total) |
| `src/domain/trading/brokers/ibkr/` | IBroker adapter (1,198 LOC) |

**Total IBKR surface:** ~47,536 LOC including generated protobuf bindings.

### ibkr-client/src non-generated files (9,478 LOC)

| File | LOC | Role |
|---|---|---|
| `src/wrapper.ts` | 1,146 | EWrapper callback interface (38 methods) |
| `src/client/historical.ts` | 993 | Historical data request methods |
| `src/client/orders.ts` | 886 | Order placement, cancel, query |
| `src/decoder/misc.ts` | 832 | ~25 miscellaneous message handlers |
| `src/decoder/orders.ts` | 793 | ORDER_STATUS, OPEN_ORDER, NEXT_VALID_ID handlers |
| `src/decoder/order.ts` | 714 | OrderDecoder — legacy text-protocol order struct decoding |
| `src/decoder/contract.ts` | 680 | Contract + ContractDetails decoders |
| `src/decoder/historical.ts` | 585 | Historical data decoders |
| `src/decoder/account.ts` | 489 | Account value, portfolio, position decoders |
| `src/decoder/market-data.ts` | 472 | Tick price/size/generic/option decoders |
| `src/client/account.ts` | 317 | Account subscription, summary, positions |
| `src/client/base.ts` | 303 | EClient base: connect, handshake, disconnect |
| `src/client/market-data.ts` | 281 | Market data request methods |
| `src/decoder/execution.ts` | 266 | Execution details decoders |
| `src/utils.ts` | 180 | Field decode helpers, sentinel formatting |
| `src/comm.ts` | 133 | Wire framing: makeMsg, readMsg, makeField |
| `src/connection.ts` | 115 | TCP socket wrapper |
| `src/decoder/base.ts` | 91 | Decoder dispatch tables |
| `src/client/encode.ts` | 74 | Shared contract encoding helpers |
| `src/reader.ts` | 54 | EReader: socket data -> framed messages |

### ibkr-client/src generated protobuf bindings (34,425 LOC, 203 files)

These are `ts-proto`-generated TypeScript bindings from the 203 `.proto` files in
`packages/ibkr-client/ref/source/proto/`. In a Rust port, `prost-build` would
generate equivalent Rust structs from the same `.proto` files.
Estimated engineering cost: ~0 eng-days after one-time build.rs setup.

Heaviest generated files (points to real data-model complexity):

| Generated file | LOC | Notes |
|---|---|---|
| `protobuf/Order.ts` | 3,124 | 140 fields in Order.proto |
| `protobuf/ContractDetails.ts` | 1,372 | 63 fields in ContractDetails.proto |
| `protobuf/ApiSettingsConfig.ts` | 787 | Config blob, not trading-critical |

### ibkr-types/src (2,421 LOC)

| File | LOC | Role |
|---|---|---|
| `src/common.ts` | 406 | TickerId, OrderId, TagValue, BarData, etc. |
| `src/order-condition.ts` | 398 | PriceCondition, TimeCondition, MarginCondition, etc. |
| `src/order.ts` | 271 | Order class — 70+ fields, UNSET sentinel defaults |
| `src/contract.ts` | 265 | Contract, ComboLeg, DeltaNeutralContract, ContractDetails |
| `src/message.ts` | 188 | IN/OUT message ID constants (both protocols) |
| `src/server-versions.ts` | 167 | 100+ MIN_SERVER_VER_* constants (v39-v222) |
| `src/order-state.ts` | 113 | OrderState class |

### IBroker adapter (1,198 LOC)

| File | LOC | Role |
|---|---|---|
| `ibkr/request-bridge.ts` | 611 | Callback->Promise bridging (4 routing modes) |
| `ibkr/IbkrBroker.ts` | 446 | IBroker implementation |
| `ibkr/ibkr-contracts.ts` | 80 | Symbol resolution, error classification |
| `ibkr/ibkr-types.ts` | 59 | CollectedOpenOrder, TickSnapshot, etc. |

**Public API surface (methods used by UnifiedTradingAccount):**
`init()`, `close()`, `placeOrder()`, `modifyOrder()`, `cancelOrder()`,
`closePosition()`, `getAccount()`, `getPositions()`, `getOrders()`,
`getOrder()`, `getQuote()`, `getMarketClock()`, `searchContracts()`,
`getContractDetails()`.

---

## 2. Protocol Implementation - Handshake + Message Framing

### Wire format

The TWS API is a binary TCP protocol. All messages use a 4-byte big-endian
length prefix. The framing layer is in `src/comm.ts` (133 LOC).

**Message framing (ALL messages):**
```
[4-byte big-endian total payload length][payload bytes]
```

**Handshake sequence (from `client/base.ts`):**
1. Client sends literal `API\0` (4 bytes, NO length prefix) concatenated with
   a length-prefixed version string: `[4-byte BE len]["v100..222"]`
2. Server responds: `[4-byte BE len][serverVersion\0][connTime\0]`
3. Client sends StartApi: `[4-byte BE len][VERSION\0][clientId\0][optCapab\0]`
4. Server sends `nextValidId` and `managedAccounts` - connection is live

**Text protocol encoding (pre-v201 or text-only message types):**
- Each field: `String(value) + "\0"` (null terminator, not separator)
- `UNSET_DECIMAL/UNSET_INTEGER/UNSET_DOUBLE` encode as `"\0"` (empty field)
- `DOUBLE_INFINITY` encodes as `"Infinity\0"`
- Booleans: `"1\0"` or `"0\0"` (NOT "true"/"false")
- `Decimal.toFixed()` prevents scientific notation (critical: `"0.00000001"` not `"1e-8"`)

**Dual-protocol dispatch (from `onMessage()` in `client/base.ts`):**
```typescript
if (this.serverVersion() >= MIN_SERVER_VER_PROTOBUF) {   // >= 201
  msgId = msgBuf.readUInt32BE(0)     // 4-byte BE integer
  payload = msgBuf.subarray(4)
} else {
  msgId = parseInt(first_null_field)  // text field
  payload = rest_after_first_null
}
if (msgId > 200) {   // PROTOBUF_MSG_ID = 200
  msgId -= 200
  this.decoder.processProtoBuf(payload, msgId)
} else {
  fields = split_on_null(payload)
  this.decoder.interpret(fields, msgId)
}
```

**Important note from DESIGN.md:** The TS implementation currently **sends ALL
requests using the legacy text protocol** even on v201+ servers. TWS accepts
this (backward compatible). A Rust port can start the same way: send text,
receive protobuf. This avoids needing to port the protobuf request encoding path.

### Server version range

`MIN_CLIENT_VER = 100`, `MAX_CLIENT_VER = 222`. The protobuf response path activates
at server v201 (`MIN_SERVER_VER_PROTOBUF`). Both paths must be handled in Rust.

The full message ID space:
- Outgoing (client->server): 59 `OUT.*` constants
- Incoming text (server->client): 109+ `IN.*` constants
- Incoming protobuf: 203 message types (msgId = text_msgId + 200 on wire)

---

## 3. Proto Definition Coverage

**203 `.proto` files** in `packages/ibkr-client/ref/source/proto/`.
All `proto3` syntax, `package protobuf`. These ARE the canonical IBKR protocol
source and can be fed directly to `prost-build`.

### Categories

| Category | Count | Key files |
|---|---|---|
| Handshake/version/config | ~20 | `StartApiRequest`, `CurrentTime`, `ApiSettingsConfig`, `ManagedAccounts` |
| Account/position/PnL | ~28 | `AccountValue`, `PortfolioValue`, `Position`, `PnL`, `PnLSingle`, `AccountSummary` |
| Orders/execution | ~25 | `Order` (140 fields), `OrderState`, `OpenOrder`, `PlaceOrderRequest`, `OrderStatus`, `Execution` |
| Market data (ticks) | ~25 | `TickPrice`, `TickSize`, `TickOptionComputation`, `TickByTickData`, `MarketDataRequest` |
| Historical data | ~15 | `HistoricalData`, `HistoricalDataBar`, `HistoricalTick`, `HistoricalDataRequest` |
| Contract | ~5 | `Contract` (21 fields), `ContractDetails` (63 fields) |
| Scanner | ~6 | `ScannerData`, `ScannerSubscription` |
| News/WSH | ~10 | `HistoricalNews`, `WshEventData`, `NewsArticle` |
| Cancel/no-op requests | ~30 | Cancel* messages, typically 1-2 fields each |
| Misc | ~39 | Display groups, Verify, FA, SmartComponents, etc. |

### prost-build estimate

`prost-build` from 203 files generates:
- 203 Rust structs with `Option<T>` fields
- `Order` struct: 140 `Option<T>` fields
- One-time setup cost (build.rs, Cargo.toml): ~0.5 eng-days
- Ongoing cost per IBKR API update: ~0 eng-days

**Finding on PortfolioValue.proto:** Financial fields (`position`, `marketPrice`,
`marketValue`, `averageCost`, `unrealizedPNL`, `realizedPNL`) are `optional double`
in protobuf. prost generates `Option<f64>`. The TS layer converts these to `Decimal`
at the callback layer. The Rust port must do the same conversion and must NOT
surface these as raw `f64` in the broker trait output.

---

## 4. Handshake + Protocol Byte Parity

The wire format is deterministic: same logical message always produces same bytes.
Record/replay tests are feasible.

**Key encoding invariants (must hold in Rust for byte parity):**

| TS behavior | Rust requirement |
|---|---|
| `String(val) + "\0"` for all fields | null-terminated UTF-8, no exceptions |
| `Decimal.toFixed()` (no scientific notation) | BigDecimal::to_plain_string() or custom formatter |
| `UNSET_DECIMAL` -> `"\0"` (empty, not the 2^127-1 value) | Special-case in encoder |
| `UNSET_INTEGER/UNSET_DOUBLE` -> `"\0"` (empty) | Special-case in encoder |
| `Infinity` -> `"Infinity\0"` | Literal string match |
| `true/false` -> `"1\0"/"0\0"` | NOT "true"/"false" |
| `null/undefined` -> panic | Rust compiler enforces this already |

**Handshake bytes (exact):**
```
// Step 1: sent without outer length prefix
41 50 49 00                            // "API\0"
00 00 00 09                            // length of "v100..222" (9 bytes)
76 31 30 30 2e 2e 32 32 32             // "v100..222"

// Step 2: StartApi (after receiving serverVersion)
00 00 00 XX                            // total length
32 00                                  // "2\0" (VERSION=2)
30 00                                  // "0\0" (clientId=0)
00                                     // "\0" (empty optCapab, if serverVersion>=72)
```

The Rust TCP handshake spike should capture actual TS session bytes (using a TCP
proxy) and compare against Rust output. If they match, the framing is correct.

---

## 5. WireDecimal / UNSET_DECIMAL Handling

### TS sentinel values (packages/ibkr-types/src/const.ts)

```typescript
UNSET_INTEGER = 2 ** 31 - 1               // 2147483647
UNSET_DOUBLE  = Number.MAX_VALUE           // 1.7976931348623157e308
UNSET_LONG    = BigInt(2 ** 63) - 1n       // 9223372036854775807
UNSET_DECIMAL = new Decimal('170141183460469231731687303715884105727')  // 2^127-1
```

### Phase 1 Rust implementation (crates/alice-trading-core/src/decimal.rs)

```rust
pub enum WireDecimal {
    Unset,
    Value { value: DecimalString },
}
```

Uses `bigdecimal::BigDecimal` internally. BigDecimal CAN represent 2^127-1 exactly
(unlike `rust_decimal` which caps at ~7.9e28). Phase 1 is correct.

**v4 §6.1 compliance:** `rust_decimal` is forbidden at the wire layer. The existing
`bigdecimal` usage in `decimal.rs` satisfies this. No change needed there.

**Gap identified: missing `from_wire_field()` multi-sentinel parser.**

When DECODING text-protocol messages, `utils.ts:decodeDecimal()` recognizes these
wire strings as sentinel values:
```typescript
// All of these decode to UNSET_DECIMAL:
""                          // empty field
"2147483647"               // UNSET_INTEGER used in Decimal field
"9223372036854775807"      // i64::MAX
"1.7976931348623157E308"   // UNSET_DOUBLE (scientific notation from some TWS versions)
"-9223372036854775808"     // i64::MIN
```

The Rust decoder must have a `WireDecimal::from_wire_field(s: &str)` method handling
this same sentinel table. This function does not exist in the current Phase 1 code.
It must be added before the IBKR decoder is implemented.

**Encoding:** `WireDecimal::Unset` must serialize as `"\0"` (empty field), NOT as
the 2^127-1 value. This is correct behavior per `makeFieldHandleEmpty()` in TS.

---

## 6. nextValidId / Client Order ID Strategy

### How the TS implementation works

`request-bridge.ts`:
```typescript
private nextOrderId_ = 0

override nextValidId(orderId: number): void {
  this.nextOrderId_ = orderId    // Set from broker on EACH connect
  this.connectResolve?.()        // Connect promise resolves here
}

getNextOrderId(): number {
  return this.nextOrderId_++     // Increment locally, NO disk persistence
}
```

`IbkrBroker.placeOrder()`:
```typescript
const orderId = this.bridge.getNextOrderId()   // integer, e.g. 1000
this.client.placeOrder(orderId, contract, order)
return { orderId: String(orderId), ... }        // string in PlaceOrderResult
```

### Critical findings

**1. No persistence.** `nextOrderId_` is in-memory only. On restart, the broker
issues a new `nextValidId` which becomes the new counter start. The TS journal
records the string orderId (`"1000"`) and reconciliation calls
`lookup_by_client_order_id("1000")` which scans open orders for orderId==1000.

**2. Integer IDs at the wire, strings in the journal.** IBKR order IDs are `i32`
on the wire. The journal stores them as strings. `modifyOrder("1000", changes)`
parses back to `i32` via `parseInt(orderId, 10)`.

**3. Crash-safety gap (correctness bug).** If the Rust process crashes between
`allocate_client_order_id()` returning "1005" and the journal intent being written,
AND the broker's `nextValidId` on reconnect returns 1003 (broker had not processed
the crashed request), the Rust port will re-use IDs 1003, 1004, 1005. Reconciliation
queries `"1005"` and finds the NEW order, not the crashed one.

**Fix required:** Persist the current `nextOrderId` to disk atomically with each
journal intent write. On reconnect: `nextOrderId = max(disk_persisted, broker_issued)`.

**4. Trait compatibility.** `Broker::allocate_client_order_id()` returns `String`.
For IBKR this will be `"1000"`, `"1001"`. This is compatible with the journal's
`Vec<String>` storage. The `lookup_by_client_order_id("1000")` impl must parse
to `i32` and issue `reqOpenOrders()`. This requires TWS to be connected at
reconciliation time.

**5. reqId namespace separation.** `RequestBridge` starts `nextReqId_` at 10,000
to avoid collision with the order ID range. The Rust IBKR broker must maintain
this same convention: reqId counter >= 10,000, orderId counter from `nextValidId`
(typically 1-999 after a fresh TWS start).

---

## 7. State Complexity

### 7.1 Connection state machine (3 states)

`DISCONNECTED -> CONNECTING -> CONNECTED`. Reconnect is NOT implemented in TS.
For production Rust: reconnect with exponential backoff, re-subscribe account
updates on reconnect, re-request `nextValidId` (critical for order ID continuity).

### 7.2 Message routing — four modes

The `RequestBridge` implements four concurrent routing modes that the Rust actor
must replicate:

**Mode A (reqId-based, single result):**
Keyed on `reqId`. One `oneshot::Sender<T>` per pending request.
Examples: `symbolSamples`, `tickSnapshotEnd`, `accountSummaryEnd`.

**Mode B (reqId-based, collector):**
Keyed on `reqId`. Accumulates callbacks until an `*End` message, then resolves.
Examples: `contractDetails`+`contractDetailsEnd`.

**Mode C (orderId-based):**
Keyed on `orderId`. Resolves on first `openOrder` callback, or on `orderStatus`
with `status=="Cancelled"` for cancel requests.
Examples: `placeOrder`, `cancelOrder`, `modifyOrder`.

**Mode D (single-slot batch collector):**
One in-flight batch request at a time. Accumulates into a `Vec<T>` until `*End`.
Examples: `reqOpenOrders`+`openOrderEnd`, `reqCompletedOrders`+`completedOrdersEnd`.

**Mode E (persistent subscription with double-buffer):**
Account data subscription. `accountCachePending_` accumulates updates, then on
`accountDownloadEnd` atomically replaces `accountCache_`.
In Rust: background Tokio task + `Arc<RwLock<AccountSnapshot>>`.

### 7.3 Order-state callback ordering guarantee

TWS delivers order state in this observed order (NOT guaranteed by protocol):
1. `openOrder(orderId, contract, order, orderState)` - initial ack
2. `orderStatus(orderId, status, filled, ...)` - fill updates
3. `executionDetails(...)` + `commissionAndFeesReport(...)` - fill details

The `RequestBridge` resolves `requestOrder()` on the FIRST `openOrder` callback.
`orderStatus` updates the fill cache but only resolves if `status=="Cancelled"`.
This ordering assumption must be preserved exactly in the Rust port.

### 7.4 Heartbeats / keep-alive

The TS implementation has no client-initiated heartbeat. Server sends `currentTime`
messages spontaneously (~60s on Gateway). The decoder handles these but takes no
action. A production Rust port should detect silence >120s and reconnect or probe.

### 7.5 Reqid namespace collision

`nextReqId_` starts at 10,000 (to avoid orderId space). `nextOrderId_` starts
from `nextValidId` (broker-issued, typically small integers). These two counters
must not overlap. If `nextValidId` ever exceeds 10,000 (unusual but possible in
long-running sessions), collision occurs. A Rust port should use separate u32
atomics and document the floor explicitly.

---

## 8. Effort Estimate

### TS IBKR LOC breakdown

| Layer | LOC | Translates to Rust? |
|---|---|---|
| Protocol types/constants | 2,421 | Yes, partially — some replaced by prost structs |
| Protocol I/O (handwritten) | 9,478 | Yes, 1:1 port |
| Generated protobuf bindings | 34,425 | No — prost-build generates Rust equivalent |
| IBroker adapter | 1,198 | Yes, 1:1 port |
| **Handwritten total** | **10,676** | |

### Rust port breakdown (eng-days)

| Component | Low | Mid | High | Notes |
|---|---|---|---|---|
| prost-build setup + code generation | 0.5 | 0.5 | 1.0 | One-time build.rs + Cargo.toml |
| TCP connection + framing (`comm.rs`, `connection.rs`, `reader.rs`) | 1.0 | 1.5 | 2.0 | Tokio TcpStream, buf accumulation |
| Handshake + StartApi | 0.5 | 1.0 | 1.5 | Dual-path setup, version exchange |
| Decoder dispatch (109+ text + 203 proto handlers) | 3.0 | 4.0 | 6.0 | Largest single risk; match arms |
| Encoder outgoing requests (59 OUT types, text protocol) | 2.0 | 3.0 | 4.0 | Version-gated fields are the risk |
| RequestBridge -> Rust actor (4 routing modes, Tokio channels) | 2.0 | 3.0 | 5.0 | Mode D (account sub) is subtlest |
| `WireDecimal::from_wire_field()` + sentinel table | 0.5 | 0.5 | 1.0 | Adding to existing Phase 1 code |
| `nextValidId` persistence + restart floor | 0.5 | 1.0 | 1.5 | New requirement absent in TS |
| `Broker` trait implementation | 1.0 | 1.5 | 2.0 | Mostly wiring existing components |
| Reconnect logic (absent in TS) | 1.0 | 1.5 | 2.0 | Required for production |
| Record/replay test infrastructure | 1.0 | 2.0 | 3.0 | No prior art in codebase |
| Integration tests (live TWS) | 1.0 | 2.0 | 3.0 | E2E test setup |
| **Total** | **14.0** | **21.5** | **32.0** | |

**v4 plan estimate: 18-25 eng-days.** This analysis places mid-case at 21.5 days,
achievable IF: proto generation is automated, reconnect is in-scope, and record/replay
testing is a first-class deliverable.

**Scope reduction option:** Limit to trading-relevant messages only:
orders, account/positions, quotes (snapshot), contract search.
This excludes historical data (993 LOC), scanner (748 LOC), news/WSH.
Estimated reduction: ~4-6 eng-days at mid-case, bringing to ~15-17 days.

---

## 9. Existing Rust IBKR Crates Survey

No Rust IBKR crate is referenced in this repository's `Cargo.toml`, `Cargo.lock`,
or any source file. The project explicitly rejected third-party IBKR wrappers
even for TypeScript (DESIGN.md: `@stoqey/ib` rejected due to supply chain risk,
single maintainer).

**Community Rust crates (offline knowledge, not verified):**
- `twsapi` / `twsapi-rs` — sporadic maintenance, Java-style design, likely pre-v201
- `ibkr-api-tokio` — low activity, unknown protobuf coverage
- Various forks — no production track record

**Case for a from-scratch Rust port:**
The TS DESIGN.md reasoning applies directly. The specific requirements for
OpenAlice (v201+ protobuf, `nextValidId` persistence, `allocate_client_order_id()`
integration with Phase 4e journal) are project-specific and unlikely to be
supported by generic community crates.

---

## 10. Key Technical Findings

### Finding 1 — Dual-protocol decoder is the architectural load-bearer

The decoder must dispatch 109+ text-protocol message IDs AND 203 protobuf message
IDs from a single byte stream, based on runtime `msgId` and server version.

In TS: two `Map<number, Handler>` lookups, handlers registered at init time.
In Rust: idiomatic choices are:
- A large `match msgId` with 109+ arms (compile-time, zero-cost, verbose)
- `HashMap<u32, Box<dyn Fn(&mut DecoderState, Bytes) -> Result<()>>>` (runtime, allocates)

The TS registration pattern (`decoder.registerText(msgId, handler)`) maps most
cleanly to the HashMap approach in Rust. The 203-arm match is safer but requires
code generation or macros to keep maintainable. Budget 3-4 eng-days for the
decoder alone — this is where unexpected complexity hides.

### Finding 2 — placeOrder has 60+ version gates in 886 LOC

`client/orders.ts:886 LOC` contains `placeOrder()` with version gates starting
at line 32. The first 80 lines alone gate on:
`MIN_SERVER_VER_DELTA_NEUTRAL`, `MIN_SERVER_VER_SCALE_ORDERS2`,
`MIN_SERVER_VER_ALGO_ORDERS`, `MIN_SERVER_VER_NOT_HELD`,
`MIN_SERVER_VER_SEC_ID_TYPE`, `MIN_SERVER_VER_PLACE_ORDER_CONID`,
`MIN_SERVER_VER_SSHORTX` — and this is only the validation section.

Missing one gate produces malformed messages. TWS may silently ignore or reject
with an error code. This cannot be unit-tested without live TWS. The TS
implementation was validated against a real Gateway — the Rust port requires the
same validation environment.

### Finding 3 — nextOrderId persistence is a correctness gap

The TS `RequestBridge` initializes `nextOrderId_` from `nextValidId` on each
connect with no disk persistence. A crash between `allocate_client_order_id()`
returning `"1005"` and the journal intent being written, followed by reconnect
where broker issues `nextValidId=1003`, causes the Rust port to re-issue orderId
1005 for a different order. Reconciliation finds the wrong order.

**Required fix (not present in TS, must be in Rust):** Persist `nextOrderId` to
disk atomically with each journal intent write. On reconnect:
`nextOrderId = max(disk_persisted, broker_nextValidId)`.

---

## 11. Unresolvable Offline Unknowns

### Unknown 1 — Live TWS parity at v201+

Whether a Rust framing implementation produces byte-identical output for the
dual-path case (send text, receive protobuf) can only be confirmed against a live
TWS/Gateway instance. The recommended pre-implementation spike (two-day TCP
handshake exercise) is the resolution path.

### Unknown 2 — Rust IBKR community crate protobuf coverage

The survey was offline. Whether any mature Rust crate handles server v201+
protobuf responses with production reliability is unverified. Given the rejection
history of third-party wrappers, this is unlikely to change the recommendation.

### Unknown 3 — Tokio reconnect with inflight oneshot receivers

The TS implementation does not reconnect. When the connection drops, `rejectAll()`
rejects all pending Promises and the UTA health layer handles it. In Rust, a
reconnecting Tokio actor with pending `oneshot::Receiver<T>` holders (from
`place_order()` callers awaiting confirmation) is a non-trivial design: senders
were associated with the old connection. The new connection will never produce
those IDs. Callers must be notified of failure before the actor reconnects.
This is the highest risk eng-day multiplier for production readiness.

---

## 12. Recommendation

**Port IBKR to Rust — with pre-conditions.**

### Green-lights

1. The protocol is fully understood. The TS implementation is a complete, validated
   reference with 203 canonical `.proto` files.
2. The non-generated handwritten surface is ~10,676 LOC — large but tractable.
   The Rust equivalent will be smaller due to stronger static types.
3. Phase 1 `WireDecimal`/`bigdecimal` foundation is correct; only needs
   `from_wire_field()` sentinel parser added.
4. The Rust broker trait is already defined with the right methods.
5. The TS implementation deliberately defers protobuf request encoding —
   the Rust port can start the same way (send text, receive protobuf).

### Pre-conditions (block-the-port items)

**Pre-condition 1 — Complete Phase 4f first.**
The `nextValidId` persistence story (Finding 3) must be designed and implemented
as part of the journal intent-write path before the IBKR broker writes its first
order. Otherwise the Rust port ships with a known crash-recovery correctness bug.

**Pre-condition 2 — Run the two-day TCP handshake spike.**
Build a minimal Tokio TCP client that:
- Sends the handshake (`API\0` + length-prefixed version string)
- Receives server version
- Sends StartApi
- Receives `nextValidId` and `managedAccounts`
- Compares wire bytes against a captured TS session transcript

If byte-identical: full port is green-lit.
If divergence found: investigate before committing 18+ eng-days.

**Pre-condition 3 — Scope reconnect as in-phase, not follow-on.**
The TS lack of reconnect is a known limitation. Adding reconnect to the Rust port
from the start is cheaper than retrofitting post-integration.

### Scope reduction (recommended)

Limit v5 port to trading-relevant messages only:
- Handshake + connection management
- Order placement/cancel/modify/query
- Account/positions data (persistent subscription)
- Quote snapshots
- Contract search

Exclude: historical data, scanner, news/WSH, FA management.
This reduces mid-estimate from 21.5 to approximately 15-17 eng-days.

---

## Appendix A — Protocol Dual-Path Decision Tree

```
incoming byte stream (Tokio TcpStream)
  |
EReader: accumulate bytes, extract [4-byte-length][payload]
  |
onMessage(payload: &[u8])
  |
if server_version >= 201:
  msgId = u32::from_be_bytes(&payload[0..4])
  payload = &payload[4..]
else:
  msgId = parse ascii integer until first '\0'
  payload = &payload[null_pos+1..]
  |
if msgId > 200:
  msgId -= 200
  prost_decode(payload) -> dispatch to proto_handler[msgId]
else:
  split payload on '\0' -> Vec<String>
  dispatch to text_handler[msgId](fields iterator)
```

This is the core of the Rust decoder — ~30 lines of logic feeding dispatch tables
with 30-109 active arms (trading-relevant subset).

---

## Appendix B — WireDecimal Wire-Sentinel Table

Wire strings that MUST map to `WireDecimal::Unset` in the Rust decoder:

| Wire string | Source |
|---|---|
| `""` (empty null-terminated field) | Normal UNSET encoding |
| `"2147483647"` | UNSET_INTEGER in Decimal field |
| `"9223372036854775807"` | i64::MAX in Decimal field |
| `"1.7976931348623157E308"` | UNSET_DOUBLE (scientific notation) |
| `"-9223372036854775808"` | i64::MIN in Decimal field |
| `"170141183460469231731687303715884105727"` | UNSET_DECIMAL direct |

Sending `WireDecimal::Unset` must produce `"\0"` (empty field), NOT the 2^127-1 value.

---

## Appendix C — File Paths

```
// Protocol types
packages/ibkr-types/src/const.ts              // UNSET_DECIMAL = 2^127-1
packages/ibkr-types/src/message.ts            // IN/OUT message IDs
packages/ibkr-types/src/server-versions.ts    // 100+ version gate constants
packages/ibkr-types/src/order.ts              // Order class, 70+ fields

// Protocol I/O
packages/ibkr-client/src/comm.ts              // Wire framing (133 LOC)
packages/ibkr-client/src/connection.ts        // TCP socket (115 LOC)
packages/ibkr-client/src/reader.ts            // EReader (54 LOC)
packages/ibkr-client/src/wrapper.ts           // EWrapper interface (1,146 LOC)
packages/ibkr-client/src/client/base.ts       // EClient + handshake (303 LOC)
packages/ibkr-client/src/client/orders.ts     // placeOrder + 60+ gates (886 LOC)
packages/ibkr-client/src/decoder/base.ts      // Decoder dispatch (91 LOC)
packages/ibkr-client/src/decoder/orders.ts    // Order handlers text+proto (793 LOC)
packages/ibkr-client/src/decoder/order.ts     // OrderDecoder legacy text (714 LOC)

// Protobuf source (203 .proto files)
packages/ibkr-client/ref/source/proto/Order.proto            // 140 fields
packages/ibkr-client/ref/source/proto/ContractDetails.proto  // 63 fields
packages/ibkr-client/ref/source/proto/PlaceOrderRequest.proto // wraps Order+Contract

// IBroker adapter
src/domain/trading/brokers/ibkr/IbkrBroker.ts      // IBroker impl (446 LOC)
src/domain/trading/brokers/ibkr/request-bridge.ts  // 4-mode routing (611 LOC)

// Rust Phase 1 foundation
crates/alice-trading-core/src/decimal.rs    // WireDecimal (correct, needs from_wire_field)
crates/alice-trading-core/src/brokers/traits.rs     // Broker trait
crates/alice-trading-core/src/journal/types.rs      // ExecutionIntent / client_order_ids: Vec<String>
```
