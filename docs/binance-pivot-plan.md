# Binance Cross Margin Pivot Plan

**Status:** Active execution starting 2026-05-13.
**Supersedes:** `docs/RUST_MIGRATION_PLAN.v4.md` (multi-broker assumption obsolete), `docs/migration-broker-decision.md` (Path C selected by pivot).

## Decision

OpenAlice pivots to **Binance Cross Margin Classic** as the sole real broker. All multi-broker scaffolding (Alpaca, IBKR, Longbridge, LeverUp, non-Binance CCXT exchanges) is removed. The Rust core (Phases 0-4f) is retained because it's broker-agnostic — `TradingGit`, guards, journal, `UtaActor`, and napi proxy continue to provide durable commits, restart reconciliation, and atomic state persistence regardless of broker count.

### Open-question resolutions (controller-decided per autonomy grant)

| # | Question | Decision | Reasoning |
|---|---|---|---|
| Q1 | Cross Margin Classic (3x/5x) or Portfolio Margin (~10x)? | **Cross Margin Classic** | The user-provided Binance FAQ URL targets Classic specifically. Portfolio Margin can come later. |
| Q2 | Spot + margin hybrid or margin-only? | **Hybrid** | Cross Margin's natural state — orders without `sideEffectType` are spot, with it are margin. Both available. |
| Q3 | Futures (USDM/COINM)? | **Out of scope** | Separate wallets + different API. Not "Cross Margin" focus. |
| Q4 | Hedge mode (long+short same symbol)? | **No** | Cross Margin spot doesn't support it. Existing net-position model unchanged. |
| Q5 | CCXT path or native Binance? | **CCXT path** | ~1 week vs ~2-3 weeks. Validates thesis with minimal investment. Native Binance becomes a follow-on if margin-specific analytics prove insufficient. |

## What gets kept

**Rust core (Phases 0-4f deliverables)** — all retained:
- `crates/alice-trading-core/` — TradingGit, types, hash_v2, persisted_commit, canonical, decimal, operation_wire, wire_schema (Phase 0-3)
- Broker trait, `BrokerError`, `MockBroker` (Phase 4b)
- Guard pipeline + 3 guards (Phase 4c)
- `UtaActor`, `UtaCommand`, health state, recovery loop, atomic-write persistence (Phase 4d)
- ExecutionJournal + reconciler (Phase 4e)
- napi binding `TradingCore` + per-UTA methods + event stream (Phase 4f)
- `RustUtaProxy` TS class + UTAManager routing (Phase 4f Task D)

**TS infrastructure** — all retained:
- `UnifiedTradingAccount` class (now simpler — single broker family)
- EventLog, ConnectorCenter, AgentCenter
- Web/Telegram/MCP connectors
- AI provider routing

**Mock broker** — retained as test infrastructure. Removing it would orphan ~150 cargo tests + the parity scripts.

## What gets deleted

| Path | LOC | Reason |
|---|---|---|
| `src/domain/trading/brokers/alpaca/` | 1411 | Multi-broker assumption obsolete |
| `src/domain/trading/brokers/ibkr/` | 1198 | Multi-broker assumption obsolete |
| `src/domain/trading/brokers/longbridge/` | 1878 | Multi-broker assumption obsolete |
| `src/domain/trading/brokers/others/` (leverup, etc.) | 1820 | Multi-broker assumption obsolete |
| `packages/ibkr/` | 937 | IBKR-specific package no longer needed |
| `src/domain/trading/brokers/ccxt/exchanges/bybit.ts` | ~150 | Non-Binance exchange override |
| `src/domain/trading/brokers/ccxt/exchanges/hyperliquid.ts` | ~200 | Non-Binance exchange override |
| Tests referencing the above | ~250 | Adapt or delete |

**Total removable: ~7,844 LOC** (revised from prior 10,277 estimate — keeping Phase 5 spike reports + decision doc as archived history).

## What gets archived (not deleted)

Move to `docs/archive/v4-multi-broker/`:
- `docs/RUST_MIGRATION_PLAN.v4.md` — historical reference for the journey
- `docs/migration-broker-decision.md` — the decision-point document
- `crates/alice-trading-core/spikes/alpaca/REPORT.md`
- `crates/alice-trading-core/spikes/ibkr/REPORT.md`

The git history obviously preserves everything; archiving makes the high-value docs findable rather than gone.

## What gets added

### New types (`src/domain/trading/brokers/types.ts`)

```typescript
interface MarginAccount {
  totalAssetBtc: string;           // Total collateral value in BTC equivalent
  totalLiabilityBtc: string;       // Total borrowed in BTC equivalent
  totalNetAssetBtc: string;
  marginLevel: string;             // Binance margin ratio = totalAsset / (totalLiability + interest)
  borrowEnabled: boolean;
  transferEnabled: boolean;
  tradeEnabled: boolean;
}

interface MarginAsset {
  asset: string;                   // e.g., 'USDT', 'BTC'
  free: string;
  locked: string;                  // in open orders
  borrowed: string;                // outstanding loan
  interest: string;                // accrued interest
  netAsset: string;                // free + locked - borrowed - interest
}

interface MarginOrderParams {
  sideEffectType?: 'NO_SIDE_EFFECT' | 'MARGIN_BUY' | 'AUTO_REPAY';
  isIsolated?: boolean;            // Cross = false (Phase Pivot default)
  autoRepayAtCancel?: boolean;
}

interface FundingTransfer {
  type: 'SPOT_TO_CROSS_MARGIN' | 'CROSS_MARGIN_TO_SPOT';
  asset: string;
  amount: string;
}
```

Extend `Position`:
```typescript
interface Position {
  // ... existing fields ...
  marginMetadata?: {
    borrowed: string;
    interest: string;
    marginLevel: string;           // snapshot at position read time
  };
}
```

Extend `Order`:
```typescript
interface Order {
  // ... existing fields ...
  marginParams?: MarginOrderParams;
}
```

### New broker interface methods

```typescript
interface Broker {
  // ... existing ...
  getMarginAccount?(): Promise<MarginAccount>;
  getMarginAssets?(): Promise<MarginAsset[]>;
  borrow?(asset: string, amount: string): Promise<{ txId: string }>;
  repay?(asset: string, amount: string): Promise<{ txId: string }>;
  transferFunding?(op: FundingTransfer): Promise<{ txId: string }>;
}
```

Optional (`?`) because `MockBroker` doesn't implement them (yet). CcxtBroker (configured for Binance margin) implements them all.

### CCXT margin enablement (`CcxtBroker.ts`)

```typescript
interface CcxtBrokerConfig {
  // ... existing ...
  marginType?: 'cross' | 'none';   // default 'none' for backward compat
}
```

When `marginType === 'cross'`:
- Pass `defaultType: 'margin'` to CCXT exchange constructor
- `placeOrder` accepts `order.marginParams`, maps to Binance `params` object
- Implement all 5 new optional broker methods using CCXT's `fetchBalance` (with `{ type: 'margin' }`), `loanCreate`, `loanRepay`, `transferIn`, `transferOut`

### Journal extensions (`crates/alice-trading-core/src/journal/`)

`Operation` enum extends with margin ops:
```rust
pub enum Operation {
    PlaceOrder { /* ... */ },
    ModifyOrder { /* ... */ },
    CancelOrder { /* ... */ },
    ClosePosition { /* ... */ },
    // NEW:
    Borrow { asset: String, amount: String },
    Repay { asset: String, amount: String },
    TransferFunding { from: String, to: String, asset: String, amount: String },
}
```

Each new variant gets its own client_order_id via `allocate_client_order_id()`. Same record_intent → broker call → record_completion → close 5-step recipe.

`OperationResult` adds `Borrow { tx_id }`, `Repay { tx_id }`, `Transfer { tx_id }` variants.

### Single Binance preset

`src/domain/trading/brokers/preset-catalog.ts` shrinks to one preset:
```typescript
export const PRESETS = [
  {
    id: 'binance-cross-margin',
    label: 'Binance Cross Margin',
    type: 'ccxt',
    config: {
      exchange: 'binance',
      marginType: 'cross',
      sandbox: false,
      // API key / secret loaded from env at runtime
    },
  },
];
```

Plus existing `mock-paper` for testing.

## Execution tasks

| Task | Effort | Dependencies |
|---|---|---|
| **P1** — Pivot plan + archive prior docs | ½ day | — |
| **P2** — Delete dead broker scaffolding (alpaca/ibkr/longbridge/others) | ½ day | P1 |
| **P3** — Prune config schema + registry + preset catalog | ½ day | P2 |
| **P4** — Margin type extensions + Broker interface | ½ day | P3 |
| **P5** — CCXT margin enablement (defaultType, sideEffectType) | 1 day | P4 |
| **P6** — Margin operations (borrow/repay/transfer) in CcxtBroker | 1 day | P5 |
| **P7** — Journal: add Borrow/Repay/Transfer Operation variants | ½ day | P6 |
| **P8** — Tests + close-out | 1 day | P7 |

**Total estimated effort:** ~5-6 eng-days. Compressed via parallel subagent dispatch where dependencies allow.

## DoD

- Phase 4f cutover gate remains green (Mock UTA via Rust proxy works)
- All deleted broker directories are gone; `tsc --noEmit` clean
- New margin types compile; `CcxtBroker.ts` with `marginType: 'cross'` instantiates without runtime error
- Journal extension: 3 new Operation variants serialize/deserialize cleanly; reconciler handles them
- All existing tests still pass (modulo the 2 pre-existing flakes); deleted tests removed
- Binance preset is the only non-mock preset

## Rollback

The `RUST_MIGRATION_PLAN.v4.md` is preserved in `docs/archive/v4-multi-broker/`. Git history preserves all deleted code. Rolling back is `git revert <pivot-commit>` or manually restoring directories from `git show <hash>:path`.

## Out of scope for the pivot

- **Live Binance API testing** — requires API keys; deferred until user confirms.
- **Native Binance client** — staying on CCXT for now.
- **Portfolio Margin / Futures / Isolated Margin** — explicitly excluded per Q1-Q3.
- **Margin-specific guards** (liquidation-ratio threshold, borrow-rate alert) — could be added as a follow-on; pivot ships the protocol/journal foundation.

## Estimated total effort vs. v4 alternative

| Path | Effort | Code delta |
|---|---|---|
| v4 (Alpaca + IBKR ports) | ~5-6 weeks | +5,000 LOC, -0 LOC |
| **Pivot (this plan)** | **~1 week** | **-7,844 LOC, +1,200 LOC** |

**Net code reduction: ~6,644 LOC.** Focused product, finished in a week.
