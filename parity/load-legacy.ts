#!/usr/bin/env tsx
/**
 * parity/load-legacy.ts — DoD verifier for Phase 0 deliverable 4.
 *
 * Verifies that `loadGitState(accountId)` for legacy-mapped accountIds
 * returns the byte-identical content of the legacy-path fixture file.
 *
 * SAFETY: uses mkdtemp + child_process to avoid touching the repo's data/
 * directory. The persister resolves `data/...` against CWD at *module load
 * time* (LEGACY_GIT_PATHS is a module-level constant). To ensure those
 * paths resolve inside the temp dir, each case is run in a fresh child
 * process whose CWD is set to the temp dir before any module is loaded.
 */

import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = resolve(__filename, '../..')
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')

interface Case {
  fixture: string
  legacyPath: string
  accountId: string
}

const CASES: Case[] = [
  {
    fixture: resolve('parity/fixtures/legacy-paths/crypto-trading-commit.json'),
    legacyPath: 'data/crypto-trading/commit.json',
    accountId: 'bybit-main',
  },
  {
    fixture: resolve('parity/fixtures/legacy-paths/securities-trading-commit.json'),
    legacyPath: 'data/securities-trading/commit.json',
    accountId: 'alpaca-paper',
  },
]

/** Inline runner script written to the temp dir and executed via tsx. */
const runnerScript = (accountId: string, fixturePath: string, persistencePath: string) => `
import { loadGitState } from '${persistencePath}'
import { readFile } from 'node:fs/promises'

const loaded = await loadGitState('${accountId}')
if (loaded === undefined) {
  process.stderr.write('UNDEFINED\\n')
  process.exit(1)
}
const expected = JSON.parse(await readFile('${fixturePath}', 'utf-8'))
const ls = JSON.stringify(loaded)
const es = JSON.stringify(expected)
if (ls !== es) {
  process.stderr.write('MISMATCH\\n')
  process.stderr.write('Expected: ' + es.slice(0, 200) + '\\n')
  process.stderr.write('Got:      ' + ls.slice(0, 200) + '\\n')
  process.exit(2)
}
process.stdout.write('OK\\n')
`

async function runOneCase(c: Case): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'parity-load-legacy-'))
  try {
    // Populate the legacy path inside the temp dir.
    const targetPath = join(tmp, c.legacyPath)
    await mkdir(dirname(targetPath), { recursive: true })
    await copyFile(c.fixture, targetPath)

    // Write the runner script into the temp dir.
    const scriptPath = join(tmp, 'runner.mts')
    const persistencePath = join(repoRoot, 'src/domain/trading/git-persistence.js')
    await writeFile(scriptPath, runnerScript(c.accountId, c.fixture, persistencePath))

    // Run in a child process whose CWD is the temp dir, so LEGACY_GIT_PATHS
    // (resolved at module load time) points into tmp, not the repo's data/ dir.
    const result = spawnSync(tsxBin, [scriptPath], {
      cwd: tmp,
      encoding: 'utf-8',
      env: { ...process.env },
    })

    if (result.status !== 0) {
      const errMsg = (result.stderr || result.stdout || '').trim()
      throw new Error(
        `loadGitState('${c.accountId}') failed (exit ${result.status}): ${errMsg}`,
      )
    }

    console.log(`OK ${c.accountId} → ${c.legacyPath}`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  for (const c of CASES) {
    await runOneCase(c)
  }
  console.log(`\nAll ${CASES.length} legacy-path fixtures load identically.`)
}

main().catch((e) => { console.error(`FAIL: ${(e as Error).message}`); process.exit(1) })
