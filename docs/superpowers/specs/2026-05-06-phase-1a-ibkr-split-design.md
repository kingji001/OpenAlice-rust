# Phase 1a — `@traderalice/ibkr` package split design

**Date:** 2026-05-06
**Migration phase:** v4 §5 Phase 1a (lines ~334-364). [v4 plan](../../RUST_MIGRATION_PLAN.v4.md).
**Status:** Spec — to be implemented.
**Estimated effort:** 3-4 eng-days (single PR, 5 sub-task commits).

## Goal

Split `packages/ibkr/` into two packages and a back-compat shim:

- **`@traderalice/ibkr-types`** — pure DTO classes, constants, enums. No I/O.
- **`@traderalice/ibkr-client`** — connection, decoder, EClient, protobuf wrappers. All I/O lives here.
- **`@traderalice/ibkr`** — re-export shim. Body collapses to two `export *` lines pointing at the new packages. Kept for ≥1 minor release.

This is the foundation for Phase 1b (wire-types adapters at the type-only boundary) and Phase 3 (Rust port of the type surface).

## Non-goals

- Migrating consumers from `@traderalice/ibkr` to the new packages (the 41 callers stay on the shim — Round 1 decision; matches v4 §5 Phase 1a "no callers change").
- Splitting tests into the new packages (tests stay in `packages/ibkr/tests/` and exercise the shim — Round 1 decision).
- Refactoring `Order` / `Contract` / `ContractDetails` / `ContractDescription` from classes to interfaces (the decoder mutates them imperatively — Round 1 decision; matches v4 §5 Phase 1a Deliverable 7).
- Reorganizing `tests/` layout, e2e harness, or vitest configs.
- Touching `pnpm-workspace.yaml`, `turbo.json`, or root `package.json` (the `packages/*` glob auto-discovers; Turbo's `^build` cascade handles dep order).

## Architecture

Three resulting packages. Topological build order: `ibkr-types` → `ibkr-client` → `ibkr` (shim).

### `packages/ibkr-types/` — pure DTOs (no I/O)

`src/` files moved verbatim from `packages/ibkr/src/`:

| File | Why types-side |
|---|---|
| `const.ts` | UNSET_DECIMAL/DOUBLE/INTEGER/LONG, etc. |
| `errors.ts` | Error code enums (no instance state) |
| `server-versions.ts` | Version constants |
| `message.ts` | Message-id enums |
| `news.ts` | News-related types |
| `tag-value.ts` | `TagValue` class — pure data |
| `softdollartier.ts` | `SoftDollarTier` class |
| `tick-type.ts` | `TickType` enum |
| `account-summary-tags.ts` | Tag enums |
| `ineligibility-reason.ts` | Enum |
| `contract.ts` | `Contract`, `ContractDetails`, `ComboLeg`, `DeltaNeutralContract`, `ContractDescription` classes |
| `order.ts` | `Order`, `OrderComboLeg` classes |
| `order-state.ts` | `OrderState`, `OrderAllocation` |
| `order-cancel.ts` | `OrderCancel` |
| `order-condition.ts` | OrderCondition class hierarchy (no I/O) |
| `execution.ts` | `Execution`, `ExecutionFilter` |
| `commission-and-fees-report.ts` | Report DTO |
| `scanner.ts` | `ScannerSubscription`, `ScanData` |
| `common.ts` | Shared types |
| `index.ts` (NEW) | Re-exports above |

**Dependencies:** `decimal.js` only.

### `packages/ibkr-client/` — I/O layer

`src/` files moved from `packages/ibkr/src/`:

| File | Notes |
|---|---|
| `connection.ts` | Socket connection |
| `reader.ts` | EReader |
| `wrapper.ts` | `EWrapper` interface + `DefaultEWrapper` |
| `comm.ts` | `makeField`/`readMsg` etc. — wire-format helpers |
| `utils.ts` | IO utilities (default classification; verify during implementation — see Risks) |
| `decoder/` (full subdir, 9 files) | Verbatim move |
| `client/` (full subdir, 7 files) | Verbatim move |
| `protobuf/` (full subdir, 203 generated files) | Verbatim move |
| `decoder/order.ts` (NEW path) | Renamed move from `packages/ibkr/src/order-decoder.ts` per v4 plan |
| `index.ts` (NEW) | Re-exports above |

Plus `ref/` (proto sources + Python reference samples) moves to `packages/ibkr-client/ref/`. Plus `generate-proto.sh` moves to `packages/ibkr-client/generate-proto.sh` (no path edits needed — `SCRIPT_DIR`-relative resolution still works).

**Dependencies:** `@bufbuild/protobuf`, `protobufjs`, `decimal.js`, and `@traderalice/ibkr-types` (workspace).

**devDependencies:** `ts-proto` (for `generate:proto` script).

### `packages/ibkr/` — re-export shim

Single source file `src/index.ts`:

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

Plus existing `tests/` (8 unit + 3 e2e files) which continue to import via `@traderalice/ibkr`.

**Dependencies:** `@traderalice/ibkr-types` + `@traderalice/ibkr-client` only (workspace).

The previous direct deps (`@bufbuild/protobuf`, `decimal.js`, `protobufjs`) become transitive via the new packages and are removed from this package.

## Package configuration

### `packages/ibkr-types/package.json`

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
  "dependencies": { "decimal.js": "^10.6.0" },
  "devDependencies": { "@types/node": "^22.13.4", "typescript": "^5.7.3" },
  "engines": { "node": ">=20.0.0" },
  "license": "AGPL-3.0"
}
```

### `packages/ibkr-client/package.json`

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
    "typescript": "^5.7.3"
  },
  "engines": { "node": ">=20.0.0" },
  "license": "AGPL-3.0"
}
```

### `packages/ibkr/package.json` (modified)

The `dependencies` field becomes:

```json
"dependencies": {
  "@traderalice/ibkr-client": "workspace:*",
  "@traderalice/ibkr-types": "workspace:*"
}
```

`devDependencies` keeps `vitest` (tests live here). Drop `ts-proto`, `tsup` (not used after `tsup.config.ts` deletion). Keep `typescript`, `@types/node`.

### tsconfig.json

Both new packages use a tsconfig identical to `packages/ibkr/tsconfig.json` (verbatim copy):

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

(For `ibkr-types`, the `"ref"` exclude is harmless — there is no `ref/` dir in that package.)

### `pnpm-workspace.yaml` and `turbo.json`

**No edits.** The existing `packages/*` glob picks up the new packages. Turbo's `tasks.build.dependsOn: ["^build"]` ensures `ibkr-types` builds before `ibkr-client` builds before `ibkr` (shim) when the existing `predev` filter on `@traderalice/ibkr` runs.

## Move mechanics (file shuffle)

`git mv` for every file so history is preserved. Three batches:

**Batch 1 — types** (file moves only; internal cross-imports stay relative):

```bash
mkdir -p packages/ibkr-types/src
git mv packages/ibkr/src/{const,errors,server-versions,message,news}.ts packages/ibkr-types/src/
git mv packages/ibkr/src/{tag-value,softdollartier,tick-type,account-summary-tags,ineligibility-reason}.ts packages/ibkr-types/src/
git mv packages/ibkr/src/{contract,order,order-state,order-cancel,order-condition,execution,commission-and-fees-report,scanner,common}.ts packages/ibkr-types/src/
```

**Batch 2 — client + proto + ref**:

```bash
mkdir -p packages/ibkr-client/src/decoder packages/ibkr-client/src/client
git mv packages/ibkr/src/{connection,reader,wrapper,comm,utils}.ts packages/ibkr-client/src/
git mv packages/ibkr/src/decoder/* packages/ibkr-client/src/decoder/
git mv packages/ibkr/src/client/* packages/ibkr-client/src/client/
git mv packages/ibkr/src/protobuf packages/ibkr-client/src/protobuf
git mv packages/ibkr/src/order-decoder.ts packages/ibkr-client/src/decoder/order.ts
git mv packages/ibkr/ref packages/ibkr-client/ref
git mv packages/ibkr/generate-proto.sh packages/ibkr-client/generate-proto.sh
```

**Batch 3 — collapse shim**:

- Rewrite `packages/ibkr/src/index.ts` to the 2-line re-export shim
- Delete `packages/ibkr/tsup.config.ts` (unused; not carried forward to new packages)
- Update `packages/ibkr/package.json` deps as shown above

## Internal import rewrites (in `ibkr-client/src/`)

Any line in a `packages/ibkr-client/src/` file that previously did `from './<types-file>.js'` becomes `from '@traderalice/ibkr-types'`. Grep-driven mechanical pass:

```bash
grep -nE "from '\\./(contract|order|execution|order-state|order-cancel|order-condition|tag-value|softdollartier|tick-type|const|errors|message|news|common|account-summary-tags|ineligibility-reason|commission-and-fees-report|scanner|server-versions)" packages/ibkr-client/src -r
```

Lists every line to rewrite. Known sites flagged by the v4 outline:

- `decoder/account.ts:47,103,220,325` — `new Contract()`
- `decoder/contract.ts:116,181` — `new Contract()` / `new ContractDetails()`
- `decoder/execution.ts:43,89,140,157` — `new Contract()` / `new Execution()`
- `decoder/order.ts` (was `order-decoder.ts`) — `Order`/`OrderComboLeg` etc.
- `decoder/{orders,historical,market-data,misc}.ts` — audit
- `client/{encode,orders,account,historical,market-data}.ts` — likely reference `Order`/`Contract`
- `wrapper.ts` — `EWrapper` interface uses DTO types in method signatures
- `connection.ts`, `reader.ts`, `comm.ts`, `utils.ts` — likely zero or few imports; audit

After the rewrite, re-run the grep with the same pattern; expected zero matches under `packages/ibkr-client/src/`.

## New `index.ts` files

### `packages/ibkr-types/src/index.ts`

```typescript
export * from './const.js'
export * from './errors.js'
export * from './server-versions.js'
export * from './message.js'
export * from './news.js'

export { TagValue, type TagValueList } from './tag-value.js'
export { SoftDollarTier } from './softdollartier.js'
export { type TickType, TickTypeEnum, tickTypeToString } from './tick-type.js'
export { AccountSummaryTags, AllTags } from './account-summary-tags.js'
export { IneligibilityReason } from './ineligibility-reason.js'

export { Contract, ContractDetails, ComboLeg, DeltaNeutralContract, ContractDescription } from './contract.js'
export { Order, OrderComboLeg } from './order.js'
export { OrderState, OrderAllocation } from './order-state.js'
export { OrderCancel } from './order-cancel.js'
export { Execution, ExecutionFilter } from './execution.js'
export { CommissionAndFeesReport } from './commission-and-fees-report.js'
export { ScannerSubscription, ScanData } from './scanner.js'
export * from './common.js'
```

`order-condition.ts`'s exports should be appended if it exports anything publicly — verify during implementation.

### `packages/ibkr-client/src/index.ts`

```typescript
export { makeField, makeFieldHandleEmpty, makeMsg, readMsg, readFields } from './comm.js'
export { Connection } from './connection.js'
export { EReader } from './reader.js'
export { Decoder } from './decoder/index.js'
export { type EWrapper, DefaultEWrapper } from './wrapper.js'
export { EClient } from './client/index.js'
```

## READMEs

Each new package gets its own `README.md` (one paragraph each):

- `packages/ibkr-types/README.md` — explains purity (no I/O, no protocol), names the DTO classes, points back at `packages/ibkr-client/` for I/O, points at `packages/ibkr/` as the back-compat shim.
- `packages/ibkr-client/README.md` — explains it owns Connection/EClient/EReader/Decoder/protobuf, points at `ibkr-types` for the data classes it constructs, mentions `generate:proto` script and `ref/source/proto/` location.
- `packages/ibkr/README.md` (modified) — repurpose as the shim's README. One paragraph: "This package re-exports `@traderalice/ibkr-types` and `@traderalice/ibkr-client`. New code should depend on those directly. Kept for ≥1 minor release after Phase 1a."

## Sequencing within Phase 1a (sub-tasks)

All sub-tasks land in **one PR** with multiple commits. The tree is partially broken between Batch 1 and Batch 3 — that's intentional and acceptable inside a PR.

| Sub-task | What lands | After this commit |
|---|---|---|
| A — scaffold | Empty `ibkr-types/` and `ibkr-client/` package dirs (package.json + tsconfig + empty src/index.ts + README) + `pnpm install` | New packages register; tree builds (new packages empty but valid) |
| B — move types | 19 `git mv` operations into `ibkr-types/src/`; add real `index.ts`; build `ibkr-types` | `packages/ibkr/` no longer compiles (its index.ts references moved files); `ibkr-types` builds clean |
| C — move client | File moves into `ibkr-client/src/`; protobuf + ref move; rewrite internal imports; add real `index.ts`; build `ibkr-client` | `ibkr-client` builds clean against `ibkr-types`; `packages/ibkr/` still broken |
| D — collapse shim | Rewrite `packages/ibkr/src/index.ts` to 2-line shim; update `package.json` deps; delete `tsup.config.ts`; `pnpm install`; build shim | Tree fully builds again; shim resolves to both new packages |
| E — full DoD pass | Verification only (no new code). All DoD commands run green. | Phase 1a done |

## Definition of Done

- [ ] `pnpm install` clean from a fresh state (no warnings about missing deps or broken workspace links)
- [ ] All three packages build green via `pnpm --filter @traderalice/ibkr-types build && pnpm --filter @traderalice/ibkr-client build && pnpm --filter @traderalice/ibkr build`
- [ ] `npx tsc --noEmit` from repo root → no NEW errors vs. baseline
- [ ] `pnpm test` from repo root → no regressions vs. baseline (currently 1299/1299)
- [ ] `pnpm --filter @traderalice/ibkr test` → all 8 unit + 3 e2e specs pass against the shim (e2e may require live IBKR credentials — skip if not available, but unit tests must pass)
- [ ] `pnpm dev` boots and `curl http://localhost:3002/api/status` returns the expected JSON
- [ ] `git ls-files packages/ibkr/src/` shows ONLY `index.ts`
- [ ] `git diff <base>..HEAD -- src/` is empty (no `src/` edits)
- [ ] `git diff <base>..HEAD -- pnpm-workspace.yaml turbo.json package.json` is empty (root config untouched)
- [ ] `git mv` history preserved for every moved file (`git log --follow <new-path>` shows pre-split commits)

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `pnpm install` lockfile churn beyond intended scope | High (will happen) | Low | Expected — review `pnpm-lock.yaml` diff to confirm changes are scoped to the three packages only. |
| Internal import rewrites in `ibkr-client/src/` miss a file | Medium | Medium | Grep-driven rewrite + per-package build after each batch surfaces misses early. Re-run the negative-grep after rewrite (expect zero matches). |
| Vitest can't resolve `@traderalice/ibkr` from `packages/ibkr/tests/` because dist isn't built | Medium | Medium | If it surfaces, add `pretest: pnpm build` to `packages/ibkr/package.json`. |
| `tsup.config.ts` deletion breaks an unknown CI script | Low | Low | Grep `tsup.config.ts` references across repo before deleting (expected zero outside `packages/ibkr/`). |
| `utils.ts` actually contains a mix of types-side and IO-side helpers | Low | Low | Inspect during Batch 2; if mixed, split into two files (one per package). Default placement: `ibkr-client`. |
| `order-condition.ts` has hidden I/O dependencies | Low | Low | Grep imports during Batch 1; default placement: `ibkr-types`. If it imports from `comm.ts`/`reader.ts`/etc., move to `ibkr-client` instead. |
| The 41 callers' import resolution silently changes (e.g., a value import was relying on a non-typed re-export) | Low | Medium | The shim re-exports `*` from both packages; the union should match the current `@traderalice/ibkr` export surface. Verified by `tsc --noEmit` passing across `src/`. |
| LeverUp broker code (or another out-of-scope broker) imports something only available in the old package layout | Low | Low | Repo-wide grep for `'@traderalice/ibkr'` confirmed 41 imports today, all bare-package. No deep imports, no surprise consumers. |

## Acceptance signal

Phase 1a is "done" when:

- All DoD bullets pass
- The PR's diff is purely package-layout work — zero `src/` edits, zero root-config edits
- A reviewer can scan `git log --follow` for any moved file and see the pre-split commit history preserved
- The shim's two-line `index.ts` is the only file under `packages/ibkr/src/`
