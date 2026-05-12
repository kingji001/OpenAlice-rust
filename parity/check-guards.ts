#!/usr/bin/env tsx
/**
 * parity/check-guards.ts
 *
 * Walks every JSON scenario in parity/fixtures/guards/. For each:
 *   1. Resolve guards via TS registry
 *   2. Build a stub IBroker reflecting broker_state
 *   3. Drive the TS guard pipeline through each op (with delay steps)
 *   4. Assert actual outcomes match expected[] (success + optional errorContains)
 *
 * Phase 4f will add Rust-side parity via napi binding. Phase 4c only
 * locks the TS truth: every fixture's expected[] is achievable.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Contract, Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { createGuardPipeline, resolveGuards } from '../src/domain/trading/guards/index.js'
import type { Operation } from '../src/domain/trading/git/types.js'
import type { Position, AccountInfo, IBroker } from '../src/domain/trading/brokers/types.js'

interface Step {
  step: 'op' | 'delay'
  op?: Record<string, unknown>
  ms?: number
}

interface Expected {
  success: boolean
  errorContains?: string
}

interface Scenario {
  description: string
  guards: Array<{ type: string; options?: Record<string, unknown> }>
  broker_state: {
    positions: Array<Record<string, unknown>>
    account: Record<string, unknown>
  }
  ops: Step[]
  expected: Expected[]
}

const FIXTURES_ROOT = resolve('parity/fixtures/guards')

function buildContract(raw: Record<string, unknown>): Contract {
  const c = new Contract()
  c.aliceId = String(raw.aliceId ?? '')
  c.symbol = String(raw.symbol ?? '')
  c.secType = String(raw.secType ?? 'STK')
  c.exchange = String(raw.exchange ?? 'MOCK')
  c.currency = String(raw.currency ?? 'USD')
  return c
}

function buildOrder(raw: Record<string, unknown>): Order {
  const o = new Order()
  o.action = String(raw.action ?? 'BUY') as 'BUY' | 'SELL'
  o.orderType = String(raw.orderType ?? 'MKT')
  o.totalQuantity = raw.totalQuantity
    ? new Decimal(String(raw.totalQuantity))
    : UNSET_DECIMAL
  o.cashQty = raw.cashQty ? new Decimal(String(raw.cashQty)) : UNSET_DECIMAL
  o.lmtPrice = raw.lmtPrice ? new Decimal(String(raw.lmtPrice)) : UNSET_DECIMAL
  return o
}

function buildOperation(raw: Record<string, unknown>): Operation {
  const action = String(raw.action)
  if (action === 'placeOrder') {
    return {
      action: 'placeOrder',
      contract: buildContract(raw.contract as Record<string, unknown>),
      order: buildOrder(raw.order as Record<string, unknown>),
    }
  }
  if (action === 'closePosition') {
    return {
      action: 'closePosition',
      contract: buildContract(raw.contract as Record<string, unknown>),
    }
  }
  if (action === 'modifyOrder') {
    return { action: 'modifyOrder', orderId: String(raw.orderId), changes: {} }
  }
  if (action === 'cancelOrder') {
    return { action: 'cancelOrder', orderId: String(raw.orderId) }
  }
  if (action === 'syncOrders') {
    return { action: 'syncOrders' }
  }
  throw new Error(`unknown action: ${action}`)
}

function buildPositions(raws: Array<Record<string, unknown>>): Position[] {
  return raws.map((r) => ({
    contract: buildContract(r.contract as Record<string, unknown>),
    currency: String(r.currency ?? 'USD'),
    side: (r.side ?? 'long') as 'long' | 'short',
    quantity: new Decimal(String(r.quantity ?? '0')),
    avgCost: String(r.avgCost ?? '0'),
    marketPrice: String(r.marketPrice ?? '0'),
    marketValue: String(r.marketValue ?? '0'),
    unrealizedPnL: String(r.unrealizedPnL ?? '0'),
    realizedPnL: String(r.realizedPnL ?? '0'),
  }))
}

function buildBroker(state: Scenario['broker_state']): IBroker {
  const positions = buildPositions(state.positions)
  const account = state.account as unknown as AccountInfo
  return {
    async getPositions() { return positions },
    async getAccount() { return account },
  } as IBroker
}

async function runScenario(file: string, scenario: Scenario): Promise<{ pass: boolean; report: string }> {
  const guards = resolveGuards(scenario.guards)
  const broker = buildBroker(scenario.broker_state)
  const dispatcher = async (_op: Operation): Promise<unknown> => ({ success: true })
  const pipeline = createGuardPipeline(dispatcher, broker, guards)

  const actuals: Expected[] = []
  let expectedIdx = 0

  for (const step of scenario.ops) {
    if (step.step === 'delay') {
      await new Promise((r) => setTimeout(r, step.ms ?? 0))
      continue
    }
    const op = buildOperation(step.op as Record<string, unknown>)
    const result = (await pipeline(op)) as { success: boolean; error?: string }
    actuals.push({ success: result.success, errorContains: result.error })

    const exp = scenario.expected[expectedIdx]
    expectedIdx++
    if (exp === undefined) {
      return { pass: false, report: `${file}: op ${expectedIdx} has no expected entry` }
    }
    if (result.success !== exp.success) {
      return {
        pass: false,
        report: `${file}: op ${expectedIdx} expected success=${exp.success}, got success=${result.success} (error: ${result.error})`,
      }
    }
    if (exp.errorContains !== undefined) {
      if (!result.error || !result.error.includes(exp.errorContains)) {
        return {
          pass: false,
          report: `${file}: op ${expectedIdx} expected error containing "${exp.errorContains}", got "${result.error ?? '(none)'}"`,
        }
      }
    }
  }

  if (expectedIdx !== scenario.expected.length) {
    return {
      pass: false,
      report: `${file}: expected ${scenario.expected.length} outcomes, but only ${expectedIdx} ops ran`,
    }
  }

  return { pass: true, report: `${file}: ${expectedIdx} ops, all match` }
}

function walkFixtures(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      out.push(...walkFixtures(full))
    } else if (s.isFile() && entry.endsWith('.json')) {
      out.push(full)
    }
  }
  return out
}

async function main(): Promise<void> {
  if (!statSync(FIXTURES_ROOT).isDirectory()) {
    console.log(`No fixtures directory at ${FIXTURES_ROOT}`)
    return
  }
  const files = walkFixtures(FIXTURES_ROOT)
  if (files.length === 0) {
    console.log('No fixture files found.')
    process.exit(1)
  }

  let pass = 0
  let fail = 0
  for (const f of files.sort()) {
    const scenario: Scenario = JSON.parse(readFileSync(f, 'utf-8'))
    const { pass: ok, report } = await runScenario(f.replace(FIXTURES_ROOT + '/', ''), scenario)
    if (ok) { pass++; console.log(`  OK  ${report}`) }
    else { fail++; console.error(`  FAIL  ${report}`) }
  }
  console.log(`\nResults: ${pass} pass, ${fail} fail (${pass + fail} total)`)
  if (fail > 0) process.exit(1)
  console.log('All Phase 4c parity scenarios match expected outcomes.')
}

main().catch((e) => { console.error(e); process.exit(1) })
