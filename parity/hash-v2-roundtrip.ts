#!/usr/bin/env tsx
/**
 * parity/hash-v2-roundtrip.ts
 *
 * For a git-state fixture file: rehydrate operations on each v2 commit,
 * recompute intentFullHash from canonical wire input, assert match with
 * persisted intentFullHash. v1 commits skipped.
 *
 * Usage:
 *   pnpm tsx parity/hash-v2-roundtrip.ts parity/fixtures/git-states/01-single-commit.json
 */

import { readFileSync } from 'node:fs'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'
import {
  classifyCommit,
  verifyCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import type { GitExportState } from '../src/domain/trading/git/types.js'

async function main(): Promise<void> {
  const fixturePath = process.argv[2]
  if (!fixturePath) {
    console.error('Usage: pnpm tsx parity/hash-v2-roundtrip.ts <git-state-fixture>')
    process.exit(2)
  }

  const state = JSON.parse(readFileSync(fixturePath, 'utf-8')) as GitExportState
  let v2Verified = 0
  let v1Skipped = 0
  let mismatches = 0

  for (const rawCommit of state.commits) {
    const commit = {
      ...rawCommit,
      operations: rawCommit.operations.map(rehydrateOperation),
    }
    const persisted = classifyCommit(commit)
    const result = verifyCommit(persisted)
    if (result.kind === 'skipped') {
      v1Skipped++
    } else if (result.kind === 'verified') {
      v2Verified++
    } else {
      mismatches++
      console.error(`MISMATCH ${result.hash}: ${result.message}`)
    }
  }

  console.log(`${fixturePath}: ${v2Verified} v2 verified, ${v1Skipped} v1 skipped, ${mismatches} mismatches`)
  if (mismatches > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
