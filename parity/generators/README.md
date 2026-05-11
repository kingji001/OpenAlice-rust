# Generators

Deterministic, idempotent fixture-emitting scripts. Each generator
overwrites its target directory entirely — re-running produces
byte-identical output.

## Conventions

- Numeric fields serialized via `src/domain/trading/canonical-decimal.ts::toCanonicalDecimalString`.
- File output via `src/domain/trading/canonical-json.ts::canonicalJson({ pretty: true })`.
- File names follow `case-<descriptive-slug>-<NNN>.json`.
- The 3-digit suffix is the deterministic enumeration index — file order
  matches enumeration order so a reviewer can read fixtures in cross-product
  order.

## Canonical helpers

Phase 0 originally shipped these as `_canonical-decimal.ts` and
`_canonical-json.ts` private helpers in this directory. Phase 1c
lifted both into public modules at `src/domain/trading/canonical-*.ts`
and deleted the private helpers. Generators here cross-import from
`src/` via relative paths (`../../src/domain/trading/canonical-*.js`).

## Adding a generator

1. Add `parity/generators/<name>.ts` exporting a `main()`.
2. Use `src/domain/trading/canonical-decimal.ts` for any Decimal serialization.
3. Use `src/domain/trading/canonical-json.ts::canonicalJson({ pretty: true })` for file emit.
4. Output to `parity/fixtures/<name>/`.
5. Re-running must produce byte-identical output.
6. Add a CI step that re-generates and asserts no diff.
