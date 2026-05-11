#!/usr/bin/env tsx
/**
 * parity/check-mixed-log.ts
 *
 * For each fixture in parity/fixtures/mixed-version-logs/:
 *   - Load
 *   - For each commit: classify (must be 'v1-opaque' or 'v2')
 *   - For each v2 commit: rehydrate operations, run verifyCommit
 *   - Re-serialize each commit (serializeCommit) → assert deep-equal to source
 *
 * Asserts mixed v1+v2 logs round-trip without losing either form.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'
import {
  classifyCommit,
  serializeCommit,
  verifyCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import type { GitExportState } from '../src/domain/trading/git/types.js'

const FIXTURE_DIR = resolve('parity/fixtures/mixed-version-logs')

async function checkFixture(filename: string): Promise<{ pass: boolean; report: string }> {
  const path = resolve(FIXTURE_DIR, filename)
  const state = JSON.parse(readFileSync(path, 'utf-8')) as GitExportState

  let v1 = 0, v2Verified = 0, mismatches = 0

  for (const rawCommit of state.commits) {
    const rehydrated = {
      ...rawCommit,
      operations: rawCommit.operations.map(rehydrateOperation),
    }
    const persisted = classifyCommit(rehydrated)

    if (persisted.kind === 'v1-opaque') {
      v1++
      const serialized = serializeCommit(persisted)
      if (JSON.stringify(serialized) !== JSON.stringify(rehydrated)) {
        mismatches++
        return { pass: false, report: `${filename}: v1 commit ${rawCommit.hash} round-trip failed` }
      }
    } else {
      const result = verifyCommit(persisted)
      if (result.kind === 'verified') v2Verified++
      else { mismatches++; return { pass: false, report: `${filename}: ${result.message}` } }
    }
  }

  return {
    pass: mismatches === 0,
    report: `${filename}: ${v1} v1 + ${v2Verified} v2 verified, ${mismatches} mismatches`,
  }
}

async function main(): Promise<void> {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('No fixtures in mixed-version-logs/')
    return
  }

  let allPass = true
  for (const f of files) {
    const { pass, report } = await checkFixture(f)
    console.log(report)
    if (!pass) allPass = false
  }

  if (!allPass) process.exit(1)
  console.log('\nAll mixed-version-log fixtures verified.')
}

main().catch((e) => { console.error(e); process.exit(1) })
