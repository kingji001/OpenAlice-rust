# Phase 1c — Canonical JSON utility design

**Date:** 2026-05-12
**Migration phase:** v4 §5 Phase 1c (lines ~419-434). [v4 plan](../../RUST_MIGRATION_PLAN.v4.md).
**Status:** Spec — to be implemented.
**Estimated effort:** 2 eng-days (single PR, 5 sub-task commits).

## Goal

Lift the 3 inline canonical-formatter helpers shipped during Phase 0 (private) and Phase 1b (inline) into a single public source-of-truth module under `src/domain/trading/`. Delete the 3 inline helpers. Switch 4 consumers to import from the public modules. Add the wire-fixture round-trip test the v4 spec calls for.

Phase 1c is dead code on the live path. Phase 2 wires `canonicalJson` into TradingGit's hash inputs.

## Non-goals

- Wiring canonical-json into TradingGit (Phase 2's job).
- Extending `canonicalJson` to accept new value shapes — the existing Phase 0 implementation is generic and already handles WireDecimal/WireDouble correctly because the `kind` and `value` discriminant keys sort alphabetically into the right order.
- Migrating consumers of `@traderalice/ibkr` to direct `@traderalice/ibkr-types` imports (Phase 8 cleanup).
- Rewriting test cases inside the 2 moved specs — they continue to test the same behavior, just from a different path.

## Architecture

Two new public modules + one new spec, replacing three inline helpers.

### Public modules (new)

```
src/domain/trading/
├── canonical-decimal.ts             # NEW: explicit decimal formatter
└── canonical-json.ts                # NEW: sort-key recursive JSON serializer
```

**`canonical-decimal.ts`** — lifted from Phase 0's `parity/generators/_canonical-decimal.ts` and Phase 1b's `src/domain/trading/wire-canonical-decimal.ts` (both have byte-identical logic modulo header comments). Exports:

- `toCanonicalDecimalString(d: Decimal): string` — applies v4 §6.1 rules
- `class CanonicalDecimalError extends Error` — thrown on NaN/Infinity

Rules (v4 §6.1):
- No exponent / scientific notation
- No leading `+`
- No trailing decimal point
- Canonical zero = `"0"` (not `"0.0"`, not `"-0"`)
- Negative sign only on nonzero values
- Reject NaN / Infinity / -0 with a thrown `CanonicalDecimalError`
- Trailing zeros after decimal point stripped

**`canonical-json.ts`** — lifted from Phase 0's `parity/generators/_canonical-json.ts` (byte-identical logic). Exports:

- `canonicalJson(value: CanonicalJsonValue, opts?: { pretty?: boolean }): string` — sort-key recursive serializer
- `type CanonicalJsonValue = string | number | boolean | null | CanonicalJsonValue[] | { [k: string]: CanonicalJsonValue }`

Rules:
- Sort object keys alphabetically at every nesting level
- Arrays preserve order (semantic)
- No whitespace by default; pretty-printed via `opts.pretty`
- Strings/numbers/null/booleans serialize via standard JSON rules
- Caller is responsible for converting Decimals to canonical strings BEFORE calling this — `canonicalJson` operates on plain JSON values only

WireDecimal / WireDouble values serialize correctly via the generic serializer because the discriminant keys (`kind`, `value`) sort alphabetically (`kind` < `value`) into the v3-locked wire form.

### Spec files (moved + new)

```
src/domain/trading/__test__/
├── canonical-decimal.spec.ts        # MOVED from parity/generators/_canonical-decimal.spec.ts
├── canonical-json.spec.ts           # MOVED from parity/generators/_canonical-json.spec.ts
└── canonical-roundtrip.spec.ts      # NEW: wire-fixture round-trip
```

The 2 moved specs (`git mv`, history preserved) carry over their 24 existing tests (17 from canonical-decimal + 7 from canonical-json). Their imports rewrite from `'./_canonical-*.js'` to `'../canonical-*.js'`.

The new round-trip spec walks every fixture in `parity/fixtures/orders-on-wire/` (341 files) + `parity/fixtures/sentinels/` (86 files) = 427 fixtures, parses each as JSON, runs through `canonicalJson` then `JSON.parse`, and asserts the result deep-equals the original parsed object. This complements Phase 1b's IBKR-class → Wire → IBKR-class round-trip with JSON → canonical-JSON → JSON.

### Deletions (3 inline helpers)

```
parity/generators/_canonical-decimal.ts        # Phase 0 private helper
parity/generators/_canonical-json.ts           # Phase 0 private helper
src/domain/trading/wire-canonical-decimal.ts   # Phase 1b inline helper
```

All three had documented "Phase 1c will replace this" header comments. Deletion is the spec-intended cleanup.

## Consumer import rewrites

6 import lines across 4 files:

| File | Current import | New import |
|---|---|---|
| `parity/generators/sentinels.ts` | `from './_canonical-decimal.js'` | `from '../../src/domain/trading/canonical-decimal.js'` |
| `parity/generators/sentinels.ts` | `from './_canonical-json.js'` | `from '../../src/domain/trading/canonical-json.js'` |
| `parity/generators/operations.ts` | `from './_canonical-decimal.js'` | `from '../../src/domain/trading/canonical-decimal.js'` |
| `parity/generators/operations.ts` | `from './_canonical-json.js'` | `from '../../src/domain/trading/canonical-json.js'` |
| `parity/run-ts.ts` | `from './generators/_canonical-json.js'` | `from '../src/domain/trading/canonical-json.js'` |
| `src/domain/trading/wire-adapters.ts` | `from './wire-canonical-decimal.js'` | `from './canonical-decimal.js'` |

`parity/` → `src/` cross-directory imports follow existing precedent (`parity/_construct.ts` already imports `TradingGit` from `src/domain/trading/git/TradingGit.js`).

## Sub-task sequencing (single PR)

| Sub-task | What lands | After this commit |
|---|---|---|
| A — create public modules | `src/domain/trading/canonical-decimal.ts` + `src/domain/trading/canonical-json.ts`. New files only; nothing imports them yet. | Public modules exist; inline helpers still in place; all existing consumers unchanged. |
| B — move specs + rewrite their imports | `git mv` 2 Phase 0 specs into `src/domain/trading/__test__/`. Rewrite each spec's import from `./_canonical-*.js` to `../canonical-*.js`. | Moved specs exercise the new public modules; old specs gone from `parity/generators/`. |
| C — switch consumers + delete inline helpers | Rewrite 6 import lines across 4 consumer files. Then `git rm` the 3 inline helpers. | All consumers go through the public modules; inline helpers gone. |
| D — round-trip fixture test | New `src/domain/trading/__test__/canonical-roundtrip.spec.ts` walks 427 Phase 0 fixtures, asserts round-trip. | v4 round-trip requirement met. |
| E — DoD verification | No new code. Runs all DoD checks. | Phase 1c done. |

A → B → C strictly sequential. D depends on A. E depends on all.

## Definition of Done

- [ ] 3 new files exist: `src/domain/trading/canonical-decimal.ts`, `src/domain/trading/canonical-json.ts`, `src/domain/trading/__test__/canonical-roundtrip.spec.ts`
- [ ] 2 spec files moved via `git mv` (history preserved): `src/domain/trading/__test__/canonical-decimal.spec.ts`, `src/domain/trading/__test__/canonical-json.spec.ts`
- [ ] 3 deletions: `parity/generators/_canonical-decimal.ts`, `parity/generators/_canonical-json.ts`, `src/domain/trading/wire-canonical-decimal.ts`
- [ ] `pnpm install` clean (no dependency changes; pure refactor)
- [ ] `npx tsc --noEmit` clean (no NEW errors)
- [ ] `pnpm test` → no regressions; total tests increase by ~427 round-trip cases (1738 baseline + ~427 = ~2165). Note that the 24 moved-spec tests were already in the baseline count.
- [ ] `pnpm tsx parity/generators/operations.ts` runs clean. Re-running produces byte-identical output to the pre-Phase-1c state (since the public formatter has byte-identical rules to the inline helper it replaced). Verify: `git diff parity/fixtures/operations/` is empty after re-run.
- [ ] `pnpm tsx parity/generators/sentinels.ts` runs clean. Same byte-identical regeneration verified.
- [ ] `pnpm tsx parity/run-ts.ts <sample-fixture>` produces byte-identical output to the pre-Phase-1c state.
- [ ] `pnpm dev` boots; `/api/status` returns expected JSON.
- [ ] `git ls-files parity/generators/ | grep canonical` is empty (no canonical helpers left in `parity/`).
- [ ] `git ls-files src/domain/trading/wire-canonical-decimal.ts` is empty.
- [ ] Round-trip test passes for all 427 fixtures.
- [ ] Moved specs still pass (24 tests: 17 canonical-decimal + 7 canonical-json).
- [ ] `git diff <base>..HEAD -- src/` shows only Phase 1c additions/moves/deletions plus the `wire-adapters.ts` one-line import rewrite.
- [ ] `git diff <base>..HEAD -- packages/ pnpm-workspace.yaml turbo.json package.json` empty.

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `parity/` → `src/` import paths break because some build tool excludes `src/` from `parity/` resolution | Low | High | The pattern already exists (`parity/_construct.ts` imports `src/domain/trading/git/TradingGit.js`). Sub-task A test will catch any resolution issue. |
| Phase 0 fixtures regenerate to byte-different output after consumer-import switch | Low | Medium | The new public module is byte-identical logic to the inline helpers (modulo header comments). Sub-task C runs `pnpm tsx parity/generators/operations.ts` after the switch and asserts `git diff parity/fixtures/operations/` is empty. Same for `sentinels.ts`. |
| Round-trip test discovers a wire fixture that doesn't round-trip (e.g., a fixture with `undefined` that JSON.parse handles differently) | Low | Medium | Phase 0 fixtures are JSON-clean (no `undefined`). Phase 1b's 427 round-trip already exercises the same fixture corpus via wire adapters. If a fixture has weird structure, the test fails clearly listing the file. |
| Moving the 2 Phase 0 spec files breaks vitest config | Low | Low | Vitest default config picks up `*.spec.ts` recursively. Verify by running the moved specs in Sub-task B. |
| Same-commit dependency between `wire-adapters.ts` import rewrite and `wire-canonical-decimal.ts` deletion | n/a — same-commit change | n/a | Sub-task C does both in one commit. |

## Out of scope

- Wiring canonical-json into TradingGit (Phase 2).
- Adding `canonicalJson` support for any non-Wire types (the function is generic).
- Migrating consumers of `@traderalice/ibkr` to direct `@traderalice/ibkr-types` imports (Phase 8).
- Rewriting any test cases inside the 2 moved specs.

## Acceptance signal

Phase 1c is "done" when:

- All DoD bullets pass.
- The PR's diff is purely refactor: 3 public modules created, 3 inline helpers deleted, 2 spec files moved, 6 import lines rewritten, 1 new round-trip spec added. No production behavior change.
- `pnpm tsx parity/generators/operations.ts` post-Phase-1c produces byte-identical fixtures to pre-Phase-1c. This is the key correctness signal — the refactor didn't accidentally change formatter behavior.
- A reviewer can read `canonical-decimal.ts` (single function, ~25 lines) and `canonical-json.ts` (single function, ~30 lines), then a single sample test, and understand the contract.
