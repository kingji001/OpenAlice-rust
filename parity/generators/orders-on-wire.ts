/**
 * Orders-on-wire generator — Phase 0 deliverable 5.
 *
 * Reads every fixture in parity/fixtures/operations/placeOrder/, rehydrates
 * the Order and Contract instances, and emits the result of plain
 * JSON.stringify(instance, null, 2) to:
 *   parity/fixtures/orders-on-wire/order/<sha8>.json
 *   parity/fixtures/orders-on-wire/contract/<sha8>.json
 *
 * Dedup'd by sha8(JSON.stringify(instance)) — multiple Operation fixtures
 * may share the same Order or Contract shape after stringify.
 *
 * These snapshots capture today's IBKR class instance stringify output,
 * which Phase 1b's WireOrder/WireContract adapters must round-trip.
 *
 * Re-running overwrites both target dirs entirely. Idempotent.
 */

import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import { Order, Contract } from '@traderalice/ibkr'

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8)
}

async function main(): Promise<void> {
  const orderDir = resolve('parity/fixtures/orders-on-wire/order')
  const contractDir = resolve('parity/fixtures/orders-on-wire/contract')
  await rm(orderDir, { recursive: true, force: true })
  await rm(contractDir, { recursive: true, force: true })
  await mkdir(orderDir, { recursive: true })
  await mkdir(contractDir, { recursive: true })

  const placeOrderDir = resolve('parity/fixtures/operations/placeOrder')
  const fixtures = (await readdir(placeOrderDir)).filter((f) => f.endsWith('.json'))

  const orderHashes = new Set<string>()
  const contractHashes = new Set<string>()

  for (const f of fixtures) {
    const raw = JSON.parse(await readFile(join(placeOrderDir, f), 'utf-8'))
    const op = raw.operation
    if (op.action !== 'placeOrder') continue

    // Rehydrate Order — use class defaults for fields not in fixture.
    const order = new Order()
    if (op.order.action) order.action = op.order.action
    if (op.order.orderType) order.orderType = op.order.orderType
    if (op.order.tif) order.tif = op.order.tif
    if (op.order.totalQuantity) order.totalQuantity = new Decimal(op.order.totalQuantity)
    if (op.order.lmtPrice) order.lmtPrice = new Decimal(op.order.lmtPrice)
    if (op.order.auxPrice) order.auxPrice = new Decimal(op.order.auxPrice)
    const orderJson = JSON.stringify(order, null, 2)
    const orderSha = sha8(orderJson)
    if (!orderHashes.has(orderSha)) {
      orderHashes.add(orderSha)
      await writeFile(join(orderDir, `${orderSha}.json`), orderJson)
    }

    // Rehydrate Contract — use class defaults for fields not in fixture.
    const contract = new Contract()
    if (op.contract.symbol) contract.symbol = op.contract.symbol
    if (op.contract.secType) contract.secType = op.contract.secType
    if (op.contract.exchange) contract.exchange = op.contract.exchange
    if (op.contract.currency) contract.currency = op.contract.currency
    const contractJson = JSON.stringify(contract, null, 2)
    const contractSha = sha8(contractJson)
    if (!contractHashes.has(contractSha)) {
      contractHashes.add(contractSha)
      await writeFile(join(contractDir, `${contractSha}.json`), contractJson)
    }
  }

  console.log(`Emitted ${orderHashes.size} unique order snapshots, ${contractHashes.size} unique contract snapshots from ${fixtures.length} fixtures.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
