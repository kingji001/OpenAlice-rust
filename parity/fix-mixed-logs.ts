#!/usr/bin/env tsx
/**
 * One-time repair: recompute intentFullHash for v2 commits in mixed-version-logs
 * using their actual parentHash in that chain context.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'
import { generateIntentHashV2 } from '../src/domain/trading/git/hash-v2.js'
import type { GitExportState } from '../src/domain/trading/git/types.js'

const FIXTURE_DIR = resolve('parity/fixtures/mixed-version-logs')

const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'))
for (const filename of files) {
  const path = resolve(FIXTURE_DIR, filename)
  const state = JSON.parse(readFileSync(path, 'utf-8')) as GitExportState
  let changed = false

  for (const commit of state.commits) {
    if (commit.hashVersion !== 2) continue

    // Rehydrate operations then recompute intentFullHash using actual parentHash in this chain
    const rehydrated = {
      ...commit,
      operations: commit.operations.map(rehydrateOperation),
    }
    const { intentFullHash, shortHash } = generateIntentHashV2({
      parentHash: commit.parentHash,
      message: commit.message,
      operations: rehydrated.operations,
      hashInputTimestamp: commit.hashInputTimestamp!,
    })

    if (intentFullHash !== commit.intentFullHash || shortHash !== commit.hash) {
      console.log(`${filename}: commit ${commit.hash} (parentHash=${commit.parentHash}): recomputing hash`)
      console.log(`  old intentFullHash: ${commit.intentFullHash}`)
      console.log(`  new intentFullHash: ${intentFullHash}`)

      // Update all downstream parentHash references that point to old hash
      const oldHash = commit.hash
      commit.intentFullHash = intentFullHash
      commit.hash = shortHash

      // Fix any downstream commits that reference old hash as parentHash
      for (const other of state.commits) {
        if (other.parentHash === oldHash) {
          other.parentHash = shortHash
        }
      }

      changed = true
    }
  }

  if (changed) {
    // Fix head pointer
    const lastCommit = state.commits[state.commits.length - 1]
    state.head = lastCommit.hash

    writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
    console.log(`Written: ${filename}`)
  } else {
    console.log(`${filename}: no changes needed`)
  }
}
