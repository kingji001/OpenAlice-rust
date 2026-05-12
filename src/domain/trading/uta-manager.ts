/**
 * UTAManager — UTA lifecycle management, registry, and aggregation.
 *
 * Owns the full UTA lifecycle: create → register → reconnect → remove → close.
 * Also provides cross-UTA operations (aggregated equity, contract search).
 *
 * Phase 4f: UTAManager accepts an optional TradingCore binding and
 * TradingCoreConfig. When present, accounts whose `brokerImpl` resolves to
 * 'rust' are backed by a RustUtaProxy instead of the TS UnifiedTradingAccount.
 * When absent, ALL accounts use the TS path — backward compatible.
 */

import Decimal from 'decimal.js'
import type { Contract, ContractDescription, ContractDetails } from '@traderalice/ibkr'
import type { AccountCapabilities, BrokerHealth, BrokerHealthInfo } from './brokers/types.js'
import { CcxtBroker } from './brokers/ccxt/CcxtBroker.js'
import { createCcxtProviderTools } from './brokers/ccxt/ccxt-tools.js'
import { createBroker } from './brokers/factory.js'
import { getBrokerPreset } from './brokers/preset-catalog.js'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { RustUtaProxy } from './unified-trading-account-rust.js'
import { loadGitState, createGitPersister } from './git-persistence.js'
import { readUTAsConfig, type UTAConfig, type TradingCoreConfig } from '../../core/config.js'
import type { EventLog } from '../../core/event-log.js'
import type { ToolCenter } from '../../core/tool-center.js'
import type { ReconnectResult } from '../../core/types.js'
import type { FxService } from './fx-service.js'
import type { TradingCore } from '@traderalice/trading-core-bindings'
import './contract-ext.js'

/** Union type covering both TS and Rust-backed UTAs. */
export type AnyUta = UnifiedTradingAccount | RustUtaProxy

/** Type guard: returns true when the UTA is backed by the TS implementation. */
export function isTsUta(uta: AnyUta): uta is UnifiedTradingAccount {
  return uta instanceof UnifiedTradingAccount
}

/** Type guard: returns true when the UTA is backed by the Rust proxy. */
export function isRustProxy(uta: AnyUta): uta is RustUtaProxy {
  return uta instanceof RustUtaProxy
}

// ==================== UTA summary ====================

export interface UTASummary {
  id: string
  label: string
  capabilities: AccountCapabilities
  health: BrokerHealthInfo
}

// ==================== Aggregated equity ====================

export interface AggregatedEquity {
  totalEquity: string
  totalCash: string
  totalUnrealizedPnL: string
  totalRealizedPnL: string
  /** Present when one or more accounts used fallback FX rates. */
  fxWarnings?: string[]
  accounts: Array<{
    id: string
    label: string
    baseCurrency: string
    equity: string
    cash: string
    unrealizedPnL: string
    health: BrokerHealth
  }>
}

// ==================== Contract search result ====================

export interface ContractSearchResult {
  accountId: string
  results: ContractDescription[]
}

// ==================== UTAManager ====================

export class UTAManager {
  private entries = new Map<string, AnyUta>()
  private reconnecting = new Set<string>()

  private eventLog?: EventLog
  private toolCenter?: ToolCenter
  private fxService?: FxService
  /** Optional Rust napi binding — absent means all UTAs use the TS path. */
  private tradingCore?: TradingCore
  /** Rust routing config — resolves which broker impl to use per account type. */
  private tradingCoreConfig?: TradingCoreConfig

  constructor(deps?: {
    eventLog?: EventLog
    toolCenter?: ToolCenter
    fxService?: FxService
    tradingCore?: TradingCore
    tradingCoreConfig?: TradingCoreConfig
  }) {
    this.eventLog = deps?.eventLog
    this.toolCenter = deps?.toolCenter
    this.fxService = deps?.fxService
    this.tradingCore = deps?.tradingCore
    this.tradingCoreConfig = deps?.tradingCoreConfig
  }

  setFxService(fx: FxService): void {
    this.fxService = fx
  }

  // ==================== Routing ====================

  /**
   * Resolve which broker implementation to use for this account config.
   *
   * Priority order:
   * 1. Per-account `brokerImpl` override in the account config.
   * 2. Global default from `tradingCoreConfig.defaultBrokerImpl[accountType]`.
   * 3. Fall back to 'ts' when TradingCore is not initialized.
   *
   * CCXT accounts are pinned to 'ts' regardless of any override.
   */
  private _resolveImpl(cfg: UTAConfig): 'ts' | 'rust' {
    if (!this.tradingCore) return 'ts'

    const accountType = this._inferAccountType(cfg)

    // CCXT is always TS — never migrates (Phase 4f design decision D8)
    if (accountType === 'ccxt') return 'ts'

    const explicit = cfg.brokerImpl
    const globalDefault = this.tradingCoreConfig?.defaultBrokerImpl?.[
      accountType as keyof TradingCoreConfig['defaultBrokerImpl']
    ] ?? 'ts'

    return explicit ?? globalDefault
  }

  /** Infer a simple account type string from presetId. */
  private _inferAccountType(cfg: UTAConfig): string {
    const presetId = cfg.presetId ?? ''
    if (presetId.startsWith('mock')) return 'mock'
    if (presetId.startsWith('alpaca')) return 'alpaca'
    if (presetId.startsWith('ibkr')) return 'ibkr'
    // Any CCXT-backed preset
    if (presetId.startsWith('bybit') || presetId.startsWith('okx') ||
        presetId.startsWith('hyperliquid') || presetId.startsWith('bitget') ||
        presetId.startsWith('ccxt')) return 'ccxt'
    return 'mock'
  }

  /**
   * Spawn a UTA for the given config, dispatching to Rust proxy or TS
   * implementation based on resolved impl.
   */
  private async _spawnUta(cfg: UTAConfig): Promise<AnyUta> {
    const impl = this._resolveImpl(cfg)

    if (impl === 'rust') {
      if (!this.tradingCore || !this.eventLog) {
        throw new Error(
          `Account '${cfg.id}' configured for Rust impl but TradingCore or EventLog not initialized`,
        )
      }
      const proxy = new RustUtaProxy({
        accountConfig: cfg,
        tradingCore: this.tradingCore,
        eventLog: this.eventLog,
      })
      await proxy.start()
      return proxy
    }

    // TS path (existing implementation)
    return this._spawnTsUta(cfg)
  }

  /** Spawn a TS-backed UTA (original implementation path). */
  private async _spawnTsUta(cfg: UTAConfig): Promise<UnifiedTradingAccount> {
    const broker = createBroker(cfg, { fxService: this.fxService })
    const savedState = await loadGitState(cfg.id)
    return new UnifiedTradingAccount(broker, {
      guards: cfg.guards,
      savedState,
      onCommit: createGitPersister(cfg.id),
      onHealthChange: (utaId, health) => {
        this.eventLog?.append('account.health', { accountId: utaId, ...health })
      },
      eventLog: this.eventLog,
    })
  }

  // ==================== Lifecycle ====================

  /** Create a UTA from config, register it, and start async broker connection. */
  async initUTA(cfg: UTAConfig): Promise<AnyUta> {
    const uta = await this._spawnUta(cfg)
    this.add(uta)
    return uta
  }

  /** Reconnect a UTA: close old → re-read config → create new → verify connection. */
  async reconnectUTA(utaId: string): Promise<ReconnectResult> {
    if (this.reconnecting.has(utaId)) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    this.reconnecting.add(utaId)
    try {
      // Re-read config to pick up credential/guard changes
      const freshUTAs = await readUTAsConfig()

      // Close old UTA
      await this.removeUTA(utaId)

      const cfg = freshUTAs.find((a) => a.id === utaId)
      if (!cfg) {
        return { success: true, message: `UTA "${utaId}" not found in config (removed or disabled)` }
      }

      const uta = await this.initUTA(cfg)

      // Wait for broker connection to verify — only TS UTAs have waitForConnect().
      if (isTsUta(uta)) {
        await uta.waitForConnect()
      }

      // Re-register CCXT-specific tools if this UTA routes to the CCXT engine.
      if (getBrokerPreset(cfg.presetId).engine === 'ccxt') {
        this.toolCenter?.register(
          createCcxtProviderTools(this),
          'trading-ccxt',
        )
      }

      const label = uta.label ?? utaId
      console.log(`reconnect: ${label} online`)
      return { success: true, message: `${label} reconnected` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`reconnect: ${utaId} failed:`, msg)
      return { success: false, error: msg }
    } finally {
      this.reconnecting.delete(utaId)
    }
  }

  /** Close and deregister a UTA. No-op if UTA doesn't exist. */
  async removeUTA(utaId: string): Promise<void> {
    const uta = this.entries.get(utaId)
    if (!uta) return
    this.entries.delete(utaId)
    try { await uta.close() } catch { /* best effort */ }
  }

  /** Register CCXT provider tools if any CCXT accounts are present. */
  registerCcxtToolsIfNeeded(): void {
    const hasCcxt = this.resolve()
      .filter(isTsUta)
      .some((uta) => uta.broker instanceof CcxtBroker)
    if (hasCcxt) {
      this.toolCenter?.register(createCcxtProviderTools(this), 'trading-ccxt')
      console.log('ccxt: provider tools registered')
    }
  }

  // ==================== Registration ====================

  add(uta: AnyUta): void {
    if (this.entries.has(uta.id)) {
      throw new Error(`UTA "${uta.id}" already registered`)
    }
    this.entries.set(uta.id, uta)
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  // ==================== Lookups ====================

  get(id: string): AnyUta | undefined {
    return this.entries.get(id)
  }

  async listUTAs(): Promise<UTASummary[]> {
    return Promise.all(Array.from(this.entries.values()).map(async (uta) => ({
      id: uta.id,
      label: uta.label,
      capabilities: await uta.getCapabilities(),
      health: await uta.getHealthInfo(),
    })))
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  get size(): number {
    return this.entries.size
  }

  // ==================== Source routing ====================

  resolve(source?: string): AnyUta[] {
    if (!source) {
      return Array.from(this.entries.values())
    }
    const byId = this.entries.get(source)
    if (byId) return [byId]
    return []
  }

  resolveOne(source: string): AnyUta {
    const results = this.resolve(source)
    if (results.length === 0) {
      throw new Error(`No UTA found matching source "${source}". Use listUTAs to see available UTAs.`)
    }
    if (results.length > 1) {
      throw new Error(
        `Multiple UTAs match source "${source}": ${results.map((r) => r.id).join(', ')}. Use UTA id for exact match.`,
      )
    }
    return results[0]
  }

  // ==================== Cross-account aggregation ====================

  async getAggregatedEquity(): Promise<AggregatedEquity> {
    const results = await Promise.all(
      Array.from(this.entries.values()).map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
        try {
          const info = await uta.getAccount()
          return { id: uta.id, label: uta.label, health: uta.health, info }
        } catch {
          return { id: uta.id, label: uta.label, health: uta.health, info: null }
        }
      }),
    )

    let totalEquity = new Decimal(0)
    let totalCash = new Decimal(0)
    let totalUnrealizedPnL = new Decimal(0)
    let totalRealizedPnL = new Decimal(0)
    const fxWarnings: string[] = []
    const accounts: AggregatedEquity['accounts'] = []

    for (const { id, label, health, info } of results) {
      const baseCurrency = info?.baseCurrency ?? 'USD'
      if (info) {
        if (this.fxService && baseCurrency !== 'USD') {
          // Convert non-USD account values to USD
          const [eqR, cashR, pnlR, rpnlR] = await Promise.all([
            this.fxService.convertToUsd(info.netLiquidation, baseCurrency),
            this.fxService.convertToUsd(info.totalCashValue, baseCurrency),
            this.fxService.convertToUsd(info.unrealizedPnL, baseCurrency),
            this.fxService.convertToUsd(info.realizedPnL ?? '0', baseCurrency),
          ])
          totalEquity = totalEquity.plus(eqR.usd)
          totalCash = totalCash.plus(cashR.usd)
          totalUnrealizedPnL = totalUnrealizedPnL.plus(pnlR.usd)
          totalRealizedPnL = totalRealizedPnL.plus(rpnlR.usd)
          // Collect warnings (deduplicate — same currency produces same warning)
          const w = eqR.fxWarning
          if (w && !fxWarnings.includes(w)) fxWarnings.push(w)
          accounts.push({ id, label, baseCurrency, equity: eqR.usd, cash: cashR.usd, unrealizedPnL: pnlR.usd, health })
        } else {
          // Already USD or no FxService — pass through
          totalEquity = totalEquity.plus(info.netLiquidation)
          totalCash = totalCash.plus(info.totalCashValue)
          totalUnrealizedPnL = totalUnrealizedPnL.plus(info.unrealizedPnL)
          totalRealizedPnL = totalRealizedPnL.plus(info.realizedPnL ?? '0')
          accounts.push({ id, label, baseCurrency, equity: info.netLiquidation, cash: info.totalCashValue, unrealizedPnL: info.unrealizedPnL, health })
        }
      } else {
        accounts.push({ id, label, baseCurrency, equity: '0', cash: '0', unrealizedPnL: '0', health })
      }
    }

    return {
      totalEquity: totalEquity.toString(), totalCash: totalCash.toString(),
      totalUnrealizedPnL: totalUnrealizedPnL.toString(), totalRealizedPnL: totalRealizedPnL.toString(),
      fxWarnings: fxWarnings.length > 0 ? fxWarnings : undefined,
      accounts,
    }
  }

  // ==================== Cross-account contract search ====================

  async searchContracts(
    pattern: string,
    accountId?: string,
  ): Promise<ContractSearchResult[]> {
    const targets: AnyUta[] = accountId
      ? [this.entries.get(accountId)].filter((u): u is AnyUta => u != null)
      : Array.from(this.entries.values())

    const results = await Promise.all(
      targets.map(async (uta) => {
        if (uta.health !== 'healthy') {
          uta.nudgeRecovery()
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
        try {
          const descriptions = await uta.searchContracts(pattern)
          return { accountId: uta.id, results: descriptions }
        } catch {
          return { accountId: uta.id, results: [] as ContractDescription[] }
        }
      }),
    )

    return results.filter((r) => r.results.length > 0)
  }

  async getContractDetails(
    query: Contract,
    accountId: string,
  ): Promise<ContractDetails | null> {
    const uta = this.entries.get(accountId)
    if (!uta) return null
    // RustUtaProxy does not implement getContractDetails (Phase 6).
    if (isTsUta(uta)) return uta.getContractDetails(query)
    return null
  }

  // ==================== Cleanup ====================

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.entries.values()).map((uta) => uta.close()),
    )
    this.entries.clear()
  }
}
