import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('sentinels generator', () => {
  it('emits at least one fixture per type', () => {
    execSync('pnpm tsx parity/generators/sentinels.ts', { stdio: 'pipe' })
    const types = ['order-fields', 'contract-fields', 'execution-fields', 'orderstate-fields']
    for (const t of types) {
      const dir = resolve(`parity/fixtures/sentinels/${t}`)
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
      expect(files.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('every fixture is valid JSON with name + type properties', () => {
    const types = ['order-fields', 'contract-fields', 'execution-fields', 'orderstate-fields']
    for (const t of types) {
      const dir = resolve(`parity/fixtures/sentinels/${t}`)
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const obj = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'))
        expect(obj).toHaveProperty('name')
        expect(obj).toHaveProperty('type')
      }
    }
  })

  it('is idempotent — re-running yields byte-identical output', () => {
    execSync('pnpm tsx parity/generators/sentinels.ts', { stdio: 'pipe' })
    const sample = resolve('parity/fixtures/sentinels/order-fields')
    const before = readdirSync(sample).map((f) => readFileSync(resolve(sample, f), 'utf-8')).join('')
    execSync('pnpm tsx parity/generators/sentinels.ts', { stdio: 'pipe' })
    const after = readdirSync(sample).map((f) => readFileSync(resolve(sample, f), 'utf-8')).join('')
    expect(after).toBe(before)
  })
})
