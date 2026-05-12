# Broker Migration Decision

**Status:** Phase 5 (offline half) evidence collected — pending USER decision on whether to invest engineering time in real-broker Rust ports for Phase 6.

**Date:** 2026-05-13
**Evidence:** [Alpaca survey](../crates/alice-trading-core/spikes/alpaca/REPORT.md) · [IBKR survey](../crates/alice-trading-core/spikes/ibkr/REPORT.md)

---

## TL;DR for the user

| Broker | Recommendation | Mid estimate | Critical gate |
|---|---|---|---|
| **Alpaca** | **Yes, port** | ~4.5 eng-days | Resolve GPL license question on `apca` crate |
| **IBKR** | **Yes — with preconditions** | ~15-17 eng-days (reduced scope) | 2-day live byte-parity spike before committing |
| **LeverUp** | Out of scope | n/a | Stay TS until LeverUp's TS impl stabilizes (v4 open decision) |

**"Neither endorsed" is a first-class outcome.** Phase 4f shipped the Rust core. If you don't port either broker, the Rust crate continues serving Mock UTAs in production and the TS implementations of Alpaca/IBKR remain canonical. The migration arc still completed successfully.

---

## Alpaca evidence (synthesized from spike)

### Where Alpaca lives today

- `src/domain/trading/brokers/alpaca/` — TS implementation, modest LOC, called by `UnifiedTradingAccount`
- Currently the easiest broker to reason about in the codebase
- Crash-recovery hole exists today: TS `AlpacaBroker` never sets `client_order_id` on any order (0 occurrences) — meaning a process crash between submission and confirmation has no path to recover

### What `apca` (the Rust client crate) covers

| Surface | Coverage |
|---|---|
| All 5 order types | ✅ Native |
| Bracket orders | ✅ Native |
| Fractional shares | ✅ Native |
| Positions, account, clock | ✅ Native |
| `client_order_id` on submission | ✅ First-class |
| `GetByClientId` lookup | ✅ First-class — perfect Phase 4e journal fit |
| Asset search with `name` field | ❌ Missing (~30 LOC raw `reqwest` workaround) |
| Combined snapshot (account+positions+orders) | ❌ Missing (3 calls needed) |

### Phase 4e journal protocol alignment

`apca` exposes `client_order_id` on order submission and lookup-by-client-id. The Phase 4e journal recipe (`record_intent` → broker call → `record_completion` → `persist_commit` → `close`) maps directly onto `apca`'s API. The Rust port would CLOSE a correctness gap that exists in the current TS implementation.

### The GPL question

`apca` is licensed **GPL-3.0-or-later**.

- **Private deployment** (your own machine, no redistribution): legally fine.
- **Open-source OpenAlice**: GPL contamination — `apca` infects whatever consumes it. You either accept GPL across the project or you don't use `apca`.
- **Distribute Rust crate as library**: GPL contamination of consumers.

If GPL is unacceptable, the fallback is a raw `reqwest`-based HTTP client (~+200 LOC, +1 eng-day on the estimate). Still feasible, just more code.

### Cost breakdown — Alpaca port (with `apca`)

| Component | Estimate |
|---|---|
| `Broker` trait impl over `apca` | ~1.5 days |
| Type bridging (Decimal, Status enum, etc.) | ~1 day |
| Asset-search `name` workaround (raw reqwest) | ~0.5 day |
| Tests, fixtures, error mapping | ~1 day |
| Wiring (factory, config, UTAManager routing) | ~0.5 day |
| **Total (Mid)** | **~4.5 eng-days** |

Without `apca` (raw client): add ~1 day → **~5.5 eng-days**.

---

## IBKR evidence (synthesized from spike)

### Where IBKR lives today

- `packages/ibkr/` — substantial implementation, ~thousands of LOC
- TS-side handles a complex stateful binary TCP protocol with text + protobuf messages
- The OpenAlice TS impl has been validated against real TWS/Gateway at server version 201+

### What makes IBKR hard

**(1) Dual-protocol decoder is the architectural load-bearer.**
Every incoming message routes to either a text handler (109+ message IDs) or a protobuf handler (203 message types), based on runtime `msgId` and server version. In TS this is two `Map<number, Handler>` tables. In Rust the idiomatic patterns (a giant `match` or `HashMap<u32, Box<dyn Fn>>`) have no clean 1:1 analog. This component carries 3-6 eng-days alone.

**(2) `WireDecimal::from_wire_field` is missing.**
The IBKR text protocol represents "unset decimal" as any of SIX different wire strings:
- `""` (empty)
- `"2147483647"` (i32::MAX)
- `"9223372036854775807"` (i64::MAX)
- `"1.7976931348623157E308"` (f64::MAX)
- `"-9223372036854775808"` (i64::MIN)
- The literal `i128::MAX = 2^127 - 1`

The Phase 1 `WireDecimal::Unset` variant exists structurally, but the decoder-side parsing function that recognizes all six sentinels does not. Must be added before any decoder work.

**(3) `nextValidId` has a crash-recovery correctness bug.**
TS `RequestBridge` initializes `nextOrderId_` from broker-issued `nextValidId` on each connect with zero disk persistence. Scenario:
- Rust allocates `client_order_id = 1005`
- Rust crashes BEFORE journal intent write completes
- On restart, broker's `nextValidId` returns `1003`
- Rust re-issues `1005` for a DIFFERENT order
- Journal reconciliation finds the wrong order

Fix: persist `nextOrderId` to disk atomically with each intent write; use `max(disk_value, broker_issued)` on reconnect. The TS impl doesn't do this. The Rust port MUST do this — it's a Rust-specific addition driven by the Phase 4e journal protocol.

**(4) Tokio reconnect with inflight `oneshot::Receiver`s.**
The TS impl has NO reconnect logic. When a Tokio actor reconnects after a disconnect, any `oneshot::Receiver<T>` holders awaiting old-connection responses will hang forever unless the actor explicitly fails them. The state machine for this is non-trivial and is the highest risk multiplier for production readiness.

### Live unknowns (can only be answered in the live half)

1. **Byte parity at server v201+** — Rust framing must produce byte-identical output for dual-path (send text, receive protobuf). Only confirmable with a live TWS/Gateway.
2. **Existing Rust IBKR crate maturity** — `twsapi`, `ibkr-api-tokio`, etc. May have protobuf v201+ gaps. Likely won't change recommendation (OpenAlice has rejected third-party wrappers before for supply-chain reasons) but worth verifying.

### Cost breakdown — IBKR port (with `prost-build` + custom client)

| Component | Mid estimate |
|---|---|
| Proto code generation + setup | ~1 day |
| Dual-protocol decoder (text + protobuf) | ~3-5 days |
| State machine core + message routing | ~2-3 days |
| `WireDecimal::from_wire_field` + sentinel handling | ~1 day |
| Connection management + reconnect | ~2-3 days |
| `nextValidId` disk persistence | ~0.5 day |
| Broker trait impl | ~2 days |
| Tests + record/replay infrastructure | ~2-3 days |
| **Total (Mid, reduced scope)** | **~15-17 eng-days** |
| **Total (Mid, full v4 scope)** | **~18-25 eng-days** |

Reduced scope = trading-relevant messages only (orders, account/positions, quote snapshots, contract search). Excludes historical data, advanced market data, news, financials.

---

## Cost-benefit comparison

| Dimension | Alpaca | IBKR | Notes |
|---|---|---|---|
| Mid estimate | 4.5 days | 15-17 days | 3-4x IBKR cost |
| Risk profile | Low | High | IBKR has 4 distinct technical risks |
| Live test required to commit | No | **Yes** (2-day spike) | IBKR has unknowns offline can't resolve |
| Library availability | `apca` (GPL) | Custom build likely needed | Different supply-chain stances |
| Production deployment risk | Low | Medium-High | Reconnect state machine is novel |
| Net correctness improvement | **High** (closes journal hole) | High (closes nextValidId hole) | Both improve current TS bugs |
| User-visible benefit | Marginal (perf, parity) | Marginal (perf, parity) | Trading semantics unchanged |

**Conventional wisdom**: if you're going to do one, do Alpaca first. It's the smaller bet, validates the journal protocol against a real broker, and de-risks IBKR.

---

## Recommendation framework

This is your call. The evidence supports any of the following paths:

### Path A: Port both Alpaca and IBKR (Phase 6 full)
- Alpaca first (~4.5 days)
- Then IBKR 2-day live byte-parity spike
- IF spike confirms feasibility, IBKR port (~15-17 days)
- Total: ~22 eng-days minimum, ~25-30 with integration + dogfooding
- **Choose this if**: you want full broker parity in Rust, are comfortable with GPL or willing to write raw HTTP client, have access to TWS/Gateway for testing
- **Risk**: ~6 weeks of work that may surface integration issues only visible in production

### Path B: Port Alpaca only (Phase 6 partial)
- ~4.5 days Alpaca
- IBKR stays TS forever (acceptable per v4 plan §3)
- Total: ~1 week + integration
- **Choose this if**: you want one Rust broker for validation, find IBKR's complexity unacceptable, or want to ship the migration faster
- **Risk**: low

### Path C: Neither — Rust core ships as-is (Phase 6 skipped)
- Phase 4f already runs Mock UTAs through Rust in production
- Real brokers stay TS canonical
- Phase 7 (cutover with TS fallback retained) becomes a no-op for brokers; the Rust core takes over for the parts it already covers (TradingGit, guards, journal, event stream)
- **Choose this if**: the cost-benefit doesn't justify either port, or production stability is the priority
- **Risk**: zero (no new code paths)

### Path D: Spike further before deciding (Phase 5 live half)
- Run the IBKR byte-parity spike (2 days)
- Run Alpaca paper-account integration with `apca` (1 day)
- Then re-evaluate
- **Choose this if**: you're not yet sure either way and want more evidence
- **Risk**: 3 days of investigation that may still result in path B or C

---

## Author's recommendation (for what it's worth)

**Path B — Port Alpaca only.**

Reasoning:
1. **Alpaca cost-benefit is clearly positive**: 4.5 days closes a real correctness bug (no `client_order_id` in current TS) and proves the Phase 4e journal end-to-end against a real broker.
2. **IBKR cost-benefit is borderline**: 15-17 days is 3-4x the cost for a similar marginal user-visible benefit. The reconnect state machine and dual-protocol decoder are genuinely novel work without a clear template to follow.
3. **"Acceptable to skip" is a first-class outcome per v4**: the Rust core ships regardless. There is no penalty for leaving IBKR TS.
4. **You can always come back to IBKR**: if Alpaca-Rust runs cleanly for ≥1 minor release in production, the case for IBKR strengthens. The current state of "neither broker proves the Rust path in production" is what makes IBKR risky to commit to now.

This recommendation is not load-bearing. You may well have business or strategic reasons to prefer Path A or Path C that don't show up in the technical evidence. Pick what fits your priorities.

---

## What happens after you choose

| Path | Next phase | Effort | Files affected |
|---|---|---|---|
| A | Phase 6 (Alpaca then IBKR) | ~5-6 weeks | New: `brokers/alpaca.rs`, `brokers/ibkr/` |
| B | Phase 6 (Alpaca only) | ~1 week | New: `brokers/alpaca.rs` |
| C | Phase 7 (no-op for brokers; defer to Phase 8) | ~½ day | Config flips only |
| D | Phase 5 live half | ~3 days | New fixtures; report updates |

---

## Decision (to be filled in by user)

**Selected path:** _____________
**Decided on:** _____________
**By:** _____________
**Rationale (1-3 sentences):**

_____________

---

*This document is the formal output of Phase 5 of the OpenAlice Rust migration. The Rust core arc (Phases 0-4f) is complete and shipped regardless of this decision.*
