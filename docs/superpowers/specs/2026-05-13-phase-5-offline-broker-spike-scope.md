# Phase 5 (offline half) — Broker spike scope

## Goal

Produce enough offline evidence to decide whether to invest engineering time in real-broker Rust ports (Alpaca, IBKR) for Phase 6. **Acceptable terminal state**: "neither broker port is worth it; Rust core ships, brokers stay TS forever."

The live half (paper-account testing, IBKR Gateway connectivity) is deferred until the offline half identifies which broker (if any) is worth a closer look.

## Out of scope for offline half

- Live broker API calls (paper or otherwise)
- IBKR TWS/Gateway connectivity testing
- The decision itself — this is a USER call once the evidence is in
- LeverUp broker (v4 open decision: stay TS until LeverUp's TS impl stabilizes)

## Deliverables

### D1: Alpaca offline survey

**File**: `crates/alice-trading-core/spikes/alpaca/REPORT.md`

Covers:
1. Current TS Alpaca implementation footprint — file list, LOC, public methods
2. `apca` Rust crate API survey — what's covered, what's missing
3. Mapping table: TS `Order` → apca `Order` (field-by-field, including decimal handling + status enum)
4. Mapping table: TS `Position` → apca `Position`
5. Mapping table: TS `Contract` → apca `Asset`
6. Gap analysis: bracket orders, OCO, fractional shares, paper-vs-live config, error mapping
7. Phase 4e journal/`client_order_id` fit: how does `apca` expose `clientOrderId` on order placement + lookup?
8. Rust port effort estimate (LOC delta, weeks)

### D2: IBKR offline survey

**File**: `crates/alice-trading-core/spikes/ibkr/REPORT.md`

Covers:
1. Current TS IBKR implementation footprint — `packages/ibkr/` structure, LOC, key files
2. Existing Rust IBKR crates survey (twsapi-rs, ibkr-rust, alternatives) — completeness, maintenance, license
3. Proto definition coverage at `packages/ibkr/ref/source/proto/` — what `prost-build` would generate; gaps vs runtime needs
4. Handshake protocol notes — byte-level parity expectations vs Rust client
5. `WireDecimal` / `UNSET_DECIMAL` handling — proof of `i128::MAX` round-trip via canonical string
6. `nextValidId`-based client-order-id strategy for journal restart reconciliation
7. Phase 4e journal fit: what does an IBKR `nextValidId` reservation/restart look like
8. Rust port effort estimate (LOC delta, weeks)

### D3: `WireDecimal::UNSET_DECIMAL` round-trip tests

**File**: `crates/alice-trading-core/tests/wire_decimal_unset.rs`

Fixture-based round-trip:
- `WireDecimal::Unset` (`i128::MAX = 2^127 - 1 ≈ 1.7e38`) → canonical string → parse → equals original
- Reject `NaN`, `Infinity` (already covered in Phase 1b — this test pins IBKR's specific sentinel)
- Cross-fixture with `packages/ibkr/ref/fixtures/` if present

### D4: Record/replay harness skeleton

**Files**:
- `parity/replay/README.md` — design + usage
- `parity/replay/captured/.gitkeep` — captured fixture directory
- `parity/replay/record.ts` — skeleton recorder (no live capture yet)
- `parity/replay/replay.ts` — skeleton replayer that feeds a fixture through TS or Rust client

The skeleton is wireframe-only; populated with real captures in the live half.

### D5: Decision document framework

**File**: `docs/migration-broker-decision.md`

Sections:
- Decision summary (filled by user)
- Alpaca evidence (synthesized from D1)
- IBKR evidence (synthesized from D2)
- Cost-benefit comparison
- Recommendation framework
- "Neither endorsed" path: what changes (nothing — Rust core ships, TS brokers stay)
- "Both endorsed" path: Phase 6 sub-phase ordering

## DoD

- D1, D2, D5 written as markdown reports with concrete data, not placeholders
- D3 passes `cargo test -p alice-trading-core --test wire_decimal_unset`
- D4 skeleton documented; no actual captured fixtures required for the offline half
- Full Rust + TS suites remain green

## Estimated effort

2-3 eng-days for the offline half. Dispatched in parallel:
- Alpaca survey (1 agent, ~1 day equivalent)
- IBKR survey (1 agent, ~1 day equivalent)
- D3 + D4 code (1 agent, ~½ day equivalent)
- D5 synthesis (controller, after surveys return)

## Cutover gate

None — Phase 5 produces decisions, not code paths. Phase 4f's cutover gate is the only gate this session has left active.
