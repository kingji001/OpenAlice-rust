# Phase 2 — Hash v2 (intent only) Design

**Date:** 2026-05-12
**Migration phase:** v4 §5 Phase 2 (lines ~434-540, with v4 erratum-amended row 2 fixing all four timestamp sites). [v4 plan](../../RUST_MIGRATION_PLAN.v4.md).
**Status:** Spec — to be implemented.
**Estimated effort:** 4-5 eng-days (single PR, 9 sub-task commits).

## Goal

Introduce a forward-compatible canonical hash for new commits. Existing v1 commits stay opaque (loaded verbatim, never recomputed). New commits ship with `hashVersion: 2`, `intentFullHash` (64-char SHA-256 over canonical wire input), and `hashInputTimestamp` (the exact timestamp fed into the hash and persisted on the commit). Mixed v1+v2 logs are first-class.

**This is the first phase to integrate Phases 1a + 1b + 1c into live `TradingGit` code.** Wire adapters convert Operations to wire form; `canonicalJson` serializes; SHA-256 produces the hash.

Phase 2 also fixes a latent v1 bug: `commit()`, `push()`, `reject()`, and `sync()` each called `new Date().toISOString()` independently, so a commit's persisted `timestamp` field could diverge from the timestamp that was actually fed into its hash. v4 erratum row 2 mandates capturing the timestamp at the intent site and reusing it for both the hash input and the persisted timestamp.

## Non-goals

- Phase 2.5 entry hash (`entryHashVersion`/`entryFullHash`) — Phase 2 reserves the schema fields but does not populate them.
- Rust parity harness for v2 hashing — Phase 3 lands the Rust port.
- Wiring v2 into the per-UTA actor (Phase 4d).
- Migrating existing users' `data/trading/<accountId>/commit.json` files — they load as-is, new commits append as v2 (mixed log).
- Removing the v1 fallback — Phase 8 cleanup removes after ≥1 minor release on v2 default.

## Architecture

5 new files under `src/domain/trading/git/` + 1 additive change to `src/domain/trading/wire-adapters.ts` + 1 schema extension + 1 verifier CLI + fixture corpus changes.

```
src/domain/trading/
├── git/
│   ├── types.ts                     # MODIFY: 5 new optional GitCommit fields
│   ├── TradingGit.ts                # MODIFY: 4 timestamp sites + v2 hash path + v1 fallback
│   ├── hash-v2.ts                   # NEW: generateIntentHashV2()
│   ├── operation-wire.ts            # NEW: operationToWire() — walks Operation variants
│   ├── persisted-commit.ts          # NEW: PersistedCommit decoder + verifier
│   └── _rehydrate.ts                # NEW: extracted from TradingGit (was private method)
├── wire-adapters.ts                 # MODIFY: add partialToWire + ibkrPartialOrderToWire
└── __test__/
    ├── hash-v2.spec.ts              # NEW: determinism + canonical-stability
    ├── operation-wire.spec.ts       # NEW: each Operation variant maps correctly
    ├── persisted-commit.spec.ts     # NEW: classifyCommit + verifyCommit
    └── wire-adapters.spec.ts        # MODIFY: add partialToWire tests

scripts/
└── verify-v2-hashes.ts              # NEW: on-demand CLI

parity/
├── fixtures/
│   ├── git-states/                  # REGENERATE: 10 scenarios captured as v2
│   ├── git-states-v1-frozen/        # NEW: 10 v1-format captures (frozen)
│   └── mixed-version-logs/          # NEW: 5 hand-authored v1+v2 mixed logs
├── hash-v2-roundtrip.ts             # NEW: DoD script
├── check-mixed-log.ts               # NEW: DoD script
└── legacy-v1-untouched.ts           # NEW: DoD script
```

### Schema extension (`src/domain/trading/git/types.ts`)

`GitCommit` gains 5 optional fields (3 active in Phase 2, 2 reserved for Phase 2.5):

```typescript
export interface GitCommit {
  // Existing fields (v1 + v2)
  hash: CommitHash                  // 8-char display hash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  round?: number

  // Phase 2 — populated for v2 commits
  hashVersion?: 1 | 2               // absent or 1 = legacy v1; 2 = canonical v2
  intentFullHash?: string           // 64-char SHA-256; present iff hashVersion === 2
  hashInputTimestamp?: string       // exact timestamp fed into v2 hash; present iff hashVersion === 2

  // Phase 2.5 — reserved, NOT populated in Phase 2
  entryHashVersion?: 1
  entryFullHash?: string
}
```

For v2 commits, `timestamp === hashInputTimestamp` (the fix for the v3 latent bug). For v1 commits, `timestamp` is unchanged from today's behavior and `hashInputTimestamp` is absent.

### Hash v2 algorithm (`src/domain/trading/git/hash-v2.ts`)

```typescript
export interface HashV2Input {
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  hashInputTimestamp: string
}

export function generateIntentHashV2(input: HashV2Input): {
  intentFullHash: string
  shortHash: CommitHash
} {
  const canonical = canonicalJson({
    hashVersion: 2,
    parentHash: input.parentHash,
    message: input.message,
    operations: input.operations.map(operationToWire),
    hashInputTimestamp: input.hashInputTimestamp,
  })
  const intentFullHash = createHash('sha256').update(canonical).digest('hex')
  return { intentFullHash, shortHash: intentFullHash.slice(0, 8) }
}
```

The `hashVersion: 2` literal is embedded in the canonical input, binding the hash to the algorithm version. A future v3 would have `hashVersion: 3` in its input and produce different bytes.

### Operation wire-form helper (`src/domain/trading/git/operation-wire.ts`)

Walks an `Operation` variant and converts IBKR-class fields via Phase 1b adapters:

```typescript
export function operationToWire(op: Operation): CanonicalJsonValue {
  switch (op.action) {
    case 'placeOrder':
      return {
        action: 'placeOrder',
        order: ibkrOrderToWire(op.order) as unknown as CanonicalJsonValue,
        contract: ibkrContractToWire(op.contract) as unknown as CanonicalJsonValue,
        ...(op.tpsl ? { tpsl: tpslToWire(op.tpsl) } : {}),
      }
    case 'modifyOrder':
      return {
        action: 'modifyOrder',
        orderId: op.orderId,
        changes: ibkrPartialOrderToWire(op.changes) as unknown as CanonicalJsonValue,
      }
    case 'closePosition':
      return {
        action: 'closePosition',
        contract: ibkrContractToWire(op.contract) as unknown as CanonicalJsonValue,
        ...(op.quantity ? { quantity: toCanonicalDecimalString(op.quantity) } : {}),
      }
    case 'cancelOrder':
      return {
        action: 'cancelOrder',
        orderId: op.orderId,
        ...(op.orderCancel ? { orderCancel: op.orderCancel as unknown as CanonicalJsonValue } : {}),
      }
    case 'syncOrders':
      return { action: 'syncOrders' }
  }
}

function tpslToWire(tpsl: { takeProfit?: string | Decimal; stopLoss?: string | Decimal }): CanonicalJsonValue {
  return {
    ...(tpsl.takeProfit ? { takeProfit: typeof tpsl.takeProfit === 'string' ? tpsl.takeProfit : toCanonicalDecimalString(tpsl.takeProfit) } : {}),
    ...(tpsl.stopLoss ? { stopLoss: typeof tpsl.stopLoss === 'string' ? tpsl.stopLoss : toCanonicalDecimalString(tpsl.stopLoss) } : {}),
  }
}
```

### Partial-Order wire adapter (`src/domain/trading/wire-adapters.ts`)

Phase 2 makes a small additive change to Phase 1b's `wire-adapters.ts` to support `Operation.modifyOrder.changes: Partial<Order>`:

```typescript
/**
 * Like toWire but accepts a partial source. Fields present in `partial`
 * AND in the schema are wrapped; non-schema fields pass through; absent
 * fields stay absent. Used for Operation.modifyOrder.changes (Partial<Order>).
 */
export function partialToWire<T extends object>(
  partial: Partial<T>,
  schema: Schema,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(partial)) {
    const v = (partial as Record<string, unknown>)[key]
    if (v === undefined) continue
    if (key in schema) {
      out[key] = wrapValue(v, schema[key]!)
    } else {
      out[key] = v
    }
  }
  return out
}

export const ibkrPartialOrderToWire = (changes: Partial<Order>): Partial<WireOrder> =>
  partialToWire(changes, ORDER_SCHEMA) as Partial<WireOrder>
```

Tests added in `wire-adapters.spec.ts`: empty in → empty out; single-Decimal-field in → properly-wrapped single-field out; sentinel handling identical to `toWire`.

### TradingGit changes — 4 timestamp sites (`src/domain/trading/git/TradingGit.ts`)

New instance state on TradingGit:
```typescript
private pendingV2: { hashInputTimestamp: string; intentFullHash: string } | null = null
```

(The struct keeps the two v2-specific fields tied together for cleaner lifecycle management. Cleared alongside `pendingMessage` and `pendingHash` at end of push/reject success.)

The existing `generateCommitHash` function is renamed to `generateCommitHashV1` — preserved as the v1 fallback path. New v2 commits go through `generateIntentHashV2` instead.

**`commit()`** — capture `hashInputTimestamp`, compute v2 hash, set `pendingV2`:

```typescript
commit(message: string): CommitPrepareResult {
  if (this.stagingArea.length === 0) {
    throw new Error('Nothing to commit: staging area is empty')
  }

  const hashInputTimestamp = new Date().toISOString()
  const hashVersion = this.config.hashVersion ?? 2

  let pendingHash: CommitHash
  let pendingV2: { hashInputTimestamp: string; intentFullHash: string } | null = null

  if (hashVersion === 2) {
    const { intentFullHash, shortHash } = generateIntentHashV2({
      parentHash: this.head,
      message,
      operations: this.stagingArea,
      hashInputTimestamp,
    })
    pendingHash = shortHash
    pendingV2 = { hashInputTimestamp, intentFullHash }
  } else {
    pendingHash = generateCommitHashV1({
      message,
      operations: this.stagingArea,
      timestamp: hashInputTimestamp,
      parentHash: this.head,
    })
  }

  this.pendingHash = pendingHash
  this.pendingMessage = message
  this.pendingV2 = pendingV2

  return { prepared: true, hash: pendingHash, message, operationCount: this.stagingArea.length }
}
```

**`push()`** — reuse `pendingV2` for both the persisted `timestamp` and the new v2 fields:

```typescript
const commit: GitCommit = {
  hash,
  parentHash: this.head,
  message,
  operations,
  results,
  stateAfter,
  timestamp: this.pendingV2?.hashInputTimestamp ?? new Date().toISOString(),
  round: this.currentRound,
  ...(this.pendingV2 !== null ? {
    hashVersion: 2 as const,
    intentFullHash: this.pendingV2.intentFullHash,
    hashInputTimestamp: this.pendingV2.hashInputTimestamp,
  } : {}),
}
// ...append, persist via onCommit, clear staging + pendingV2
```

For v1 commits (`pendingV2 === null`), `timestamp` falls back to `new Date().toISOString()` — preserving today's wall-clock behavior byte-identically.

**`reject()`** — same pattern as `push()` (uses `pendingV2` for `timestamp` + v2 fields).

**`sync()`** — captures its own `hashInputTimestamp` locally (no pending state to share since sync is single-step):

```typescript
const hashInputTimestamp = new Date().toISOString()
const hashVersion = this.config.hashVersion ?? 2

let hash: CommitHash
let v2Fields: Partial<GitCommit> = {}
if (hashVersion === 2) {
  const { intentFullHash, shortHash } = generateIntentHashV2({
    parentHash: this.head,
    message,
    operations,
    hashInputTimestamp,
  })
  hash = shortHash
  v2Fields = { hashVersion: 2, intentFullHash, hashInputTimestamp }
} else {
  hash = generateCommitHashV1({ updates, timestamp: hashInputTimestamp, parentHash: this.head })
}

const commit: GitCommit = {
  hash,
  parentHash: this.head,
  message,
  operations,
  results: /* ... */,
  stateAfter: currentState,
  timestamp: hashInputTimestamp,
  round: this.currentRound,
  ...v2Fields,
}
```

### Reversibility config

`TradingGitConfig` gains an optional `hashVersion?: 1 | 2` field. Defaults to 2. Wired through `UTAManager.initUTA()` from the top-level config namespace (`tradingCore.commitHashVersion` per v4 §6.10).

### PersistedCommit decoder (`src/domain/trading/git/persisted-commit.ts`)

Discriminated union + classifier + verifier + serializer:

```typescript
export interface PersistedCommitV1Opaque {
  kind: 'v1-opaque'
  raw: GitCommit  // hashVersion absent or 1
}

export interface PersistedCommitV2 {
  kind: 'v2'
  commit: GitCommit  // hashVersion === 2; intentFullHash + hashInputTimestamp present
}

export type PersistedCommit = PersistedCommitV1Opaque | PersistedCommitV2

export function classifyCommit(raw: GitCommit): PersistedCommit {
  if (raw.hashVersion === 2) return { kind: 'v2', commit: raw }
  return { kind: 'v1-opaque', raw }
}

export interface VerifyResult {
  kind: 'verified' | 'mismatch' | 'skipped'
  hash: string
  expectedIntentFullHash?: string
  actualIntentFullHash?: string
  message?: string
}

export function verifyCommit(persisted: PersistedCommit, opts: { strict?: boolean } = {}): VerifyResult {
  if (persisted.kind === 'v1-opaque') return { kind: 'skipped', hash: persisted.raw.hash }

  const c = persisted.commit
  if (c.intentFullHash === undefined || c.hashInputTimestamp === undefined) {
    const msg = `v2 commit ${c.hash} is missing intentFullHash or hashInputTimestamp`
    if (opts.strict) throw new Error(msg)
    return { kind: 'mismatch', hash: c.hash, message: msg }
  }

  const canonical = canonicalJson({
    hashVersion: 2,
    parentHash: c.parentHash,
    message: c.message,
    operations: c.operations.map(operationToWire),
    hashInputTimestamp: c.hashInputTimestamp,
  })
  const actualIntentFullHash = createHash('sha256').update(canonical).digest('hex')

  if (actualIntentFullHash !== c.intentFullHash) {
    const msg = `v2 commit ${c.hash}: intentFullHash mismatch (expected ${c.intentFullHash.slice(0, 8)}…, got ${actualIntentFullHash.slice(0, 8)}…)`
    if (opts.strict) throw new Error(msg)
    return { kind: 'mismatch', hash: c.hash, expectedIntentFullHash: c.intentFullHash, actualIntentFullHash, message: msg }
  }

  return { kind: 'verified', hash: c.hash, actualIntentFullHash, expectedIntentFullHash: c.intentFullHash }
}

export function serializeCommit(persisted: PersistedCommit): GitCommit {
  return persisted.kind === 'v1-opaque' ? persisted.raw : persisted.commit
}
```

**Rehydration prerequisite**: `verifyCommit` expects `c.operations` to contain rehydrated class instances (Decimal instances, not strings). Callers run `_rehydrateOperation` first.

### Extract `_rehydrateOperation` (`src/domain/trading/git/_rehydrate.ts`)

Currently a private method on `TradingGit` (`TradingGit.ts:312-371`). Phase 2 extracts to a standalone helper so the verifier CLI can reuse it without instantiating TradingGit:

```typescript
export function rehydrateOperation(op: Operation): Operation {
  // Same logic as current TradingGit._rehydrateOperation: walks the
  // operation, reconstructs Order/Contract/etc. class instances, rewraps
  // Decimal-string fields as Decimal instances.
}
```

TradingGit imports and calls this helper instead of having the method inline. Behavior preserved byte-identically.

### Verifier CLI (`scripts/verify-v2-hashes.ts`)

On-demand CLI:

```
pnpm tsx scripts/verify-v2-hashes.ts                # all accounts under data/trading/
pnpm tsx scripts/verify-v2-hashes.ts --account=<id> # one account
pnpm tsx scripts/verify-v2-hashes.ts --strict       # exit 1 on first mismatch
```

For each account's `commit.json`:
1. Load via `loadGitState(accountId)`.
2. For each commit: rehydrate operations, `classifyCommit`, `verifyCommit`.
3. Per-account summary: total / v2-verified / v1-skipped / v2-mismatches.
4. If any mismatches AND `--strict`, exit 1.

Does NOT walk `LEGACY_GIT_PATHS` (pre-v2 paths can only contain v1 commits, which are skipped anyway).

### Fixture corpus changes

**Regenerated** (`parity/fixtures/git-states/`): all 10 scenarios re-captured via post-Phase-2 `run-ts.ts` (which emits v2 by default). Each commit has `hashVersion: 2`, `intentFullHash`, `hashInputTimestamp`; the `hash` short-form is `intentFullHash.slice(0,8)`.

**New frozen** (`parity/fixtures/git-states-v1-frozen/`): 10 v1-format captures, copies of the pre-Phase-2 `git-states/*.json`. Frozen forever. The `legacy-v1-untouched.ts` DoD script asserts these never get recomputed by the loader.

**New mixed** (`parity/fixtures/mixed-version-logs/`): 5 hand-authored mixed `GitExportState` files combining v1 + v2 commits in one log. Cover edge cases:
- `01-v1-then-v2.json` — migration path (3 v1 commits + 2 v2 commits)
- `02-v2-then-v2.json` — steady state (5 v2 commits)
- `03-v1-only.json` — pre-Phase-2 user (4 v1 commits)
- `04-v2-only.json` — fresh-install user (4 v2 commits)
- `05-alternating.json` — edge case (v1, v2, v1, v2, v2)

### `run-ts.ts` changes

Defaults to `hashVersion: 2` (uses the new TradingGitConfig field). No CLI flag added — Phase 0's CLI behavior unchanged; only the wire output now carries v2 fields.

### DoD scripts (3 new at `parity/`)

**`hash-v2-roundtrip.ts`**: for a `GitExportState` fixture file, recompute `intentFullHash` for each v2 commit and assert match.

**`check-mixed-log.ts`**: for each `mixed-version-logs/*.json`, load → classify each commit → re-serialize → assert byte-identical to source. Plus verify v2 commits.

**`legacy-v1-untouched.ts`**: for each `git-states-v1-frozen/*.json`, load → assert all commits classify as `v1-opaque` → re-serialize → assert byte-identical. Plus assert no v2-recompute path is touched.

## Sub-task sequencing

| Sub-task | What lands |
|---|---|
| A — schema extension | `types.ts` 5 optional fields |
| B — partial-Order wire adapter | `wire-adapters.ts` additive change + tests |
| C — operation-wire + hash-v2 | 2 new files + determinism specs |
| D — extract rehydration | `_rehydrate.ts` + TradingGit refactor (behavior-preserving) |
| E — PersistedCommit decoder | `persisted-commit.ts` + specs |
| F — TradingGit cuts over | 4 timestamp sites rewritten; v2 path live; v1 fallback retained |
| G — `verify-v2-hashes.ts` CLI | scripts/ |
| H — fixture corpus rebuild | freeze v1, regenerate v2, author mixed |
| I — DoD scripts + verification | 3 parity scripts + run all DoD |

Strictly sequential A → B → C → D → E → F → G → H → I.

## Definition of Done

- [ ] `GitCommit` has 5 new optional fields (3 active, 2 reserved)
- [ ] `npx tsc --noEmit` clean
- [ ] `pnpm test` → no regressions; ~30-50 new tests
- [ ] `pnpm tsx parity/hash-v2-roundtrip.ts parity/fixtures/git-states/01-single-commit.json` → exits 0
- [ ] `pnpm tsx parity/check-mixed-log.ts` → exits 0 over all 5 mixed-version fixtures
- [ ] `pnpm tsx parity/legacy-v1-untouched.ts` → exits 0 over all 10 v1-frozen fixtures
- [ ] `pnpm tsx scripts/verify-v2-hashes.ts` → exits 0 (over whatever's in `data/trading/`)
- [ ] `pnpm dev` boots; new commits land with `hashVersion: 2`
- [ ] **Critical**: an existing `data/trading/<accountId>/commit.json` with v1 commits continues to load unchanged. New commits append as v2. The loaded log is mixed.
- [ ] **Critical**: with `hashVersion: 1` set in config, new commits land as v1 (no `hashVersion`, no `intentFullHash`). Byte-identical to today's behavior.
- [ ] `git diff <base>..HEAD -- packages/` empty (no `packages/` edits)
- [ ] `git diff <base>..HEAD -- pnpm-workspace.yaml turbo.json package.json` empty
- [ ] `parity/fixtures/git-states/` regenerated to v2 form (every commit has `hashVersion: 2`)
- [ ] `parity/fixtures/git-states-v1-frozen/` exists with 10 frozen v1 captures
- [ ] `parity/fixtures/mixed-version-logs/` exists with 5 hand-authored mixed examples

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| v2 hash differs from what Phase 3 Rust computes | Medium | High | Deferred to Phase 3 parity harness. Phase 2's output is the parity target. |
| Rehydration in the verifier produces slightly different operation objects than what was originally hashed | Medium | Medium | Decimal-string round-trip is exact (Phase 1c verified). Class fields preserved by JSON.stringify + Object.assign. Verifier's first DoD run on the regenerated fixtures catches any drift. |
| Existing TradingGit tests fail because hash output changed | High (expected) | Low | Update test fixtures + expected-hash values during Task F. Document in the commit message. |
| `pendingV2` instance state leaks across commit/push cycles | Low | High | Clear at end of push/reject success. Test: call `commit()` without `push()`, then `commit()` again → second commit's hash is independent. |
| Mixed-version log fails to load because the decoder is too strict | Medium | High | `classifyCommit` only checks `hashVersion === 2`. Anything else → v1-opaque. `check-mixed-log.ts` exercises this. |
| Phase 2.5 reserved fields accidentally populated | Low | Low | Code review catch. No code path writes these fields. |
| Persistence form change breaks consumers reading `commit.json` directly | Low | Medium | Only new fields are added; no existing fields removed. Old readers ignoring v2 fields still work. |
| `hashVersion: 1` opt-out path drifts from today's behavior | Medium | Low | `generateCommitHashV1` is a verbatim rename. Test: with `hashVersion: 1` config + fixed input, produces today's hash byte-identically. |
| Wire adapters fail on a hash-input field shape that wasn't covered by Phase 1b's 427 fixtures | Low | Medium | Phase 2 adds operation-level tests covering every Operation variant. If a real production commit fails, the verifier reports it as `mismatch` for triage rather than crashing. |

## Out of scope

- Phase 2.5 entry hash population
- Rust parity harness for v2 (Phase 3)
- Per-UTA actor integration (Phase 4d)
- Bulk-rewrite of existing v1 commits (out forever)
- Removing the v1 fallback (Phase 8)

## Acceptance signal

Phase 2 is "done" when:

- All DoD bullets pass.
- A fresh `pnpm dev` produces v2 commits on `git add → commit → push` lifecycle.
- An existing v1 `commit.json` in `data/trading/` loads, new operations land as v2, and the mixed log persists + reloads correctly.
- The 3 DoD parity scripts (`hash-v2-roundtrip.ts`, `check-mixed-log.ts`, `legacy-v1-untouched.ts`) exit 0.
- A v2 commit's `timestamp` field equals its `hashInputTimestamp` field (the v4 erratum fix).
- The `hashVersion: 1` config produces byte-identical-to-today commits.
