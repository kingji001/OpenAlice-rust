/**
 * Shared TradingGit-with-stubs builder for parity harness.
 *
 * TradingGit is constructed with stubbed callbacks — no MockBroker, no UTA
 * actor. The stub policy controls executeOperation results and getGitState
 * snapshots so that fixtures and scenarios are fully deterministic.
 *
 * Used by run-ts.ts (single, scenario, batch modes).
 */

import { TradingGit } from '../src/domain/trading/git/TradingGit.js'
import type { Operation, OperationResult, GitState } from '../src/domain/trading/git/types.js'

export interface StubPolicy {
  /** Returns the OperationResult for a given Operation about to be executed. */
  resultFor(operation: Operation): Promise<OperationResult>
  /** Returns the current broker-side GitState (positions, cash, pending orders). */
  stateNow(): Promise<GitState>
}

export const DEFAULT_GIT_STATE: GitState = {
  netLiquidation: '100000',
  totalCashValue: '100000',
  unrealizedPnL: '0',
  realizedPnL: '0',
  positions: [],
  pendingOrders: [],
}

export function buildTradingGit(stubPolicy: StubPolicy): TradingGit {
  return new TradingGit({
    executeOperation: (op) => stubPolicy.resultFor(op),
    getGitState: () => stubPolicy.stateNow(),
    onCommit: () => Promise.resolve(),  // no-op; persistence isn't tested in Phase 0
  })
}

/**
 * Default-stub policy used when a scenario step omits stubResults.
 * placeOrder → fills at order.totalQuantity / order.lmtPrice (or 100 if MKT).
 * Other actions → success: true with a synthetic orderId.
 */
export class DefaultStubPolicy implements StubPolicy {
  private callIndex = 0
  private state: GitState = DEFAULT_GIT_STATE

  async resultFor(op: Operation): Promise<OperationResult> {
    this.callIndex++
    const orderId = `mock-${this.callIndex}`
    if (op.action === 'placeOrder') {
      const filledQty = op.order.totalQuantity?.toString() ?? '0'
      // Use lmtPrice if set; otherwise fall back to 100.
      const filledPrice = op.order.lmtPrice && op.order.lmtPrice.toString() !== '0'
        ? op.order.lmtPrice.toString()
        : '100'
      return { action: 'placeOrder', success: true, orderId, status: 'filled', filledQty, filledPrice }
    }
    return { action: op.action, success: true, orderId, status: 'submitted' }
  }

  async stateNow(): Promise<GitState> {
    return this.state
  }

  setState(s: GitState): void {
    this.state = s
  }
}

/**
 * Scripted-stub policy used by scenario mode. Returns prescripted results
 * in order of operation. If exhausted, throws.
 */
export class ScriptedStubPolicy implements StubPolicy {
  private idx = 0
  constructor(private readonly results: OperationResult[], private state: GitState = DEFAULT_GIT_STATE) {}

  async resultFor(_op: Operation): Promise<OperationResult> {
    if (this.idx >= this.results.length) {
      throw new Error(`ScriptedStubPolicy exhausted at idx=${this.idx}`)
    }
    return this.results[this.idx++]
  }

  async stateNow(): Promise<GitState> {
    return this.state
  }

  setState(s: GitState): void {
    this.state = s
  }
}
