# Broker-Client Replay Harness

## Purpose

The replay harness enables **deterministic broker-client parity testing**:
capture a sequence of broker interactions once (against a real broker or a
live test environment), save it as a fixture, then replay it against either
the TypeScript client or the Rust client to verify that both sides produce
identical behaviour.

This eliminates the need for a live broker connection in CI and makes
regression tests reproducible across machines and time.

## Record Modes

Two capture modes are supported to match the two broker integration styles
used in OpenAlice:

### HTTP-mock (Alpaca-style REST)

- Intercepts outgoing HTTP requests and the corresponding responses.
- Fixture format: **JSON** — a list of `{request, response}` objects.
- File extension: `.json`
- Suitable for: Alpaca, any REST-based broker.

### TCP-bytes (IBKR-style)

- Captures the raw byte stream exchanged over the TWS/Gateway TCP connection.
- Fixture format: **binary blob** — raw bytes with length-prefixed framing.
- File extension: `.bin`
- Suitable for: Interactive Brokers (EClient/EWrapper protocol).

## Fixture Format

### HTTP fixture (`*.json`)

```json
[
  {
    "seq": 1,
    "direction": "request",
    "method": "POST",
    "url": "/v2/orders",
    "headers": { "content-type": "application/json" },
    "body": { "symbol": "AAPL", "qty": "1", "side": "buy", "type": "market", "time_in_force": "day" }
  },
  {
    "seq": 2,
    "direction": "response",
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": { "id": "abc123", "status": "accepted" }
  }
]
```

### TCP fixture (`*.bin`)

Raw bytes preceded by a 4-byte big-endian length prefix per message, e.g.:

```
[0x00 0x00 0x00 0x05] [0x31 0x00 0x31 0x00 0x00]  <- first message (5 bytes)
[0x00 0x00 0x00 0x07] [...]                         <- next message
```

## File Layout

Fixtures are stored under `parity/replay/captured/` with the following
directory structure:

```
parity/replay/captured/
  alpaca/
    buy-1share/
      2026-05-12T14-30-00Z.json
      2026-05-12T15-00-00Z.json
  ibkr/
    place-limit-order/
      2026-05-12T14-30-00Z.bin
```

Pattern: `captured/<broker>/<scenario>/<ISO-timestamp>.<ext>`

- `<broker>`: `alpaca` | `ibkr` | `mock`
- `<scenario>`: kebab-case description, e.g. `buy-1share`, `cancel-order`
- `<ISO-timestamp>`: capture time in UTC, colons replaced with hyphens for
  filesystem safety

## Usage

### Recording (LIVE — not yet implemented in Phase 5 offline skeleton)

```bash
pnpm tsx parity/replay/record.ts --broker alpaca --scenario buy-1share
```

Options:

| Flag | Description |
|---|---|
| `--broker` | `alpaca` or `ibkr` |
| `--scenario` | scenario name (used in fixture filename) |
| `--out` | override output path (default: auto-generated under `captured/`) |

### Replaying (LIVE — not yet implemented in Phase 5 offline skeleton)

```bash
pnpm tsx parity/replay/replay.ts --fixture parity/replay/captured/alpaca/buy-1share/2026-05-12T14-30-00Z.json --target ts
pnpm tsx parity/replay/replay.ts --fixture parity/replay/captured/alpaca/buy-1share/2026-05-12T14-30-00Z.json --target rust
```

Options:

| Flag | Description |
|---|---|
| `--fixture` | path to the `.json` or `.bin` fixture file |
| `--target` | `ts` (TypeScript client) or `rust` (Rust client via NAPI binding) |
| `--verbose` | print each replayed message |

## Phase Status

| Phase | Deliverable | Status |
|---|---|---|
| Phase 5 (offline) | Skeleton scripts + fixture directory layout | Done |
| Phase 5 (live) | Actual HTTP capture (Alpaca) | Deferred |
| Phase 5 (live) | Actual TCP capture (IBKR) | Deferred |
| Phase 6 | Full parity diff reporting between TS and Rust | Deferred |

## Design Notes

- Fixtures are intentionally human-readable (JSON) where possible so that
  scenario authors can craft or edit them without a running broker.
- Binary (TCP) fixtures are not editable by hand but can be regenerated from
  a live run at any time.
- The replay harness is decoupled from the unit test suite — it is invoked
  directly via `pnpm tsx`, not via Vitest, so that it can run in environments
  without a Node.js test runner configuration.
