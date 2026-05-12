/**
 * RustUtaProxy — TypeScript-side proxy for a Rust-backed UTA actor.
 *
 * Mirrors the public surface of UnifiedTradingAccount so that UTAManager
 * can route accounts to Rust without changing callers. All heavy lifting
 * (order staging, git commit graph, broker calls) runs inside the Rust
 * UtaActor; this class is a thin napi bridge.
 *
 * Phase 4f: Mock broker only. Real brokers (Alpaca, IBKR) stay on the TS
 * path until Phase 5/6.
 */

import { TradingCore, type TradingCoreEvent } from '@traderalice/trading-core-bindings'
import { BrokerError } from './brokers/types.js'
import type {
  AccountCapabilities,
  AccountInfo,
  BrokerHealth,
  BrokerHealthInfo,
  OpenOrder,
  Position,
  Quote,
} from './brokers/types.js'
import type { ContractDescription } from '@traderalice/ibkr'
import type { Contract } from '@traderalice/ibkr'
import type {
  AddResult,
  CommitPrepareResult,
  PushResult,
  RejectResult,
  SyncResult,
  GitStatus,
  GitCommit,
  CommitLogEntry,
} from './git/types.js'
import type {
  StagePlaceOrderParams,
  StageModifyOrderParams,
  StageClosePositionParams,
} from './UnifiedTradingAccount.js'
import type { EventLog } from '../../core/event-log.js'
import type { UTAConfig } from '../../core/config.js'

// ==================== RustUtaProxy ====================

export class RustUtaProxy {
  public readonly id: string
  public readonly label: string

  private tc: TradingCore
  private eventLog: EventLog
  private accountConfig: UTAConfig
  private lastSeq = 0
  private _started = false
  private _eventQueue: Promise<void> = Promise.resolve()
  private _cachedHealth: BrokerHealth = 'healthy'
  private _cachedHealthInfo: BrokerHealthInfo = {
    status: 'healthy',
    consecutiveFailures: 0,
    recovering: false,
    disabled: false,
  }

  constructor(opts: {
    accountConfig: UTAConfig
    tradingCore: TradingCore
    eventLog: EventLog
  }) {
    this.id = opts.accountConfig.id
    this.label = opts.accountConfig.label ?? opts.accountConfig.id
    this.tc = opts.tradingCore
    this.eventLog = opts.eventLog
    this.accountConfig = opts.accountConfig
  }

  // ==================== Lifecycle ====================

  async start(): Promise<void> {
    if (this._started) return
    await this.tc.initUta({
      id: this.id,
      accountType: this._resolveAccountType(),
      brokerId: this._resolveBrokerId(),
      enabled: this.accountConfig.enabled ?? true,
      guards: (this.accountConfig.guards ?? []).map(g => ({
        guardType: g.type,
        configJson: JSON.stringify(g.options ?? {}),
      })),
      brokerConfig: {
        configJson: JSON.stringify(this.accountConfig.presetConfig ?? {}),
      },
    })
    this.tc.subscribeEvents(this.id, this._dispatchEvent.bind(this))
    this._started = true
  }

  async stop(): Promise<void> {
    if (!this._started) return
    await this.tc.shutdownUta(this.id)
    this._started = false
  }

  /** Surface a close() method matching UnifiedTradingAccount.close() signature. */
  async close(): Promise<void> {
    return this.stop()
  }

  // ==================== Health ====================

  get health(): BrokerHealth {
    return this._cachedHealth
  }

  get disabled(): boolean {
    return this._cachedHealth === 'offline' && this._cachedHealthInfo.disabled
  }

  async getHealthInfo(): Promise<BrokerHealthInfo> {
    return { ...this._cachedHealthInfo }
  }

  /** No-op: Rust actor manages its own recovery. Provided for interface parity. */
  nudgeRecovery(): void {
    void this.tc.nudgeRecovery(this.id).catch(() => {})
  }

  // ==================== Stage operations ====================

  async stagePlaceOrder(params: StagePlaceOrderParams): Promise<AddResult> {
    return this._call(async () => {
      const napiParams = {
        contractJson: JSON.stringify({ aliceId: params.aliceId, symbol: params.symbol }),
        orderJson: JSON.stringify({
          action: params.action,
          orderType: params.orderType,
          totalQuantity: params.totalQuantity,
          cashQty: params.cashQty,
          lmtPrice: params.lmtPrice,
          auxPrice: params.auxPrice,
          trailStopPrice: params.trailStopPrice,
          trailingPercent: params.trailingPercent,
          tif: params.tif ?? 'DAY',
          goodTillDate: params.goodTillDate,
          outsideRth: params.outsideRth,
          parentId: params.parentId,
          ocaGroup: params.ocaGroup,
        }),
        tpslJson: (params.takeProfit || params.stopLoss)
          ? JSON.stringify({ takeProfit: params.takeProfit, stopLoss: params.stopLoss })
          : undefined,
      }
      const result = await this.tc.stagePlaceOrder(this.id, napiParams)
      return {
        staged: true as const,
        index: result.index,
        operation: JSON.parse(result.operationJson),
      }
    })
  }

  async stageModifyOrder(params: StageModifyOrderParams): Promise<AddResult> {
    return this._call(async () => {
      const napiParams = {
        orderId: params.orderId,
        changesJson: JSON.stringify({
          totalQuantity: params.totalQuantity,
          lmtPrice: params.lmtPrice,
          auxPrice: params.auxPrice,
          trailStopPrice: params.trailStopPrice,
          trailingPercent: params.trailingPercent,
          orderType: params.orderType,
          tif: params.tif,
          goodTillDate: params.goodTillDate,
        }),
      }
      const result = await this.tc.stageModifyOrder(this.id, napiParams)
      return {
        staged: true as const,
        index: result.index,
        operation: JSON.parse(result.operationJson),
      }
    })
  }

  async stageClosePosition(params: StageClosePositionParams): Promise<AddResult> {
    return this._call(async () => {
      const napiParams = {
        contractJson: JSON.stringify({ aliceId: params.aliceId, symbol: params.symbol }),
        quantity: params.qty,
      }
      const result = await this.tc.stageClosePosition(this.id, napiParams)
      return {
        staged: true as const,
        index: result.index,
        operation: JSON.parse(result.operationJson),
      }
    })
  }

  // ==================== Git flow ====================

  async commit(message: string): Promise<CommitPrepareResult> {
    return this._call(async () => {
      const result = await this.tc.commit(this.id, message)
      return {
        prepared: true as const,
        hash: result.hash,
        message: result.message,
        operationCount: result.operationCount,
      }
    })
  }

  async push(): Promise<PushResult> {
    return this._call(async () => {
      const result = await this.tc.push(this.id)
      return {
        hash: result.hash,
        message: result.message,
        operationCount: result.operationCount,
        submitted: result.submitted.map(r => ({
          action: r.action as PushResult['submitted'][0]['action'],
          success: r.success,
          orderId: r.orderId,
          status: r.status as PushResult['submitted'][0]['status'],
          filledQty: r.filledQty,
          filledPrice: r.filledPrice,
          error: r.error,
        })),
        rejected: result.rejected.map(r => ({
          action: r.action as PushResult['rejected'][0]['action'],
          success: r.success,
          orderId: r.orderId,
          status: r.status as PushResult['rejected'][0]['status'],
          filledQty: r.filledQty,
          filledPrice: r.filledPrice,
          error: r.error,
        })),
      }
    })
  }

  async reject(reason?: string): Promise<RejectResult> {
    return this._call(async () => {
      const result = await this.tc.reject(this.id, reason ?? '')
      return {
        hash: result.hash,
        message: result.message,
        operationCount: result.operationCount,
      }
    })
  }

  async sync(_opts?: { delayMs?: number }): Promise<SyncResult> {
    return this._call(async () => {
      // Phase 4f: Mock broker sync — no real pending orders to query.
      // Returns a no-op result. Phase 6 will wire real order-status updates.
      const result = await this.tc.sync(this.id, [], '{}')
      return {
        hash: result.hash,
        updatedCount: result.updatedCount,
        updates: [],
      }
    })
  }

  // ==================== Git queries ====================

  async status(): Promise<GitStatus> {
    return this._call(async () => {
      const state = await this.tc.exportState(this.id)
      const commits: GitCommit[] = JSON.parse(state.commitsJson ?? '[]')
      return {
        staged: [],
        pendingMessage: null,
        pendingHash: null,
        head: state.head ?? null,
        commitCount: commits.length,
      }
    })
  }

  async log(options?: { limit?: number; symbol?: string }): Promise<CommitLogEntry[]> {
    return this._call(async () => {
      const state = await this.tc.exportState(this.id)
      let commits: GitCommit[] = JSON.parse(state.commitsJson ?? '[]')

      if (options?.symbol) {
        const sym = options.symbol
        commits = commits.filter(c =>
          c.operations.some(op => {
            if ('contract' in op && op.contract) {
              return op.contract.symbol === sym || op.contract.aliceId?.includes(sym)
            }
            return false
          }),
        )
      }

      if (options?.limit) {
        commits = commits.slice(-options.limit)
      }

      return commits.map(c => ({
        hash: c.hash,
        parentHash: c.parentHash,
        message: c.message,
        timestamp: c.timestamp,
        round: c.round,
        operations: c.operations.map(op => ({
          symbol: 'contract' in op && op.contract ? (op.contract.symbol ?? 'unknown') : 'unknown',
          action: op.action,
          change: op.action,
          status: 'submitted',
        })),
      }))
    })
  }

  async show(hash: string): Promise<GitCommit | null> {
    return this._call(async () => {
      const state = await this.tc.exportState(this.id)
      const commits: GitCommit[] = JSON.parse(state.commitsJson ?? '[]')
      return commits.find(c => c.hash === hash) ?? null
    })
  }

  // ==================== Read methods ====================

  async getAccount(): Promise<AccountInfo> {
    return this._call(async () => {
      const snap = await this.tc.getAccount(this.id)
      return {
        baseCurrency: 'USD',
        netLiquidation: snap.netLiquidation,
        totalCashValue: snap.totalCashValue,
        unrealizedPnL: snap.unrealizedPnL,
        realizedPnL: snap.realizedPnL,
      }
    })
  }

  async getPositions(): Promise<Position[]> {
    return this._call(async () => {
      const snaps = await this.tc.getPositions(this.id)
      return snaps.map(s => JSON.parse(s.positionJson) as Position)
    })
  }

  async getPendingOrderIds(): Promise<Array<{ orderId: string; symbol: string }>> {
    // Phase 4f: Derive from exported state. Pending orders = those in the
    // last commit's results with status 'submitted'.
    return this._call(async () => {
      const state = await this.tc.exportState(this.id)
      const commits = JSON.parse(state.commitsJson ?? '[]') as Array<{
        results?: Array<{ orderId?: string; status?: string }>
        operations?: Array<{ action?: string; contract?: { symbol?: string } }>
      }>
      if (commits.length === 0) return []
      const last = commits[commits.length - 1]
      const pending: Array<{ orderId: string; symbol: string }> = []
      if (last.results) {
        for (let i = 0; i < last.results.length; i++) {
          const r = last.results[i]
          if (r.status === 'submitted' && r.orderId) {
            const op = last.operations?.[i]
            const symbol = op?.contract?.symbol ?? 'unknown'
            pending.push({ orderId: r.orderId, symbol })
          }
        }
      }
      return pending
    })
  }

  async getMarketClock(): Promise<{ isOpen: boolean; nextOpen?: Date; nextClose?: Date; timestamp?: Date }> {
    // Phase 4f: Mock is always open.
    return { isOpen: true }
  }

  // ==================== Broker-passthrough stubs (Phase 6) ====================

  async getOrders(_orderIds: string[]): Promise<OpenOrder[]> {
    throw new Error('Phase 4f stub: getOrders requires broker passthrough — wired in Phase 6 with real brokers')
  }

  async getQuote(_contract: Contract): Promise<Quote> {
    throw new Error('Phase 4f stub: getQuote requires broker passthrough — wired in Phase 6 with real brokers')
  }

  async searchContracts(_pattern: string): Promise<ContractDescription[]> {
    throw new Error('Phase 4f stub: searchContracts requires broker passthrough — wired in Phase 6 with real brokers')
  }

  async getCapabilities(): Promise<AccountCapabilities> {
    // Mirror Mock broker's DEFAULT_CAPABILITIES for Phase 4f Mock-only scope.
    // Real brokers will query their own capability sets in Phase 6.
    return {
      supportedSecTypes: ['STK', 'CRYPTO'],
      supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT'],
    }
  }

  async stageCancelOrder(_params: { orderId: string }): Promise<AddResult> {
    throw new Error('Phase 4f stub: stageCancelOrder requires broker passthrough — wired in Phase 6 with real brokers')
  }

  // ==================== Error wrapping helper ====================

  async _call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('BROKER_ERROR:')) {
        const json = e.message.slice('BROKER_ERROR:'.length)
        let data: { message: string; code: string; permanent?: boolean; broker?: string }
        try {
          data = JSON.parse(json)
        } catch {
          throw e
        }
        const reconstructed = new Error(data.message)
        Object.setPrototypeOf(reconstructed, BrokerError.prototype)
        ;(reconstructed as any).name = 'BrokerError'
        // BrokerError.code and .permanent are readonly in TS, but we need to set
        // them on the reconstructed error. Use Object.defineProperty to bypass readonly.
        Object.defineProperty(reconstructed, 'code', { value: data.code, writable: false, enumerable: true })
        Object.defineProperty(reconstructed, 'permanent', { value: data.permanent ?? false, writable: false, enumerable: true })
        if (data.broker !== undefined) {
          Object.defineProperty(reconstructed, 'broker', { value: data.broker, writable: false, enumerable: true })
        }
        throw reconstructed
      }
      if (e instanceof Error && e.message.startsWith('RUST_PANIC:')) {
        const panicErr = new Error(e.message)
        ;(panicErr as Error & { code: string }).code = 'RUST_PANIC'
        throw panicErr
      }
      throw e
    }
  }

  // ==================== Event dispatch ====================

  private _dispatchEvent(err: Error | null, event?: TradingCoreEvent): void {
    if (err || !event) return

    // Queue all event processing onto a sequential promise chain so that
    // backfill is always awaited BEFORE _applyEvent runs for the triggering
    // event, preventing duplicate application of backfilled events.
    this._eventQueue = this._eventQueue.then(async () => {
      const expected = this.lastSeq + 1
      if (this.lastSeq > 0 && event.seq !== expected) {
        // Gap detected — backfill missed events up to (but not including) this event
        try {
          await this._backfill(this.lastSeq, event.seq)
        } catch (e) {
          console.warn(`[RustUtaProxy ${this.id}] backfill failed:`, e)
        }
      }
      this._applyEvent(event)
      this.lastSeq = Math.max(this.lastSeq, Number(event.seq))
    }).catch(e => {
      console.warn(`[RustUtaProxy ${this.id}] event dispatch error:`, e)
    })
  }

  private _applyEvent(event: TradingCoreEvent): void {
    let payload: unknown
    try {
      payload = JSON.parse(event.payloadJson)
    } catch {
      return
    }

    if (
      event.eventType === 'commit.notify' ||
      event.eventType === 'reject.notify'
    ) {
      void this.eventLog.append(event.eventType as 'commit.notify' | 'reject.notify', payload as never).catch(() => {})
    } else if (event.eventType === 'account.health') {
      const healthPayload = payload as {
        status?: string
        consecutiveFailures?: number
        message?: string
        recovering?: boolean
        disabled?: boolean
      }
      // Map Rust health status → TS BrokerHealth
      const status = this._mapHealthStatus(healthPayload.status)
      this._cachedHealth = status
      this._cachedHealthInfo = {
        status,
        consecutiveFailures: healthPayload.consecutiveFailures ?? 0,
        lastError: healthPayload.message,
        recovering: healthPayload.recovering ?? false,
        disabled: healthPayload.disabled ?? false,
      }
      void this.eventLog.append('account.health', {
        accountId: this.id,
        status,
        consecutiveFailures: this._cachedHealthInfo.consecutiveFailures,
      } as never).catch(() => {})
    }
  }

  private _mapHealthStatus(status: string | undefined): BrokerHealth {
    switch (status) {
      case 'healthy': return 'healthy'
      case 'degraded': return 'degraded'
      case 'offline':
      case 'unhealthy': return 'offline'
      default: return 'healthy'
    }
  }

  private async _backfill(afterSeq: number, upToSeq?: number): Promise<void> {
    const missed = this.tc.eventLogRecent(this.id, afterSeq)
    for (const ev of missed) {
      if (ev.seq > afterSeq && (upToSeq === undefined || ev.seq < upToSeq)) {
        this._applyEvent(ev)
        this.lastSeq = Math.max(this.lastSeq, Number(ev.seq))
      }
    }
  }

  // ==================== Internal helpers ====================

  private _resolveAccountType(): string {
    const presetId = this.accountConfig.presetId ?? ''
    if (presetId.startsWith('mock')) return 'mock'
    if (presetId.startsWith('alpaca')) return 'alpaca'
    if (presetId.startsWith('ibkr')) return 'ibkr'
    if (presetId.startsWith('bybit') || presetId.startsWith('okx') || presetId.startsWith('ccxt')) return 'ccxt'
    return 'mock'
  }

  private _resolveBrokerId(): string {
    // For Phase 4f: Mock broker
    const presetId = this.accountConfig.presetId ?? ''
    if (presetId === 'mock' || presetId.startsWith('mock-')) return presetId
    return 'mock-paper'
  }
}
