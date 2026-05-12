#!/usr/bin/env tsx
/**
 * parity/check-canonical-decimal-rust.ts
 *
 * Reads parity/fixtures/canonical-decimal/cases.json. For each case:
 *   - Run the TS toCanonicalDecimalString → assert equal to expected
 *   - Run the Rust canonicalizeDecimal (via napi binding) → assert equal to expected
 *
 * Phase 3 Task D: Rust binding invocation added.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import Decimal from 'decimal.js'
import { toCanonicalDecimalString } from '../src/domain/trading/canonical-decimal.js'

const require = createRequire(import.meta.url)
const binding = require('../packages/trading-core-bindings/index.js') as {
  canonicalizeDecimal(req: { input: string }): { canonical: string }
}

interface Case { input: string; expected: string }

const cases: Case[] = JSON.parse(
  readFileSync(resolve('parity/fixtures/canonical-decimal/cases.json'), 'utf-8'),
)

let failures = 0
for (const c of cases) {
  // TS side
  const tsActual = toCanonicalDecimalString(new Decimal(c.input))
  if (tsActual !== c.expected) {
    console.error(`TS MISMATCH input=${c.input}: expected=${c.expected} got=${tsActual}`)
    failures++
  }

  // Rust side
  try {
    const rustResult = binding.canonicalizeDecimal({ input: c.input })
    if (rustResult.canonical !== c.expected) {
      console.error(`Rust MISMATCH input=${c.input}: expected=${c.expected} got=${rustResult.canonical}`)
      failures++
    }
  } catch (e) {
    console.error(`Rust ERROR input=${c.input}: ${(e as Error).message}`)
    failures++
  }
}

if (failures > 0) {
  console.error(`\n${failures} canonical-decimal mismatches`)
  process.exit(1)
}
console.log(`OK: ${cases.length} TS canonical-decimal cases match fixtures`)
console.log(`OK: ${cases.length} Rust canonical-decimal cases match fixtures`)
