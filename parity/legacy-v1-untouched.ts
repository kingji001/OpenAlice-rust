#!/usr/bin/env tsx
/**
 * parity/legacy-v1-untouched.ts
 *
 * For each fixture in parity/fixtures/git-states-v1-frozen/:
 *   - Load
 *   - For each commit: assert classifies as 'v1-opaque'
 *   - For each commit: serializeCommit must equal source verbatim
 *
 * Pins the invariant that v1 commits never get recomputed or
 * re-canonicalized.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  classifyCommit,
  serializeCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import type { GitExportState } from '../src/domain/trading/git/types.js'

const FIXTURE_DIR = resolve('parity/fixtures/git-states-v1-frozen')

async function checkFixture(filename: string): Promise<{ pass: boolean; report: string }> {
  const path = resolve(FIXTURE_DIR, filename)
  const state = JSON.parse(readFileSync(path, 'utf-8')) as GitExportState

  for (const rawCommit of state.commits) {
    const persisted = classifyCommit(rawCommit)
    if (persisted.kind !== 'v1-opaque') {
      return { pass: false, report: `${filename}: commit ${rawCommit.hash} classified as ${persisted.kind}, expected v1-opaque` }
    }
    const serialized = serializeCommit(persisted)
    if (JSON.stringify(serialized) !== JSON.stringify(rawCommit)) {
      return { pass: false, report: `${filename}: v1 commit ${rawCommit.hash} not preserved verbatim` }
    }
  }

  return { pass: true, report: `${filename}: ${state.commits.length} v1 commits, all preserved verbatim` }
}

async function main(): Promise<void> {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('No fixtures in git-states-v1-frozen/')
    return
  }

  let allPass = true
  for (const f of files) {
    const { pass, report } = await checkFixture(f)
    console.log(report)
    if (!pass) allPass = false
  }

  if (!allPass) process.exit(1)
  console.log('\nAll v1-frozen fixtures preserved verbatim.')
}

main().catch((e) => { console.error(e); process.exit(1) })
