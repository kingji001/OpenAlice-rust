/**
 * src/__test__/testnet-scaffold-regression.spec.ts
 *
 * CI guardrail for the Binance testnet parity scaffold.
 *
 * Verifies:
 *   1. Each script exits 0 (skip path) when credentials are absent.
 *   2. Each script prints [skip] on stdout in skip mode.
 *   3. Each script exits 0 and prints [dry-run] lines in BINANCE_TESTNET_DRY_RUN=1 mode.
 *   4. Each script prints "[ok] dry-run completed" at the end of dry-run mode.
 *
 * These tests catch accidental breakage of import paths, env-var gating, and
 * dry-run mode without requiring live Binance testnet credentials.
 *
 * Note: pnpm tsx startup is ~2–3 s per script. 4 scripts × 2 tests = ~16–24 s
 * wall time. Each test has a 30 s timeout.
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SCRIPTS = [
  'check-binance-testnet-spot.ts',
  'check-binance-testnet-margin.ts',
  'check-binance-testnet-usdm.ts',
  'check-binance-testnet-coinm.ts',
]

// Env with all credential vars explicitly cleared so CI never picks up ambient creds.
const NO_CREDS_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  BINANCE_TESTNET_KEY: '',
  BINANCE_TESTNET_SECRET: '',
  BINANCE_USDM_TESTNET_KEY: '',
  BINANCE_USDM_TESTNET_SECRET: '',
  BINANCE_COINM_TESTNET_KEY: '',
  BINANCE_COINM_TESTNET_SECRET: '',
  BINANCE_TESTNET_DRY_RUN: '',
}

const DRY_RUN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  BINANCE_TESTNET_DRY_RUN: '1',
}

describe('testnet scaffold regression', () => {
  for (const script of SCRIPTS) {
    it(`${script} exits 0 with [skip] when creds missing`, () => {
      const scriptPath = resolve(__dirname, '..', '..', 'parity', 'testnet', script)
      const out = execSync(`pnpm tsx ${scriptPath}`, {
        env: NO_CREDS_ENV,
        encoding: 'utf-8',
      })
      expect(out).toMatch(/\[skip\]/)
    }, 30000)

    it(`${script} dry-run prints intended calls and exits 0`, () => {
      const scriptPath = resolve(__dirname, '..', '..', 'parity', 'testnet', script)
      const out = execSync(`pnpm tsx ${scriptPath}`, {
        env: DRY_RUN_ENV,
        encoding: 'utf-8',
      })
      expect(out).toMatch(/\[dry-run\]/)
      expect(out).toMatch(/\[ok\] dry-run completed/)
    }, 30000)
  }
})
