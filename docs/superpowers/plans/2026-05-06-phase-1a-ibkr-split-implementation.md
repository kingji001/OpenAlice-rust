# Phase 1a — `@traderalice/ibkr` Package Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `packages/ibkr/` into `@traderalice/ibkr-types` (DTOs), `@traderalice/ibkr-client` (I/O), and `@traderalice/ibkr` (re-export shim).

**Architecture:** Three pnpm workspace packages. Topological build order: `ibkr-types` → `ibkr-client` → `ibkr`. The shim collapses to a 2-line `index.ts` re-exporting both new packages. Consumers (41 callers in `src/`) keep importing `from '@traderalice/ibkr'` unchanged. `git mv` for every file move (history preserved).

**Tech Stack:** TypeScript, pnpm workspaces, `tsc` (build), Turbo (`^build` cascade), vitest (tests).

**Spec:** [`docs/superpowers/specs/2026-05-06-phase-1a-ibkr-split-design.md`](../specs/2026-05-06-phase-1a-ibkr-split-design.md) (commit `f466e57`).

---

## Spec deviations (read first)

The spec assumed tests in `packages/ibkr/tests/` import from `@traderalice/ibkr` (the shim). They actually use deep relative paths (`from '../src/contract.js'`). After the file moves, those paths break.

Forcing function: 2 of 7 unit-test files import internals not exposed by the shim (`utils.ts` exports `BadMessage` which isn't re-exported; `protobuf-decode.spec.ts` imports specific `protobuf/CurrentTime.js` files). For those 2 files, the only clean fix is moving them to `packages/ibkr-client/tests/`.

**Deviation:**
- **5 unit tests** (`models`, `account-summary-tags`, `comm`, `order-condition`, `order-precision`) stay in `packages/ibkr/tests/`. Their deep `'../src/X.js'` imports get rewritten to `from '@traderalice/ibkr'` (the shim).
- **2 unit tests** (`utils`, `protobuf-decode`) move to `packages/ibkr-client/tests/`. Their imports get rewritten to relative paths within `ibkr-client` (e.g., `from '../src/utils.js'` continues to work because `tests/` is a sibling of `src/` in the new package).
- **3 e2e tests** stay in `packages/ibkr/tests/e2e/` unchanged. They already use `from '../../src/index.js'` which resolves to the shim's `index.ts`.
- **New file:** `packages/ibkr-client/vitest.config.ts` (copied from `packages/ibkr/vitest.config.ts`).

This adds a small new vitest config and 2 file moves. Otherwise the spec is unchanged.

**Pre-flight checks before starting:**

- [ ] Working tree clean: `git status --short` empty.
- [ ] On master at expected commit: `git log --oneline -1` shows `f466e57` or later.
- [ ] `packages/ibkr/` exists with current src/tests structure.
- [ ] Baseline test count: `pnpm test 2>&1 | grep -E "^\s+Tests" | tail -1` — record number for later comparison (currently ~1299 passing).

---

## Task A: Scaffold the two new package directories

Create empty `ibkr-types/` and `ibkr-client/` packages so `pnpm install` registers them. No file moves yet.

**Files:**
- Create: `packages/ibkr-types/package.json`
- Create: `packages/ibkr-types/tsconfig.json`
- Create: `packages/ibkr-types/src/index.ts` (empty placeholder)
- Create: `packages/ibkr-types/README.md`
- Create: `packages/ibkr-client/package.json`
- Create: `packages/ibkr-client/tsconfig.json`
- Create: `packages/ibkr-client/src/index.ts` (empty placeholder)
- Create: `packages/ibkr-client/README.md`

- [ ] **Step 1: Create `packages/ibkr-types/package.json`**

```json
{
  "name": "@traderalice/ibkr-types",
  "version": "0.1.0",
  "description": "Pure DTO types for IBKR TWS API v10.44.01 — no I/O.",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "rm -rf dist && tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "decimal.js": "^10.6.0"
  },
  "devDependencies": {
    "@types/node": "^22.13.4",
    "typescript": "^5.7.3"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "license": "AGPL-3.0"
}
```

- [ ] **Step 2: Create `packages/ibkr-types/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "ref", "**/*.test.ts", "**/*.spec.ts"]
}
```

- [ ] **Step 3: Create `packages/ibkr-types/src/index.ts` (empty placeholder)**

```typescript
// Placeholder — populated by Task B.
export {}
```

- [ ] **Step 4: Create `packages/ibkr-types/README.md`**

```markdown
# @traderalice/ibkr-types

Pure DTO types for IBKR TWS API v10.44.01. No I/O, no protocol logic, no
network code.

Includes the data classes (`Order`, `Contract`, `ContractDetails`,
`Execution`, `OrderState`, etc.), enums (`TickType`, `IneligibilityReason`,
`AccountSummaryTags`), and constants (`UNSET_DECIMAL`, `UNSET_DOUBLE`,
`UNSET_INTEGER`, `UNSET_LONG`).

For the I/O layer (Connection, EClient, EReader, Decoder, protobuf
wrappers), see [`@traderalice/ibkr-client`](../ibkr-client/).

For the back-compat re-export shim, see [`@traderalice/ibkr`](../ibkr/).
This shim package re-exports both `ibkr-types` and `ibkr-client` and is
kept for ≥1 minor release after Phase 1a.

## Why split

v3 shipped both DTOs and I/O in one package. v4 Phase 1a (per
[`docs/RUST_MIGRATION_PLAN.v4.md`](../../docs/RUST_MIGRATION_PLAN.v4.md))
split them so the Rust port can target the type surface independently
of the I/O implementation.
```

- [ ] **Step 5: Create `packages/ibkr-client/package.json`**

```json
{
  "name": "@traderalice/ibkr-client",
  "version": "0.1.0",
  "description": "TWS API I/O layer (connection, decoder, EClient) for IBKR.",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "rm -rf dist && tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --config vitest.config.ts",
    "generate:proto": "bash generate-proto.sh"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.11.0",
    "@traderalice/ibkr-types": "workspace:*",
    "decimal.js": "^10.6.0",
    "protobufjs": "^7.5.5"
  },
  "devDependencies": {
    "@types/node": "^22.13.4",
    "ts-proto": "^2.11.5",
    "typescript": "^5.7.3",
    "vitest": "^3.0.6"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "license": "AGPL-3.0"
}
```

- [ ] **Step 6: Create `packages/ibkr-client/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "ref", "**/*.test.ts", "**/*.spec.ts"]
}
```

- [ ] **Step 7: Create `packages/ibkr-client/src/index.ts` (empty placeholder)**

```typescript
// Placeholder — populated by Task C.
export {}
```

- [ ] **Step 8: Create `packages/ibkr-client/README.md`**

```markdown
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

\```bash
pnpm --filter @traderalice/ibkr-client generate:proto
\```

(Use literal triple-backticks in the README.)

The 203 generated files are checked into the repo; regenerate only when
upgrading IBKR proto schemas.
```

- [ ] **Step 9: Run `pnpm install` to register the new packages**

```bash
pnpm install
```
Expected: pnpm reports the two new workspaces. No errors.

- [ ] **Step 10: Verify both new packages build (with empty src/index.ts placeholders)**

```bash
pnpm --filter @traderalice/ibkr-types build
pnpm --filter @traderalice/ibkr-client build
```
Expected: both succeed. `dist/` directories created in each.

- [ ] **Step 11: Verify the shim still builds (it hasn't changed yet)**

```bash
pnpm --filter @traderalice/ibkr build
```
Expected: succeeds (the shim's source files haven't moved yet, so its index.ts still resolves all its exports).

- [ ] **Step 12: Commit**

```bash
git add packages/ibkr-types/ packages/ibkr-client/ pnpm-lock.yaml
git commit -m "feat(ibkr): scaffold ibkr-types + ibkr-client packages (Task A)

Empty package shells with package.json, tsconfig.json, README.md,
and placeholder src/index.ts. Both new packages register in the
pnpm workspace; topological build order works (ibkr-types →
ibkr-client → ibkr shim).

No source files moved yet — Tasks B+C populate the new packages."
```

---

## Task B: Move `ibkr-types` source files

19 `git mv` operations into `packages/ibkr-types/src/`, then write the real `index.ts`.

**Files:**
- Move (via `git mv`): 19 files from `packages/ibkr/src/` to `packages/ibkr-types/src/`
- Modify: `packages/ibkr-types/src/index.ts` (replace placeholder with real re-exports)

After this task, `packages/ibkr/` will NOT compile (its current `index.ts` still references the moved files). That's expected — Task D fixes it.

- [ ] **Step 1: Confirm `order-condition.ts` belongs in `ibkr-types`**

Read the imports of `packages/ibkr/src/order-condition.ts`:
```bash
head -20 packages/ibkr/src/order-condition.ts
```
Expected: imports from `./const.js` only — no I/O modules. If it imports from `comm.ts`/`reader.ts`/`connection.ts`, escalate (re-evaluate placement). If it only imports from `./const.js` (which is also moving to ibkr-types), proceed.

- [ ] **Step 2: Move the 5 "constants" files**

```bash
git mv packages/ibkr/src/const.ts packages/ibkr-types/src/
git mv packages/ibkr/src/errors.ts packages/ibkr-types/src/
git mv packages/ibkr/src/server-versions.ts packages/ibkr-types/src/
git mv packages/ibkr/src/message.ts packages/ibkr-types/src/
git mv packages/ibkr/src/news.ts packages/ibkr-types/src/
```

- [ ] **Step 3: Move the 5 "simple types" files**

```bash
git mv packages/ibkr/src/tag-value.ts packages/ibkr-types/src/
git mv packages/ibkr/src/softdollartier.ts packages/ibkr-types/src/
git mv packages/ibkr/src/tick-type.ts packages/ibkr-types/src/
git mv packages/ibkr/src/account-summary-tags.ts packages/ibkr-types/src/
git mv packages/ibkr/src/ineligibility-reason.ts packages/ibkr-types/src/
```

- [ ] **Step 4: Move the 9 "data model" files**

```bash
git mv packages/ibkr/src/contract.ts packages/ibkr-types/src/
git mv packages/ibkr/src/order.ts packages/ibkr-types/src/
git mv packages/ibkr/src/order-state.ts packages/ibkr-types/src/
git mv packages/ibkr/src/order-cancel.ts packages/ibkr-types/src/
git mv packages/ibkr/src/order-condition.ts packages/ibkr-types/src/
git mv packages/ibkr/src/execution.ts packages/ibkr-types/src/
git mv packages/ibkr/src/commission-and-fees-report.ts packages/ibkr-types/src/
git mv packages/ibkr/src/scanner.ts packages/ibkr-types/src/
git mv packages/ibkr/src/common.ts packages/ibkr-types/src/
```

- [ ] **Step 5: Verify file count**

```bash
ls packages/ibkr-types/src/ | wc -l
```
Expected: 20 (19 moved + the placeholder `index.ts`).

- [ ] **Step 6: Replace `packages/ibkr-types/src/index.ts` with real re-exports**

```typescript
/**
 * @traderalice/ibkr-types — pure DTO types for IBKR TWS API v10.44.01.
 */

// Constants
export * from './const.js'
export * from './errors.js'
export * from './server-versions.js'
export * from './message.js'
export * from './news.js'

// Simple types
export { TagValue, type TagValueList } from './tag-value.js'
export { SoftDollarTier } from './softdollartier.js'
export { type TickType, TickTypeEnum, tickTypeToString } from './tick-type.js'
export { AccountSummaryTags, AllTags } from './account-summary-tags.js'
export { IneligibilityReason } from './ineligibility-reason.js'

// Data models
export { Contract, ContractDetails, ComboLeg, DeltaNeutralContract, ContractDescription } from './contract.js'
export { Order, OrderComboLeg } from './order.js'
export { OrderState, OrderAllocation } from './order-state.js'
export { OrderCancel } from './order-cancel.js'
export { Execution, ExecutionFilter } from './execution.js'
export { CommissionAndFeesReport } from './commission-and-fees-report.js'
export { ScannerSubscription, ScanData } from './scanner.js'
export * from './common.js'
```

- [ ] **Step 7: Verify `order-condition.ts` exports**

```bash
grep -nE "^export" packages/ibkr-types/src/order-condition.ts | head -10
```
If it has any `export` statements, append a corresponding line to `index.ts` (e.g., `export * from './order-condition.js'` if it uses `export *` style; otherwise list specific exports). If it has no public exports, leave `index.ts` as written.

- [ ] **Step 8: Build `ibkr-types`**

```bash
pnpm --filter @traderalice/ibkr-types build
```
Expected: succeeds. The 19 moved files compile cleanly; their internal cross-imports (e.g., `contract.ts` importing from `./const.js`) still work because both files moved together.

- [ ] **Step 9: Verify shim is now broken (expected)**

```bash
pnpm --filter @traderalice/ibkr build 2>&1 | tail -10
```
Expected: FAILS with errors about missing `./contract.js`, `./order.js`, etc. — its `src/index.ts` still references files that have moved. This is fine; Task D will fix it.

- [ ] **Step 10: Commit**

```bash
git add packages/ibkr-types/ packages/ibkr/src/
git commit -m "feat(ibkr): move DTO files to ibkr-types (Task B)

19 files moved via git mv (history preserved):
- Constants: const, errors, server-versions, message, news
- Simple types: tag-value, softdollartier, tick-type,
  account-summary-tags, ineligibility-reason
- Data models: contract, order, order-state, order-cancel,
  order-condition, execution, commission-and-fees-report,
  scanner, common

Real index.ts re-exports written. ibkr-types builds clean.

NOTE: packages/ibkr/ does NOT compile after this commit — its
index.ts still references moved files. Task C+D fix it."
```

---

## Task C: Move `ibkr-client` source files + protobuf + ref + script + rewrite imports

File moves into `packages/ibkr-client/src/`, then a grep-driven import rewrite pass.

**Files:**
- Move (via `git mv`): `connection.ts`, `reader.ts`, `wrapper.ts`, `comm.ts`, `utils.ts` → `packages/ibkr-client/src/`
- Move (via `git mv`): `decoder/*` → `packages/ibkr-client/src/decoder/`
- Move (via `git mv`): `client/*` → `packages/ibkr-client/src/client/`
- Move (via `git mv`): `protobuf/` → `packages/ibkr-client/src/protobuf/`
- Move + rename: `order-decoder.ts` → `packages/ibkr-client/src/decoder/order.ts`
- Move (via `git mv`): `ref/` → `packages/ibkr-client/ref/`
- Move (via `git mv`): `generate-proto.sh` → `packages/ibkr-client/generate-proto.sh`
- Modify: every file in `packages/ibkr-client/src/` that imports from a now-moved DTO file (rewrite to `from '@traderalice/ibkr-types'`)
- Modify: `packages/ibkr-client/src/index.ts` (replace placeholder with real re-exports)

- [ ] **Step 1: Confirm `utils.ts` placement**

```bash
head -30 packages/ibkr/src/utils.ts
grep -n "^import" packages/ibkr/src/utils.ts
```
Expected: imports from `./const.js` (and possibly `decimal.js`). Has wire-format helpers (`BadMessage`, byte/decimal converters). Belongs in `ibkr-client`. If you find pure-data helpers with no I/O concerns, escalate (the spec defaults to ibkr-client; revisit if mixed).

- [ ] **Step 2: Move the 5 root-level IO files**

```bash
git mv packages/ibkr/src/connection.ts packages/ibkr-client/src/
git mv packages/ibkr/src/reader.ts packages/ibkr-client/src/
git mv packages/ibkr/src/wrapper.ts packages/ibkr-client/src/
git mv packages/ibkr/src/comm.ts packages/ibkr-client/src/
git mv packages/ibkr/src/utils.ts packages/ibkr-client/src/
```

- [ ] **Step 3: Move the decoder/ subdir**

```bash
mkdir -p packages/ibkr-client/src/decoder
git mv packages/ibkr/src/decoder/* packages/ibkr-client/src/decoder/
```

- [ ] **Step 4: Move the client/ subdir**

```bash
mkdir -p packages/ibkr-client/src/client
git mv packages/ibkr/src/client/* packages/ibkr-client/src/client/
```

- [ ] **Step 5: Move the protobuf/ subdir (203 generated files)**

```bash
git mv packages/ibkr/src/protobuf packages/ibkr-client/src/protobuf
```

- [ ] **Step 6: Rename + move `order-decoder.ts` to `decoder/order.ts`**

```bash
git mv packages/ibkr/src/order-decoder.ts packages/ibkr-client/src/decoder/order.ts
```

- [ ] **Step 7: Move `ref/` and `generate-proto.sh`**

```bash
git mv packages/ibkr/ref packages/ibkr-client/ref
git mv packages/ibkr/generate-proto.sh packages/ibkr-client/generate-proto.sh
```

- [ ] **Step 8: Verify the shim package src/ is now down to one file**

```bash
ls packages/ibkr/src/
```
Expected: only `index.ts` remains. If anything else is left (e.g., a missed file), `git mv` it to whichever new package matches its content.

- [ ] **Step 9: Identify import-rewrite sites in `ibkr-client`**

```bash
grep -rnE "from '\\./(contract|order|execution|order-state|order-cancel|order-condition|tag-value|softdollartier|tick-type|const|errors|message|news|common|account-summary-tags|ineligibility-reason|commission-and-fees-report|scanner|server-versions)" packages/ibkr-client/src/
```

This lists every `from './<types-file>.js'` import in the new ibkr-client. Each one needs to become `from '@traderalice/ibkr-types'` (with appropriate named imports). Capture the output for the next step.

- [ ] **Step 10: Rewrite imports**

For each file the grep listed, rewrite the import. Use `Edit` per file. Pattern:

Before:
```typescript
import { Contract, Order } from './contract.js'
```
After:
```typescript
import { Contract, Order } from '@traderalice/ibkr-types'
```

If a file has multiple imports from different former-`./X.js` files, consolidate into one `from '@traderalice/ibkr-types'` import. E.g., these three:
```typescript
import { Contract } from './contract.js'
import { Order } from './order.js'
import { UNSET_DECIMAL } from './const.js'
```
Become:
```typescript
import { Contract, Order, UNSET_DECIMAL } from '@traderalice/ibkr-types'
```

- [ ] **Step 11: Verify zero remaining types-side relative imports in ibkr-client**

```bash
grep -rnE "from '\\./(contract|order|execution|order-state|order-cancel|order-condition|tag-value|softdollartier|tick-type|const|errors|message|news|common|account-summary-tags|ineligibility-reason|commission-and-fees-report|scanner|server-versions)" packages/ibkr-client/src/
```
Expected: zero matches. If any remain, repeat Step 10 for those files.

- [ ] **Step 12: Replace `packages/ibkr-client/src/index.ts` with real re-exports**

```typescript
/**
 * @traderalice/ibkr-client — TWS API I/O layer.
 *
 * Constructs DTO instances from @traderalice/ibkr-types as it decodes
 * incoming TWS messages.
 */

// Protocol
export { makeField, makeFieldHandleEmpty, makeMsg, readMsg, readFields } from './comm.js'
export { Connection } from './connection.js'
export { EReader } from './reader.js'
export { Decoder } from './decoder/index.js'

// Client & Wrapper
export { type EWrapper, DefaultEWrapper } from './wrapper.js'
export { EClient } from './client/index.js'
```

- [ ] **Step 13: Build `ibkr-client`**

```bash
pnpm --filter @traderalice/ibkr-client build
```
Expected: succeeds. If errors mention `from '@traderalice/ibkr-types'` not resolving, ensure `ibkr-types` was built (Task B) and that `pnpm install` registered the workspace dep (it should have during Task A).

If errors mention specific named imports not being exported from `ibkr-types`, check the `ibkr-types/src/index.ts` from Task B — the import name might need to be added there.

- [ ] **Step 14: Commit**

```bash
git add packages/ibkr-client/ packages/ibkr/src/
git commit -m "feat(ibkr): move I/O files + protobuf to ibkr-client (Task C)

File moves (git mv, history preserved):
- 5 root files: connection, reader, wrapper, comm, utils
- decoder/ subdir (9 files)
- client/ subdir (7 files)
- protobuf/ subdir (203 generated files)
- order-decoder.ts → decoder/order.ts (renamed per v4 plan)
- ref/ + generate-proto.sh

Internal import rewrites: every relative import to a moved DTO file
(./contract.js, ./order.js, ./const.js, etc.) rewritten to
'@traderalice/ibkr-types'. Zero remaining.

ibkr-client builds clean against ibkr-types. The shim package
(packages/ibkr/) still does not compile — Task D fixes it."
```

---

## Task D: Collapse `packages/ibkr/` to the shim + rewrite test imports

Three things land here: rewrite the shim's `index.ts` + `package.json`, delete the unused `tsup.config.ts`, and rewrite the unit test imports per the spec deviation.

**Files:**
- Modify: `packages/ibkr/src/index.ts` (replace 38-line file with 2-line re-export)
- Modify: `packages/ibkr/package.json` (replace dependencies)
- Delete: `packages/ibkr/tsup.config.ts`
- Modify: `packages/ibkr/tests/models.spec.ts`
- Modify: `packages/ibkr/tests/account-summary-tags.spec.ts`
- Modify: `packages/ibkr/tests/comm.spec.ts`
- Modify: `packages/ibkr/tests/order-condition.spec.ts`
- Modify: `packages/ibkr/tests/order-precision.spec.ts`
- Move (via `git mv`): `packages/ibkr/tests/utils.spec.ts` → `packages/ibkr-client/tests/utils.spec.ts`
- Move (via `git mv`): `packages/ibkr/tests/protobuf-decode.spec.ts` → `packages/ibkr-client/tests/protobuf-decode.spec.ts`
- Create: `packages/ibkr-client/vitest.config.ts`

- [ ] **Step 1: Confirm tsup is unused outside packages/ibkr/**

```bash
grep -rln "tsup" packages/ibkr/ | grep -v node_modules
```
Expected: only `packages/ibkr/tsup.config.ts` (and possibly `packages/ibkr/package.json` mentioning tsup as a devDep). No CI scripts or other references. If anything outside `packages/ibkr/` references `tsup.config.ts`, escalate.

- [ ] **Step 2: Replace `packages/ibkr/src/index.ts` with the 2-line re-export shim**

Replace the entire file contents (currently 38 lines) with:

```typescript
/**
 * @traderalice/ibkr — re-export shim.
 *
 * v3 shipped this as a single package containing both DTO types and the
 * I/O layer. v4 Phase 1a split it into:
 *   - @traderalice/ibkr-types  (pure data classes, no I/O)
 *   - @traderalice/ibkr-client (connection, decoder, EClient)
 *
 * This shim re-exports both for back-compat. Kept for ≥1 minor release.
 * New code should import from the split packages directly.
 */

export * from '@traderalice/ibkr-types'
export * from '@traderalice/ibkr-client'
```

- [ ] **Step 3: Update `packages/ibkr/package.json` dependencies**

Read the current file:
```bash
cat packages/ibkr/package.json
```

Edit the `dependencies` block. Replace:
```json
"dependencies": {
  "@bufbuild/protobuf": "^2.11.0",
  "decimal.js": "^10.6.0",
  "protobufjs": "^7.5.5"
}
```
With:
```json
"dependencies": {
  "@traderalice/ibkr-client": "workspace:*",
  "@traderalice/ibkr-types": "workspace:*"
}
```

In the `devDependencies` block, remove `ts-proto` and `tsup` (no longer needed). Keep `@types/node`, `typescript`, `vitest`.

In the `scripts` block, remove the `generate:proto` line (the script moved to `packages/ibkr-client/`).

- [ ] **Step 4: Delete `packages/ibkr/tsup.config.ts`**

```bash
rm packages/ibkr/tsup.config.ts
```

- [ ] **Step 5: Refresh lockfile**

```bash
pnpm install
```
Expected: pnpm updates the lockfile to reflect the new workspace links (ibkr now depends on ibkr-types + ibkr-client). Should be quick.

- [ ] **Step 6: Build the shim**

```bash
pnpm --filter @traderalice/ibkr build
```
Expected: succeeds. The shim's dist/index.js re-exports both new packages.

- [ ] **Step 7: Build all three packages in topological order to confirm**

```bash
pnpm --filter @traderalice/ibkr-types build && \
pnpm --filter @traderalice/ibkr-client build && \
pnpm --filter @traderalice/ibkr build
```
Expected: all three succeed.

- [ ] **Step 8: Rewrite `packages/ibkr/tests/models.spec.ts` imports**

Read the current top of the file:
```bash
head -15 packages/ibkr/tests/models.spec.ts
```
Replace its 7 deep `from '../src/X.js'` imports with one line:
```typescript
import {
  Contract,
  ContractDetails,
  ComboLeg,
  Order,
  OrderState,
  Execution,
  ExecutionFilter,
  TagValue,
  SoftDollarTier,
  UNSET_DOUBLE,
  UNSET_INTEGER,
  UNSET_DECIMAL,
} from '@traderalice/ibkr'
```
(Use the named imports the file actually uses — read the existing imports to confirm the exact set.)

- [ ] **Step 9: Rewrite `packages/ibkr/tests/account-summary-tags.spec.ts` imports**

Replace:
```typescript
import { AccountSummaryTags, AllTags } from '../src/account-summary-tags.js'
```
With:
```typescript
import { AccountSummaryTags, AllTags } from '@traderalice/ibkr'
```

- [ ] **Step 10: Rewrite `packages/ibkr/tests/comm.spec.ts` imports**

Read the current imports:
```bash
head -15 packages/ibkr/tests/comm.spec.ts
```
Replace the two `from '../src/X.js'` imports with one consolidated import from `@traderalice/ibkr`:
```typescript
import {
  makeInitialMsg,
  makeField,
  makeFieldHandleEmpty,
  makeMsg,
  makeMsgProto,
  readMsg,
  readFields,
  UNSET_DOUBLE,
  UNSET_INTEGER,
  DOUBLE_INFINITY,
} from '@traderalice/ibkr'
```
(Verify exact names against the existing imports.)

⚠️ **If `makeInitialMsg` or `makeMsgProto` is NOT exported from the shim**: those are wire-format helpers from `comm.ts`. Check `packages/ibkr-client/src/index.ts` from Task C — line 11 should re-export `makeField, makeFieldHandleEmpty, makeMsg, readMsg, readFields` but not necessarily `makeInitialMsg` or `makeMsgProto`. If the test file uses an unexported helper, ADD it to `packages/ibkr-client/src/index.ts`'s comm.js export line, rebuild ibkr-client, then proceed.

- [ ] **Step 11: Rewrite `packages/ibkr/tests/order-condition.spec.ts` imports**

```bash
head -20 packages/ibkr/tests/order-condition.spec.ts
```
Replace its `from '../src/order-condition.js'` import. The test imports specific OrderCondition classes — keep those names but switch the source:
```typescript
import {
  // (whatever specific classes the test imports — e.g., PriceCondition, TimeCondition)
} from '@traderalice/ibkr'
```
⚠️ If `order-condition.ts`'s exports were NOT added to `packages/ibkr-types/src/index.ts` in Task B (the test in Step 7 of Task B was conditional), add them now. Either:
- Append `export * from './order-condition.js'` to `packages/ibkr-types/src/index.ts`, then rebuild ibkr-types and the shim
- OR add specific named exports per the test's needs

- [ ] **Step 12: Rewrite `packages/ibkr/tests/order-precision.spec.ts` imports**

Replace its 4 deep imports:
```typescript
import { Order, UNSET_DECIMAL, makeField, makeFieldHandleEmpty } from '@traderalice/ibkr'
```

- [ ] **Step 13: Move `utils.spec.ts` and `protobuf-decode.spec.ts` to ibkr-client**

```bash
mkdir -p packages/ibkr-client/tests
git mv packages/ibkr/tests/utils.spec.ts packages/ibkr-client/tests/utils.spec.ts
git mv packages/ibkr/tests/protobuf-decode.spec.ts packages/ibkr-client/tests/protobuf-decode.spec.ts
```

These tests' deep relative imports (`from '../src/utils.js'`, `from '../src/protobuf/CurrentTime.js'`, etc.) will now correctly resolve relative to `packages/ibkr-client/tests/` — no rewrites needed in the test files themselves. But verify:

```bash
grep -nE "^import" packages/ibkr-client/tests/utils.spec.ts | head -10
grep -nE "^import" packages/ibkr-client/tests/protobuf-decode.spec.ts | head -15
```
Expected: every `from '../src/...'` resolves to a file that exists under `packages/ibkr-client/src/`. If any reference a file that's actually in ibkr-types (e.g., `from '../src/const.js'`), rewrite that line to `from '@traderalice/ibkr-types'`.

- [ ] **Step 14: Create `packages/ibkr-client/vitest.config.ts`**

Copy from `packages/ibkr/vitest.config.ts`:
```bash
cat packages/ibkr/vitest.config.ts
```
Then create the matching file at the new location with the same content. (The config likely points at `tests/` which is fine; if it has any path overrides, adjust.)

If `packages/ibkr/vitest.config.ts` is something simple like:
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**'],
  },
})
```
Then the file at `packages/ibkr-client/vitest.config.ts` is byte-identical.

- [ ] **Step 15: Run the shim's unit tests (5 files now in packages/ibkr/tests/)**

```bash
pnpm --filter @traderalice/ibkr test
```
Expected: all 5 unit-test files pass — `models`, `account-summary-tags`, `comm`, `order-condition`, `order-precision`. (No e2e in this run; e2e requires `vitest.e2e.config.ts`.)

If any test fails on resolution, the import rewrite missed a name. Re-check the test file's imports against what the shim re-exports.

- [ ] **Step 16: Run ibkr-client's unit tests (2 files just moved)**

```bash
pnpm --filter @traderalice/ibkr-client test
```
Expected: both `utils.spec.ts` and `protobuf-decode.spec.ts` pass.

- [ ] **Step 17: Commit**

```bash
git add packages/ibkr/src/index.ts packages/ibkr/package.json packages/ibkr/tests/ packages/ibkr-client/tests/ packages/ibkr-client/vitest.config.ts pnpm-lock.yaml
git rm packages/ibkr/tsup.config.ts
git commit -m "feat(ibkr): collapse packages/ibkr to re-export shim (Task D)

- packages/ibkr/src/index.ts: 2-line re-export of both new packages
- packages/ibkr/package.json: deps replaced with workspace:* refs
  to ibkr-types + ibkr-client; ts-proto, tsup removed; generate:proto
  script removed (moved to ibkr-client)
- packages/ibkr/tsup.config.ts: deleted (build uses tsc)
- 5 unit-test files: deep './../src/X.js' imports rewritten to
  '@traderalice/ibkr' (the shim now)
- 2 unit-test files moved to ibkr-client/tests/ (they import
  internals not exposed by the shim — utils.BadMessage, specific
  protobuf/X.js files)
- packages/ibkr-client/vitest.config.ts created (mirror of shim's)

After this commit: tree fully builds, all three packages green."
```

---

## Task E: Full DoD verification

No new code or commits in this task — verification only.

- [ ] **Step 1: Clean install**

```bash
rm -rf node_modules packages/*/node_modules
pnpm install
```
Expected: clean install. No errors. Lockfile reflects three packages where there used to be one.

- [ ] **Step 2: Build all three packages in topological order**

```bash
pnpm --filter @traderalice/ibkr-types build && \
pnpm --filter @traderalice/ibkr-client build && \
pnpm --filter @traderalice/ibkr build
```
Expected: all three succeed.

- [ ] **Step 3: Repo-wide tsc**

```bash
npx tsc --noEmit
```
Expected: no NEW errors vs. baseline. If any error mentions `@traderalice/ibkr` exports being missing (in `src/`), it means the shim's re-export `*` didn't surface a name that `src/` was using. Re-check Task D's index.ts and Task C's `ibkr-client` index.ts to confirm all expected names are exported.

- [ ] **Step 4: Repo-wide tests**

```bash
pnpm test
```
Expected: ~1299 tests passing (or whatever baseline you recorded pre-flight). NO regressions.

- [ ] **Step 5: Shim package tests**

```bash
pnpm --filter @traderalice/ibkr test
```
Expected: 5 unit-test files pass.

- [ ] **Step 6: ibkr-client package tests**

```bash
pnpm --filter @traderalice/ibkr-client test
```
Expected: 2 unit-test files pass.

- [ ] **Step 7: Dev-server smoke test**

```bash
pnpm dev > /tmp/dev.log 2>&1 &
DEV_PID=$!
sleep 5
curl -sf http://localhost:3002/api/status | head -1
kill $DEV_PID 2>/dev/null
```
Expected: JSON response `{"ok":true,"version":"0.10.0-beta.0",...}`.

- [ ] **Step 8: Verify shim package is fully collapsed**

```bash
ls packages/ibkr/src/
```
Expected: ONLY `index.ts`. No other files.

- [ ] **Step 9: Verify zero src/ edits**

```bash
git diff f466e57..HEAD -- src/
```
Expected: empty output. No `src/` files changed.

- [ ] **Step 10: Verify root config untouched**

```bash
git diff f466e57..HEAD -- pnpm-workspace.yaml turbo.json package.json
```
Expected: empty output.

- [ ] **Step 11: Verify git history preserved for moved files**

```bash
git log --follow -1 packages/ibkr-types/src/contract.ts | head -5
git log --follow -1 packages/ibkr-client/src/decoder/order.ts | head -5
```
Expected: each shows pre-split commits (from when the file was at its old location).

- [ ] **Step 12: E2E tests** (optional — only if IBKR paper trading creds are configured)

```bash
pnpm --filter @traderalice/ibkr test:e2e
```
Expected: 3 e2e test files pass. (Skip if no live broker available; the shim's e2e config still references `tests/e2e/`.)

- [ ] **Step 13: Final summary**

```bash
echo "Phase 1a final state:"
echo "  packages/ibkr-types/: $(find packages/ibkr-types/src -name '*.ts' | wc -l) source files"
echo "  packages/ibkr-client/: $(find packages/ibkr-client/src -name '*.ts' | wc -l) source files"
echo "  packages/ibkr/src/: $(ls packages/ibkr/src/ | wc -l) files (should be 1)"
echo "  Tests in shim: $(ls packages/ibkr/tests/*.spec.ts 2>/dev/null | wc -l)"
echo "  Tests in ibkr-client: $(ls packages/ibkr-client/tests/*.spec.ts 2>/dev/null | wc -l)"
echo "  Total commits since spec: $(git log --oneline f466e57..HEAD | wc -l)"
```

Expected:
- `ibkr-types/`: 20 source files (19 moved + index.ts)
- `ibkr-client/`: ~225 source files (5 root + decoder/ + client/ + protobuf/ + index.ts)
- `ibkr/src/`: 1 file (index.ts shim)
- Shim tests: 5
- ibkr-client tests: 2
- Total commits: 4 (Task A, B, C, D)

---

## Self-review

**Spec coverage:**
- Round 1 file partition → Tasks B + C
- Round 2 wiring (workspace, package.json, tsconfig) → Task A + Task D's package.json edit
- Round 3 mechanics (`git mv` batches + import rewrites) → Tasks B + C
- Round 4 sub-tasks A→E → 5 tasks named A→E
- Spec DoD → Task E

**Spec deviation acknowledged:** Round 1's "all tests stay in shim" assumed tests imported via `@traderalice/ibkr`. They don't — they use deep relative paths. The plan's Task D rewrites 5 unit tests to use the shim and moves 2 unit tests (utils, protobuf-decode) to `ibkr-client/tests/` because they import internals not in the shim. E2E tests stay (they correctly use `'../../src/index.js'`). One small new file: `packages/ibkr-client/vitest.config.ts`.

**Placeholder scan:** No "TBD"/"TODO"/"fill in" placeholders in instructional steps. The literal string "TODO" appears in the plan's commit message of Task A (correctly describing what Task B+C do), not as a placeholder.

**Type/name consistency:** All package names (`@traderalice/ibkr-types`, `@traderalice/ibkr-client`, `@traderalice/ibkr`) used identically across tasks. File-list in Task B (19 files) matches the source-side count. File-list in Task C matches the source-side I/O files + protobuf + ref + script.

**Open issue flagged in plan:** Step 11 of Task D (order-condition imports) is conditional on what Step 7 of Task B did. The plan handles both cases (add exports if not added; rewrite test if exports added). Acceptable.

**Risk acknowledgment:** The plan has a partially-broken-tree window between Task B and Task D (the shim's old index.ts references moved files until D rewrites it). This is intentional and matches the spec's Sub-task sequencing.

---

## Execution notes

- Sub-tasks A → B → C → D → E are strictly sequential. D depends on B + C; E depends on all.
- Tasks B → C → D leave the `pnpm --filter @traderalice/ibkr build` step in a known-failing state until D collapses the shim. Do NOT try to fix the shim mid-stream.
- All file moves use `git mv` to preserve history. Verifiable in Task E Step 11.
- The plan does NOT touch `src/`, `pnpm-workspace.yaml`, `turbo.json`, or root `package.json`. Verified in Task E Steps 9 + 10.
- Pre-existing failing tests / tsc errors from elsewhere in the repo are NOT regressions and not your concern.
