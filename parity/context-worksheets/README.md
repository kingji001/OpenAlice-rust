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
