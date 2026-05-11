/**
 * Operation → wire-form converter for v2 hash inputs.
 *
 * Walks each Operation variant and converts IBKR-class fields (Order,
 * Contract) to wire form via Phase 1b adapters. Decimal fields outside
 * the wire-schema (e.g., closePosition.quantity) are canonicalized via
 * Phase 1c's toCanonicalDecimalString.
 *
 * Used by hash-v2.ts. The hash input is canonical JSON over the wire form.
 */

import { toCanonicalDecimalString } from '../canonical-decimal.js'
import type { CanonicalJsonValue } from '../canonical-json.js'
import {
  ibkrContractToWire,
  ibkrOrderToWire,
  ibkrPartialOrderToWire,
} from '../wire-adapters.js'
import type { TpSlParams } from '../brokers/types.js'
import type { Operation } from './types.js'

export function operationToWire(op: Operation): CanonicalJsonValue {
  switch (op.action) {
    case 'placeOrder':
      return {
        action: 'placeOrder',
        order: ibkrOrderToWire(op.order) as unknown as CanonicalJsonValue,
        contract: ibkrContractToWire(op.contract) as unknown as CanonicalJsonValue,
        ...(op.tpsl ? { tpsl: tpslToWire(op.tpsl) } : {}),
      }
    case 'modifyOrder':
      return {
        action: 'modifyOrder',
        orderId: op.orderId,
        changes: ibkrPartialOrderToWire(op.changes) as unknown as CanonicalJsonValue,
      }
    case 'closePosition':
      return {
        action: 'closePosition',
        contract: ibkrContractToWire(op.contract) as unknown as CanonicalJsonValue,
        ...(op.quantity ? { quantity: toCanonicalDecimalString(op.quantity) } : {}),
      }
    case 'cancelOrder':
      return {
        action: 'cancelOrder',
        orderId: op.orderId,
        ...(op.orderCancel ? { orderCancel: op.orderCancel as unknown as CanonicalJsonValue } : {}),
      }
    case 'syncOrders':
      return { action: 'syncOrders' }
  }
}

function tpslToWire(tpsl: TpSlParams): CanonicalJsonValue {
  return {
    ...(tpsl.takeProfit !== undefined ? { takeProfit: tpsl.takeProfit as unknown as CanonicalJsonValue } : {}),
    ...(tpsl.stopLoss !== undefined ? { stopLoss: tpsl.stopLoss as unknown as CanonicalJsonValue } : {}),
  }
}
