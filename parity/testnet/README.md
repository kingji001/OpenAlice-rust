# Binance Testnet Parity Scripts

Four scripts that test the live Binance testnet/demo API through `CcxtBroker`. Each
script **exits 0 cleanly** when its required credentials are not set, so they
are safe to sit in the repo without breaking CI or local dev.

Run them manually once you have provisioned the relevant API keys.

---

## Scripts

| Script | Mode | What it tests |
|---|---|---|
| `check-binance-testnet-spot.ts` | `spot` | Auth, balance read, place/verify/cancel a LIMIT BUY on BTC/USDT (Spot testnet) |
| `check-binance-testnet-margin.ts` | `cross-margin` | Cannot be tested — CCXT has no sapi URL in testnet or demo URL sets. Prints documented skip. |
| `check-binance-testnet-usdm.ts` | `usdm-futures` | Position mode, leverage, margin mode, mark price, funding rate, place/cancel LIMIT futures order (Demo Trading) |
| `check-binance-testnet-coinm.ts` | `coinm-futures` | Same as USDM but on demo-dapi.binance.com (BTC/USD:BTC perpetual) |

---

## Three actual testing paths

### 1. Spot testnet (api.binance.vision)

CCXT routes `setSandboxMode(true)` to `testnet.binance.vision` for spot.

**Register:** <https://testnet.binance.vision/> (GitHub OAuth login)

**Env vars:**
```
BINANCE_TESTNET_KEY=<key>
BINANCE_TESTNET_SECRET=<secret>
```

**Script:** `check-binance-testnet-spot.ts`

---

### 2. Demo Trading — futures (official Binance path)

CCXT routes `enableDemoTrading(true)` to:
- `demo-fapi.binance.com` — USDⓈ-M Futures
- `demo-dapi.binance.com` — COIN-M Futures
- `demo-api.binance.com` — Spot (also supported)

**One demo account covers both USDM and COINM** — a single key pair works for both scripts.

**Register:** <https://demo.binance.com/>

**Env vars:**
```
BINANCE_DEMO_KEY=<key>
BINANCE_DEMO_SECRET=<secret>
```

**Scripts:** `check-binance-testnet-usdm.ts`, `check-binance-testnet-coinm.ts`

---

### 3. Cross Margin Spot — NOT SUPPORTED via CCXT

CCXT has no `sapi` key in either `urls.api.test` or `urls.api.demo` blocks.
Cross Margin Spot calls all hit `sapi.binance.com`, which has no testnet or demo equivalent
reachable through CCXT's URL-resolution layer.

**What this means:**
- `check-binance-testnet-margin.ts` always prints `[skip]` and exits 0
- Live mainnet is the only end-to-end option (use with extreme caution + small amounts)
- Unit coverage: `CcxtBroker.spec.ts` (8+ margin tests with MockExchange)

**Reference:** `ccxt/ts/src/binance.ts` — check `urls.api.test` and `urls.api.demo` blocks

---

## CCXT Limitations (discovered 2025-late / 2026-early)

Three constraints discovered by probing CCXT against Binance:

1. **Futures sandbox is deprecated** — `setSandboxMode(true)` for futures throws `NotSupported`
   unless `options.disableFuturesSandboxWarning = true` is set first. The warning bypass exists
   but the futures sandbox endpoint (`testnet.binancefuture.com`) is less reliable than demo.
   **Recommendation: use `simulationMode: 'demo'` for all futures testing.**

2. **`enableDemoTrading(true)` is the official replacement** — CCXT introduced this method
   which routes all futures calls to `demo-fapi.binance.com` / `demo-dapi.binance.com`.
   This is the path Binance officially recommends as of late 2025.

3. **No sapi URL in testnet or demo blocks** — Cross Margin Spot (`sapi.binance.com`) has no
   sandbox or demo equivalent reachable via CCXT. This is a structural CCXT limitation,
   not a CcxtBroker limitation.

---

## Env var matrix

| Script | Required env vars |
|---|---|
| `check-binance-testnet-spot.ts` | `BINANCE_TESTNET_KEY`, `BINANCE_TESTNET_SECRET` |
| `check-binance-testnet-margin.ts` | _(none — always exits with documented skip)_ |
| `check-binance-testnet-usdm.ts` | `BINANCE_DEMO_KEY`, `BINANCE_DEMO_SECRET` |
| `check-binance-testnet-coinm.ts` | `BINANCE_DEMO_KEY`, `BINANCE_DEMO_SECRET` |

---

## How to run

```bash
# One at a time:
pnpm tsx parity/testnet/check-binance-testnet-spot.ts
pnpm tsx parity/testnet/check-binance-testnet-margin.ts
pnpm tsx parity/testnet/check-binance-testnet-usdm.ts
pnpm tsx parity/testnet/check-binance-testnet-coinm.ts

# Or all four (each exits 0 on skip or pass):
for s in spot margin usdm coinm; do
  pnpm tsx "parity/testnet/check-binance-testnet-${s}.ts"
done
```

Expected output when credentials are **not** set (spot/usdm/coinm):
```
[skip] BINANCE_TESTNET_KEY and BINANCE_TESTNET_SECRET required; skipping live testnet check
```

Expected output for margin script (always):
```
[skip] Cross Margin Spot (sapi) cannot be tested through CCXT — neither testnet nor demo trading
       supports sapi endpoints. CCXT enforces this at the URL-resolution layer.
```

Expected tail when credentials **are** set and all checks pass:
```
[PASS] check-binance-testnet-spot: all checks passed.
```

---

## Using a .env file

The recommended approach is to store credentials in a `.env` file at the repo
root and load it with a helper like `dotenv`:

```bash
# .env (gitignored — never commit this file)
BINANCE_TESTNET_KEY=xxxx
BINANCE_TESTNET_SECRET=yyyy
BINANCE_DEMO_KEY=aaaa
BINANCE_DEMO_SECRET=bbbb
```

Then run with dotenv loaded:

```bash
node --env-file=.env $(which pnpm) tsx parity/testnet/check-binance-testnet-spot.ts
# or
dotenv -e .env -- pnpm tsx parity/testnet/check-binance-testnet-spot.ts
```

`.env` is already gitignored by the repo's `.gitignore`.

---

## What each script does

**`check-binance-testnet-spot.ts`** — Basic spot smoke test. Places a tiny
LIMIT BUY at 50% below market on BTC/USDT (so it never fills), verifies the
order shows up in `getOrders()`, then cancels. Uses `simulationMode: 'sandbox'`
(CCXT `setSandboxMode(true)` → `testnet.binance.vision`).

**`check-binance-testnet-margin.ts`** — Documents the CCXT limitation that
prevents Cross Margin Spot from being tested via testnet or demo. Always exits
cleanly with an explanatory message. The dry-run mode prints what the call
sequence _would_ look like if CCXT supported sapi in its demo URL set.

**`check-binance-testnet-usdm.ts`** — USDⓈ-M Futures full lifecycle. Sets
position mode (ONE_WAY), leverage (×5), margin mode (CROSS), reads mark price
and funding rate, verifies position mode, then places and cancels a LIMIT order
with `positionSide=BOTH`. Uses `simulationMode: 'demo'` (CCXT `enableDemoTrading(true)`
→ `demo-fapi.binance.com`).

**`check-binance-testnet-coinm.ts`** — Same as USDM but on `demo-dapi.binance.com`.
Auto-resolves the COIN-M symbol between `BTC/USD:BTC` and `BTC/USD` depending
on what CCXT's market catalog exposes. Uses the same BINANCE_DEMO_* env vars.

---

## Cleanup behavior

Every script that places an order wraps the order lifecycle in a `try/finally`
block. The `finally` block always runs — even if an assertion fails — and
attempts to cancel any open order. Cleanup lines are prefixed with
`[cleanup]` to make the path observable in terminal output.

If an order has already filled (demo environment can be generous with fills),
the cancel step prints a warning and continues rather than failing — a filled
order is not a bug in the script.

---

## Known quirks

- **Occasional outages**: Binance demo/testnet environments go down without notice.
  If `init()` fails with a network error, wait a few minutes and retry.
- **Generous fills on limit orders**: If your limit price is accidentally close
  to the market price, the demo environment may fill it instantly. The scripts
  place orders at 50% below market to avoid this.
- **Rate limits are lower than mainnet**: Demo/testnet accounts have tighter rate
  limits. If you run all scripts back-to-back rapidly, you may hit a 429.
  Add a brief pause between runs if needed.
- **COIN-M symbol instability**: The CCXT canonical name for the BTC COIN-M
  perpetual has varied across CCXT versions (`BTC/USD:BTC` vs `BTC/USD`). The
  COINM script probes the market catalog and uses whichever resolves.

---

## Warning: credential hygiene

**Never commit credentials. Use `.env` (gitignored). After any session where
you have handled real credentials, rotate them in Binance API Management.**

If you accidentally commit a key:
1. Immediately delete the key in Binance API Management.
2. Create a new key pair.
3. Rewrite git history with `git filter-repo` or contact GitHub support to
   remove the commit from all forks.

Demo keys cannot access real funds, but rotate them anyway to establish
good habits and prevent confusion between demo and mainnet credentials.
