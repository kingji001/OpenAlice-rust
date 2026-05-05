import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

describe('orders-on-wire generator', () => {
  it('emits ≥1 unique order and ≥1 unique contract snapshot', () => {
    execSync('pnpm tsx parity/generators/orders-on-wire.ts', { stdio: 'pipe' })
    const orderCount = readdirSync(resolve('parity/fixtures/orders-on-wire/order')).filter((f) => f.endsWith('.json')).length
    const contractCount = readdirSync(resolve('parity/fixtures/orders-on-wire/contract')).filter((f) => f.endsWith('.json')).length
    expect(orderCount).toBeGreaterThanOrEqual(1)
    expect(contractCount).toBeGreaterThanOrEqual(1)
  })

  it('dedup: filename matches sha8(content)', () => {
    const orderDir = resolve('parity/fixtures/orders-on-wire/order')
    for (const f of readdirSync(orderDir).filter((x) => x.endsWith('.json'))) {
      const content = readFileSync(resolve(orderDir, f), 'utf-8')
      const expectedSha = createHash('sha256').update(content).digest('hex').slice(0, 8)
      expect(f).toBe(`${expectedSha}.json`)
    }
  })

  it('is idempotent — re-running yields same set of files', () => {
    execSync('pnpm tsx parity/generators/orders-on-wire.ts', { stdio: 'pipe' })
    const before = readdirSync(resolve('parity/fixtures/orders-on-wire/order')).sort().join(',')
    execSync('pnpm tsx parity/generators/orders-on-wire.ts', { stdio: 'pipe' })
    const after = readdirSync(resolve('parity/fixtures/orders-on-wire/order')).sort().join(',')
    expect(after).toBe(before)
  })
})
