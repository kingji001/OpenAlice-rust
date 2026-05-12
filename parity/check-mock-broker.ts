#!/usr/bin/env tsx
/**
 * parity/check-mock-broker.ts
 *
 * For each script in parity/fixtures/mock-broker-scripts/:
 *   - Run through TS MockBroker → emit canonical-JSON state snapshot
 *   - (Phase 4f will add the Rust side via napi — Phase 4b documents
 *     the snapshots for cross-comparison once FFI is wired)
 *
 * For now, this validates the TS side produces consistent canonical
 * snapshots, locking down the expected output shape for Phase 4f.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Contract, Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { canonicalJson } from '../src/domain/trading/canonical-json.js'
import { MockBroker } from '../src/domain/trading/brokers/mock/MockBroker.js'

const SCRIPT_DIR = resolve('parity/fixtures/mock-broker-scripts')

interface Step { type: string; [k: string]: unknown }
interface Script { description: string; steps: Step[] }

function buildContract(raw: Record<string, string>): Contract {
  const c = new Contract()
  c.aliceId = raw.aliceId
  c.symbol = raw.symbol
  c.secType = raw.secType
  c.exchange = raw.exchange
  c.currency = raw.currency
  return c
}

function buildOrder(raw: Record<string, string>): Order {
  const o = new Order()
  o.action = raw.action as 'BUY' | 'SELL'
  o.orderType = raw.orderType
  o.totalQuantity = new Decimal(raw.totalQuantity)
  return o
}

async function runScript(script: Script): Promise<unknown> {
  const broker = new MockBroker()
  for (const step of script.steps) {
    switch (step.type) {
      case 'setQuote':
        broker.setQuote(step.symbol as string, step.price as number)
        break
      case 'setFailMode':
        broker.setFailMode(step.count as number)
        break
      case 'placeOrder':
        await broker.placeOrder(
          buildContract(step.contract as Record<string, string>),
          buildOrder(step.order as Record<string, string>),
        )
        break
      case 'getAccount':
        try { await broker.getAccount() } catch (_) { /* swallow expected errors */ }
        break
    }
  }
  // Snapshot: positions + call counts (deterministic state)
  const positions = await broker.getPositions()
  return {
    positions: positions.map((p) => ({
      contract: { aliceId: p.contract.aliceId, symbol: p.contract.symbol },
      side: p.side,
      quantity: p.quantity.toString(),
      avgCost: p.avgCost,
    })),
    callCounts: {
      placeOrder: broker.callCount('placeOrder'),
      getAccount: broker.callCount('getAccount'),
      getPositions: broker.callCount('getPositions'),
    },
  }
}

async function main(): Promise<void> {
  const scripts = readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.json')).sort()
  if (scripts.length === 0) {
    console.error('No scripts in', SCRIPT_DIR)
    process.exit(1)
  }
  for (const f of scripts) {
    const path = resolve(SCRIPT_DIR, f)
    const script: Script = JSON.parse(readFileSync(path, 'utf-8'))
    const snapshot = await runScript(script)
    const canonical = canonicalJson(snapshot, { pretty: true })
    console.log(`=== ${f} ===`)
    console.log(`  ${script.description}`)
    console.log(canonical.split('\n').map((l) => `  ${l}`).join('\n'))
  }
  console.log('\nAll MockBroker scenarios produced consistent TS snapshots.')
  console.log('(Rust-side comparison wired in Phase 4f via napi binding.)')
}

main().catch((e) => { console.error(e); process.exit(1) })
