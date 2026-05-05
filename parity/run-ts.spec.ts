import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

describe('parity/run-ts.ts', () => {
  it('single-fixture mode emits non-empty canonical JSON to stdout', () => {
    const dir = resolve('parity/fixtures/operations/placeOrder')
    const sample = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()[0]
    const out = execSync(`pnpm tsx parity/run-ts.ts parity/fixtures/operations/placeOrder/${sample}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString()
    expect(out.length).toBeGreaterThan(0)
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('output contains all five lifecycle keys', () => {
    const dir = resolve('parity/fixtures/operations/placeOrder')
    const sample = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()[0]
    const out = JSON.parse(execSync(`pnpm tsx parity/run-ts.ts parity/fixtures/operations/placeOrder/${sample}`).toString())
    for (const k of ['addResult', 'commitResult', 'pushResult', 'logEntries', 'exportState']) {
      expect(out).toHaveProperty(k)
    }
  })

  it('is deterministic — same fixture twice yields identical stdout', () => {
    const dir = resolve('parity/fixtures/operations/placeOrder')
    const sample = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()[0]
    const fix = `parity/fixtures/operations/placeOrder/${sample}`
    const a = execSync(`pnpm tsx parity/run-ts.ts ${fix}`).toString()
    const b = execSync(`pnpm tsx parity/run-ts.ts ${fix}`).toString()
    expect(a).toBe(b)
  })
})
