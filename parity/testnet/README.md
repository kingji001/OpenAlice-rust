# Binance Testnet Parity Scripts

Four scripts that test the live Binance testnet API through `CcxtBroker`. Each
script **exits 0 cleanly** when its required credentials are not set, so they
are safe to sit in the repo without breaking CI or local dev.

Run them manually once you have provisioned testnet API keys.

---

## Scripts

| Script | Mode | What it tests |
|---|---|---|
| `check-binance-testnet-spot.ts` | `spot` | Auth, balance read, place/verify/cancel a LIMIT BUY on BTC/USDT |
| `check-binance-testnet-margin.ts` | `cross-margin` | Margin account info, asset list, place/cancel margin order, borrow/repay, transfer round-trips |
| `check-binance-testnet-usdm.ts` | `usdm-futures` | Position mode, leverage, margin mode, mark price, funding rate, place/cancel LIMIT futures order |
| `check-binance-testnet-coinm.ts` | `coinm-futures` | Same as USDM but on dapi.binance.com (BTC/USD:BTC perpetual) |

---

## Account setup

### Spot / Cross Margin testnet

1. Go to <https://testnet.binance.vision/>
2. Log in with GitHub OAuth.
3. Under **API Management**, click **Generate HMAC_SHA256 Key**.
4. Copy the key and secret — the secret is shown once only.
5. Set env vars:
   ```
   BINANCE_TESTNET_KEY=<key>
   BINANCE_TESTNET_SECRET=<secret>
   ```

Both spot and margin scripts share this key pair (the spot testnet exposes both
modes on the same account).

### USDⓈ-M Futures testnet

1. Go to <https://testnet.binancefuture.com/>
2. Register / log in.
3. Click **API Management** → create a key for USDⓈ-M.
4. Set env vars:
   ```
   BINANCE_USDM_TESTNET_KEY=<key>
   BINANCE_USDM_TESTNET_SECRET=<secret>
   ```

### COIN-M Futures testnet

1. Same portal: <https://testnet.binancefuture.com/>
2. Switch to the **COIN-M** tab (top of the page).
3. API Management → create a **separate** key for COIN-M (different from the
   USDM key — the two product families use separate signing contexts on
   testnet).
4. Set env vars:
   ```
   BINANCE_COINM_TESTNET_KEY=<key>
   BINANCE_COINM_TESTNET_SECRET=<secret>
   ```

---

## Env var matrix

| Script | Required env vars |
|---|---|
| `check-binance-testnet-spot.ts` | `BINANCE_TESTNET_KEY`, `BINANCE_TESTNET_SECRET` |
| `check-binance-testnet-margin.ts` | `BINANCE_TESTNET_KEY`, `BINANCE_TESTNET_SECRET` |
| `check-binance-testnet-usdm.ts` | `BINANCE_USDM_TESTNET_KEY`, `BINANCE_USDM_TESTNET_SECRET` |
| `check-binance-testnet-coinm.ts` | `BINANCE_COINM_TESTNET_KEY`, `BINANCE_COINM_TESTNET_SECRET` |

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

Expected output when credentials are **not** set:

```
[skip] BINANCE_TESTNET_KEY and BINANCE_TESTNET_SECRET required; skipping live testnet check
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
BINANCE_USDM_TESTNET_KEY=aaaa
BINANCE_USDM_TESTNET_SECRET=bbbb
BINANCE_COINM_TESTNET_KEY=cccc
BINANCE_COINM_TESTNET_SECRET=dddd
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
order shows up in `getOrders()`, then cancels. Confirms authentication and
order lifecycle work end-to-end.

**`check-binance-testnet-margin.ts`** — Cross Margin full lifecycle. Reads the
margin account snapshot (marginLevel, borrowEnabled), lists margin assets,
places a NO_SIDE_EFFECT LIMIT order, cancels it, then does a 1-USDT
borrow→repay round-trip and a 1-USDT SPOT→MARGIN→SPOT transfer round-trip.

**`check-binance-testnet-usdm.ts`** — USDⓈ-M Futures full lifecycle. Sets
position mode (ONE_WAY), leverage (×5), margin mode (CROSS), reads mark price
and funding rate, verifies position mode, then places and cancels a LIMIT order
with `positionSide=BOTH`.

**`check-binance-testnet-coinm.ts`** — Same as USDM but on dapi.binance.com.
Auto-resolves the COIN-M symbol between `BTC/USD:BTC` and `BTC/USD` depending
on what CCXT's market catalog exposes for the current version.

---

## Cleanup behavior

Every script that places an order wraps the order lifecycle in a `try/finally`
block. The `finally` block always runs — even if an assertion fails — and
attempts to cancel any open order. Cleanup lines are prefixed with
`[cleanup]` to make the path observable in terminal output.

If an order has already filled (testnet can be generous with fills, especially
if you place limits close to market), the cancel step prints a warning and
continues rather than failing — a filled order is not a bug in the script.

---

## Known testnet quirks

- **Occasional outages**: Binance testnets go down without notice. If
  `init()` fails with a network error, wait a few minutes and retry.
- **Generous fills on limit orders**: If your limit price is accidentally close
  to the market price, testnet may fill it instantly. The scripts place orders
  at 50% below market to avoid this, but testnet market prices can be stale.
- **Rate limits are lower than mainnet**: Testnet accounts have tighter rate
  limits. If you run all four scripts back-to-back rapidly, you may hit a 429.
  Add a brief pause between runs if needed.
- **COIN-M symbol instability**: The CCXT canonical name for the BTC COIN-M
  perpetual has varied across CCXT versions (`BTC/USD:BTC` vs `BTC/USD`). The
  COINM script probes both and uses whichever resolves.
- **Testnet resets**: Binance testnet accounts are periodically reset to their
  initial funded state. If your balance or open orders disappear, that is
  expected.

---

## Warning: credential hygiene

**Never commit credentials. Use `.env` (gitignored). After any session where
you have handled real credentials, rotate them in Binance API Management.**

If you accidentally commit a key:
1. Immediately delete the key in Binance API Management.
2. Create a new key pair.
3. Rewrite git history with `git filter-repo` or contact GitHub support to
   remove the commit from all forks.

Testnet keys cannot access real funds, but rotate them anyway to establish
good habits and prevent confusion between testnet and mainnet credentials.
