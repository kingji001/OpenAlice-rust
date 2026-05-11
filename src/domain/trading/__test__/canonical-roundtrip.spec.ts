import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, type CanonicalJsonValue } from '../canonical-json.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, '../../../../parity/fixtures')

/**
 * Round-trip every Phase 0 wire fixture through canonicalJson + JSON.parse.
 * Asserts JSON.parse(canonicalJson(parsed)) deep-equals parsed.
 *
 * Covers v4 §5 Phase 1c Deliverable 1: "Round-trip test: JSON.parse(canonical(x))
 * deep-equals x for every wire fixture."
 *
 * Fixtures:
 *   - 340 in parity/fixtures/orders-on-wire/order/
 *     1 in parity/fixtures/orders-on-wire/contract/
 *   - 49 in parity/fixtures/sentinels/order-fields/
 *     12 in parity/fixtures/sentinels/contract-fields/
 *     7 in parity/fixtures/sentinels/execution-fields/
 *    18 in parity/fixtures/sentinels/orderstate-fields/
 *   Total: 427
 */

function loadFixtureFiles(subdir: string): string[] {
  const dir = resolve(FIXTURES, subdir)
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => resolve(dir, f))
}

describe('canonical JSON round-trip', () => {
  const corpora: Array<{ name: string; subdir: string }> = [
    { name: 'orders-on-wire/order',          subdir: 'orders-on-wire/order' },
    { name: 'orders-on-wire/contract',       subdir: 'orders-on-wire/contract' },
    { name: 'sentinels/order-fields',        subdir: 'sentinels/order-fields' },
    { name: 'sentinels/contract-fields',     subdir: 'sentinels/contract-fields' },
    { name: 'sentinels/execution-fields',    subdir: 'sentinels/execution-fields' },
    { name: 'sentinels/orderstate-fields',   subdir: 'sentinels/orderstate-fields' },
  ]

  for (const corpus of corpora) {
    describe(corpus.name, () => {
      const files = loadFixtureFiles(corpus.subdir)
      it.each(files)('%s round-trips through canonicalJson', (filePath) => {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as CanonicalJsonValue
        const canonical = canonicalJson(parsed)
        const reparsed = JSON.parse(canonical) as CanonicalJsonValue
        expect(reparsed).toEqual(parsed)
      })
    })
  }
})
