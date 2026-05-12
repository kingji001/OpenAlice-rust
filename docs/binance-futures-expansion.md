# Binance Futures Scope Expansion

**Status:** Active execution starting 2026-05-13 (post-pivot).
**Supersedes:** Q3 ("Futures out of scope") of `docs/binance-pivot-plan.md`.

## Decision

The pivot's "Cross Margin Spot only" scope is **expanded** to include Binance derivatives via CCXT: **USDⓈ-M Futures** (`fapi.binance.com`) and **COIN-M Futures** (`dapi.binance.com`). Cross Margin Spot remains supported in parallel; users select per-account via config.

Portfolio Margin (`papi.binance.com`) and Options remain out of scope.

### Open-question resolutions (autonomy-decided)

| # | Question | Decision | Reasoning |
|---|---|---|---|
| F1 | USDM, COINM, or both? | **Both** | CCXT routes through `defaultType` — same client, marginal incremental code. USDM is more common in practice; COINM is for hedged crypto traders. |
| F2 | Portfolio Margin / Options? | **No** | Separate APIs (`papi.binance.com` for PM, `eoptions/` for options). Not in user's URL scope. |
| F3 | Position Mode: one-way or hedge? | **One-way default, hedge optional via config** | Matches Q4 of pivot (no hedge for spot). Hedge can be enabled per-account. |
| F4 | Margin Mode: isolated or cross? | **Cross default, isolated optional** | Matches "Cross Margin" theme of pivot. |
| F5 | Leverage management | **Add `setLeverage(symbol, leverage)` to Broker interface** | Binance requires per-symbol leverage configuration via API; no default-leverage shortcut. |
| F6 | Funding rate visibility | **Add `getFundingRate(symbol)` method, no auto-settlement tracking** | Funding rate snapshots are read-only for UI/analytics; broker auto-settles via Binance. |
| F7 | Config field naming | **Rename `marginType` → `tradingMode`** | Better describes the four-way choice (spot, cross-margin, usdm-futures, coinm-futures). Pre-prod rename. |

## Architecture

```
                  CcxtBroker
                  ├── tradingMode: 'spot'            → CCXT defaultType=spot
                  ├── tradingMode: 'cross-margin'    → CCXT defaultType=margin  (Cross Margin Spot, existing)
                  ├── tradingMode: 'usdm-futures'    → CCXT defaultType=future   (NEW — fapi.binance.com)
                  └── tradingMode: 'coinm-futures'   → CCXT defaultType=delivery (NEW — dapi.binance.com)
```

The journal, guards, UtaActor, and Rust core are unchanged — all broker-agnostic.

## What gets added

### New types (`src/domain/trading/brokers/types.ts`)

```typescript
/**
 * Futures-specific order parameters. When set on Order.futuresParams,
 * the order routes through the futures endpoint with Binance-specific behavior.
 */
export interface FuturesOrderParams {
  /**
   * - 'BOTH' (default, one-way mode): single position per symbol
   * - 'LONG' / 'SHORT' (hedge mode): independent long and short positions
   */
  positionSide?: 'BOTH' | 'LONG' | 'SHORT'
  /** If true, order can only reduce position (never flip side). */
  reduceOnly?: boolean
  /** If true, close entire position at market on fill. */
  closePosition?: boolean
  /** Time-in-force (default GTC). */
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX'
}

/**
 * Funding rate snapshot for a USDM/COINM perpetual contract.
 */
export interface FundingRate {
  symbol: string
  /** Funding rate (decimal, e.g. "0.0001" = 0.01%) */
  rate: string
  /** Annualized rate estimate, if computable */
  annualizedRate?: string
  /** Next funding time (ISO 8601) */
  nextFundingTime: string
  /** Mark price at snapshot */
  markPrice: string
  /** Index price at snapshot */
  indexPrice?: string
}

/**
 * Per-symbol leverage setting.
 */
export interface LeverageSetting {
  symbol: string
  /** Effective leverage (1–125 typically, symbol-dependent) */
  leverage: number
  /** Max notional value at this leverage (USD or quote currency) */
  maxNotionalValue?: string
}

export type PositionMode = 'ONE_WAY' | 'HEDGE'
export type MarginMode = 'CROSS' | 'ISOLATED'
```

### Extend existing types

`Position` gains optional `futuresMetadata`:
```typescript
export interface Position {
  // ... existing + marginMetadata from pivot ...
  futuresMetadata?: {
    /** Mark price at read time (different from market trade price) */
    markPrice: string
    /** Liquidation price (broker-calculated) */
    liquidationPrice?: string
    /** Effective leverage on this position */
    leverage: number
    /** Margin mode at the position level */
    marginMode: MarginMode
    /** Position side (relevant in hedge mode) */
    positionSide: 'BOTH' | 'LONG' | 'SHORT'
    /** Unrealized PnL (already in Position.unrealizedPnL but futures-specific = mark-based) */
    /** Initial margin used */
    initialMargin?: string
    /** Maintenance margin required */
    maintMargin?: string
  }
}
```

`Order` already has `marginParams?: MarginOrderParams` from the pivot. Add:
```typescript
export interface Order {
  // ... existing ...
  futuresParams?: FuturesOrderParams
}
```

### New Broker interface methods (all optional)

```typescript
export interface Broker {
  // ... existing + pivot margin methods ...

  /** Set per-symbol leverage. Idempotent. */
  setLeverage?(symbol: string, leverage: number): Promise<LeverageSetting>

  /** Read the current leverage setting for a symbol. */
  getLeverage?(symbol: string): Promise<LeverageSetting>

  /** Set account-wide position mode (one-way vs hedge). */
  setPositionMode?(mode: PositionMode): Promise<void>

  /** Read current position mode. */
  getPositionMode?(): Promise<PositionMode>

  /** Set per-symbol margin mode (cross vs isolated). */
  setMarginMode?(symbol: string, mode: MarginMode): Promise<void>

  /** Read the current funding rate for a perpetual symbol. */
  getFundingRate?(symbol: string): Promise<FundingRate>

  /** Read mark price for a symbol (futures-specific, different from last trade). */
  getMarkPrice?(symbol: string): Promise<{ symbol: string; markPrice: string; indexPrice?: string }>
}
```

### CcxtBroker changes

**Rename `marginType` → `tradingMode`** in `CcxtBrokerConfig`:
```typescript
interface CcxtBrokerConfig {
  // ... existing ...
  tradingMode?: 'spot' | 'cross-margin' | 'usdm-futures' | 'coinm-futures'
  // marginType?: 'none' | 'cross'  // DEPRECATED — accept as alias for back-compat in one place
}
```

Internal mapping in constructor:
```typescript
const defaultTypeMap = {
  'spot': 'spot',
  'cross-margin': 'margin',
  'usdm-futures': 'future',
  'coinm-futures': 'delivery',
} as const
```

Wire all 7 new optional Broker methods using CCXT's:
- `setLeverage` → `exchange.setLeverage(leverage, symbol)`
- `setPositionMode` → `exchange.fapiPrivatePostPositionSideDual({ dualSidePosition: true|false })`
- `setMarginMode` → `exchange.setMarginMode(mode, symbol)`
- `getFundingRate` → `exchange.fetchFundingRate(symbol)`
- `getMarkPrice` → `exchange.fetchMarkPrice(symbol)` or via `fetchTicker`

`placeOrder` extension: when `order.futuresParams` is set, map params to CCXT's `params` object (positionSide, reduceOnly, closePosition, timeInForce). Existing CCXT integration already handles these via `params`.

### Preset catalog

`preset-catalog.ts` adds three Binance futures presets alongside `binance-cross-margin`:
- `binance-usdm-futures` (tradingMode: 'usdm-futures')
- `binance-coinm-futures` (tradingMode: 'coinm-futures')

(Mock preset retained for test infra. Total: 4 real presets + 1 mock.)

## What does NOT change

- Rust core: TradingGit, guards, journal, UtaActor, napi proxy — all broker-agnostic and unchanged
- `Operation` enum: PlaceOrder/Modify/Cancel/ClosePosition + Borrow/Repay/TransferFunding all apply uniformly across spot/margin/futures
- EventLog, ConnectorCenter, AgentCenter, web/Telegram/MCP connectors — broker-independent

## Execution tasks

| Task | Effort | Dependencies |
|---|---|---|
| **F1** — Futures types + Position/Order extensions + Broker interface | ½ day | — |
| **F2** — CcxtBroker config rename + defaultType mapping | ½ day | F1 |
| **F3** — CcxtBroker futures order placement (positionSide, reduceOnly, etc.) | ½ day | F2 |
| **F4** — CcxtBroker 7 futures methods (setLeverage, getFundingRate, etc.) | 1 day | F2 |
| **F5** — Preset catalog + config schema updates | ¼ day | F4 |
| **F6** — Tests + close-out | 1 day | F5 |

**Total estimated effort:** ~3.5 eng-days. Compressible via parallel dispatch.

## DoD

- TSC clean
- All previously-green tests still pass
- `CcxtBroker` instantiates with `tradingMode: 'usdm-futures'` without runtime error against MockExchange
- All 7 new optional Broker methods have unit tests via MockExchange
- 3 new presets in preset-catalog (binance-cross-margin retained, plus binance-usdm-futures, binance-coinm-futures)
- Phase 4f cutover gate remains green (Mock UTA via Rust proxy works)

## Out of scope (for now)

- **Live Binance Futures API testing** — requires API keys with futures permission enabled; deferred until you provision a paper/live account
- **Portfolio Margin** (`papi.binance.com`) — explicit "no" per F2
- **Options trading** — explicit "no" per F2
- **Native Binance futures client** — CCXT path only; native client is a follow-on if margin analytics insufficient
- **Funding-rate-driven automated trading logic** — broker provides snapshots; strategy layer consumes
- **Cross-product collateral** — Portfolio Margin's selling point; not relevant here

## Combined post-pivot state

After this expansion ships:
- **4 real broker presets**: binance-cross-margin, binance-usdm-futures, binance-coinm-futures, plus mock-paper
- **1 broker engine**: CcxtBroker (configured per preset)
- **0 multi-broker abstraction tax** (registry has only ccxt + mock)
- **Rust core** retained for journal/guards/persistence/event-stream
- **Net code delta from pre-pivot baseline**: ~-7,800 LOC deleted, ~+1,800 LOC added
