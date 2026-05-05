# Orders-on-wire snapshots

Captures today's `JSON.stringify(orderInstance, null, 2)` and
`JSON.stringify(contractInstance, null, 2)` output for every unique Order
and Contract shape across `parity/fixtures/operations/placeOrder/`.

Files are named by sha8(content) for dedup. Multiple Operation fixtures
may share the same Order shape after stringify (e.g., differ only in
contract symbol but share order params).

## Used by

Phase 1b's WireOrder/WireContract adapters: each snapshot must
round-trip through Wire form and back to byte-identical JSON.

## Regenerate

```bash
pnpm tsx parity/generators/orders-on-wire.ts
```

Idempotent. Re-running yields the same set of files.
