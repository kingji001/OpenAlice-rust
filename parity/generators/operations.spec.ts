import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('operations generator', () => {
  it('produces ≥200 fixtures across all action subdirs', () => {
    execSync('pnpm tsx parity/generators/operations.ts', { stdio: 'pipe' })
    const dirs = ['placeOrder', 'modifyOrder', 'closePosition', 'cancelOrder', 'syncOrders']
    let total = 0
    for (const d of dirs) {
      total += readdirSync(resolve(`parity/fixtures/operations/${d}`)).filter((f) => f.endsWith('.json')).length
    }
    expect(total).toBeGreaterThanOrEqual(200)
  })

  it('is idempotent — re-running produces byte-identical output', () => {
    execSync('pnpm tsx parity/generators/operations.ts', { stdio: 'pipe' })
    // Pick the first placeOrder file by sorted order
    const dir = resolve('parity/fixtures/operations/placeOrder')
    const sample = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()[0]
    const before = readFileSync(resolve(dir, sample), 'utf-8')
    execSync('pnpm tsx parity/generators/operations.ts', { stdio: 'pipe' })
    const after = readFileSync(resolve(dir, sample), 'utf-8')
    expect(after).toBe(before)
  })

  it('emits valid JSON for every fixture', () => {
    const dirs = ['placeOrder', 'modifyOrder', 'closePosition', 'cancelOrder', 'syncOrders']
    for (const d of dirs) {
      const dir = resolve(`parity/fixtures/operations/${d}`)
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
      for (const f of files) {
        const content = readFileSync(resolve(dir, f), 'utf-8')
        expect(() => JSON.parse(content)).not.toThrow()
      }
    }
  })
})
