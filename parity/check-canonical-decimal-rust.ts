#!/usr/bin/env tsx
/**
 * parity/check-canonical-decimal-rust.ts
 *
 * Reads parity/fixtures/canonical-decimal/cases.json. For each case:
 *   - Run the TS toCanonicalDecimalString → assert equal to expected
 *   - (Phase 3 Task D adds Rust binding invocation here)
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Decimal from 'decimal.js'
import { toCanonicalDecimalString } from '../src/domain/trading/canonical-decimal.js'

interface Case { input: string; expected: string }

const cases: Case[] = JSON.parse(
  readFileSync(resolve('parity/fixtures/canonical-decimal/cases.json'), 'utf-8'),
)

let failures = 0
for (const c of cases) {
  const tsActual = toCanonicalDecimalString(new Decimal(c.input))
  if (tsActual !== c.expected) {
    console.error(`TS MISMATCH input=${c.input}: expected=${c.expected} got=${tsActual}`)
    failures++
  }
}

if (failures > 0) {
  console.error(`\n${failures} TS canonical-decimal mismatches`)
  process.exit(1)
}
console.log(`OK: ${cases.length} TS canonical-decimal cases match fixtures`)
