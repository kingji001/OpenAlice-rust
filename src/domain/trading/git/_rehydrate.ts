/**
 * Operation/commit rehydration helpers.
 *
 * Extracted from TradingGit (was private static methods). Phase 2 needs
 * these callable without instantiating TradingGit — the verifier CLI
 * loads commit.json and rehydrates operations before computing hashes.
 *
 * Behavior preserved byte-identically from the original methods.
 */

import Decimal from 'decimal.js'
import { Order } from '@traderalice/ibkr'
import type { GitCommit, GitState, Operation } from './types.js'

/** Rehydrate Decimal fields lost during JSON round-trip. */
export function rehydrateCommit(commit: GitCommit): GitCommit {
  return {
    ...commit,
    operations: commit.operations.map(rehydrateOperation),
    stateAfter: rehydrateGitState(commit.stateAfter),
  }
}

export function rehydrateOperation(op: Operation): Operation {
  switch (op.action) {
    case 'placeOrder':
      return {
        ...op,
        order: op.order ? rehydrateOrder(op.order) : op.order,
      }
    case 'closePosition':
      return {
        ...op,
        quantity: op.quantity != null ? new Decimal(String(op.quantity)) : op.quantity,
      }
    default:
      return op
  }
}

export function rehydrateOrder(order: Order): Order {
  const rehydrated = Object.assign(new Order(), order)
  // Decimal fields need re-wrapping after JSON.parse — strings or numbers
  // become plain JS values, not Decimal instances. `new Decimal(String(x))`
  // accepts both legacy (number) and current (string) persisted forms.
  if (order.totalQuantity != null) {
    rehydrated.totalQuantity = new Decimal(String(order.totalQuantity))
  }
  if (order.lmtPrice != null) {
    rehydrated.lmtPrice = new Decimal(String(order.lmtPrice))
  }
  if (order.auxPrice != null) {
    rehydrated.auxPrice = new Decimal(String(order.auxPrice))
  }
  if (order.trailStopPrice != null) {
    rehydrated.trailStopPrice = new Decimal(String(order.trailStopPrice))
  }
  if (order.trailingPercent != null) {
    rehydrated.trailingPercent = new Decimal(String(order.trailingPercent))
  }
  if (order.cashQty != null) {
    rehydrated.cashQty = new Decimal(String(order.cashQty))
  }
  return rehydrated
}

export function rehydrateGitState(state: GitState): GitState {
  return {
    ...state,
    positions: state.positions.map((pos) => ({
      ...pos,
      quantity: new Decimal(String(pos.quantity)),
    })),
  }
}
