#!/usr/bin/env tsx
/**
 * scripts/verify-v2-hashes.ts — on-demand v2 hash verifier.
 *
 * Walks data/trading/<accountId>/commit.json files. For each commit:
 *   - v1-opaque: skipped (v1 hashes are change-detection tokens, not
 *     content addresses per v4 §6.2; they don't verify by recomputation)
 *   - v2: recompute intentFullHash from canonical wire input;
 *     compare to persisted; warn or error (--strict)
 *
 * Usage:
 *   pnpm tsx scripts/verify-v2-hashes.ts                # all accounts
 *   pnpm tsx scripts/verify-v2-hashes.ts --account=<id> # one account
 *   pnpm tsx scripts/verify-v2-hashes.ts --strict       # exit 1 on first mismatch
 */

import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadGitState } from '../src/domain/trading/git-persistence.js'
import {
  classifyCommit,
  verifyCommit,
} from '../src/domain/trading/git/persisted-commit.js'
import { rehydrateOperation } from '../src/domain/trading/git/_rehydrate.js'

interface AccountReport {
  accountId: string
  totalCommits: number
  v1Skipped: number
  v2Verified: number
  v2Mismatches: { hash: string; message: string }[]
}

async function verifyAccount(accountId: string, strict: boolean): Promise<AccountReport> {
  const state = await loadGitState(accountId)
  if (state === undefined) {
    return { accountId, totalCommits: 0, v1Skipped: 0, v2Verified: 0, v2Mismatches: [] }
  }
  const report: AccountReport = {
    accountId,
    totalCommits: state.commits.length,
    v1Skipped: 0,
    v2Verified: 0,
    v2Mismatches: [],
  }
  for (const rawCommit of state.commits) {
    const commit = {
      ...rawCommit,
      operations: rawCommit.operations.map(rehydrateOperation),
    }
    const persisted = classifyCommit(commit)
    const result = verifyCommit(persisted, { strict })
    if (result.kind === 'skipped') report.v1Skipped++
    else if (result.kind === 'verified') report.v2Verified++
    else report.v2Mismatches.push({ hash: result.hash, message: result.message ?? 'unknown' })
  }
  return report
}

function discoverAccounts(): string[] {
  const dir = resolve('data/trading')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict')
  const accountArg = process.argv.find((a) => a.startsWith('--account='))
  const accounts = accountArg
    ? [accountArg.slice('--account='.length)]
    : discoverAccounts()

  if (accounts.length === 0) {
    console.log('No accounts found under data/trading/. Nothing to verify.')
    return
  }

  let totalMismatches = 0
  for (const accountId of accounts) {
    const r = await verifyAccount(accountId, strict)
    console.log(
      `${accountId}: ${r.totalCommits} commits (${r.v2Verified} v2 verified, ` +
      `${r.v1Skipped} v1 skipped, ${r.v2Mismatches.length} v2 mismatches)`,
    )
    for (const m of r.v2Mismatches) {
      console.log(`  MISMATCH: ${m.hash} — ${m.message}`)
    }
    totalMismatches += r.v2Mismatches.length
  }

  if (totalMismatches > 0) {
    console.log(`\nTotal v2 mismatches: ${totalMismatches}`)
    if (strict) process.exit(1)
  } else {
    console.log('\nAll v2 commits verified.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
