# @traderalice/ibkr (re-export shim)

> ⚠️ **This package is a back-compat re-export shim.** v4 Phase 1a split
> the original monolith into two packages — see below. New code should
> depend on those directly.

## What this package contains

A two-line `src/index.ts` that re-exports both:

- [`@traderalice/ibkr-types`](../ibkr-types/) — pure DTO classes (`Order`,
  `Contract`, `ContractDetails`, `Execution`, `OrderState`, etc.), enums,
  and the `UNSET_*` sentinel constants. Zero I/O.
- [`@traderalice/ibkr-client`](../ibkr-client/) — TWS API I/O layer:
  `Connection`, `EReader`, `EClient`, `Decoder`, `EWrapper`, and the
  protobuf-generated wire-format classes.

## Why this shim exists

v3 shipped a single `@traderalice/ibkr` package containing both the DTOs
and the I/O layer. v4 Phase 1a (per
[`docs/RUST_MIGRATION_PLAN.v4.md`](../../docs/RUST_MIGRATION_PLAN.v4.md))
split them so the Rust port can target the type surface independently of
the I/O implementation.

This shim is kept for **≥1 minor release** after Phase 1a so existing
consumers of `import … from '@traderalice/ibkr'` continue to work
unchanged. Cleanup happens in Phase 8.

## Quick Start (legacy path — still works)

```typescript
import { EClient, DefaultEWrapper, Contract } from '@traderalice/ibkr'
```

## Quick Start (new code, recommended)

```typescript
// Just the data classes
import { Contract, Order, UNSET_DECIMAL } from '@traderalice/ibkr-types'

// The I/O layer
import { EClient, DefaultEWrapper } from '@traderalice/ibkr-client'
```

## Tests

8 test files live here: 5 unit specs + 3 e2e specs (the e2e specs require
live IBKR paper-trading credentials). Two unit specs that need access to
internals not exposed by the shim — `utils.spec.ts` and
`protobuf-decode.spec.ts` — moved to `packages/ibkr-client/tests/` during
Phase 1a.

```bash
pnpm test          # 5 unit specs
pnpm test:e2e      # 3 e2e specs (requires IBKR Gateway/TWS at localhost:4002)
```

## Proto generation

The `generate:proto` script and the `ref/source/proto/` source files
moved to `packages/ibkr-client/` during Phase 1a:

```bash
pnpm --filter @traderalice/ibkr-client generate:proto
```
