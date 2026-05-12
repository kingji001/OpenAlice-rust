/**
 * Broker Preset Catalog — Zod-defined preset declarations.
 *
 * Single source of truth for every broker preset the wizard offers.
 * Each preset is one user-facing "account type".
 * Multiple presets map to a small set of engine implementations
 * (CcxtBroker, MockBroker).
 *
 * Pivot: Binance Cross Margin is the sole real broker. All Alpaca,
 * IBKR, Longbridge, LeverUp, Bybit, OKX, Hyperliquid, Bitget presets
 * have been removed. The mock-paper preset is retained as test
 * infrastructure.
 *
 * To add a new preset: add an entry below + register in BROKER_PRESET_CATALOG.
 */

import { z } from 'zod'

// ==================== Types ====================

export type BrokerEngine = 'ccxt' | 'mock'

export interface ModeOption {
  id: string
  label: string
}

/** Field shown on an account card under the account name (e.g., "Binance · Cross Margin"). */
export interface SubtitleSegment {
  /** Field path inside presetConfig (e.g., "mode"). */
  field: string
  /** Static text rendered when the field is truthy. */
  label?: string
  /** Static text rendered when the field is falsy (boolean fields only). */
  falseLabel?: string
  /** Prefix prepended to the value (text fields). */
  prefix?: string
}

export interface BrokerPresetDef {
  /** Stable id stored on disk in UTAConfig.presetId. */
  id: string
  /** User-facing label in the wizard. */
  label: string
  /** Short description shown under the label. */
  description: string
  /**
   * Group in the picker UI.
   */
  category: 'recommended' | 'crypto'
  /** Optional explanatory text rendered with the form. */
  hint?: string
  /** Default account id suggested in the wizard. */
  defaultName: string
  /** 2–3-char badge text for the account card. */
  badge: string
  /** Tailwind text color for the badge. */
  badgeColor: string
  /** Engine class invoked after preset resolution. */
  engine: BrokerEngine
  /** Guard category for the guards UI. */
  guardCategory: 'crypto' | 'securities'
  /** Zod schema for presetConfig — validates only the fields this preset uses. */
  zodSchema: z.ZodType
  /** Optional "Mode" dropdown (Live/Demo/Testnet/Paper/etc.). */
  modes?: ModeOption[]
  /** Account-card subtitle layout. */
  subtitleFields: SubtitleSegment[]
  /** Field names that should render as password inputs. */
  writeOnlyFields?: string[]
  /**
   * Translate validated preset form data into the engine's internal
   * config dict.
   */
  toEngineConfig: (presetData: Record<string, unknown>) => Record<string, unknown>
  /**
   * Whether a given preset config represents a paper/demo/testnet
   * account. Used by E2E test setup to filter out live accounts.
   * Default: true if presetData.mode is one of demo/testnet/paper.
   */
  isPaper?: (presetData: Record<string, unknown>) => boolean
}

// ==================== Helpers ====================

/** Default isPaper: any non-live mode counts as paper. */
function defaultIsPaper(data: Record<string, unknown>): boolean {
  const mode = String(data['mode'] ?? '').toLowerCase()
  return mode === 'demo' || mode === 'testnet' || mode === 'paper'
}

// ==================== CCXT-engine presets ====================

export const BINANCE_CROSS_MARGIN_PRESET: BrokerPresetDef = {
  id: 'binance-cross-margin',
  label: 'Binance Cross Margin',
  description: 'Binance Cross Margin Classic — spot + borrowed capital, up to 3×–5× leverage.',
  category: 'recommended',
  hint: 'Cross Margin uses a shared collateral pool across all positions. Orders placed without `sideEffectType` are spot; with `MARGIN_BUY` or `AUTO_REPAY` they draw/repay from the margin loan. Generate a Spot + Margin API key at binance.com/en/my/settings/api-management.',
  defaultName: 'binance-main',
  badge: 'BN',
  badgeColor: 'text-yellow-400',
  engine: 'ccxt',
  guardCategory: 'crypto',
  zodSchema: z.object({
    apiKey: z.string().min(1).describe('API Key'),
    secret: z.string().min(1).describe('API Secret'),
  }),
  subtitleFields: [
    { field: 'apiKey', prefix: 'Binance · ' },
  ],
  writeOnlyFields: ['apiKey', 'secret'],
  toEngineConfig: (d) => ({
    exchange: 'binance',
    tradingMode: 'cross-margin',
    sandbox: false,
    // apiKey + secret filled from env at runtime (passed via presetData)
    apiKey: d.apiKey,
    secret: d.secret,
  }),
  isPaper: () => false,
}

export const BINANCE_USDM_FUTURES_PRESET: BrokerPresetDef = {
  id: 'binance-usdm-futures',
  label: 'Binance USDⓈ-M Futures',
  description: 'Binance USDⓈ-M Perpetual Futures — USDT-margined, up to 125× leverage.',
  category: 'crypto',
  hint: 'USDⓈ-M Futures are settled in USDT/USDC. Generate an API key with Futures permission at binance.com/en/my/settings/api-management.',
  defaultName: 'binance-usdm',
  badge: 'BF',
  badgeColor: 'text-yellow-400',
  engine: 'ccxt',
  guardCategory: 'crypto',
  zodSchema: z.object({
    apiKey: z.string().min(1).describe('API Key'),
    secret: z.string().min(1).describe('API Secret'),
  }),
  subtitleFields: [
    { field: 'apiKey', prefix: 'Binance · ' },
  ],
  writeOnlyFields: ['apiKey', 'secret'],
  toEngineConfig: (d) => ({
    exchange: 'binance',
    tradingMode: 'usdm-futures',
    sandbox: false,
    apiKey: d.apiKey,
    secret: d.secret,
  }),
  isPaper: () => false,
}

export const BINANCE_COINM_FUTURES_PRESET: BrokerPresetDef = {
  id: 'binance-coinm-futures',
  label: 'Binance COIN-M Futures',
  description: 'Binance COIN-M Perpetual Futures — coin-margined (BTC, ETH, etc.).',
  category: 'crypto',
  hint: 'COIN-M Futures are settled in the base cryptocurrency. Generate an API key with Futures permission at binance.com/en/my/settings/api-management.',
  defaultName: 'binance-coinm',
  badge: 'BC',
  badgeColor: 'text-yellow-400',
  engine: 'ccxt',
  guardCategory: 'crypto',
  zodSchema: z.object({
    apiKey: z.string().min(1).describe('API Key'),
    secret: z.string().min(1).describe('API Secret'),
  }),
  subtitleFields: [
    { field: 'apiKey', prefix: 'Binance · ' },
  ],
  writeOnlyFields: ['apiKey', 'secret'],
  toEngineConfig: (d) => ({
    exchange: 'binance',
    tradingMode: 'coinm-futures',
    sandbox: false,
    apiKey: d.apiKey,
    secret: d.secret,
  }),
  isPaper: () => false,
}

// ==================== Mock-engine presets ====================

export const MOCK_PAPER_PRESET: BrokerPresetDef = {
  id: 'mock-paper',
  label: 'Mock Paper',
  description: 'In-memory mock broker for testing and paper trading. No real orders.',
  category: 'recommended',
  hint: 'The mock broker simulates fills instantly at the requested price. Use it for strategy testing without real money or real market connectivity.',
  defaultName: 'mock-paper',
  badge: 'MK',
  badgeColor: 'text-text-muted',
  engine: 'mock',
  guardCategory: 'crypto',
  zodSchema: z.object({}),
  subtitleFields: [],
  toEngineConfig: () => ({}),
  isPaper: () => true,
}

// ==================== Catalog ====================

export const BROKER_PRESET_CATALOG: BrokerPresetDef[] = [
  BINANCE_CROSS_MARGIN_PRESET,
  BINANCE_USDM_FUTURES_PRESET,
  BINANCE_COINM_FUTURES_PRESET,
  MOCK_PAPER_PRESET,
]

/** Lookup by id. Throws if unknown. */
export function getBrokerPreset(presetId: string): BrokerPresetDef {
  const preset = BROKER_PRESET_CATALOG.find(p => p.id === presetId)
  if (!preset) {
    throw new Error(`Unknown broker preset: "${presetId}". Known presets: ${BROKER_PRESET_CATALOG.map(p => p.id).join(', ')}`)
  }
  return preset
}

/** Returns true if presetId resolves to a paper/demo/testnet account. */
export function isPaperPreset(presetId: string, presetConfig: Record<string, unknown>): boolean {
  const preset = getBrokerPreset(presetId)
  return preset.isPaper ? preset.isPaper(presetConfig) : defaultIsPaper(presetConfig)
}
