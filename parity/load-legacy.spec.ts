import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

describe('parity/load-legacy.ts', () => {
  it('exits 0 and reports both legacy fixtures load', () => {
    const out = execSync('pnpm tsx parity/load-legacy.ts', { stdio: ['pipe', 'pipe', 'pipe'] }).toString()
    expect(out).toContain('OK bybit-main')
    expect(out).toContain('OK alpaca-paper')
    expect(out).toContain('All 2 legacy-path fixtures load identically')
  })

  it('did NOT write to the repo data/ dir', () => {
    expect(existsSync(resolve('data/crypto-trading/commit.json'))).toBe(false)
    expect(existsSync(resolve('data/securities-trading/commit.json'))).toBe(false)
  })
})
