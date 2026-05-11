#!/usr/bin/env tsx
/**
 * parity/run-ts.ts — TS reference CLI driving TradingGit through its lifecycle.
 *
 * Three modes:
 *   pnpm tsx parity/run-ts.ts <fixture-path>
 *     Single-fixture: load Operation, drive add → commit → push → log →
 *     exportState. Emit canonical JSON of the full lifecycle to stdout.
 *
 *   pnpm tsx parity/run-ts.ts --scenario=<file> [--emit-git-state=<out>]
 *     Scenario: walk .scenario.json step list. ScriptedStubPolicy from
 *     the scenario's stubResults drives executeOperation. Emit final
 *     GitExportState to <out> if given, else full lifecycle to stdout.
 *
 *   pnpm tsx parity/run-ts.ts --all [--bail]
 *     Batch: walk every fixture in fixtures/operations/, run each as
 *     single-fixture, write outputs to /tmp/parity-out-<sha8>.json.
 *     Print one-line summary per fixture. --bail stops on first failure.
 *
 * Determinism: Date.now() stubbed via global Date override at module init.
 * All outputs sort-keyed via canonical-json.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import { Order, Contract } from '@traderalice/ibkr'
import { canonicalJson, type CanonicalJsonValue } from '../src/domain/trading/canonical-json.js'
import { buildTradingGit, ScriptedStubPolicy, DefaultStubPolicy } from './_construct.js'
import type { Operation, OperationResult, GitState, GitExportState } from '../src/domain/trading/git/types.js'

// ---- Determinism: stub Date ----

const FIXED_TIME_MS = Date.parse('2026-01-01T00:00:00.000Z')
const OriginalDate = Date
class FrozenDate extends OriginalDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(FIXED_TIME_MS)
    else super(...(args as []))
  }
  static now(): number { return FIXED_TIME_MS }
  static parse(s: string): number { return OriginalDate.parse(s) }
  static UTC(...args: number[]): number { return OriginalDate.UTC(...args) }
}
;(globalThis as any).Date = FrozenDate

// ---- Fixture loading ----

interface OperationFixture {
  name: string
  operation: CanonicalJsonValue
}

interface ScenarioFixture {
  name: string
  description?: string
  steps: ScenarioStep[]
}

type ScenarioStep =
  | { op: 'stagePlaceOrder' | 'stageModifyOrder' | 'stageClosePosition' | 'stageCancelOrder' | 'stageSyncOrders'; fixture: string }
  | { op: 'commit'; message: string }
  | { op: 'push'; stubResults?: OperationResult[] }
  | { op: 'reject'; reason?: string }
  | { op: 'sync'; updates: unknown[]; currentState: GitState }

async function loadOperationFixture(path: string): Promise<Operation> {
  const raw = JSON.parse(await readFile(path, 'utf-8')) as OperationFixture
  return rehydrateOperation(raw.operation)
}

function rehydrateOperation(op: any): Operation {
  if (op.action === 'placeOrder') {
    const order = new Order()
    // Only assign known safe scalar fields from the fixture
    const safeOrderFields = ['action', 'orderType', 'tif', 'orderId', 'permId',
      'clientId', 'account', 'settlingFirm', 'clearingAccount', 'clearingIntent',
      'openClose', 'origin', 'orderRef', 'transmit', 'parentId', 'blockOrder',
      'sweepToFill', 'displaySize', 'triggerMethod', 'outsideRth', 'hidden',
      'discretionaryAmt', 'goodAfterTime', 'goodTillDate', 'ocaGroup', 'ocaType',
      'rule80A', 'allOrNone', 'minQty', 'percentOffset', 'overridePercentageConstraints',
      'trailStopPrice', 'trailingPercent', 'faGroup', 'faMethod', 'faPercentage',
      'faProfile', 'designatedLocation', 'shortSaleSlot', 'exemptCode',
      'eTradeOnly', 'firmQuoteOnly', 'auctionStrategy', 'startingPrice', 'stockRefPrice',
      'delta', 'stockRangeLower', 'stockRangeUpper', 'volatility', 'volatilityType',
      'continuousVwap', 'deltaNeutralOrderType', 'deltaNeutralAuxPrice',
      'deltaNeutralConId', 'deltaNeutralSettlingFirm', 'deltaNeutralClearingAccount',
      'deltaNeutralClearingIntent', 'deltaNeutralOpenClose', 'deltaNeutralShortSale',
      'deltaNeutralShortSaleSlot', 'deltaNeutralDesignatedLocation', 'referencePriceType',
      'basisPoints', 'basisPointsType', 'scaleInitLevelSize', 'scaleSubsLevelSize',
      'scalePriceIncrement', 'scalePriceAdjustValue', 'scalePriceAdjustInterval',
      'scaleProfitOffset', 'scaleAutoReset', 'scaleInitPosition', 'scaleInitFillQty',
      'scaleRandomPercent', 'scaleTable', 'activeStartTime', 'activeStopTime',
      'hedgeType', 'hedgeParam', 'optOutSmartRouting', 'requestPreTradeInformation',
      'clearingFirm', 'whatIf', 'notHeld', 'solicited', 'randomizeSize',
      'randomizePrice', 'referenceContractId', 'isPeggedChangeAmountDecrease',
      'peggedChangeAmount', 'referenceChangeAmount', 'referenceExchangeId',
      'adjustedOrderType', 'triggerPrice', 'adjustedStopPrice', 'adjustedStopLimitPrice',
      'adjustedTrailingAmount', 'adjustableTrailingUnit', 'extOperator', 'softDollarTier',
      'cashQty', 'mifid2DecisionMaker', 'mifid2DecisionAlgo', 'mifid2ExecutionTrader',
      'mifid2ExecutionAlgo', 'dontUseAutoPriceForHedge', 'autoCancelDate',
      'filledQuantity', 'refFuturesConId', 'autoCancelParent', 'shareholder',
      'imbalanceOnly', 'routeMarketableToBbo', 'parentPermId', 'usePriceMgmtAlgo',
      'duration', 'postToAts', 'advancedErrorOverride', 'manualOrderTime',
      'minTradeQty', 'minCompeteSize', 'competeAgainstBestOffset',
      'midOffsetAtWhole', 'midOffsetAtHalf', 'customerAccount', 'professionalCustomer',
      'bondAccruedInterest', 'includeOvernight', 'manualOrderIndicator', 'submitter']
    for (const field of safeOrderFields) {
      if (op.order[field] !== undefined) {
        (order as any)[field] = op.order[field]
      }
    }
    // Rewrap Decimal-string fields as Decimal instances.
    if (op.order.totalQuantity != null) order.totalQuantity = new Decimal(op.order.totalQuantity)
    if (op.order.lmtPrice != null) order.lmtPrice = new Decimal(op.order.lmtPrice)
    if (op.order.auxPrice != null) order.auxPrice = new Decimal(op.order.auxPrice)
    if (op.order.trailStopPrice != null) order.trailStopPrice = new Decimal(op.order.trailStopPrice)
    if (op.order.trailingPercent != null) order.trailingPercent = new Decimal(op.order.trailingPercent)
    if (op.order.cashQty != null) order.cashQty = new Decimal(op.order.cashQty)

    const contract = new Contract()
    const safeContractFields = ['symbol', 'secType', 'lastTradeDateOrContractMonth',
      'strike', 'right', 'multiplier', 'exchange', 'currency', 'localSymbol',
      'primaryExch', 'tradingClass', 'includeExpired', 'secIdType', 'secId',
      'description', 'issuerId', 'comboLegsDescrip', 'comboLegs', 'deltaNeutralContract',
      'conId', 'aliceId']
    for (const field of safeContractFields) {
      if (op.contract[field] !== undefined) {
        (contract as any)[field] = op.contract[field]
      }
    }

    return { action: 'placeOrder', order, contract, ...(op.tpsl ? { tpsl: op.tpsl } : {}) } as Operation
  }
  if (op.action === 'closePosition') {
    const contract = new Contract()
    const safeContractFields = ['symbol', 'secType', 'lastTradeDateOrContractMonth',
      'strike', 'right', 'multiplier', 'exchange', 'currency', 'localSymbol',
      'primaryExch', 'tradingClass', 'includeExpired', 'secIdType', 'secId',
      'description', 'issuerId', 'comboLegsDescrip', 'comboLegs', 'deltaNeutralContract',
      'conId', 'aliceId']
    for (const field of safeContractFields) {
      if (op.contract[field] !== undefined) {
        (contract as any)[field] = op.contract[field]
      }
    }
    const out: any = { action: 'closePosition', contract }
    if (op.quantity != null) out.quantity = new Decimal(op.quantity)
    return out as Operation
  }
  if (op.action === 'modifyOrder') {
    const changes: Partial<Order> = {}
    if (op.changes) {
      for (const [k, v] of Object.entries(op.changes)) {
        // Decimal fields
        if (['totalQuantity', 'lmtPrice', 'auxPrice', 'trailStopPrice',
          'trailingPercent', 'cashQty'].includes(k)) {
          (changes as any)[k] = new Decimal(v as string)
        } else {
          (changes as any)[k] = v
        }
      }
    }
    return { action: 'modifyOrder', orderId: op.orderId, changes } as Operation
  }
  if (op.action === 'cancelOrder') {
    return { action: 'cancelOrder', orderId: op.orderId, ...(op.orderCancel ? { orderCancel: op.orderCancel } : {}) } as Operation
  }
  if (op.action === 'syncOrders') {
    return { action: 'syncOrders' } as Operation
  }
  throw new Error(`Unknown operation action: ${op.action}`)
}

// ---- Single-fixture mode ----

async function runSingleFixture(path: string): Promise<CanonicalJsonValue> {
  const op = await loadOperationFixture(path)
  const stub = new DefaultStubPolicy()
  const git = buildTradingGit(stub)
  const addResult = git.add(op)
  const commitResult = git.commit(`parity-test commit for ${path}`)
  const pushResult = await git.push()
  const logEntries = git.log()
  const exportState = git.exportState()
  return {
    addResult: serializeAddResult(addResult),
    commitResult: serializeCommitResult(commitResult),
    pushResult: serializePushResult(pushResult),
    logEntries: serializeLog(logEntries),
    exportState: serializeExportState(exportState),
  }
}

function serializeAddResult(r: any): CanonicalJsonValue {
  return { action: r.operation.action, index: r.index, staged: r.staged }
}

function serializeCommitResult(r: any): CanonicalJsonValue {
  return { hash: r.hash, message: r.message, operationCount: r.operationCount, prepared: r.prepared }
}

function serializePushResult(r: any): CanonicalJsonValue {
  return {
    hash: r.hash,
    message: r.message,
    operationCount: r.operationCount,
    rejectedCount: r.rejected.length,
    submittedCount: r.submitted.length,
  }
}

function serializeLog(entries: any[]): CanonicalJsonValue {
  return entries.map((e) => ({
    hash: e.hash,
    message: e.message,
    operationCount: e.operations.length,
    parentHash: e.parentHash,
    timestamp: e.timestamp,
  }))
}

function serializeExportState(s: GitExportState): CanonicalJsonValue {
  return s as unknown as CanonicalJsonValue
}

// ---- Scenario mode ----

async function runScenario(scenarioPath: string): Promise<{ git: any; exportState: GitExportState }> {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf-8')) as ScenarioFixture
  const allStubResults: OperationResult[] = []
  for (const step of scenario.steps) {
    if (step.op === 'push' && (step as any).stubResults) {
      allStubResults.push(...(step as any).stubResults as OperationResult[])
    }
  }
  const stub = allStubResults.length > 0
    ? new ScriptedStubPolicy(allStubResults)
    : new DefaultStubPolicy()
  const git = buildTradingGit(stub)

  for (const step of scenario.steps) {
    if (step.op.startsWith('stage')) {
      const fixturePath = resolve((step as any).fixture as string)
      const fixture = await loadOperationFixture(fixturePath)
      git.add(fixture)
    } else if (step.op === 'commit') {
      git.commit((step as any).message as string)
    } else if (step.op === 'push') {
      await git.push()
    } else if (step.op === 'reject') {
      await git.reject((step as any).reason as string | undefined)
    } else if (step.op === 'sync') {
      await git.sync((step as any).updates as any, (step as any).currentState as GitState)
    }
  }

  return { git, exportState: git.exportState() }
}

// ---- Batch mode ----

async function runAll(bail: boolean): Promise<void> {
  const root = resolve('parity/fixtures/operations')
  const dirs = await readdir(root)
  let pass = 0; let fail = 0

  for (const d of dirs) {
    const dir = join(root, d)
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      continue // skip non-directories
    }
    for (const f of files) {
      const path = join(dir, f)
      try {
        const out = await runSingleFixture(path)
        const json = canonicalJson(out, { pretty: true })
        const sha = createHash('sha256').update(json).digest('hex').slice(0, 8)
        await writeFile(`/tmp/parity-out-${sha}.json`, json)
        console.log(`PASS ${d}/${f}  → /tmp/parity-out-${sha}.json`)
        pass++
      } catch (e) {
        console.log(`FAIL ${d}/${f}  → ${(e as Error).message}`)
        fail++
        if (bail) { process.exit(1) }
      }
    }
  }

  console.log(`\nBatch summary: ${pass} pass, ${fail} fail (${pass + fail} total)`)
  if (fail > 0) process.exit(1)
}

// ---- CLI dispatch ----

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--all')) {
    const bail = args.includes('--bail')
    await runAll(bail)
    return
  }

  const scenarioArg = args.find((a) => a.startsWith('--scenario='))
  if (scenarioArg) {
    const scenarioPath = scenarioArg.slice('--scenario='.length)
    const { exportState } = await runScenario(scenarioPath)
    const emitArg = args.find((a) => a.startsWith('--emit-git-state='))
    if (emitArg) {
      const out = emitArg.slice('--emit-git-state='.length)
      await writeFile(out, canonicalJson(exportState as unknown as CanonicalJsonValue, { pretty: true }))
      console.log(`wrote ${out}`)
    } else {
      console.log(canonicalJson(exportState as unknown as CanonicalJsonValue, { pretty: true }))
    }
    return
  }

  const fixturePath = args[0]
  if (!fixturePath) {
    console.error('Usage: pnpm tsx parity/run-ts.ts <fixture-path>')
    console.error('       pnpm tsx parity/run-ts.ts --scenario=<file> [--emit-git-state=<out>]')
    console.error('       pnpm tsx parity/run-ts.ts --all [--bail]')
    process.exit(2)
  }

  const out = await runSingleFixture(resolve(fixturePath))
  console.log(canonicalJson(out, { pretty: true }))
}

main().catch((e) => { console.error(e); process.exit(1) })
