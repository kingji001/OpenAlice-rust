# Generators

Deterministic, idempotent fixture-emitting scripts. Each generator
overwrites its target directory entirely — re-running produces
byte-identical output.

## Conventions

- Numeric fields serialized via `_canonical-decimal.ts::toCanonicalDecimalString`.
- File output via `_canonical-json.ts::canonicalJson({ pretty: true })`.
- File names follow `case-<descriptive-slug>-<NNN>.json`.
- The 3-digit suffix is the deterministic enumeration index — file order
  matches enumeration order so a reviewer can read fixtures in cross-product
  order.

## Private helpers

`_canonical-decimal.ts` and `_canonical-json.ts` are PRIVATE Phase 0
helpers. Phase 1c will replace these files with re-exports from
`src/domain/trading/canonical-{decimal,json}.ts`. Until then, do not
import them from `src/`.

## Adding a generator

1. Add `parity/generators/<name>.ts` exporting a `main()`.
2. Use `_canonical-decimal.ts` for any Decimal serialization.
3. Use `_canonical-json.ts::canonicalJson({ pretty: true })` for file emit.
4. Output to `parity/fixtures/<name>/`.
5. Re-running must produce byte-identical output.
6. Add a CI step that re-generates and asserts no diff.
