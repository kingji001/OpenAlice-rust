# Rust Migration Plan v4 Production — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `docs/RUST_MIGRATION_PLAN.v4.md` by folding the v4 outline's 22 amendments into the canonical v3 plan, resolve four §11 open decisions in a sibling decision doc, ship the Phase 0 prerequisites (`/api/status` route + `parity/context-worksheets/` template + tagged `TODO.md` entries) that v4 references.

**Architecture:** Documentation work plus one small TS route. v3 stays as a frozen historical baseline (with a v3→v4 pointer banner). v4 is the new canonical migration plan. The four open decisions land in a separate decision document so v4's §11 can reference them as already-locked. Parity scaffolding and TODO entries are the two Phase 0 deliverables that v4's text references — they ship in this plan so the plan-and-deliverables land coherent.

**Tech Stack:** Markdown (plans + v4 doc), TypeScript (`Hono` route + `vitest` test).

**Inputs:**
- Spec: `docs/superpowers/specs/2026-05-05-rust-migration-plan-v4-outline.md` (commit `c60de33`)
- v3 baseline: `docs/RUST_MIGRATION_PLAN.v3.md` (1596 lines)

**Pre-flight checks before starting:**
- [ ] Confirm working tree is clean: `git status --short` — only untracked plans dir if any
- [ ] Confirm v3 file exists at `docs/RUST_MIGRATION_PLAN.v3.md`: `wc -l docs/RUST_MIGRATION_PLAN.v3.md` → expect 1596
- [ ] Confirm spec at `docs/superpowers/specs/2026-05-05-rust-migration-plan-v4-outline.md`: `wc -l docs/superpowers/specs/2026-05-05-rust-migration-plan-v4-outline.md` → expect ~496

---

## Phase A — Resolve §11 open decisions (must complete before Phase D)

The v4 plan's §11 references four new decisions. v4 ships them as already-locked, with the rationale and (for some) configuration values referenced from the decision doc. This phase produces that doc.

### Task A1: Create the decisions file with frontmatter

**Files:**
- Create: `docs/superpowers/decisions/2026-05-05-v4-open-decisions.md`

- [ ] **Step 1: Create the file with frontmatter and 4-decision skeleton**

```markdown
# v4 Open Decisions — Resolutions

**Date:** 2026-05-05
**Spec:** [v4 outline](../specs/2026-05-05-rust-migration-plan-v4-outline.md)
**Status:** Resolved (referenced by `RUST_MIGRATION_PLAN.v4.md` §11)

This document locks the four new open decisions raised in the v4 outline. Each
resolution is binding for v4; revisit only via an explicit `[v4-revisit]`
TODO.md entry tracked in a future migration phase.

---

## Decision 1 — §4.4 LeverUp scope

**Question:** Does LeverUp join the Rust port path, or stay TS-only like CCXT?

**Resolution:** Stay TS-only until LeverUp's TS impl stabilizes. Revisit
post-Phase-7.

**Rationale:** LeverUp's TODO.md entries (lines 232-257) indicate the TS
implementation is still in flux (whole-position close, no limit orders, EIP-712
signing). Porting an unstable TS impl to Rust would force the Rust port to
chase TS changes, violating P4 ("one concept per phase"). The Phase 4b
`Broker` trait still includes `BrokerCapabilities` (Phase 4b Deliverable 8) so
the trait shape doesn't need rework if §11 ever flips this decision later.

**v4 anchors:** §4.4 reads "stay TS until LeverUp's TS impl stabilizes" as
fact, not recommendation. §5 Phase 5 explicitly says "LeverUp NOT in scope."

---

## Decision 2 — §6.13 TODO.md as-is items

**Question:** Port "trading-git staging area lost on restart" and "cooldown
guard state lost on restart" as-is, or fix during port?

**Resolution:** Port as-is. Both bugs land in Rust as exact behavioral
parity with TS; fixes ride in separate post-Phase-7 PRs.

**Rationale:** P4 ("one concept per phase") forbids fix-during-port. Parity
fixtures pin current TS behavior; Rust port matches; later fix-PR updates
both impls together with new fixtures. Operator may misread the migration as
fixing these — mitigated by `[migration-deferred]` tags on TODO.md entries
(Phase 0 Deliverable 10) and explicit call-outs in Phase 3 / Phase 4c PR
bodies.

**v4 anchors:** §6.13 row 1 + row 2 — Decision column reads "Port-as-is."

---

## Decision 3 — §6.14 `getPortfolio` interleaving

**Question:** Accept current inconsistency between back-to-back
`getPositions()` + `getAccount()` calls, or introduce `getPortfolioSnapshot`
actor command for atomic read?

**Resolution:** Accept current inconsistency. `RustUtaProxy` does not ship
`getPortfolioSnapshot`. The hazard is documented in §6.14.

**Rationale:** Current TS code has the same inconsistency window — there is
no lock today either. Migrating preserves observed behavior (P4). A
`getPortfolioSnapshot` could land as a post-migration improvement once the
proxy is stable; design space is open then. Adding it to Phase 4f scope
mixes "port" with "fix," which is the explicit anti-pattern P4 forbids.

**v4 anchors:** §6.14 "Two options" subsection — option (a) is the chosen
path; option (b) is documented for future revisit.

---

## Decision 4 — §6.12.1 panic dedup threshold

**Question:** N consecutive `RUST_PANIC` errors → mark UTA disabled. What
is N?

**Resolution:** `N = 5`. Exposed via `tradingCore.panicDisableThreshold`
in the new config namespace (§6.10). Setting `N = 0` disables the
dedup behavior (panics never auto-disable; useful for development).

**Rationale:** 5 consecutive panics on the same UTA strongly suggests a
systemic bug, not a transient. Smaller N (e.g., 1-2) would auto-disable on
spurious panics that recover. Larger N (e.g., 10) would let a busted UTA
spin recovery indefinitely. 5 balances responsiveness with tolerance for
transient flakiness.

**v4 anchors:** §6.12.1 "Panic dedup" paragraph — "Default `N = 5`;
configurable via `tradingCore.panicDisableThreshold`."

---
```

Run: `wc -l docs/superpowers/decisions/2026-05-05-v4-open-decisions.md`
Expected: ~80 lines.

- [ ] **Step 2: Verify markdown renders cleanly**

Run: `head -30 docs/superpowers/decisions/2026-05-05-v4-open-decisions.md`
Expected: frontmatter + Decision 1 header visible, no markdown syntax issues.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/decisions/2026-05-05-v4-open-decisions.md
git commit -m "docs: lock 4 open decisions for Rust migration v4

LeverUp stays TS, TODO items port-as-is, getPortfolio interleaving
accepted as-is, panic dedup threshold N=5 default."
```

---

## Phase B — `/api/status` route (independent of A; can run in parallel)

v4 §3.4 release gate uses `curl -sf http://localhost:3002/api/status`. Today this 404s. Phase 0 Deliverable 9 ships the route. TDD: test first.

### Task B1: Write the failing test

**Files:**
- Create: `src/connectors/web/routes/status.spec.ts`

- [ ] **Step 1: Write the spec file**

```typescript
/**
 * Tests for GET /api/status — the release-gate health endpoint.
 *
 * Returns { ok: true, version: <package.json>, uptimeSeconds: <int>, ffiLoaded: false }.
 * `ffiLoaded` is `false` until Phase 4f wires RustUtaProxy.
 */

import { describe, it, expect } from 'vitest'
import { createStatusRoutes } from './status.js'

describe('GET /api/status', () => {
  it('returns ok=true with version and ffiLoaded=false', async () => {
    const app = createStatusRoutes()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; version: string; uptimeSeconds: number; ffiLoaded: boolean }
    expect(body.ok).toBe(true)
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)  // semver-ish
    expect(typeof body.uptimeSeconds).toBe('number')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(body.ffiLoaded).toBe(false)
  })

  it('uptimeSeconds increases between calls', async () => {
    const app = createStatusRoutes()
    const r1 = await app.request('/')
    const b1 = await r1.json() as { uptimeSeconds: number }
    await new Promise((r) => setTimeout(r, 1100))  // > 1s so the integer second ticks
    const r2 = await app.request('/')
    const b2 = await r2.json() as { uptimeSeconds: number }
    expect(b2.uptimeSeconds).toBeGreaterThan(b1.uptimeSeconds)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/connectors/web/routes/status.spec.ts`
Expected: FAIL with `Cannot find module './status.js'` or similar.

### Task B2: Implement the route

**Files:**
- Create: `src/connectors/web/routes/status.ts`

- [ ] **Step 1: Implement the route**

```typescript
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const startedAt = process.hrtime.bigint()
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }

/** Release-gate health endpoint — referenced by RUST_MIGRATION_PLAN.v4.md §3.4. */
export function createStatusRoutes() {
  const app = new Hono()

  app.get('/', (c) => {
    const elapsedNs = process.hrtime.bigint() - startedAt
    const uptimeSeconds = Number(elapsedNs / 1_000_000_000n)
    return c.json({
      ok: true,
      version: packageJson.version,
      uptimeSeconds,
      ffiLoaded: false,  // flips to true in Phase 4f when RustUtaProxy is wired
    })
  })

  return app
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm test src/connectors/web/routes/status.spec.ts`
Expected: PASS — both tests green.

### Task B3: Mount the route in `web-plugin.ts`

**Files:**
- Modify: `src/connectors/web/web-plugin.ts:114` (insert one line after the `/api/persona` mount)

- [ ] **Step 1: Add the import at the top**

Find the block of route imports near the top of `web-plugin.ts` (the file already imports many `createXRoutes` factories). Insert one new import alphabetically (after `createPersonaRoutes` if listed alphabetically, or wherever the existing group ends — match local style):

```typescript
import { createStatusRoutes } from './routes/status.js'
```

- [ ] **Step 2: Add the route mount**

Find line 114 (`app.route('/api/persona', createPersonaRoutes())`). Insert immediately after:

```typescript
    app.route('/api/status', createStatusRoutes())
```

- [ ] **Step 3: Run the type check**

Run: `npx tsc --noEmit`
Expected: clean — no errors.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: all green; no regressions.

- [ ] **Step 5: Smoke test the live endpoint**

Run: `pnpm dev > /tmp/dev.log 2>&1 &` then in a second shell `sleep 3 && curl -s http://localhost:3002/api/status` then `kill %1`
Expected: JSON response `{"ok":true,"version":"0.10.0-beta.0","uptimeSeconds":...,"ffiLoaded":false}`. If the dev server takes longer to boot, increase the sleep.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/web/routes/status.ts src/connectors/web/routes/status.spec.ts src/connectors/web/web-plugin.ts
git commit -m "feat(web): add GET /api/status for v4 release-gate

New route returns { ok, version, uptimeSeconds, ffiLoaded }.
ffiLoaded is false until Phase 4f wires RustUtaProxy.
Referenced by RUST_MIGRATION_PLAN.v4.md §3.4 release gate.
Phase 0 Deliverable 9."
```

---

## Phase C — Parity scaffolding (independent of A and B; can run in parallel)

v4 §5 Phase 0 Deliverable 8 ships `parity/context-worksheets/` with a template + per-sub-PR worksheets. Deliverable 10 adds tagged `TODO.md` entries. Both land here so v4.md doesn't reference vapor.

### Task C1: Create `parity/` directory structure

**Files:**
- Create: `parity/.gitkeep`
- Create: `parity/context-worksheets/_template.md`
- Create: `parity/context-worksheets/README.md`

- [ ] **Step 1: Create the directories**

Run:
```bash
mkdir -p parity/context-worksheets parity/fixtures
touch parity/.gitkeep
```

Expected: no errors.

- [ ] **Step 2: Write the worksheet template**

Create `parity/context-worksheets/_template.md` with this content:

````markdown
# Context Worksheet — Phase <N> sub-PR <a|b|c|d>

> Copy this file to `parity/context-worksheets/phase-<N><x>.md` when you
> start the sub-PR. Fill it in **before** writing code. The worksheet
> exists so an AI agent picking up the sub-PR knows exactly what to load
> into context — no guessing, no half-loads.

## Sub-PR identity

- **Phase:** <N>
- **Sub-PR letter:** <a|b|c|d>
- **Title:** <e.g., "TradingGit state machine port">
- **PR number:** <fill at PR creation>

## Files to load (in this order)

| Order | File | Read in full or excerpt | Why |
|-------|------|-------------------------|-----|
| 1     | `docs/RUST_MIGRATION_PLAN.v4.md` (this phase only) | excerpt | Phase deliverable + DoD |
| 2     | `CLAUDE.md`                                        | full    | Repo conventions (per v4 §8.1) |
| 3     | `docs/event-system.md`                             | full    | Event spine, if phase touches events |
| 4     | `TODO.md`                                          | scan    | Check for `[migration-deferred]` overlaps |
| 5+    | <phase-specific files>                             | <full or excerpt> | <reason> |

**Total LOC target:** keep loaded source under ~5,000 LOC; if you need more,
this sub-PR likely needs to be split further — escalate (per v4 §8.3).

## Files NOT to load

List here any nearby files an agent might be tempted to load but should
NOT for this sub-PR. Prevents context bloat.

| File | Why skip |
|------|----------|
| <e.g., snapshot/store.ts> | <e.g., not touched by this sub-PR; Phase 4d (c) only> |

## Definition of Done (mirror from v4 phase deliverable)

Paste verbatim from v4.md so the agent can re-state in the PR body:

```
<DoD bullets from v4.md §5 Phase <N>>
```

## Pre-flight commands

Run these once before starting:

```bash
git status --short                                  # clean tree
npx tsc --noEmit                                    # baseline green
pnpm test                                           # baseline green
```

## Open questions to resolve before merge

- [ ] <e.g., "Confirm with maintainer whether `<X>` should be `<a>` or `<b>`">

## Notes for the next agent

When you finish this sub-PR, append notes here that the next sub-PR's agent
needs to know but isn't already in v4.md or the codebase. Examples:
- "Phase 3(c) chose option A (Rust orchestrates push/commit) — see PR #N"
- "Found that `_rehydrateOperation` actually depends on `<X>` — Phase 4d
  needs to handle this"
````

Run: `wc -l parity/context-worksheets/_template.md`
Expected: ~55 lines.

- [ ] **Step 3: Write the README**

Create `parity/context-worksheets/README.md`:

```markdown
# Context Worksheets

This directory holds one worksheet per sub-PR identified in
`RUST_MIGRATION_PLAN.v4.md` §8.4. Each worksheet lists exactly which files
an agent must load to do the sub-PR well.

## Workflow

1. **Before starting a sub-PR**, copy `_template.md` to
   `phase-<N><letter>.md` (e.g., `phase-3c.md`, `phase-4d-a.md`).
2. Fill in the worksheet **before writing any code**.
3. Reference the worksheet in the PR body (a one-line link is enough).
4. After merge, leave the worksheet in place — the next sub-PR's agent
   may need to read its "Notes for the next agent" section.

## Why this exists

v4 §8.4 marks several sub-PRs as "TIGHT — fresh agent" because the file
load required to do them well exceeds what an agent can comfortably hold
in context alongside its own working memory. The worksheet forces the
loading list into a discrete artifact — if you can't fit it on one page,
the sub-PR likely needs further decomposition.

## Conventions

- One file per sub-PR. Do not combine.
- File naming: `phase-<N><letter>.md` (e.g., `phase-3c.md`,
  `phase-4d-a.md`). Use lowercase letters; double-letters separated by
  hyphen.
- "Files NOT to load" is as load-bearing as "Files to load" — it's how
  you fight context bloat.
```

Run: `cat parity/context-worksheets/README.md | head -10`
Expected: README header + first paragraph visible.

### Task C2: Add tagged entries to `TODO.md`

**Files:**
- Modify: `TODO.md` (append to end)

- [ ] **Step 1: Read the current end of `TODO.md` to match style**

Run: `tail -20 TODO.md`
Expected: see the existing entry style (header level, bullet form, indent).

- [ ] **Step 2: Append a new section to `TODO.md`**

Append at the end of `TODO.md` (preserve trailing newline if any):

```markdown

## Rust migration v4 — deferred items

### Snapshot durability gaps `[snapshot-durability]`

Three durability gaps in `src/domain/trading/snapshot/store.ts` that the
Rust migration's missing-snapshot reconciler does NOT close. See v4
§6.4.1 for full diagnosis.

- **Non-atomic chunk append** (`store.ts:83`). Raw `appendFile` for chunks
  produces partial last lines on crash. Reconciler counts on `chunk.count`
  from index — corruption invisible until parse.
- **No `fsync`** (`store.ts:51-56`). `rename(tmp, indexPath)` lacks fsync of
  file or parent dir.
- **Index/chunk write inconsistency** (`store.ts:83-84`). Chunk written
  before index update; crash between leaves chunk-without-index, reconciler
  emits a duplicate.

Mitigation candidates (not adopted in this migration): chunk append over
fsync'd write+rename pairs; transactional index+chunk via two-phase
rename; reconciler duplicate-detection step.

### Trading git staging area lost on restart `[migration-deferred]`

`TradingGit.stagingArea`, `pendingMessage`, `pendingHash`, `currentRound`
at `src/domain/trading/git/TradingGit.ts:41-46` are RAM-only. The Rust
migration ports the bug as-is (parity); fix lands post-Phase-7 in a
separate PR that updates both TS and Rust impls together. See v4 §6.13
row 1.

### Cooldown guard state lost on restart `[migration-deferred]`

`CooldownGuard.lastTradeTime` at `src/domain/trading/guards/cooldown.ts:9,30`
is in-memory. Rust port preserves the bug for parity; fix is a post-Phase-7
PR. See v4 §6.13 row 2.

### LeverUp broker — Rust scope `[v4-revisit]`

LeverUp stays TS-only for now (decision doc:
`docs/superpowers/decisions/2026-05-05-v4-open-decisions.md`#decision-1).
Revisit post-Phase-7 once LeverUp's TS impl stabilizes. The Phase 4b
`Broker` trait already includes `BrokerCapabilities` so a future Rust port
doesn't require trait-shape rework.

### `UNSET_LONG` JS precision bug `[migration-known]`

`packages/ibkr/src/const.ts:12` defines
`UNSET_LONG = BigInt(2 ** 63) - 1n`. The `2 ** 63` is computed as a JS
Number, exceeding `Number.MAX_SAFE_INTEGER` and rounding. v4 §6.1
caveats: any Rust `i64` field reconstruction must derive `i64::MAX`
canonically, not from this lossy TS source. Phase 1b adds a fixture.
```

- [ ] **Step 3: Verify the file parses as markdown**

Run: `tail -50 TODO.md | head -50`
Expected: see the new section starting with `## Rust migration v4 — deferred items`. No accidental backticks or unrendered markdown.

- [ ] **Step 4: Commit**

```bash
git add parity/.gitkeep parity/context-worksheets/_template.md parity/context-worksheets/README.md TODO.md
git commit -m "feat(parity): scaffold context-worksheets + tag TODO.md for v4

Phase 0 Deliverables 8 + 10 from RUST_MIGRATION_PLAN.v4.md:
- parity/context-worksheets/_template.md + README.md
- TODO.md gets tagged entries for snapshot-durability gaps,
  migration-deferred bugs, LeverUp v4-revisit, UNSET_LONG known issue."
```

---

## Phase D — Produce `RUST_MIGRATION_PLAN.v4.md` (blocked by A; references B + C)

The largest phase. v4.md lands as a copy of v3 with all 22 amendments folded in.

The strategy:
1. Copy v3 to a v4 working file unchanged.
2. Apply each amendment as a discrete, verifiable edit.
3. Verify section structure is intact.
4. Add a v3→v4 pointer banner to v3 (so v3 readers know v4 exists).

Amendments are ordered front-to-back through the document so a reviewer scanning the diff reads in document order.

### Task D1: Copy v3 to v4 working file

**Files:**
- Create: `docs/RUST_MIGRATION_PLAN.v4.md` (initial copy of v3)

- [ ] **Step 1: Copy v3 to v4**

Run:
```bash
cp docs/RUST_MIGRATION_PLAN.v3.md docs/RUST_MIGRATION_PLAN.v4.md
wc -l docs/RUST_MIGRATION_PLAN.v4.md
```
Expected: 1596 lines.

- [ ] **Step 2: Update v4 frontmatter (line 1 + line 3)**

Open `docs/RUST_MIGRATION_PLAN.v4.md`. Replace line 1:

From:
```
# OpenAlice — Rust Trading-Core Migration Plan (v3)
```
To:
```
# OpenAlice — Rust Trading-Core Migration Plan (v4)
```

Replace line 3:

From:
```
**Version:** 3.0
```
To:
```
**Version:** 4.0
```

After line 3, insert two new lines (blank line + pointer):

```
**Predecessor:** [v3](RUST_MIGRATION_PLAN.v3.md) — frozen historical baseline. v3 §13 Changelog records v2→v3 diffs; v4 §14 (new) records v3→v4 diffs.
```

- [ ] **Step 3: Verify the header**

Run: `head -10 docs/RUST_MIGRATION_PLAN.v4.md`
Expected: title says v4, Version: 4.0, predecessor pointer present.

### Task D2: Apply §1 amendment (Executive Summary)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §1

Two edits in §1:

- [ ] **Step 1: Add a row to the deliverable shape file tree (after line 47)**

Find the file tree under "Deliverable shape (state 1)". After the existing `├── git.rs` row (around line 48), the tree continues with `uta.rs`, `journal.rs`, etc. After `journal.rs` add one new row:

Find:
```
│       │   ├── journal.rs          # Broker-execution journal
```
Add immediately after:
```
│       │   ├── panic.rs            # catch_unwind boundary helpers (§6.12.1)
```

- [ ] **Step 2: Add a clarifying sentence to "Acceptable terminal states"**

Find the paragraph after row 2 of the terminal-states list:

From:
```
Both outcomes are first-class. State 2 still delivers: actor-pattern concurrency safety, hash-versioned audit trail, optional entry-level audit integrity, Rust-owned commit durability, broker-execution crash recovery. The plan does not assume state 1 is the goal.
```

To:
```
Both outcomes are first-class. State 2 still delivers: actor-pattern concurrency safety, hash-versioned audit trail, optional entry-level audit integrity, Rust-owned commit durability, broker-execution crash recovery, **and the new commit.notify event surface, runtime UTA actor lifecycle, panic-safe FFI boundary, and reconnect-ownership matrix — these land regardless of broker porting**. The plan does not assume state 1 is the goal.
```

- [ ] **Step 3: Verify edits**

Run: `grep -n "panic.rs\|land regardless of broker porting" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: two matches.

### Task D3: Apply §2 amendment (add P13 + P14)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §2

The principles table currently ends with row P12 (around line 90). Add two new rows.

- [ ] **Step 1: Find the P12 row**

Run: `grep -n "P12" docs/RUST_MIGRATION_PLAN.v4.md | head -3`
Expected: line ~90 has the P12 row in the principles table.

- [ ] **Step 2: Insert P13 + P14 rows after P12**

Find:
```
| P12 | **Live brokers are not a per-PR gate.** PR CI runs deterministic tests + parity + Mock broker e2e + recorded broker replays. Live broker e2e (TWS paper, Alpaca paper, exchange testnet) is nightly/manual. | §6.7. |
```

Insert immediately after (preserve table formatting):
```
| P13 | **Panic safety at the FFI boundary.** All Rust napi-exported methods are wrapped in `std::panic::catch_unwind`. Rust panics surface as typed JS errors, not process aborts. The Node host treats them like a transient broker error: log + mark UTA offline + schedule recovery. | §6.12.1; Phase 4f `parity/check-rust-panic.ts`. |
| P14 | **Connector consumer matrix.** Every Rust→TS event flow has a documented consumer list. New consumers declare against the matrix before adoption. | §6.16; Phase 4f Telegram smoke test. |
```

- [ ] **Step 3: Verify**

Run: `grep -n "^| P1[34] " docs/RUST_MIGRATION_PLAN.v4.md`
Expected: two matches (P13 and P14 rows).

### Task D4: Apply §3.4 amendment (release-gate endpoint fix)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §3.4

The current §3.4 release-gate code-block uses `/api/status` but the route doesn't exist in v3-tree. v4-tree ships it (Phase B above). The release-gate prose stays valid; we just need a sentence noting the route is a Phase 0 deliverable, and update the gate to log the response body.

- [ ] **Step 1: Find the release-gate `curl` block**

Run: `grep -n "curl -sf http://localhost:3002/api/status" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 165.

- [ ] **Step 2: Replace the `for` loop body**

Find:
```
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3002/api/status > /dev/null; then
      echo "ready after ${i}s"
      curl -sf http://localhost:3002/api/status
      kill $DEV_PID
      exit 0
    fi
    sleep 1
  done
```

Replace with:
```
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3002/api/status > /dev/null; then
      echo "ready after ${i}s"
      curl -sf http://localhost:3002/api/status   # logs version + ffiLoaded for the gate audit trail
      kill $DEV_PID
      exit 0
    fi
    sleep 1
  done
```

(The diff is a one-comment annotation; the existing `curl` is already correct because v4 ships the route.)

- [ ] **Step 3: Add a Phase 0 dependency note**

After the closing of the bash code block in §3.4 (after the line `'`), insert a new paragraph before the platform list ("The release gate runs on darwin-arm64..."):

```

**Route prerequisite:** `GET /api/status` is shipped by Phase 0 Deliverable 9 (`src/connectors/web/routes/status.ts`). The route returns `{ ok, version, uptimeSeconds, ffiLoaded }`. `ffiLoaded` is `false` pre-Phase-4f; the gate logs the body so the audit trail captures both the build version and the FFI state at gate time.

```

- [ ] **Step 4: Verify**

Run: `grep -n "audit trail\|Route prerequisite" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: two matches.

### Task D5: Apply §4.2 amendment (broaden UTAManager surface)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §4.2

- [ ] **Step 1: Find the existing UTAManager bullet**

Run: `grep -n "UTAManager.*EventLog.*ToolCenter" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 234.

- [ ] **Step 2: Replace the single UTAManager bullet with a broader enumeration**

Find:
```
- **`UTAManager`** — wires `EventLog`, `ToolCenter`, `FxService`, snapshot hooks, CCXT-specific provider tools ([uta-manager.ts:71‑165](../src/domain/trading/uta-manager.ts:71)). Moving these across FFI grows the boundary.
```

Replace with:
```
- **`UTAManager`** — wires the following ([uta-manager.ts:71‑330](../src/domain/trading/uta-manager.ts:71)). Moving these across FFI grows the boundary.
  - `EventLog` (`uta-manager.ts:101` — `account.health` emission)
  - `ToolCenter` (`:133-139, :162-168` — CCXT-specific provider tools register on init/reconnect)
  - `FxService` (`:82-88` setter; cross-account math at `:260-293`)
  - Snapshot hooks (`:103-104` — `setSnapshotHooks`; **removed in Phase 4d**, replaced by EventLog subscription)
  - `getAggregatedEquity` (`:260-293`) — cross-account FX math, real surface area
  - `searchContracts` / `getContractDetails` (`:297-330`) — broker-agnostic, IBKR-typed contract search routed across all UTAs; FFI boundary must ship `ContractDescription` and `ContractDetails`
  - `createGitPersister(cfg.id)` (`:99`) — current persistence side-channel that the actor model replaces in Phase 4d
  - `broker.factory` / `getBrokerPreset` (`:94, :134`) — broker preset coupling
```

- [ ] **Step 3: Verify**

Run: `grep -n "createGitPersister.*persistence side-channel" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D6: Insert §4.4 (LeverUp broker placement)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` after §4.3

- [ ] **Step 1: Find the §4.3 table end**

Run: `grep -n "^### 4.3\|^## 5" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: §4.3 around line 240, §5 around line 256.

- [ ] **Step 2: Insert §4.4 between §4.3 and §5**

Find the line:
```
---

## 5. Phased migration
```

Insert before the `---` separator:

```

### 4.4 LeverUp broker placement

LeverUp is being actively developed (`TODO.md:232-257`) and was absent from v3. It has shape-distinct quirks the Phase 4b `Broker` trait must accommodate:

1. **Whole-position close** (no partial close)
2. **No limit orders** (market-only)
3. **EIP-712 signing** for order intent

**Decision (locked in [v4 open decisions](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-1)):** LeverUp stays TS-only until its TS impl stabilizes. Revisit post-Phase-7. The Phase 4b `Broker` trait still includes a `BrokerCapabilities` extension point (Phase 4b Deliverable 8) so the trait shape doesn't need rework if this decision later flips.

`tradingCore.defaultBrokerImpl.leverup` defaults to `'ts'` and is literal-pinned in the Zod schema (§6.10) until the LeverUp Rust port lands.

```

- [ ] **Step 3: Verify**

Run: `grep -n "^### 4.4 LeverUp" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D7: Apply Phase 0 amendments (3 new deliverables)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 0

- [ ] **Step 1: Find the Phase 0 deliverable list end**

Run: `grep -n "^7\\. \`parity/decimal-inventory.md\`" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 282.

- [ ] **Step 2: Append three new deliverables**

Find:
```
7. `parity/decimal-inventory.md` — written audit of every `Decimal` / number-with-sentinel field in the codebase, classifying each as: (a) value-only, (b) value-or-unset, (c) computed-only. Drives the wire-type design in Phase 1b.
```

Insert immediately after:
```
8. `parity/context-worksheets/` — one file per sub-PR identified in §8.4. Each lists exact files an agent must load. Template at `parity/context-worksheets/_template.md`; conventions in the directory README.
9. `src/connectors/web/routes/status.ts` — `GET /api/status` returning `{ ok, version, uptimeSeconds, ffiLoaded }`. Wire into `web-plugin.ts` route mount. Smoke test asserts the §3.4 release gate passes against the current TS-only build. `ffiLoaded` is `false` until Phase 4f.
10. `TODO.md` entries with `[snapshot-durability]` tag for each gap in §6.4.1; `[migration-deferred]` tag for each TODO row in §6.13 that ports as-is; `[v4-revisit]` tag for LeverUp; `[migration-known]` tag for `UNSET_LONG` precision caveat.
```

- [ ] **Step 3: Verify**

Run: `grep -n "^8\\. \`parity/context-worksheets\|^9\\. \`src/connectors/web/routes/status\|^10\\. \`TODO.md\` entries" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: three matches.

### Task D8: Apply Phase 1a amendment (decoder coupling)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 1a

- [ ] **Step 1: Find Phase 1a "Cutover gate" line**

Run: `grep -n "Cutover gate.*purely mechanical refactor" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 326.

- [ ] **Step 2: Add three new bullet points to Phase 1a deliverables**

Find the line `4. **No callers change.**` in Phase 1a deliverables (around line 315).

Insert after deliverable 4:

```
5. **Acknowledge decoder→DTO coupling.** `decoder/execution.ts:43,89,140,157`, `decoder/account.ts:47,103,220,325`, `decoder/contract.ts:116,181` all do `new Contract()` / `new Execution()` / `new ContractDetails()`. So `ibkr-client` takes a **value-level** dep on `ibkr-types` (not type-only). Document explicitly in the package READMEs.
6. **Move `order-decoder.ts`** from `packages/ibkr/src/order-decoder.ts` into `packages/ibkr-client/src/decoder/order.ts`. v3's "mechanical" framing missed this file.
7. **Decision recorded:** `Order` / `Contract` / `ContractDetails` / `ContractDescription` stay as classes (not interfaces) — the decoder constructs and mutates them imperatively. Refactor to interfaces is a separate non-mechanical change, out of scope for Phase 1a.
```

- [ ] **Step 3: Update the Phase 1a "Cutover gate" line**

Find:
```
**Cutover gate:** none — purely mechanical refactor.
```

Replace with:
```
**Cutover gate:** none. **Note:** the refactor is *conceptually* a split but not *mechanically* clean — see Deliverable 5 for the decoder coupling acknowledgement.
```

- [ ] **Step 4: Verify**

Run: `grep -n "decoder→DTO coupling\|conceptually" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: two matches.

### Task D9: Apply Phase 1b amendment (UNSET_LONG caveat)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 1b deliverables

- [ ] **Step 1: Find Phase 1b deliverable list end**

Find the Phase 1b deliverable 4 (around line 367):
```
4. **`TradingGit` continues to use the legacy hashing path on the live route.** Wire types are added but unused on the live path until Phase 2.
```

- [ ] **Step 2: Add deliverable 5**

Insert after deliverable 4:

```
5. **`UNSET_LONG` precision fixture.** `packages/ibkr/src/const.ts:12` defines `UNSET_LONG = BigInt(2 ** 63) - 1n`. The `2 ** 63` is computed as a JS Number, exceeding `Number.MAX_SAFE_INTEGER` and rounding. If any IBKR field maps to Rust `i64`, the wire-type design must reconstruct `i64::MAX` canonically (not from the lossy TS source). Phase 1b adds a fixture asserting exact `i64::MAX` round-trip for any such field. See §6.1 caveats.
```

- [ ] **Step 3: Verify**

Run: `grep -n "UNSET_LONG.*precision fixture" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D10: Apply Phase 2 amendment (4 timestamp sites)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 2 deliverable 3

- [ ] **Step 1: Find Phase 2 deliverable 3**

Run: `grep -n "fixes the latent bug where" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 493.

- [ ] **Step 2: Replace deliverable 3 paragraph**

Find:
```
3. **`TradingGit.commit()` writes both:** picks `hashInputTimestamp = new Date().toISOString()`, computes v2 hash, **persists `hashInputTimestamp` on the resulting commit**, sets `hashVersion: 2`. **`push()` uses the timestamp captured at `commit()`, not a new one** — fixes the latent bug where [TradingGit.ts:69](../src/domain/trading/git/TradingGit.ts:69) and [TradingGit.ts:124](../src/domain/trading/git/TradingGit.ts:124) used different timestamps.
```

Replace with:
```
3. **`hashInputTimestamp` captured at intent site, reused by every downstream write of the same commit.** v3 said "fix at commit/push"; the desync also exists at `reject()` ([TradingGit.ts:172](../src/domain/trading/git/TradingGit.ts:172)) and `sync()` ([TradingGit.ts:386, :404](../src/domain/trading/git/TradingGit.ts:386)). v4 fixes **all four** sites:
   - `commit()` ([TradingGit.ts:69](../src/domain/trading/git/TradingGit.ts:69)) — picks `hashInputTimestamp = new Date().toISOString()`, computes v2 hash, **persists `hashInputTimestamp` on the resulting commit**, sets `hashVersion: 2`.
   - `push()` ([TradingGit.ts:124](../src/domain/trading/git/TradingGit.ts:124)) — uses the timestamp captured at `commit()`, not a new one.
   - `reject()` ([TradingGit.ts:172](../src/domain/trading/git/TradingGit.ts:172)) — captures its own `hashInputTimestamp` at the rejection-intent moment; downstream persistence reuses it.
   - `sync()` ([TradingGit.ts:386, :404](../src/domain/trading/git/TradingGit.ts:386)) — same pattern.
   Fixtures cover all four sites for timestamp consistency.
```

- [ ] **Step 3: Verify**

Run: `grep -n "all four\|reject()\\|sync()" docs/RUST_MIGRATION_PLAN.v4.md | head -10`
Expected: matches showing the 4-site framing.

### Task D11: Apply Phase 3 amendments (callbacks + rehydration + v1-hash framing)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 3 deliverable 6 + new note

- [ ] **Step 1: Find Phase 3 deliverable 6 (typed napi surface)**

Run: `grep -n "Typed napi surface.*lib.rs" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 683.

- [ ] **Step 2: Add a paragraph to deliverable 6 about the FFI callback contract**

Find the closing of deliverable 6 (the `Generated index.d.ts checked into repo; CI fails on drift.` line, around line 699).

Insert immediately after that line:

```

   **FFI callback contract.** `TradingGitConfig` carries three callbacks the constructor accepts ([interfaces.ts:55-59](../src/domain/trading/git/interfaces.ts:55)): `executeOperation: (op) => Promise<unknown>` (broker dispatcher), `getGitState: () => Promise<GitState>` (broker state pull), `onCommit?: (state) => Promise<void>` (persistence hook). v4 chooses **Option A**: orchestrate push/commit in Rust; the three callbacks become typed napi method signatures (`broker_execute_operation`, `broker_get_state`, `commit_persisted_notify`). Rust calls TS only via these three. (Option B — orchestrate in TS, Rust holds only data — was rejected for FFI chatter.)
```

- [ ] **Step 3: Add the rehydration clarification**

Find the line `8. CI: \`.github/workflows/parity.yml\` diffs \`parity/run-ts\` and \`parity/run-rust\` outputs.` (deliverable 8, around line 703).

Insert a new deliverable 9 immediately before the closing `**DoD:**` line:

```
9. **Rehydration belongs in TS.** `Order` rehydration in `_rehydrateOperation` ([TradingGit.ts:312-371](../src/domain/trading/git/TradingGit.ts:312)) is broker-shape-aware (Decimal field-by-field rewrap of IBKR `Order`). Rust ports the rehydration logic as `WireOrder → WireOrder` round-trip; broker-class rehydration (`new Order()` + `Decimal(...)` field rewrap) belongs in the TS proxy layer (Phase 4f), not in Rust.
```

- [ ] **Step 4: Verify**

Run: `grep -n "FFI callback contract\|Rehydration belongs in TS" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: two matches.

### Task D12: Apply Phase 4b amendments (3 new deliverables)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 4b

- [ ] **Step 1: Find Phase 4b deliverable 4 (TS-side BrokerError reconstruction)**

Run: `grep -n "TS-side.*BrokerError.*reconstruction.*RustUtaProxy" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 823.

- [ ] **Step 2: Find the end of deliverable 4 (after the `Test asserts` line)**

Run: `grep -n "Test asserts.*err instanceof BrokerError" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 834.

- [ ] **Step 3: Insert deliverables 5, 6, 7, 8 after deliverable 4**

After the line `Test asserts \`err instanceof BrokerError === true\` after FFI crossing.` (the closing line of deliverable 4), insert:

```

5. **Port `BrokerError.classifyMessage()`** ([brokers/types.ts:45-59](../src/domain/trading/brokers/types.ts:45)). Regex-based error-message classifier (network-timeout, auth-rejected, etc.) called by today's broker impls to populate `code`. Replicate verbatim in Rust with fixture coverage; revisit cleanup post-Phase-7.

6. **Rationalize offline-push error shape.** `UnifiedTradingAccount.push()` ([:421-431](../src/domain/trading/UnifiedTradingAccount.ts:421)) throws plain `Error`, not `BrokerError`, when `_disabled` or `health === 'offline'`. Rust port throws `BrokerError(CONFIG, "account disabled", permanent: true)` and `BrokerError(NETWORK, "account offline", permanent: false)` respectively. Mirror the change in TS in the same PR.

7. **MockBroker port preserves five behaviors as explicit parity assertions** (not "behavioral parity" hand-wave): deterministic order ID counter; exact avg-cost recalc semantics including the "flipped position simplification" at [MockBroker.ts:527-529](../src/domain/trading/brokers/mock/MockBroker.ts:527); fail-injection machinery (`setFailMode`); call-log shape (`_callLog` / `calls()` / `callCount()` / `lastCall()`); failure-mode triggering of health transitions.

8. **`BrokerCapabilities` extension point on the `Broker` trait** (forward-compat for §4.4). Trait carries `fn capabilities(&self) -> BrokerCapabilities` returning `{ closeMode: { partial | wholePosition }, orderTypes: bitflags, signingScheme: { none | eip712 | ... } }`. Default impl returns `{ partial, market | limit | stop | bracket, none }` — current brokers (IBKR, Alpaca, Mock) satisfy the default and don't override. If §4.4 ever flips, LeverUp overrides; no trait-shape rework. No behavior change in Phase 4b.
```

- [ ] **Step 4: Verify**

Run: `grep -n "classifyMessage\|MockBroker port preserves\|BrokerCapabilities extension" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: three matches.

### Task D13: Apply Phase 4c amendment (per-op pre-fetch fix)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 4c deliverables

- [ ] **Step 1: Find Phase 4c deliverable 2**

Run: `grep -n "GuardPipeline::wrap.*matching TS factory" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 855.

- [ ] **Step 2: Replace the deliverable 2 line**

Find:
```
2. `GuardPipeline::wrap(dispatcher, broker, guards)` matching TS factory at [guard-pipeline.ts:13](../src/domain/trading/guards/guard-pipeline.ts:13). Pre-fetches `[positions, account]` outside the loop, identical to TS.
```

Replace with:
```
2. `create_guard_pipeline(dispatcher, broker, guards)` matching TS factory at [guard-pipeline.ts:13-37](../src/domain/trading/guards/guard-pipeline.ts:13). The TS function is `createGuardPipeline` (no class). **Pre-fetch is per-op, not per-push** — `[positions, account]` is fetched inside the returned `async (op)` closure. Rust port matches per-op timing. **Do NOT optimize to per-push** during the port — it would silently change guard semantics if a guard depends on positions changing between ops.
```

- [ ] **Step 3: Add deliverable 4 (parity test)**

Find the existing Phase 4c deliverable 3:
```
3. Parity fixtures + checker.
```

Insert deliverable 4 after it:
```
4. **Per-op pre-fetch parity test.** A 5-op push verifies `[positions, account]` is fetched **5 times** (not 1). Asserts on the broker mock's call log.
```

- [ ] **Step 4: Verify**

Run: `grep -n "create_guard_pipeline\|Per-op pre-fetch parity" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: two matches.

### Task D14: Apply Phase 4d amendments (3 new deliverables)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 4d

- [ ] **Step 1: Find Phase 4d deliverable 4 (integration test)**

Run: `grep -n "Integration test:.*full Mock-backed UTA lifecycle" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 907.

- [ ] **Step 2: Insert deliverables 5, 6, 7 after deliverable 4**

After the line `4. Integration test: full Mock-backed UTA lifecycle via the actor.` insert:

```

5. **Snapshot trigger swap.** `UnifiedTradingAccount.ts:429` calls `Promise.resolve(this._onPostPush?.(this.id)).catch(() => {})` directly after `git.push()` — **inline callback, not event-based**. v4 deliverable: remove `setSnapshotHooks` from `UTAManager` ([uta-manager.ts:103-104](../src/domain/trading/uta-manager.ts:103)); snapshot service subscribes to `commit.notify` from EventLog instead. Cross-reference §6.4.1 for the durability-asymmetry note. Atomicity test: assert no missed snapshot during the swap window.

6. **Runtime UTA add/remove via HTTP.** Per-UTA actor lifecycle handlers: `spawn(account_config) -> UtaHandle`; `teardown(uta_id) -> ()` drains the mpsc, joins the tokio task, releases tsfn. **Round-trip integration test: 100 cycles of spawn → command → teardown without resource leak** (file descriptors, tokio tasks, tsfn handles). Driven from existing HTTP routes: `PUT /uta/:id` ([trading-config.ts:74](../src/connectors/web/routes/trading-config.ts:74)), `DELETE /uta/:id` ([:119](../src/connectors/web/routes/trading-config.ts:119)), `POST /uta/:id/reconnect` ([trading.ts:204](../src/connectors/web/routes/trading.ts:204)).

7. **Reconnect ownership matrix wiring** (cross-reference §6.5.1). For Rust-backed UTAs, recovery loop runs in the actor; emits `account.health` via the bounded mpsc channel. tsfn re-registration on `reconnectUTA` recreate. Phase 4d parity test: TS-CCXT and Rust-Mock produce equivalent `account.health` event sequences for an identical disconnect scenario.
```

- [ ] **Step 3: Verify**

Run: `grep -n "Snapshot trigger swap\|Runtime UTA add/remove via HTTP\|Reconnect ownership matrix wiring" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: three matches.

### Task D15: Apply Phase 4f amendments (3 new deliverables)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 4f

- [ ] **Step 1: Find Phase 4f deliverable 5**

Run: `grep -n "Mock-broker e2e via the proxy" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1075.

- [ ] **Step 2: Insert deliverables 6, 7, 8 after deliverable 5**

After the line `5. Mock-broker e2e via the proxy, end-to-end through the Web UI.` insert:

```

6. **`commit.notify` schema registration.** `commit.notify` is a **net-new event** (zero hits in current `src/`). v4 registers `commit.notify` and any other Rust-emitted trading event in `AgentEventMap` ([src/core/agent-event.ts:91-103](../src/core/agent-event.ts:91)) with TypeBox schemas. Reconcile per-UTA monotonic Rust seq with EventLog's global seq ([event-log.ts:136-138](../src/core/event-log.ts:136)) — separate counters; the proxy emits both.

7. **Telegram smoke test.** [telegram-plugin.ts:111-194](../src/connectors/telegram/telegram-plugin.ts:111) calls `uta.push()` ([:163](../src/connectors/telegram/telegram-plugin.ts:163)) and `uta.reject()` ([:166](../src/connectors/telegram/telegram-plugin.ts:166)) on `bot.command('trading')` callbacks. Phase 4f DoD: a `/trading` command flow round-trips through `RustUtaProxy` end-to-end within ≤10s (Telegram callback timeout).

8. **Rust panic injection test** (`parity/check-rust-panic.ts`). Inject a panic into the Mock broker's place_order; verify TS-side error shape (`code === 'RUST_PANIC'`), recovery (UTA marked offline → respawn), and that other UTAs are unaffected.
```

- [ ] **Step 3: Verify**

Run: `grep -n "commit.notify.*schema registration\|Telegram smoke test\|Rust panic injection" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: three matches.

### Task D16: Apply Phase 5 amendment (LeverUp not in scope note)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` Phase 5

- [ ] **Step 1: Find Phase 5 deliverable 4 (decision document)**

Run: `grep -n "Decision document.*docs/migration-broker-decision" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1114.

- [ ] **Step 2: Add a note after deliverable 4**

Find the end of deliverable 4 (the line `State 2: neither endorsed → migration ends at Phase 7. Rust core ships; brokers stay TS forever. **This is an acceptable, first-class outcome.**`).

Insert a new paragraph after deliverable 4 (before `**DoD:**`):

```

   **LeverUp not in scope** for Phase 5 spike (per [v4 open decisions](../docs/superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-1) — stay TS until LeverUp's TS impl stabilizes). The decision document records this; revisit post-Phase-7.
```

- [ ] **Step 3: Verify**

Run: `grep -n "LeverUp not in scope" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D17: Apply §6.1 amendment (UNSET_LONG caveat)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §6.1

- [ ] **Step 1: Find §6.1 closing**

Run: `grep -n "Adversarial cases.*1e30, 1e-30" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1197.

- [ ] **Step 2: Append a paragraph to §6.1**

After the line ending `... `Infinity` (must throw).` insert a new paragraph:

```

**`UNSET_LONG` JS precision caveat.** [packages/ibkr/src/const.ts:12](../packages/ibkr/src/const.ts:12) defines `UNSET_LONG = BigInt(2 ** 63) - 1n`. The `2 ** 63` is computed as a JS Number, exceeds `Number.MAX_SAFE_INTEGER`, and rounds. The `BigInt(...)` then wraps the rounded value, so `UNSET_LONG` is **not** exactly `i64::MAX`. If any IBKR field maps to Rust `i64` in the wire-type design, the Rust side reconstructs `i64::MAX` from the canonical wire form, not from the lossy TS source. Phase 1b adds a fixture asserting exact `i64::MAX` round-trip.
```

- [ ] **Step 3: Verify**

Run: `grep -n "UNSET_LONG.*JS precision caveat" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D18: Apply §6.2 amendment (v1 hash provenance)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §6.2

- [ ] **Step 1: Find §6.2 v1 commits line**

Run: `grep -n "v1 commits.*everything currently on disk" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1201.

- [ ] **Step 2: Replace the v1 line with an expanded paragraph**

Find:
```
- **v1 commits** (everything currently on disk): `hash` is opaque. Never recomputed.
```

Replace with:
```
- **v1 commits** (everything currently on disk): `hash` is opaque. Never recomputed. **v1 hash provenance:** verified at [TradingGit.ts:33-38, :70-75](../src/domain/trading/git/TradingGit.ts:33), the v1 commit hash is `sha256(JSON.stringify({ message, operations, timestamp, parentHash })).slice(0, 8)`. The `JSON.stringify` output depends on JS class iteration order (e.g., `Order`, `Contract`) and decimal.js `.toString()` choices. There is no key-sort, no normalization, no stable encoding. **v1 hashes are change-detection tokens, not content addresses.** A Rust impl cannot reproduce them and will not try. Loaders preserve v1 verbatim (`PersistedCommit::V1Opaque`); display them; never re-hash.
```

- [ ] **Step 3: Verify**

Run: `grep -n "change-detection tokens, not content addresses" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D19: Apply §6.4 amendment (asymmetry note) + insert §6.4.1

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §6.4 + new §6.4.1

- [ ] **Step 1: Find the §6.4 atomic-write code block end**

Run: `grep -n "Missing-snapshot reconciler.*closes the gap" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1253.

- [ ] **Step 2: Insert asymmetry note before "Missing-snapshot reconciler"**

Find the line:
```
**Missing-snapshot reconciler** (closes the gap noted by v2 review — there is no reconciler in the current code, so v3 ships one as a Phase 4d deliverable):
```

Insert immediately before it (with a blank line separator):

```

**Asymmetry note.** The atomic-write recipe applies to Rust-owned `commit.json` only. The TS-side snapshot writer ([src/domain/trading/snapshot/store.ts](../src/domain/trading/snapshot/store.ts)) is **not** upgraded as part of this migration. Snapshot writes use `appendFile` for chunks (non-atomic) and lack `fsync` on file or parent dir. The missing-snapshot reconciler closes one gap; §6.4.1 enumerates the gaps it leaves. The asymmetry is acknowledged, not unintentional — fixing it is out of scope, tracked separately.

```

- [ ] **Step 3: Find §6.5 header for §6.4.1 insertion**

Run: `grep -n "^### 6.5 " docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1273.

- [ ] **Step 4: Insert §6.4.1 between §6.4 and §6.5**

Find:
```
After commit persistence succeeds, the actor emits `commit.notify` to TS for snapshot/UI consumption. **TS never gates push success on its own write.**

### 6.5 Per-UTA serialization (P7)
```

Insert §6.4.1 between them:

```
After commit persistence succeeds, the actor emits `commit.notify` to TS for snapshot/UI consumption. **TS never gates push success on its own write.**

### 6.4.1 Snapshot durability gaps

Three gaps the missing-snapshot reconciler does **not** close, all in `src/domain/trading/snapshot/store.ts`:

1. **Non-atomic chunk append** ([store.ts:83](../src/domain/trading/snapshot/store.ts:83)). Raw `appendFile` for snapshot chunks. A crash mid-write produces a chunk file with a partial last line. The reconciler scans index entries and counts on `chunk.count` — corrupted last lines are invisible until `readRange` parses and throws.
2. **No `fsync`** ([store.ts:51-56](../src/domain/trading/snapshot/store.ts:51)). Snapshot writes do `rename(tmp, indexPath)` without fsync of the file or parent dir.
3. **Index/chunk write inconsistency** ([store.ts:83-84](../src/domain/trading/snapshot/store.ts:83)). `doAppend` writes the chunk first then updates the index. A crash between them: chunk has the snapshot, index doesn't. Reconciler thinks the snapshot is missing and triggers a **second** snapshot for the same commit hash — duplicate entries.

**Mitigations not adopted in this migration** (logged in `TODO.md` with `[snapshot-durability]` during Phase 0):

- Chunk append over fsync'd write+rename pairs
- Transactional `index+chunk` write via two-phase rename
- Reconciler duplicate-detection step

The migration ships the missing-snapshot reconciler (Phase 4d) and accepts the three gaps above.

### 6.5 Per-UTA serialization (P7)
```

- [ ] **Step 5: Verify**

Run: `grep -n "^### 6.4.1 Snapshot\|Asymmetry note.*atomic-write recipe" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: two matches.

### Task D20: Insert §6.5.1 (reconnect ownership matrix)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` between §6.5 and §6.6

- [ ] **Step 1: Find §6.6 header**

Run: `grep -n "^### 6.6 Typed FFI" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

- [ ] **Step 2: Insert §6.5.1 before §6.6**

Find the line `### 6.6 Typed FFI surface (P10)` (around line 1283). Insert before it:

```
### 6.5.1 Reconnect ownership matrix

Today, reconnect lives in two places:

- **UTA-level auto-recovery** ([UnifiedTradingAccount.ts:296-328](../src/domain/trading/UnifiedTradingAccount.ts:296)). Exponential backoff 5s → 60s, broker-agnostic. Calls `broker.init()` + `broker.getAccount()` to test.
- **`UTAManager.reconnectUTA`** ([uta-manager.ts:111-151](../src/domain/trading/uta-manager.ts:111)). Reads fresh config and **recreates** the UTA — full re-instantiation, not just reconnection. Re-registers CCXT provider tools.

Brokers (`CcxtBroker`, `AlpacaBroker`, `IbkrBroker`) have no reconnect logic of their own — they expose only `init()` / `close()`.

**After migration:**

| Broker | Recovery loop owner | Triggered by | Health emitter |
|---|---|---|---|
| CCXT | TS UTA actor (Phase 4a retrofit) | `_scheduleRecoveryAttempt` | TS `eventLog.append('account.health', …)` |
| IBKR (Rust path, post-Phase 6.ibkr) | Rust UTA actor (Phase 4d) | Same algorithm, ported | Rust mpsc → TS `EventLog` via `commit.notify`-channel |
| IBKR (TS fallback path) | TS UTA actor (Phase 4a retrofit) | Same | TS |
| Alpaca (Rust path, post-Phase 6.alpaca) | Rust UTA actor | Same | Rust mpsc |
| Alpaca (TS fallback path) | TS UTA actor | Same | TS |
| Mock | Same as broker family running it | | |

**Risk:** divergence between TS and Rust recovery-loop semantics (back-off intervals, jitter, `_disabled` semantics for permanent errors). **Mitigation:** Phase 4d parity test asserts TS-CCXT and Rust-Mock produce equivalent `account.health` event sequences for an identical disconnect scenario. Phase 4f extends to real-broker Mock paths.

**Actor lifecycle on reconnect.** `UTAManager.reconnectUTA` recreates the UTA. For Rust-backed UTAs: drain the old actor's mpsc → join the tokio task → unregister tsfn → spawn new actor → register new tsfn. **Phase 4d** integration test covers the lifecycle (spawn/teardown 100 cycles); **Phase 4f** integration test covers reconnect via the proxy (tsfn re-registration + EventLog re-subscription).

```

- [ ] **Step 3: Verify**

Run: `grep -n "^### 6.5.1 Reconnect ownership" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D21: Apply §6.10 amendment (tradingCore is new namespace)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §6.10

- [ ] **Step 1: Find §6.10 opening**

Run: `grep -n "^### 6.10 Feature-flag config" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

- [ ] **Step 2: Insert clarifying paragraph at the start of §6.10**

Find the line right after `### 6.10 Feature-flag config (structured)` (the next non-empty line should be `\`data/config/trading-core.json\`:`).

Insert immediately after the heading:

```

**`tradingCore` is a new config namespace.** v3 implies (line 1343) `ccxt: 'ts'` is "literal-pinned at the Zod schema level," which reads as if an existing flag is being constrained. Verified at [src/core/config.ts](../src/core/config.ts): there is **no** existing `tradingCore` namespace; zero references to `defaultBrokerImpl`. The Phase 4f deliverable introduces this namespace; Zod literal-pinning is on the **new** schema. Account-level `brokerImpl` override is also new; `accounts.json` schema needs the field added in Phase 4f. The `panicDisableThreshold` setting (§6.12.1) lives in this namespace too.

```

- [ ] **Step 3: Verify**

Run: `grep -n "tradingCore.*new config namespace" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D22: Insert §6.12.1 (Rust panic policy)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` between §6.12 and §6.13

- [ ] **Step 1: Find §6.13 header (the v3 mixed-version commit log loader)**

Run: `grep -n "^### 6.13 Mixed-version commit log loader" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1384.

- [ ] **Step 2: Renumber the existing §6.13 to §6.17**

Find:
```
### 6.13 Mixed-version commit log loader
```

Replace with:
```
### 6.17 Mixed-version commit log loader
```

- [ ] **Step 3: Insert §6.12.1, §6.13 (new), §6.14, §6.15, §6.16 before §6.17**

Find the line `### 6.17 Mixed-version commit log loader` (just renamed). Insert all of §6.12.1, §6.13, §6.14, §6.15, §6.16 immediately before it:

```
### 6.12.1 Rust panic policy (P13 enforcement)

- **Boundary.** Every `#[napi]`-exported method body is wrapped in `std::panic::catch_unwind`. The wrapper converts panic payloads to typed `napi::Error` with `code = "RUST_PANIC"` and `message = <panic message + backtrace>`.
- **`ThreadsafeFunction` callbacks.** `tsfn.call` itself does not unwind into the Node thread. Panics inside the Rust task that **produces** events go through the same `catch_unwind` wrapper; on panic, the actor emits a synthetic `account.health` event with `state: 'offline'`, `reason: 'rust_panic'`, then exits cleanly.
- **TS handling.** `RustUtaProxy` catches `code === 'RUST_PANIC'` errors and (a) logs a structured event, (b) marks the UTA offline via the same path as `BrokerError(NETWORK)`, (c) schedules a recovery attempt that respawns the actor. **No process abort.**
- **Test.** Phase 4f DoD adds `parity/check-rust-panic.ts` — inject a panic into the Mock broker, verify TS-side error shape, recovery, and that other UTAs are unaffected.
- **Panic dedup.** After N consecutive `RUST_PANIC` errors on the same UTA, mark it `disabled` and require manual `reconnectUTA`. Default `N = 5`; configurable via `tradingCore.panicDisableThreshold`. Locked in [v4 open decisions](../docs/superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-4).

### 6.13 Pre-existing TODO.md triage

Each `TODO.md` item below overlaps with the Rust migration. Per-item fate:

| TODO entry (line) | Migration touches | Decision |
|---|---|---|
| Trading git staging area lost on restart (88-93) | Phase 3, Phase 4d | **Port-as-is.** Preserves parity. Fix in a separate post-migration PR. Document in Phase 3 PR body with `[migration-deferred]` tag. (Decision locked in [v4 open decisions](../docs/superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-2).) |
| Cooldown guard state lost on restart (80-86) | Phase 4c | **Port-as-is.** Same rationale. `[migration-deferred]` tag. |
| Snapshot/FX numbers wildly wrong (60-69) | Snapshot stays TS | **Out of scope.** Migration does not fix; TODO entry stays open. |
| OKX UTA spot-holding fix needs live confirmation (95-102) | CCXT stays TS | **Out of scope.** Note in Phase 5 spike: CCXT is not exercised by parity work. |
| Heartbeat dedup window lost on restart (71-78) | Out of trading scope | **Out of scope.** Listed for completeness. |
| LeverUp items (232-257) | Phase 4b Broker trait, §4.4 | **Stay TS** (decision 1). Phase 4b adds `BrokerCapabilities` extension point so a future Rust port doesn't require trait-shape rework. |

**Principle:** the migration preserves existing behavior including known bugs; fixes ride in separate PRs after Phase 7. P4 ("one concept per phase") would be violated by fix-during-port.

### 6.14 Tool-surface contract

`src/tool/trading.ts` exposes 16 tools that call UTA methods directly via `manager.resolve()` / `manager.resolveOne()` — no abstraction layer. v4 enumerates the contract `RustUtaProxy` must honor:

| Tool | UTA method(s) | Sync requirement | Notes |
|---|---|---|---|
| `searchContracts` ([:121-130](../src/tool/trading.ts:121)) | `uta.searchContracts` | async OK | UTAManager-level today |
| `getAccount` ([:165-173](../src/tool/trading.ts:165)) | `uta.getAccount` | async OK | |
| `getPortfolio` ([:184-235](../src/tool/trading.ts:184)) | `uta.getPositions` + `uta.getAccount` (back-to-back) | **interleaving hazard** | P7 protects within one mpsc round-trip, not between two |
| `getOrders` ([:249-271](../src/tool/trading.ts:249)) | `uta.getOrders` (`Promise.all` across UTAs) | latency-sensitive | FFI overhead × N accounts |
| `getQuote` ([:282-291](../src/tool/trading.ts:282)) | `uta.getQuote` | async OK | |
| `tradingLog` ([:319-327](../src/tool/trading.ts:319)) | `uta.gitLog` | async OK | |
| `tradingShow` ([:333-339](../src/tool/trading.ts:333)) | `uta.show(hash)` on every UTA | sync-style scan | Async-message proxy can satisfy if `show` is keyed by hash and returns immediately |
| `tradingStatus` ([:346-349](../src/tool/trading.ts:346)) | `uta.status` | async OK | Telegram also calls this |
| `simulatePriceChange` ([:362-367](../src/tool/trading.ts:362)) | `uta.simulatePriceChange` | async OK | |
| `tradingStagePlaceOrder` ([:410](../src/tool/trading.ts:410)) | `uta.stagePlaceOrder` | async OK | |
| `tradingStageCancelOrder` ([:427](../src/tool/trading.ts:427)) | `uta.stageCancelOrder` | async OK | |
| `tradingStageReplaceOrder` ([:438](../src/tool/trading.ts:438)) | `uta.stageReplaceOrder` | async OK | |
| `tradingStageClosePosition` ([:447](../src/tool/trading.ts:447)) | `uta.stageClosePosition` | async OK | |
| `tradingCommit` ([:457-465](../src/tool/trading.ts:457)) | `uta.commit` per UTA, no source = all UTAs | best-effort sequential | See §6.15 |
| `tradingPush` ([:473-493](../src/tool/trading.ts:473)) | `uta.push` per UTA | latency-sensitive | Telegram also calls this |
| `tradingSync` ([:503-512](../src/tool/trading.ts:503)) | `uta.sync` | async OK | |

**Latency budget.** `RustUtaProxy` round-trip target: ≤5 ms per call on Mock. Phase 4f parity test asserts `Promise.all([5 UTAs].map(u => u.getOrders()))` completes in ≤50 ms.

**Interleaving hazard.** `getPortfolio` does back-to-back `uta.getPositions()` + `uta.getAccount()` ([:190-191](../src/tool/trading.ts:190)) expecting consistent state. Under the actor model, a `commit` from another tool call can interleave between the two `await`s. **v4 accepts current inconsistency** for parity (locked in [v4 open decisions](../docs/superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-3)). A `getPortfolioSnapshot` actor command for atomic reads is reserved for post-migration improvement.

### 6.15 Cross-UTA semantics

Operations spanning multiple UTAs (`tradingCommit` with no source, `getPortfolio`, `getOrders`, `simulatePriceChange`) are **best-effort sequential, not transactional**. If UTA A commits successfully and UTA B fails, the result is a partial-commit state with no rollback.

This is current TS behavior; the migration preserves it. The actor model does **not** change this contract — per-UTA serialization is the only atomicity guarantee. Any future cross-UTA atomicity feature would need a new coordinator above the actors (out of scope).

Documented explicitly so post-migration debugging doesn't blame the actor model.

### 6.16 Connector consumer matrix (P14 enforcement)

| Consumer | Source | UTA touchpoints | Latency budget | Migration test |
|---|---|---|---|---|
| Web UI (REST) | [src/connectors/web/routes/trading.ts](../src/connectors/web/routes/trading.ts) | direct UTA method calls | UI: ≤200 ms p95 | Phase 4f Mock e2e |
| Web UI (SSE / EventLog) | [src/connectors/web/routes/events.ts:124](../src/connectors/web/routes/events.ts:124) | EventLog subscribe | streaming | Phase 4f event-stream parity |
| Telegram (REST-style) | [src/connectors/telegram/telegram-plugin.ts:111-194](../src/connectors/telegram/telegram-plugin.ts:111) | `uta.push` ([:163](../src/connectors/telegram/telegram-plugin.ts:163)), `uta.reject` ([:166](../src/connectors/telegram/telegram-plugin.ts:166)), `uta.status` | ≤10 s (Telegram callback timeout) | **Phase 4f smoke test** |
| MCP-ask | [src/connectors/mcp-ask/mcp-ask-connector.ts:15](../src/connectors/mcp-ask/mcp-ask-connector.ts:15) | none (`capabilities.push: false`) | n/a | n/a |
| Diary | [src/connectors/web/routes/diary.ts:137](../src/connectors/web/routes/diary.ts:137) | EventLog read of `account.health` | n/a | event schema parity |

**Rule:** any future consumer added to this list specifies (1) which UTA methods it calls, (2) latency budget, (3) behavior under FFI backpressure (queue full, panic, timeout). The matrix is the load-bearing artifact for §6.12 / P14.

### 6.17 Mixed-version commit log loader
```

- [ ] **Step 4: Verify all new sections present**

Run: `grep -nE "^### 6\\.(12\\.1|13|14|15|16|17) " docs/RUST_MIGRATION_PLAN.v4.md`
Expected: 6 matches in order: 6.12.1, 6.13, 6.14, 6.15, 6.16, 6.17.

### Task D23: Apply §7 risk register amendment (6 new rows)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §7

- [ ] **Step 1: Find the last row of the risk register**

Run: `grep -n "Mixed-version commit log loader bug" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1434.

- [ ] **Step 2: Append 7 new rows after the last existing row**

Find:
```
| Mixed-version commit log loader bug | Medium | Medium | `parity/check-mixed-log.ts` fuzzes randomly-ordered v1/v2-intent/v2-entry sequences. |
```

Insert immediately after (preserve table format, no blank line between rows):
```
| `commit.notify` event surface invented but not registered in `AgentEventMap` | Medium | Medium | Phase 4f Deliverable 6 registers schema; CI test asserts every Rust-emitted event has a TypeBox schema entry. |
| Snapshot trigger pipeline change drops snapshots in the swap window | Medium | Medium | Phase 4d Deliverable 5 cuts over inline-callback → event-subscription atomically; integration test asserts no missed snapshot during the swap. |
| Runtime UTA add/remove leaks tokio tasks / tsfn handles / file descriptors | Medium | High | Phase 4d Deliverable 6: 100-cycle round-trip integration test (§6.5.1); resource leak check in CI. |
| Reconnect semantics diverge between TS-CCXT and Rust-IBKR/Alpaca recovery loops | Medium | Medium | §6.5.1 parity test asserts equivalent `account.health` event sequence on identical disconnect scenario. |
| Rust panic in single UTA actor JS-throws into unrelated tool's await chain | Low | High | §6.12.1 `catch_unwind` boundary; Phase 4f Deliverable 8 panic injection test. |
| LeverUp broker added to `Broker` trait late, breaks Phase 4b assumptions | Medium | Medium | §4.4 surfaces upfront; Phase 4b Deliverable 8 `BrokerCapabilities` extension point validates against LeverUp's whole-position-close + market-only + EIP-712 quirks. |
| TODO.md "trading-git staging area lost on restart" ports as a known bug; an operator misreads the migration as fixing it | Low | Medium | §6.13 explicitly lists as-is ports; PR body for Phase 3 + 4c calls them out. |
```

- [ ] **Step 3: Verify**

Run: `grep -c "commit.notify event surface invented\|Runtime UTA add/remove leaks\|Rust panic in single UTA actor" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: 3.

### Task D24: Apply §8.4 amendment (tiered context-budget table)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §8.4

- [ ] **Step 1: Find §8.4 opening and content**

Run: `grep -n "^### 8.4 Per-phase context budget" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1478.

- [ ] **Step 2: Replace the §8.4 body**

Find the entire §8.4 content (from `### 8.4 Per-phase context budget` through the line before `## 9. Timeline summary`):

The content to replace is:
```
### 8.4 Per-phase context budget

These fit a single agent context window:
- Phase 0, 1a, 1b, 1c, 2, 2.5, 4a, 4b, 4c, 4f, 5 (each spike), 7.

These need internal sub-PR splits:
- **Phase 3:** (a) decimal types + canonical, (b) `PersistedCommit` + classifier, (c) `TradingGit` state machine, (d) napi typed surface.
- **Phase 4d:** (a) `UtaActor` core + state machine, (b) health + recovery, (c) commit persistence + reconciler.
- **Phase 4e:** (a) `ExecutionJournal` + atomic write, (b) per-broker client-order-ID, (c) restart reconciler + crash test.
- **Phase 6.<broker>:** (a) Rust port behind flag, (b) record/replay harness, (c) nightly live test.

---
```

Replace with:
```
### 8.4 Per-phase context budget

| Phase | Single-agent context fits? | Files an agent must load |
|---|---|---|
| 0 | Yes | `docs/event-system.md`, `CLAUDE.md`, `TODO.md`, `src/domain/trading/*` (read-only inventory) |
| 1a | Yes | `packages/ibkr/src/*` (DTO classes + decoder) |
| 1b | Yes | Phase 1a output + `parity/fixtures/orders-on-wire/`, `parity/decimal-inventory.md` |
| 1c | Yes | Phase 1b adapters + decimal.js docs subset |
| 2 | Yes | `TradingGit.ts` (657 L), `git-persistence.ts` (48 L), Phase 1 deliverables |
| 2.5 | Yes | Phase 2 deliverables + 1 new file |
| 3 (a) decimal + canonical | Yes | decimal.js + bigdecimal docs, canonical formatter spec, Phase 1c source |
| 3 (b) PersistedCommit | Yes | Phase 2 PersistedCommit decoder + V1Opaque shape spec |
| 3 (c) TradingGit state machine | **TIGHT — fresh agent** | `TradingGit.ts` (657 L), `types.ts`, `interfaces.ts`, GitState rehydration logic, parity fixtures |
| 3 (d) napi typed surface | Yes | napi-rs docs subset, Phase 3(c) Rust source |
| 4a | Yes | `UnifiedTradingAccount.ts` (586 L), AsyncQueue ref impl |
| 4b | Yes | `brokers/types.ts`, `MockBroker.ts` (548 L), `brokers/types.ts:45-59` classifyMessage |
| 4c | Yes | `guards/*` (~10 files), `TradingGit.ts:90-130` (push loop context) |
| 4d (a) UtaActor core | **TIGHT — fresh agent** | `UnifiedTradingAccount.ts` (586 L) + Phase 3 + Phase 4a + actor pattern docs |
| 4d (b) health + recovery | Yes | `UnifiedTradingAccount.ts:193-328` (health), Phase 4d(a) source |
| 4d (c) commit persistence + reconciler | **TIGHT — fresh agent** | `git-persistence.ts`, `snapshot/store.ts`, snapshot reconciler logic |
| 4e (a) ExecutionJournal + atomic write | Yes | journal protocol spec + Phase 4d output |
| 4e (b) per-broker client-order-ID | Yes | per-broker client-order-ID specs (IBKR `nextValidId`, Alpaca, etc.) |
| 4e (c) restart reconciler + crash test | Yes | restart reconciler logic + crash test harness |
| 4f | **TIGHT — fresh agent** | EVERYTHING above + napi-rs typed export + `telegram-plugin.ts:111-194` + `AgentEventMap` |
| 5 (each spike) | Yes | broker crate + IBKR/Alpaca proto + journal protocol summary |
| 6.alpaca / 6.ibkr | Multi-agent | sub-PR (a) port, (b) record/replay, (c) live test — separate agents |
| 7 | Yes | rollback script + dogfood checklist |

The "TIGHT — fresh agent" rows mean: a **fresh agent**, not the same agent that did the prior sub-PR. Each phase deliverable PR explicitly states "fresh-agent context required" in the PR body so the orchestrator knows to spawn a new agent.

Phase 0 Deliverable 8 creates the per-sub-PR context worksheet template (`parity/context-worksheets/_template.md`). Sub-PR splits for Phase 3 and Phase 4d follow the rows above; Phase 4e splits per the original v3 sub-PR list (4e (a)/(b)/(c)).

---
```

- [ ] **Step 3: Verify**

Run: `grep -n "TIGHT — fresh agent" docs/RUST_MIGRATION_PLAN.v4.md | wc -l`
Expected: 4 matches (one for each TIGHT row).

### Task D25: Apply §11 amendment (4 new open decisions)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §11

- [ ] **Step 1: Find the §11 last existing decision**

Run: `grep -n "Phase 6 default broker impl" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1543.

- [ ] **Step 2: Replace the §11 intro and append 4 new decisions**

Find the §11 opening:
```
## 11. Open decisions (lock at execution time)

These are explicit calls the maintainer (or executing agent) must record in the PR or `docs/migration-broker-decision.md`:
```

Replace with:
```
## 11. Open decisions (lock at execution time)

These are explicit calls the maintainer (or executing agent) must record in the PR or `docs/migration-broker-decision.md`. **v4 decisions** (1–4) are pre-locked in [docs/superpowers/decisions/2026-05-05-v4-open-decisions.md](superpowers/decisions/2026-05-05-v4-open-decisions.md):
```

Find the line:
```
- [ ] **Phase 6 default broker impl:** the per-broker default in `tradingCore.defaultBrokerImpl` flips from `'ts'` to `'rust'` at Phase 6.<broker>.b. Confirm green-night threshold (default 3 consecutive nights of live tests).
```

Insert immediately after (the existing v3 list ends here — append new rows):

```
- [x] **§4.4 LeverUp scope.** Stay TS until LeverUp's TS impl stabilizes. Revisit post-Phase-7. (See [decision 1](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-1).)
- [x] **§6.13 TODO.md as-is items.** Trading-git staging area + cooldown guard state: port-as-is. (See [decision 2](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-2).)
- [x] **§6.14 interleaving stance.** Accept current `getPortfolio` inconsistency. No `getPortfolioSnapshot` in Phase 4f. (See [decision 3](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-3).)
- [x] **§6.12.1 panic dedup threshold.** N=5 default for `tradingCore.panicDisableThreshold`. (See [decision 4](superpowers/decisions/2026-05-05-v4-open-decisions.md#decision-4).)
```

- [ ] **Step 3: Verify**

Run: `grep -n "v4-open-decisions.md" docs/RUST_MIGRATION_PLAN.v4.md | wc -l`
Expected: at least 5 matches (intro + 4 decisions).

### Task D26: Apply §12 amendment (approval staging update)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` §12

- [ ] **Step 1: Find §12 closing line**

Run: `grep -n "Phase 8.*deferred ≥1 minor release" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match around line 1571.

- [ ] **Step 2: Replace the §12 code block with the v4 version**

Find the entire ```` ``` ```` code block of §12 (from the opening ` ``` ` to the closing ` ``` `, around lines 1551-1572).

Replace with:
```
```
Approve now (mechanical, low-risk):
  Phase 0   — fixtures & inventory + /api/status route + context worksheets [v4 amend]
  Phase 1a  — ibkr-types / ibkr-client split + order-decoder.ts move [v4 amend]
  Phase 1b  — wire types + adapters + UNSET_LONG fixture [v4 amend]
  Phase 1c  — canonical JSON utility [unchanged]
  Phase 2   — hash v2 intent only — fix all FOUR timestamp sites (commit/push/reject/sync) [v4 amend]
  Phase 2.5 — entry hash, default-accepted [unchanged]
  Phase 3   — Rust TradingGit (sub-PRs a/b/c/d), each fresh-agent context where marked [v4 amend]

Require evidence before approval:
  Phase 4a  — TS UTA actor retrofit [unchanged]
  Phase 4b  — Rust Broker trait + Mock + classifyMessage + offline-error rationalization + BrokerCapabilities [v4 amend]
  Phase 4c  — Rust guards + per-op pre-fetch parity test [v4 amend]
  Phase 4d  — Rust UTA actor + persistence + snapshot trigger swap + runtime lifecycle + reconnect parity [v4 amend]
  Phase 4e  — Execution journal + crash-recovery test [unchanged]
  Phase 4f  — RustUtaProxy + bounded event-stream + commit.notify schema + Telegram smoke test + panic test [v4 amend]
  Phase 5   — broker decision point — LeverUp explicitly NOT in scope (decision 1) [v4 amend]
  Phase 6   — broker-by-broker, only after spike report endorsement [unchanged]
  Phase 7   — TS fallback retained, real dogfood + rollback test [unchanged]
  Phase 8   — deferred ≥1 minor release after Phase 7 [unchanged]

New gates introduced by v4 (apply across phases):
  - Reconnect-ownership parity test (§6.5.1) — required for Phase 4d sign-off
  - Rust panic policy test (§6.12.1) — required for Phase 4f sign-off
  - Snapshot durability gap log (§6.4.1) — TODO.md entries created by end of Phase 0
  - Connector consumer matrix (§6.16) — current state documented in Phase 0; updated on every connector change
```
```

(Note: the literal backticks in the replacement use ``` to avoid markdown nesting confusion; when applying the edit, type literal backticks.)

- [ ] **Step 3: Verify**

Run: `grep -n "New gates introduced by v4" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

### Task D27: Add §14 (Changelog from v3) at end of file

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v4.md` end of file

- [ ] **Step 1: Find the end of §13**

Run: `tail -20 docs/RUST_MIGRATION_PLAN.v4.md`
Expected: §13 changelog table ends with a row about "Phase 2.5 default-accepted, between Phase 2 and Phase 3."

- [ ] **Step 2: Append §14 at end of file**

Append at the absolute end of `docs/RUST_MIGRATION_PLAN.v4.md` (preserve trailing newline if any):

```

---

## 14. Changelog from v3

This section mirrors §13's format. Each row records one diff applied from a stress-test review of v3 (commit `c60de33` of the v4 outline).

| # | v3 claim | v4 correction | Verified against |
|---|----------|---------------|------------------|
| 1 | Phase 4c: `GuardPipeline.wrap` "pre-fetches `[positions, account]` outside the loop." | Function is `createGuardPipeline` (no class). Pre-fetch is **per op**, not per push. Rust matches per-op. | `guards/guard-pipeline.ts:13-37`, `TradingGit.ts:100-112` |
| 2 | Phase 2: timestamp desync at `commit()` and `push()`. | Same bug at `reject()` and `sync()`. Fix all four sites. | `TradingGit.ts:69, 124, 172, 386, 404` |
| 3 | §3.4 release gate: `curl -sf http://localhost:3002/api/status`. | `/api/status` did not exist in v3-tree. v4 ships it as Phase 0 Deliverable 9. | `web-plugin.ts:93-114` |
| 4 | `commit.notify` referenced in v3 §6.4 / §1 / §7 / §8 / §11 as if it exists. | Net-new event. v4 Phase 4f Deliverable 6 registers schema in `AgentEventMap` with TypeBox. | `agent-event.ts:91-103, 275`; grep returns zero |
| 5 | §6.10: `ccxt: 'ts'` "literal-pinned at the Zod schema level." | `tradingCore` namespace is net-new. v4 Phase 4f introduces it. | `src/core/config.ts` (no references) |
| 6 | Phase 1a: "purely mechanical refactor." | Decoder constructs DTO classes via `new` and mutates fields. `order-decoder.ts` lives at wrong layer. | `decoder/{execution,account,contract}.ts`; `order-decoder.ts` |
| 7 | §6.4 / Phase 4d: snapshot trigger described as event-based. | Inline callback today (`UnifiedTradingAccount.ts:429`). Actor→TS hop is net-new structural change. | `main.ts:115-119`, `UnifiedTradingAccount.ts:429` |
| 8 | §4.3 / Phase 3: `TradingGit` "ports cleanly." | `TradingGitConfig` carries 3 callbacks tunneling broker surface across FFI. `Order` rehydration is broker-shape-aware. | `interfaces.ts:55-59`, `TradingGit.ts:312-371` |
| 9 | §6.2: v1 hashes are "opaque." | Make explicit: change-detection tokens, not content addresses. Depend on JS class iteration order + decimal.js. | `TradingGit.ts:33-38, 70-75` |
| 10 | Phase 4b: `BrokerError` shape `{code, message, permanent}`. | `class extends Error` with non-trivial `classifyMessage()` regex pipeline. `push()` offline-rejection throws plain `Error`, not `BrokerError`. | `brokers/types.ts:16, 45-59`; `UnifiedTradingAccount.ts:421-431` |
| 11 | §4.2: UTAManager wires {EventLog, ToolCenter, FxService, snapshot hooks, CCXT tools}. | Surface is broader: `getAggregatedEquity`, `searchContracts`/`getContractDetails`, `createGitPersister`, `broker.factory`/`getBrokerPreset`. | `uta-manager.ts:71-330` |
| 12 | §4 / §5: brokers covered are CCXT, Alpaca, IBKR, Mock. | LeverUp absent. v4 §4.4 adds placement; decision: stay TS. Phase 4b Deliverable 8 adds `BrokerCapabilities` for forward-compat. | `TODO.md:232-257` |
| 13 | (Not addressed.) Runtime UTA add/remove via HTTP. | `UTAManager.{initUTA,reconnectUTA,removeUTA,add,remove}` driven from HTTP. v4 Phase 4d Deliverable 6 ships actor lifecycle handlers + 100-cycle test. | `uta-manager.ts:93,111,154,172,179`; HTTP routes |
| 14 | (Not addressed.) Reconnect ownership across the FFI. | New §6.5.1 matrix. TS owns CCXT recovery, Rust owns IBKR/Alpaca recovery post-port. Parity test in Phase 4d. | `UnifiedTradingAccount.ts:296-328`; `uta-manager.ts:111-151` |
| 15 | (Not addressed.) Rust panic policy. | New §6.12.1 + P13. `catch_unwind` boundary; panics → typed JS errors; no process abort. Phase 4f Deliverable 8 panic injection test. Default panic dedup `N=5` (decision 4). | `napi-rs` docs |
| 16 | (Not addressed.) Snapshot durability asymmetry. | New §6.4.1 enumerates 3 gaps the reconciler doesn't close. Out of scope; logged with `[snapshot-durability]` tag. | `snapshot/store.ts:51-56, 83-84, 109-111` |
| 17 | (Not addressed.) Tool-surface contract. | New §6.14 enumerates 16 tools + UTA touchpoints. `getPortfolio` interleaving hazard documented. Latency budget set. | `src/tool/trading.ts:121-512` |
| 18 | (Not addressed.) Cross-UTA atomicity. | New §6.15 documents best-effort sequential as intentional carry-over. | `src/tool/trading.ts:457-465` |
| 19 | (Not addressed.) Connector consumer matrix. | New P14 + §6.16. Telegram observes/mutates trading state directly. Phase 4f Deliverable 7 Telegram smoke test. | `telegram-plugin.ts:111-194` |
| 20 | (Not addressed.) Pre-existing TODO.md items overlap migration. | New §6.13 triages: staging-area + cooldown port-as-is; snapshot/FX out-of-scope; LeverUp into §4.4. | `TODO.md:60-69, 71-78, 80-86, 88-93, 95-102, 232-257` |
| 21 | §8.4: Phases 0–2.5, 4a/4b/4c/4f, 5(spike), 7 "fit a single agent context window." | Optimistic for 3(c), 4d(a), 4d(c), 4f. v4 §8.4 replaces with tiered table marking which sub-PRs need fresh-agent context. | `TradingGit.ts` (657L) + `UnifiedTradingAccount.ts` (586L) |
| 22 | (Not addressed.) `UNSET_LONG = BigInt(2 ** 63) - 1n` JS precision bug. | v4 §6.1 caveats + Phase 1b Deliverable 5 fixture for canonical `i64::MAX` reconstruction. | `packages/ibkr/src/const.ts:12` |
```

- [ ] **Step 3: Verify**

Run: `grep -n "^## 14. Changelog from v3" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: one match.

Run: `grep -c "^| 22 |" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: 1.

### Task D28: Add v3→v4 pointer banner to v3 (so v3 readers know v4 exists)

**Files:**
- Modify: `docs/RUST_MIGRATION_PLAN.v3.md` (top of file only)

- [ ] **Step 1: Insert banner after the title line**

Find line 1: `# OpenAlice — Rust Trading-Core Migration Plan (v3)`

Insert immediately after (before line 2, which is blank):

```

> **⚠️ Superseded by [v4](RUST_MIGRATION_PLAN.v4.md).** This document is preserved as a historical baseline. Open decisions, risk register additions, and 22 stress-test corrections live in v4. See v4 §14 (Changelog from v3) for the diff.

```

- [ ] **Step 2: Verify**

Run: `head -5 docs/RUST_MIGRATION_PLAN.v3.md`
Expected: title line + the new banner visible.

### Task D29: Final spec-coverage scan

**Files:** none (verification only)

- [ ] **Step 1: Verify v4.md has all 22 changelog rows referenced as edits**

Run:
```bash
grep -c "^| [0-9]\+ |" docs/RUST_MIGRATION_PLAN.v4.md
```
Expected: at least 28 (§13 has ~14 rows + §14 has 22 + §7 risk register rows + LeverUp §6.13 row).

- [ ] **Step 2: Verify all new section headers exist**

Run:
```bash
grep -nE "^### (4\\.4|6\\.4\\.1|6\\.5\\.1|6\\.12\\.1|6\\.13|6\\.14|6\\.15|6\\.16|6\\.17|8\\.4) " docs/RUST_MIGRATION_PLAN.v4.md
```
Expected: 10 matches in numerical order (§4.4, §6.4.1, §6.5.1, §6.12.1, §6.13, §6.14, §6.15, §6.16, §6.17, §8.4).

- [ ] **Step 3: Verify P13 + P14 in principles table**

Run: `grep -nE "^\\| P1[34] " docs/RUST_MIGRATION_PLAN.v4.md`
Expected: 2 matches.

- [ ] **Step 4: Verify cross-references resolve**

Run:
```bash
grep -oE "v4-open-decisions.md#decision-[0-9]+" docs/RUST_MIGRATION_PLAN.v4.md | sort -u
```
Expected: 4 unique anchors `#decision-1` through `#decision-4`.

Run:
```bash
ls docs/superpowers/decisions/2026-05-05-v4-open-decisions.md
```
Expected: file exists (created in Phase A).

- [ ] **Step 5: Verify no broken outline-level references**

Run: `grep -n "see Phase 4d Deliverable [0-9]" docs/RUST_MIGRATION_PLAN.v4.md` and `grep -n "see Phase 4f Deliverable [0-9]" docs/RUST_MIGRATION_PLAN.v4.md`
Expected: deliverable references match the deliverable numbers actually present in the corresponding phases.

- [ ] **Step 6: Final word-count check**

Run: `wc -l docs/RUST_MIGRATION_PLAN.v4.md`
Expected: ~1850–1950 lines (v3 was 1596; v4 adds ~250–350 lines of new content).

### Task D30: Commit v4 + the v3 banner

**Files:**
- Stage: `docs/RUST_MIGRATION_PLAN.v4.md`, `docs/RUST_MIGRATION_PLAN.v3.md`

- [ ] **Step 1: Commit**

Run:
```bash
git add docs/RUST_MIGRATION_PLAN.v4.md docs/RUST_MIGRATION_PLAN.v3.md
git commit -m "docs: produce RUST_MIGRATION_PLAN.v4.md from v3 + v4 outline

22 amendments folded in from the stress-test outline at
docs/superpowers/specs/2026-05-05-rust-migration-plan-v4-outline.md
(commit c60de33). Highlights:

- Fix 6 v3 claims that were factually wrong (snapshot trigger
  pipeline, /api/status route, GuardPipeline pre-fetch timing,
  packages/ibkr 'mechanical' split, commit.notify event existence,
  tradingCore config pinning).
- Add 7 new §6 subsections (6.4.1, 6.5.1, 6.12.1, 6.13, 6.14,
  6.15, 6.16) addressing snapshot durability asymmetry, reconnect
  ownership, panic policy, TODO triage, tool-surface contract,
  cross-UTA semantics, connector matrix.
- 2 new principles (P13 panic safety, P14 connector matrix).
- 6 new risk register rows.
- 4 §11 open decisions pre-locked via the decisions doc shipped
  in this PR series.
- §8.4 context-budget claim replaced with a tiered table.

v3 stays as a frozen historical baseline with a v3→v4 pointer
banner. Decisions doc + Phase 0 deliverables (status route +
context-worksheet template + tagged TODO entries) shipped in
prior commits in this series."
```

---

## Self-Review

Performed against the spec.

**Spec coverage:** Every changelog row 1–22 in the v4 outline maps to a task in this plan:
- Rows 1, 5, 17–18 → Tasks D5, D11, D14 (UTAManager surface, BrokerError offline-error, TradingGit callbacks)
- Row 1 (G claim) → Task D13 (Phase 4c per-op fix)
- Row 2 (C timestamps) → Task D10
- Row 3 (release gate) → Tasks B1–B3 + D4
- Row 4 (commit.notify) → Task D15 (Phase 4f Deliverable 6)
- Row 5 (tradingCore) → Task D21
- Row 6 (Phase 1a) → Task D8
- Row 7 (snapshot trigger) → Task D14 (Phase 4d Deliverable 5)
- Row 8 (TradingGit ports cleanly) → Task D11 (Phase 3 callbacks + rehydration)
- Row 9 (v1 hash provenance) → Task D18
- Row 10 (BrokerError class) → Task D12 (Phase 4b Deliverables 5, 6)
- Row 11 (UTAManager wider) → Task D5
- Row 12 (LeverUp) → Tasks D6 + D12 (Deliverable 8) + A1 (decision 1)
- Row 13 (runtime UTA) → Task D14 (Deliverable 6)
- Row 14 (reconnect ownership) → Task D20
- Row 15 (panic policy) → Tasks D3 (P13) + D22 (§6.12.1)
- Row 16 (snapshot durability) → Tasks C2 (TODO.md) + D19 (§6.4.1)
- Row 17 (tool-surface contract) → Task D22 (§6.14)
- Row 18 (cross-UTA atomicity) → Task D22 (§6.15)
- Row 19 (connector matrix) → Tasks D3 (P14) + D22 (§6.16)
- Row 20 (TODO triage) → Task D22 (§6.13)
- Row 21 (context budgets) → Task D24
- Row 22 (UNSET_LONG) → Task D9 (Phase 1b) + D17 (§6.1)

All 4 v4 outline open decisions covered in Task A1.
All 3 Phase 0 deliverables (worksheets, status route, TODO entries) covered in Phases B + C.
Task D28 adds the v3→v4 pointer; Task D29 verifies the final spec coverage.

**Placeholder scan:** No "TBD," "TODO," "fill in," etc. inside instructional steps. The literal string `TODO.md` and the literal `TODO` markdown headings in Task C2 are filename/content references, not placeholders.

**Type / name consistency:** `RustUtaProxy`, `TradingCore`, `commit.notify`, `BrokerCapabilities`, `panicDisableThreshold` are used consistently across tasks. Decision-doc anchors (`#decision-1`..`#decision-4`) are referenced in Task A1 (where they're defined) and Tasks D6, D16, D22, D25 (where they're cited). No drift.

**File-path consistency:** all references use `docs/RUST_MIGRATION_PLAN.v4.md`, `docs/RUST_MIGRATION_PLAN.v3.md`, `docs/superpowers/decisions/2026-05-05-v4-open-decisions.md`, `parity/context-worksheets/...`, and `src/connectors/web/routes/status.ts` — matching the working-directory layout.

---

## Execution notes

- **Phase A**, **Phase B**, **Phase C** are **independent**. Run in parallel if executing via `subagent-driven-development`.
- **Phase D** is **blocked by A** (D6, D16, D22, D25 cite the decisions doc).
- All edits to v4.md preserve v3 line numbers in the *cited references* (e.g., `[TradingGit.ts:69]` stays the same because the source file hasn't changed). The v4.md file's own line numbers will shift as amendments are applied; verification commands use `grep` for content matches, not line numbers.
- After each phase commits, run `pnpm test` + `npx tsc --noEmit` to confirm green tree (Phase B is the only one that touches code; Phases A, C, D are docs-only).
