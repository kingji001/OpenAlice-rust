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
