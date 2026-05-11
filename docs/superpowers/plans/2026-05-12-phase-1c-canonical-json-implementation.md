# Phase 1c — Canonical JSON Utility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the canonical-decimal + canonical-json helpers from Phase 0 private (`parity/generators/_canonical-*.ts`) and Phase 1b inline (`src/domain/trading/wire-canonical-decimal.ts`) into 2 public modules at `src/domain/trading/canonical-{decimal,json}.ts`. Delete the 3 inline helpers. Switch 4 consumers.

**Architecture:** Pure refactor. Public modules have byte-identical logic to the inline helpers they replace (modulo header comments). Phase 0's 2 spec files move via `git mv` so history is preserved. One new spec adds the round-trip-over-427-fixtures test v4 §5 Phase 1c Deliverable 1 calls for.

**Tech Stack:** TypeScript, `decimal.js`, `vitest`. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-12-phase-1c-canonical-json-design.md`](../specs/2026-05-12-phase-1c-canonical-json-design.md) (commit `678669a`).

**Pre-flight checks before starting:**

- [ ] Working tree clean: `git status --short` empty.
- [ ] On master at expected commit: `git log --oneline -1` shows `678669a` or later.
- [ ] Baseline test count: record `pnpm test 2>&1 | grep -E "^\s+Tests" | tail -1` (~1738).
- [ ] Phase 0 fixture corpus present: `find parity/fixtures/orders-on-wire parity/fixtures/sentinels -name '*.json' | wc -l` returns 427.
- [ ] The 3 inline helpers exist (will be deleted in Task C): `ls parity/generators/_canonical-decimal.ts parity/generators/_canonical-json.ts src/domain/trading/wire-canonical-decimal.ts`.
- [ ] The 2 Phase 0 specs exist (will be moved in Task B): `ls parity/generators/_canonical-decimal.spec.ts parity/generators/_canonical-json.spec.ts`.

---

## Task A: Create public modules

Two new public files. Logic byte-identical to the existing inline helpers (modulo header comments). Nothing imports these yet — the inline helpers stay in place; this task is additive.

**Files:**
- Create: `src/domain/trading/canonical-decimal.ts`
- Create: `src/domain/trading/canonical-json.ts`

- [ ] **Step 1: Create `src/domain/trading/canonical-decimal.ts`**

```typescript
/**
 * Canonical decimal-string formatter.
 *
 * Public module per v4 §5 Phase 1c. Lifted from Phase 0's private helper
 * (parity/generators/_canonical-decimal.ts) and Phase 1b's inline helper
 * (src/domain/trading/wire-canonical-decimal.ts). Both inline helpers
 * are deleted in Phase 1c Task C.
 *
 * Rules (v4 §6.1):
 *   - No exponent / scientific notation.
 *   - No leading '+'.
 *   - No trailing decimal point.
 *   - Canonical zero = "0" (not "0.0", not "-0").
 *   - Negative sign only on nonzero values.
 *   - Reject NaN / Infinity / -0 with a thrown error.
 *   - Trailing zeros after decimal point are stripped.
 */

import Decimal from 'decimal.js'

export class CanonicalDecimalError extends Error {}

export function toCanonicalDecimalString(d: Decimal): string {
  if (d.isNaN()) throw new CanonicalDecimalError('NaN is not representable')
  if (!d.isFinite()) throw new CanonicalDecimalError('Infinity is not representable')

  // Use decimal.js's toFixed() to avoid exponent notation, then strip.
  // toFixed() with no arg returns the full precision without exponent.
  let s = d.toFixed()

  // Strip trailing zeros after decimal point (and the point itself if all zeros).
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }

  // Canonical zero handling: "-0" → "0", "0" stays "0".
  if (s === '-0' || s === '0') return '0'

  // No leading '+' to strip — decimal.js doesn't emit one.
  return s
}
```

- [ ] **Step 2: Create `src/domain/trading/canonical-json.ts`**

```typescript
/**
 * Canonical JSON serializer.
 *
 * Public module per v4 §5 Phase 1c. Lifted from Phase 0's private helper
 * (parity/generators/_canonical-json.ts), deleted in Phase 1c Task C.
 *
 * Rules:
 *   - Sort object keys recursively (alphabetical).
 *   - Arrays preserve order (semantic).
 *   - No whitespace by default; pretty-printed via the `pretty` option.
 *   - Strings/numbers/null/booleans serialize via standard JSON rules.
 *
 * The caller is responsible for converting Decimals to canonical strings
 * BEFORE calling this — canonical-json operates on plain JSON values only.
 */

export type CanonicalJsonValue =
  | string | number | boolean | null
  | CanonicalJsonValue[]
  | { [k: string]: CanonicalJsonValue }

export function canonicalJson(value: CanonicalJsonValue, opts: { pretty?: boolean } = {}): string {
  const sortedReplacer = (_: string, v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k]
      }
      return sorted
    }
    return v
  }
  return opts.pretty
    ? JSON.stringify(value, sortedReplacer, 2)
    : JSON.stringify(value, sortedReplacer)
}
```

- [ ] **Step 3: Verify tsc clean**

```bash
npx tsc --noEmit
```
Expected: no NEW errors. (Pre-existing errors are not your concern.)

- [ ] **Step 4: Verify the existing inline-helper specs still pass against the unchanged inline files**

```bash
pnpm test parity/generators/_canonical-decimal.spec.ts parity/generators/_canonical-json.spec.ts
```
Expected: 24 tests still pass (17 + 7). This confirms the inline helpers still work; we haven't broken anything yet.

- [ ] **Step 5: Commit**

```bash
git add src/domain/trading/canonical-decimal.ts src/domain/trading/canonical-json.ts
git commit -m "feat(canonical): public canonical-decimal + canonical-json modules (Task A)

Byte-identical lift from Phase 0's parity/generators/_canonical-*.ts
and Phase 1b's src/domain/trading/wire-canonical-decimal.ts. Inline
helpers stay in place until Task C swaps consumers and deletes them.

Spec: docs/superpowers/specs/2026-05-12-phase-1c-canonical-json-design.md"
```

---

## Task B: Move + rewrite Phase 0 specs

`git mv` 2 spec files into `__test__/` next to the new public modules. Update each spec's import to point at the public module.

**Files:**
- Move: `parity/generators/_canonical-decimal.spec.ts` → `src/domain/trading/__test__/canonical-decimal.spec.ts`
- Move: `parity/generators/_canonical-json.spec.ts` → `src/domain/trading/__test__/canonical-json.spec.ts`
- Modify (after move): single import line in each spec file

- [ ] **Step 1: Move the 2 spec files via `git mv`**

```bash
mkdir -p src/domain/trading/__test__
git mv parity/generators/_canonical-decimal.spec.ts src/domain/trading/__test__/canonical-decimal.spec.ts
git mv parity/generators/_canonical-json.spec.ts src/domain/trading/__test__/canonical-json.spec.ts
```

Verify the moves happened with rename detection:
```bash
git status --short
```
Expected output includes:
```
R  parity/generators/_canonical-decimal.spec.ts -> src/domain/trading/__test__/canonical-decimal.spec.ts
R  parity/generators/_canonical-json.spec.ts -> src/domain/trading/__test__/canonical-json.spec.ts
```

- [ ] **Step 2: Rewrite the import in `canonical-decimal.spec.ts`**

The moved file currently has (from its Phase 0 origin):
```typescript
import { toCanonicalDecimalString, CanonicalDecimalError } from './_canonical-decimal.js'
```

That relative path no longer resolves (the file is now in `__test__/`, and the public module is at `../canonical-decimal.ts`). Rewrite to:

```typescript
import { toCanonicalDecimalString, CanonicalDecimalError } from '../canonical-decimal.js'
```

Use the Edit tool. Single-line change.

- [ ] **Step 3: Rewrite the import in `canonical-json.spec.ts`**

The moved file currently has:
```typescript
import { canonicalJson } from './_canonical-json.js'
```

Rewrite to:
```typescript
import { canonicalJson } from '../canonical-json.js'
```

- [ ] **Step 4: Run the moved specs against the new public modules**

```bash
pnpm test src/domain/trading/__test__/canonical-decimal.spec.ts src/domain/trading/__test__/canonical-json.spec.ts
```
Expected: 24 tests pass (17 + 7). If any fail, the import rewrite is wrong or the public module diverges from the inline helper.

- [ ] **Step 5: Verify history preserved**

```bash
git log --follow --oneline src/domain/trading/__test__/canonical-decimal.spec.ts | head -3
```
Expected: shows pre-move commits (from when the file was at `parity/generators/_canonical-decimal.spec.ts`). If `git log --follow` returns only the move commit, history was NOT preserved — re-run the `git mv`.

- [ ] **Step 6: Commit**

```bash
git add src/domain/trading/__test__/
git commit -m "test(canonical): move Phase 0 specs + rewrite imports (Task B)

git mv the 2 Phase 0 spec files into __test__/ next to the new
public modules; rewrite each spec's import to point at the public
module. History preserved (verifiable via git log --follow).

24 tests carry over (17 canonical-decimal + 7 canonical-json),
now exercising the public modules from Task A."
```

---

## Task C: Switch consumers + delete inline helpers

6 import rewrites across 4 consumer files, then `git rm` the 3 inline helpers. Single commit so the tree is never in a half-broken state.

**Files:**
- Modify: `parity/generators/sentinels.ts` (lines 15-16 — 2 imports)
- Modify: `parity/generators/operations.ts` (lines 24-25 — 2 imports)
- Modify: `parity/run-ts.ts` (line 29 — 1 import)
- Modify: `src/domain/trading/wire-adapters.ts` (line 30 — 1 import)
- Delete: `parity/generators/_canonical-decimal.ts`
- Delete: `parity/generators/_canonical-json.ts`
- Delete: `src/domain/trading/wire-canonical-decimal.ts`

- [ ] **Step 1: Rewrite `parity/generators/sentinels.ts` imports**

Find lines 15-16:
```typescript
import { toCanonicalDecimalString } from './_canonical-decimal.js'
import { canonicalJson, type CanonicalJsonValue } from './_canonical-json.js'
```

Replace with:
```typescript
import { toCanonicalDecimalString } from '../../src/domain/trading/canonical-decimal.js'
import { canonicalJson, type CanonicalJsonValue } from '../../src/domain/trading/canonical-json.js'
```

Path explanation: `parity/generators/sentinels.ts` → `../..` reaches the repo root → `src/domain/trading/`.

- [ ] **Step 2: Rewrite `parity/generators/operations.ts` imports**

Find lines 24-25 (same pattern):
```typescript
import { toCanonicalDecimalString } from './_canonical-decimal.js'
import { canonicalJson, type CanonicalJsonValue } from './_canonical-json.js'
```

Replace with:
```typescript
import { toCanonicalDecimalString } from '../../src/domain/trading/canonical-decimal.js'
import { canonicalJson, type CanonicalJsonValue } from '../../src/domain/trading/canonical-json.js'
```

- [ ] **Step 3: Rewrite `parity/run-ts.ts` import**

Find line 29:
```typescript
import { canonicalJson, type CanonicalJsonValue } from './generators/_canonical-json.js'
```

Replace with:
```typescript
import { canonicalJson, type CanonicalJsonValue } from '../src/domain/trading/canonical-json.js'
```

Path explanation: `parity/run-ts.ts` → `..` reaches the repo root → `src/domain/trading/`.

- [ ] **Step 4: Rewrite `src/domain/trading/wire-adapters.ts` import**

Find line 30:
```typescript
import { toCanonicalDecimalString } from './wire-canonical-decimal.js'
```

Replace with:
```typescript
import { toCanonicalDecimalString } from './canonical-decimal.js'
```

- [ ] **Step 5: Verify all 4 files now reference the public modules**

```bash
grep -nE "from '.*canonical-(decimal|json)" parity/generators/sentinels.ts parity/generators/operations.ts parity/run-ts.ts src/domain/trading/wire-adapters.ts
```

Expected output (6 lines, all pointing at the public modules):
```
parity/generators/sentinels.ts:15:import { toCanonicalDecimalString } from '../../src/domain/trading/canonical-decimal.js'
parity/generators/sentinels.ts:16:import { canonicalJson, type CanonicalJsonValue } from '../../src/domain/trading/canonical-json.js'
parity/generators/operations.ts:24:import { toCanonicalDecimalString } from '../../src/domain/trading/canonical-decimal.js'
parity/generators/operations.ts:25:import { canonicalJson, type CanonicalJsonValue } from '../../src/domain/trading/canonical-json.js'
parity/run-ts.ts:29:import { canonicalJson, type CanonicalJsonValue } from '../src/domain/trading/canonical-json.js'
src/domain/trading/wire-adapters.ts:30:import { toCanonicalDecimalString } from './canonical-decimal.js'
```

Any line still containing `_canonical-decimal.js`, `_canonical-json.js`, or `wire-canonical-decimal.js` is a missed rewrite. Verify with:
```bash
grep -rnE "from '.*_canonical-|from '.*wire-canonical-" parity/ src/
```
Expected: empty output (no remaining references).

- [ ] **Step 6: Delete the 3 inline helpers**

```bash
git rm parity/generators/_canonical-decimal.ts
git rm parity/generators/_canonical-json.ts
git rm src/domain/trading/wire-canonical-decimal.ts
```

- [ ] **Step 7: Verify tsc clean**

```bash
npx tsc --noEmit
```
Expected: no NEW errors. If errors say "Cannot find module '@traderalice/...'" they're pre-existing. If errors say "Cannot find module './_canonical-...'" or "'./wire-canonical-...'", you missed a consumer rewrite.

- [ ] **Step 8: Verify the moved specs still pass**

```bash
pnpm test src/domain/trading/__test__/canonical-decimal.spec.ts src/domain/trading/__test__/canonical-json.spec.ts
```
Expected: 24 tests pass.

- [ ] **Step 9: Verify byte-identical fixture regeneration — the load-bearing correctness check**

```bash
pnpm tsx parity/generators/operations.ts
git status --short parity/fixtures/operations/
```

Expected: `pnpm tsx` runs without error, prints `Emitted 735 fixtures: ...`. `git status` returns empty output (no changes to any fixture file — the public formatter produces byte-identical output to the inline helper).

If `git status` shows modified files, the public module's logic differs from the inline helper. Diff a sample:
```bash
git diff parity/fixtures/operations/placeOrder/case-buy-mkt-day-plain-default-001.json | head -20
```
Compare the change against the public module's source — find and fix the divergence, then re-run.

- [ ] **Step 10: Verify byte-identical sentinel fixture regeneration**

```bash
pnpm tsx parity/generators/sentinels.ts
git status --short parity/fixtures/sentinels/
```
Expected: same as above — runs clean, no changes to fixtures.

- [ ] **Step 11: Verify byte-identical run-ts.ts output**

Pick a sample fixture and run it through both pre-switch and post-switch states. Since we're already post-switch, just run it and confirm output is well-formed JSON:

```bash
pnpm tsx parity/run-ts.ts parity/fixtures/operations/syncOrders/case-001.json | head -10
```
Expected: pretty JSON output starting with `{` and including `addResult`, `commitResult`, etc.

- [ ] **Step 12: Commit**

```bash
git add parity/generators/sentinels.ts parity/generators/operations.ts parity/run-ts.ts src/domain/trading/wire-adapters.ts
git commit -m "refactor(canonical): switch consumers + delete inline helpers (Task C)

- 4 consumer files updated to import from src/domain/trading/canonical-*:
  - parity/generators/sentinels.ts (2 imports)
  - parity/generators/operations.ts (2 imports)
  - parity/run-ts.ts (1 import)
  - src/domain/trading/wire-adapters.ts (1 import)
- 3 inline helpers deleted (git rm):
  - parity/generators/_canonical-decimal.ts (Phase 0 private)
  - parity/generators/_canonical-json.ts (Phase 0 private)
  - src/domain/trading/wire-canonical-decimal.ts (Phase 1b inline)

Byte-identical fixture regeneration verified: re-running
parity/generators/operations.ts and sentinels.ts produces no diff
against the committed fixtures. The public formatter has byte-identical
behavior to the inline helpers it replaced."
```

---

## Task D: Round-trip fixture test

Add the v4 §5 Phase 1c Deliverable 1 round-trip test — walks 427 Phase 0 fixtures and asserts `JSON.parse(canonicalJson(parsed))` deep-equals the parsed object.

**Files:**
- Create: `src/domain/trading/__test__/canonical-roundtrip.spec.ts`

- [ ] **Step 1: Create the spec file**

```typescript
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, type CanonicalJsonValue } from '../canonical-json.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, '../../../../parity/fixtures')

/**
 * Round-trip every Phase 0 wire fixture through canonicalJson + JSON.parse.
 * Asserts JSON.parse(canonicalJson(parsed)) deep-equals parsed.
 *
 * Covers v4 §5 Phase 1c Deliverable 1: "Round-trip test: JSON.parse(canonical(x))
 * deep-equals x for every wire fixture."
 *
 * Fixtures:
 *   - 340 in parity/fixtures/orders-on-wire/order/
 *     1 in parity/fixtures/orders-on-wire/contract/
 *   - 49 in parity/fixtures/sentinels/order-fields/
 *     12 in parity/fixtures/sentinels/contract-fields/
 *     7 in parity/fixtures/sentinels/execution-fields/
 *    18 in parity/fixtures/sentinels/orderstate-fields/
 *   Total: 427
 */

function loadFixtureFiles(subdir: string): string[] {
  const dir = resolve(FIXTURES, subdir)
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => resolve(dir, f))
}

describe('canonical JSON round-trip', () => {
  const corpora: Array<{ name: string; subdir: string }> = [
    { name: 'orders-on-wire/order',          subdir: 'orders-on-wire/order' },
    { name: 'orders-on-wire/contract',       subdir: 'orders-on-wire/contract' },
    { name: 'sentinels/order-fields',        subdir: 'sentinels/order-fields' },
    { name: 'sentinels/contract-fields',     subdir: 'sentinels/contract-fields' },
    { name: 'sentinels/execution-fields',    subdir: 'sentinels/execution-fields' },
    { name: 'sentinels/orderstate-fields',   subdir: 'sentinels/orderstate-fields' },
  ]

  for (const corpus of corpora) {
    describe(corpus.name, () => {
      const files = loadFixtureFiles(corpus.subdir)
      it.each(files)('%s round-trips through canonicalJson', (filePath) => {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as CanonicalJsonValue
        const canonical = canonicalJson(parsed)
        const reparsed = JSON.parse(canonical) as CanonicalJsonValue
        expect(reparsed).toEqual(parsed)
      })
    })
  }
})
```

- [ ] **Step 2: Run the round-trip spec**

```bash
pnpm test src/domain/trading/__test__/canonical-roundtrip.spec.ts
```

Expected: 427 tests pass (one `it.each` instance per fixture file).

If any fail:
- "AssertionError: expected X to deeply equal Y" — the round-trip diverged. Inspect the named fixture and the canonical output to find the structural difference. Likely culprits: a fixture containing a value that JSON.parse handles non-canonically (e.g., big numbers losing precision — but Phase 0 fixtures use string-encoded Decimals so this should be safe).
- "Cannot find module ..." — fixture path or import path is wrong. Verify `FIXTURES` resolves to `<repo>/parity/fixtures`.

- [ ] **Step 3: Confirm repo-wide tests are still green**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests" | tail -2
```
Expected: 1738 baseline + ~427 new round-trip tests = ~2165 total. Zero failures.

- [ ] **Step 4: Commit**

```bash
git add src/domain/trading/__test__/canonical-roundtrip.spec.ts
git commit -m "test(canonical): round-trip 427 wire fixtures (Task D)

Walks every Phase 0 fixture in parity/fixtures/orders-on-wire/ (341)
and parity/fixtures/sentinels/ (86) = 427 fixtures. Asserts
JSON.parse(canonicalJson(parsed)) deep-equals parsed.

Implements v4 §5 Phase 1c Deliverable 1's round-trip requirement.
Complements Phase 1b's wire-roundtrip.spec.ts (IBKR-class → Wire →
IBKR-class) with JSON → canonical-JSON → JSON."
```

---

## Task E: DoD verification

No new code or commits. Run all DoD checks.

- [ ] **Step 1: All expected files exist**

```bash
ls src/domain/trading/canonical-decimal.ts src/domain/trading/canonical-json.ts src/domain/trading/__test__/canonical-decimal.spec.ts src/domain/trading/__test__/canonical-json.spec.ts src/domain/trading/__test__/canonical-roundtrip.spec.ts
```
Expected: all 5 files listed.

- [ ] **Step 2: All expected files deleted**

```bash
ls parity/generators/_canonical-decimal.ts parity/generators/_canonical-json.ts src/domain/trading/wire-canonical-decimal.ts 2>&1
```
Expected: 3 "No such file or directory" errors (the 3 inline helpers are gone).

- [ ] **Step 3: tsc clean**

```bash
npx tsc --noEmit
```
Expected: no NEW errors vs. baseline. If errors specifically reference `canonical-decimal.ts`, `canonical-json.ts`, or any of the consumer files modified in Task C, those ARE Phase 1c's concern. Pre-existing errors elsewhere in the repo are not.

- [ ] **Step 4: Full test suite**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests" | tail -2
```
Expected: ~2165 tests passing (1738 + 427), zero failures.

- [ ] **Step 5: Fixture regeneration byte-identical (the key correctness signal)**

```bash
pnpm tsx parity/generators/operations.ts
pnpm tsx parity/generators/sentinels.ts
git status --short parity/fixtures/
```
Expected: both generators run clean (each emits its fixture count summary line), and `git status` returns empty output. If anything changed, the public formatter diverges from the deleted inline helper — investigate and fix.

- [ ] **Step 6: run-ts.ts spot-check**

```bash
SAMPLE=$(ls parity/fixtures/operations/placeOrder | head -1)
pnpm tsx parity/run-ts.ts parity/fixtures/operations/placeOrder/$SAMPLE | head -20
```
Expected: pretty JSON output with `addResult`, `commitResult`, `pushResult`, `logEntries`, `exportState` keys.

- [ ] **Step 7: Dev-server smoke test**

```bash
pnpm dev > /tmp/dev.log 2>&1 &
DEV_PID=$!
sleep 10
curl -s http://localhost:3002/api/status
echo ""
pkill -f "tsx watch src/main.ts" 2>/dev/null
```
Expected: JSON response like `{"ok":true,"version":"0.10.0-beta.0","uptimeSeconds":...,"ffiLoaded":false}`.

- [ ] **Step 8: Zero `packages/` and root-config edits**

```bash
git diff 678669a..HEAD -- packages/ pnpm-workspace.yaml turbo.json package.json
```
Expected: empty.

- [ ] **Step 9: No remaining references to deleted files**

```bash
grep -rnE "_canonical-decimal|_canonical-json|wire-canonical-decimal" parity/ src/ 2>/dev/null
```
Expected: empty (no source code references; OK if a doc/spec file mentions them historically).

If you see any matches in `parity/` or `src/`:
- A consumer file got missed in Task C — go back and fix it.
- A docstring still references the old paths — update the docstring.

- [ ] **Step 10: History preserved on moved specs**

```bash
git log --follow --oneline src/domain/trading/__test__/canonical-decimal.spec.ts | head -3
git log --follow --oneline src/domain/trading/__test__/canonical-json.spec.ts | head -3
```
Expected: each shows commits from before the Task B move (the original Phase 0 creation commit + any subsequent edits).

- [ ] **Step 11: Final summary**

```bash
echo "Phase 1c deliverables:"
echo "  canonical-decimal.ts: $(wc -l < src/domain/trading/canonical-decimal.ts) lines"
echo "  canonical-json.ts: $(wc -l < src/domain/trading/canonical-json.ts) lines"
echo "  canonical-decimal.spec.ts: $(wc -l < src/domain/trading/__test__/canonical-decimal.spec.ts) lines"
echo "  canonical-json.spec.ts: $(wc -l < src/domain/trading/__test__/canonical-json.spec.ts) lines"
echo "  canonical-roundtrip.spec.ts: $(wc -l < src/domain/trading/__test__/canonical-roundtrip.spec.ts) lines"
echo "  Inline helpers remaining: $(ls parity/generators/_canonical-*.ts src/domain/trading/wire-canonical-*.ts 2>/dev/null | wc -l) (expected 0)"
echo "  Total Phase 1c commits since 678669a: $(git log --oneline 678669a..HEAD | wc -l)"
```

Expected:
- canonical-decimal.ts: ~40 lines
- canonical-json.ts: ~35 lines
- canonical-decimal.spec.ts: ~35 lines
- canonical-json.spec.ts: ~30 lines
- canonical-roundtrip.spec.ts: ~50 lines
- Inline helpers remaining: 0
- Total Phase 1c commits: 4 (Tasks A, B, C, D — Task E is verification-only)

---

## Self-review

**Spec coverage:**
- §Architecture deliverable 1 (canonical-decimal.ts) → Task A
- §Architecture deliverable 2 (canonical-json.ts) → Task A
- §Architecture moved specs → Task B
- §Architecture deletions → Task C
- §Architecture round-trip spec → Task D
- §Consumer import rewrites → Task C
- §Sub-task sequencing A→B→C→D→E → Tasks A through E
- §DoD bullets → Task E (verification steps map 1:1)

**Placeholder scan:** No "TBD"/"fill in details" patterns in instructional steps. The `<sample-fixture>` in Step 6 of Task E is filled in by the bash subshell (`SAMPLE=$(...)`), not a manual placeholder.

**Type consistency:** `CanonicalJsonValue`, `toCanonicalDecimalString`, `canonicalJson`, `CanonicalDecimalError` used identically across tasks. Path conventions (`from '../canonical-X.js'` for tests; `from '../../src/domain/trading/canonical-X.js'` for `parity/generators/`; `from '../src/domain/trading/canonical-X.js'` for `parity/run-ts.ts`; `from './canonical-decimal.js'` for `wire-adapters.ts`) match the spec exactly.

**Risk acknowledgment:**
- Task C's byte-identical-regeneration check (Steps 9-10) is the load-bearing correctness signal. If it fails, the refactor changed formatter behavior and must be debugged before the task commits.
- Task B's `git mv` history preservation is verified in Step 5. If `git log --follow` doesn't reach pre-move commits, re-run the move.

---

## Execution notes

- All Phase 1c work is purely refactor: 2 file creations + 2 file moves + 3 file deletions + 1 new test + 6 import-line rewrites. No production behavior change.
- Tasks A → B → C → D → E are sequential. Task A is harmless (new files, nothing imports them yet). Task B moves the specs and rewrites their imports. Task C is the load-bearing step (consumer swap + deletes); the byte-identical fixture regeneration is the correctness check.
- The implementer should run `npx tsc --noEmit` after Tasks A, B, C, D — catches regressions immediately.
- If Task C's regeneration step finds a divergence, do NOT commit — investigate the public-module-vs-inline-helper diff and reconcile before proceeding. The most likely cause is a comment-only diff in the lifted file masking an actual logic difference; re-diff the source files.
