/**
 * TsUtaActor — single-mutator queue for UnifiedTradingAccount.
 *
 * Phase 4a: wraps every public UTA method in a FIFO queue so concurrent
 * calls serialize. Eliminates the latent race where parallel AI tool
 * calls today can interleave stage/commit/push on the same UTA.
 *
 * Strict no-reentrancy: handlers MUST NOT call actor.send() — that
 * deadlocks. Internal callers invoke _doFoo() impl methods directly.
 *
 * Spec: docs/superpowers/specs/2026-05-12-phase-4a-uta-actor-retrofit-design.md
 */

import type { Contract } from '@traderalice/ibkr'
import type {
  StagePlaceOrderParams,
  StageModifyOrderParams,
  StageClosePositionParams,
  UnifiedTradingAccount,
} from './UnifiedTradingAccount.js'
import type { PriceChangeInput } from './git/types.js'

// ============================================================================
// AsyncQueue — minimal FIFO queue with async pop
// ============================================================================

export class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(item: T) => void> = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  pop(): Promise<T> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T)
    return new Promise<T>((resolve) => this.waiters.push(resolve))
  }

  /** For test introspection only — not used in production. */
  get pendingCount(): number { return this.items.length }
}

// ============================================================================
// UtaCommand — one variant per public UTA method
// ============================================================================

export type UtaCommand =
  // ---- Mutators (touch local state) ----
  | { type: 'nudgeRecovery' }
  | { type: 'stagePlaceOrder'; params: StagePlaceOrderParams }
  | { type: 'stageModifyOrder'; params: StageModifyOrderParams }
  | { type: 'stageClosePosition'; params: StageClosePositionParams }
  | { type: 'stageCancelOrder'; params: { orderId: string } }
  | { type: 'commit'; message: string }
  | { type: 'push' }
  | { type: 'reject'; reason?: string }
  | { type: 'sync'; opts?: { delayMs?: number } }
  | { type: 'setCurrentRound'; round: number }
  | { type: 'close' }
  // ---- Local-state readers ----
  | { type: 'getHealthInfo' }
  | { type: 'log'; options?: { limit?: number; symbol?: string } }
  | { type: 'show'; hash: string }
  | { type: 'status' }
  | { type: 'getPendingOrderIds' }
  | { type: 'exportGitState' }
  | { type: 'getCapabilities' }
  // ---- Broker passthroughs (no local state) ----
  | { type: 'waitForConnect' }
  | { type: 'simulatePriceChange'; priceChanges: PriceChangeInput[] }
  | { type: 'getAccount' }
  | { type: 'getPositions' }
  | { type: 'getOrders'; orderIds: string[] }
  | { type: 'getQuote'; contract: Contract }
  | { type: 'getMarketClock' }
  | { type: 'searchContracts'; pattern: string }
  | { type: 'refreshCatalog' }
  | { type: 'getContractDetails'; query: Contract }
  | { type: 'getState' }

// ============================================================================
// TsUtaActor — single-mutator queue
// ============================================================================

interface QueuedCommand {
  cmd: UtaCommand
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timeoutMs?: number
}

export interface SendOptions {
  timeoutMs?: number
}

export class TsUtaActor {
  private readonly queue = new AsyncQueue<QueuedCommand>()
  private reentrancyDepth = 0
  private stopped = false

  constructor(private readonly uta: UnifiedTradingAccount) {
    void this.runLoop()
  }

  async send<R>(cmd: UtaCommand, opts: SendOptions = {}): Promise<R> {
    if (this.reentrancyDepth > 0) {
      throw new Error(
        `TsUtaActor: reentrant send() detected for command '${cmd.type}'. ` +
        `Command handlers must call _doFoo() impl methods directly, not actor.send().`,
      )
    }
    if (this.stopped) {
      throw new Error(`TsUtaActor: cannot send command '${cmd.type}' — actor stopped.`)
    }
    return new Promise<R>((resolve, reject) => {
      this.queue.push({
        cmd,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutMs: opts.timeoutMs,
      })
    })
  }

  /** For test introspection only. */
  get pendingCount(): number { return this.queue.pendingCount }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const queued = await this.queue.pop()
      this.reentrancyDepth++
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        const work = Promise.resolve(this.dispatch(queued.cmd))
        const result = queued.timeoutMs
          ? await Promise.race([
              work,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(
                  () => reject(new Error(`TsUtaActor: command '${queued.cmd.type}' timed out after ${queued.timeoutMs}ms`)),
                  queued.timeoutMs,
                )
              }),
            ])
          : await work
        queued.resolve(result)
      } catch (e) {
        queued.reject(e)
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        this.reentrancyDepth--
      }
    }
  }

  private dispatch(cmd: UtaCommand): Promise<unknown> | unknown {
    switch (cmd.type) {
      // ---- Mutators ----
      case 'nudgeRecovery':       return this.uta._doNudgeRecovery()
      case 'stagePlaceOrder':     return this.uta._doStagePlaceOrder(cmd.params)
      case 'stageModifyOrder':    return this.uta._doStageModifyOrder(cmd.params)
      case 'stageClosePosition':  return this.uta._doStageClosePosition(cmd.params)
      case 'stageCancelOrder':    return this.uta._doStageCancelOrder(cmd.params)
      case 'commit':              return this.uta._doCommit(cmd.message)
      case 'push':                return this.uta._doPush()
      case 'reject':              return this.uta._doReject(cmd.reason)
      case 'sync':                return this.uta._doSync(cmd.opts)
      case 'setCurrentRound':     return this.uta._doSetCurrentRound(cmd.round)
      case 'close':               return this.uta._doClose()
      // ---- Readers ----
      case 'getHealthInfo':       return this.uta._doGetHealthInfo()
      case 'log':                 return this.uta._doLog(cmd.options)
      case 'show':                return this.uta._doShow(cmd.hash)
      case 'status':              return this.uta._doStatus()
      case 'getPendingOrderIds':  return this.uta._doGetPendingOrderIds()
      case 'exportGitState':      return this.uta._doExportGitState()
      case 'getCapabilities':     return this.uta._doGetCapabilities()
      // ---- Broker passthroughs ----
      case 'waitForConnect':      return this.uta._doWaitForConnect()
      case 'simulatePriceChange': return this.uta._doSimulatePriceChange(cmd.priceChanges)
      case 'getAccount':          return this.uta._doGetAccount()
      case 'getPositions':        return this.uta._doGetPositions()
      case 'getOrders':           return this.uta._doGetOrders(cmd.orderIds)
      case 'getQuote':            return this.uta._doGetQuote(cmd.contract)
      case 'getMarketClock':      return this.uta._doGetMarketClock()
      case 'searchContracts':     return this.uta._doSearchContracts(cmd.pattern)
      case 'refreshCatalog':      return this.uta._doRefreshCatalog()
      case 'getContractDetails':  return this.uta._doGetContractDetails(cmd.query)
      case 'getState':            return this.uta._doGetState()
      default: {
        const _exhaustive: never = cmd
        throw new Error(`TsUtaActor: unknown command type ${(_exhaustive as { type: string }).type}`)
      }
    }
  }

}
