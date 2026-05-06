# @traderalice/ibkr-client

TWS API I/O layer for IBKR: socket Connection, EReader, EClient,
Decoder, EWrapper interface, and the protobuf-generated wire-format
classes.

Constructs DTO instances from [`@traderalice/ibkr-types`](../ibkr-types/) —
the decoder does `new Contract()`, `new Execution()`, etc. as it parses
TWS messages.

For just the DTO types without the I/O layer, depend on
`@traderalice/ibkr-types` directly.

For the back-compat re-export shim, see [`@traderalice/ibkr`](../ibkr/).

## Proto generation

The `generate:proto` script regenerates `src/protobuf/*.ts` from the
`.proto` files under `ref/source/proto/`:

```bash
pnpm --filter @traderalice/ibkr-client generate:proto
```

The 203 generated files are checked into the repo; regenerate only when
upgrading IBKR proto schemas.
