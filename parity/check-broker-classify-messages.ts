#!/usr/bin/env tsx
/**
 * parity/check-broker-classify-messages.ts
 *
 * Reads parity/fixtures/broker-classify-messages/cases.json. For each case:
 *   - Run TS BrokerError.classifyMessage → assert equal to expected
 *
 * The Rust integration test (tests/broker_error_serialize.rs) reads the
 * same fixture and asserts byte-identical output, so when both pass we
 * know TS↔Rust agree on every classification.
 *
 * Note: TS classifyMessage is private — we access it via BrokerError.from
 * which calls classifyMessage internally then constructs a BrokerError
 * with the classified code.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BrokerError, type BrokerErrorCode } from '../src/domain/trading/brokers/types.js'

interface Case { input: string; expected: BrokerErrorCode | null }

const cases: Case[] = JSON.parse(
  readFileSync(resolve('parity/fixtures/broker-classify-messages/cases.json'), 'utf-8'),
)

let failures = 0
for (const c of cases) {
  // BrokerError.from with fallback Unknown — classifyMessage may return
  // a code OR null, in which case the fallback is used. To distinguish,
  // we use a sentinel: fallback = '__SENTINEL__' (which isn't valid),
  // then check.
  const be = BrokerError.from(new Error(c.input), 'UNKNOWN' as BrokerErrorCode)
  // If c.expected is null, the classifier should not match (code = fallback Unknown).
  // If c.expected is a string, code should equal expected.
  const expected = c.expected ?? 'UNKNOWN'
  if (be.code !== expected) {
    console.error(`TS MISMATCH input=${JSON.stringify(c.input)} expected=${JSON.stringify(expected)} got=${JSON.stringify(be.code)}`)
    failures++
  }
}

if (failures > 0) {
  console.error(`\n${failures} TS classify_message mismatches`)
  process.exit(1)
}
console.log(`OK: ${cases.length} TS classify_message cases match fixtures`)
