/**
 * BROKER_PRESET_CATALOG round-trip tests.
 *
 * For every preset, ensure:
 *   1. A reasonable presetConfig sample passes the preset's zodSchema
 *   2. toEngineConfig(parsed) produces a dict accepted by the target
 *      engine's configSchema
 *   3. isPaper / default isPaper resolves predictably
 *
 * This catches drift between preset declarations and engine schemas
 * (e.g. a preset adding a field the engine doesn't know about).
 */

import { describe, it, expect } from 'vitest'
import {
  BROKER_PRESET_CATALOG,
  getBrokerPreset,
  isPaperPreset,
  BINANCE_CROSS_MARGIN_PRESET,
  BINANCE_USDM_FUTURES_PRESET,
  BINANCE_COINM_FUTURES_PRESET,
  MOCK_PAPER_PRESET,
} from './preset-catalog.js'
import { BROKER_ENGINE_REGISTRY } from './registry.js'
import { BUILTIN_BROKER_PRESETS } from './presets.js'

// ==================== Sample data per preset ====================

/** Minimal valid presetConfig for each preset id. Use to round-trip through schema + engine. */
const SAMPLE_CONFIGS: Record<string, Record<string, unknown>> = {
  'binance-cross-margin':  { apiKey: 'k', secret: 's' },
  'binance-usdm-futures':  { apiKey: 'k', secret: 's' },
  'binance-coinm-futures': { apiKey: 'k', secret: 's' },
  'mock-paper':            {},
}

// ==================== Catalog integrity ====================

describe('BROKER_PRESET_CATALOG', () => {
  it('declares unique preset ids', () => {
    const ids = BROKER_PRESET_CATALOG.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('contains exactly binance-cross-margin, binance-usdm-futures, binance-coinm-futures, and mock-paper', () => {
    const ids = BROKER_PRESET_CATALOG.map(p => p.id).sort()
    expect(ids).toEqual(['binance-coinm-futures', 'binance-cross-margin', 'binance-usdm-futures', 'mock-paper'])
  })

  it('every preset id has a sample config in the test fixture', () => {
    for (const preset of BROKER_PRESET_CATALOG) {
      expect(SAMPLE_CONFIGS[preset.id], `missing SAMPLE_CONFIGS["${preset.id}"]`).toBeDefined()
    }
  })

  it('getBrokerPreset throws on unknown id', () => {
    expect(() => getBrokerPreset('does-not-exist')).toThrow(/Unknown broker preset/)
  })
})

// ==================== Per-preset round-trip ====================

describe.each(BROKER_PRESET_CATALOG)('preset $id', (preset) => {
  const sample = SAMPLE_CONFIGS[preset.id]

  it('zodSchema accepts the sample presetConfig', () => {
    expect(() => preset.zodSchema.parse(sample)).not.toThrow()
  })

  it('toEngineConfig output is accepted by the target engine schema', () => {
    const parsed = preset.zodSchema.parse(sample) as Record<string, unknown>
    const engineConfig = preset.toEngineConfig(parsed)
    const engineEntry = BROKER_ENGINE_REGISTRY[preset.engine]
    expect(() => engineEntry.configSchema.parse(engineConfig)).not.toThrow()
  })
})

// ==================== Engine config translation ====================

describe('preset → engine config translation', () => {
  it('Binance Cross Margin sets exchange=binance, tradingMode=cross-margin, sandbox=false', () => {
    const cfg = BINANCE_CROSS_MARGIN_PRESET.toEngineConfig({ apiKey: 'k', secret: 's' })
    expect(cfg.exchange).toBe('binance')
    expect(cfg.tradingMode).toBe('cross-margin')
    expect(cfg.sandbox).toBe(false)
    expect(cfg.apiKey).toBe('k')
    expect(cfg.secret).toBe('s')
  })

  it('Binance USDM Futures sets exchange=binance, tradingMode=usdm-futures, sandbox=false', () => {
    const cfg = BINANCE_USDM_FUTURES_PRESET.toEngineConfig({ apiKey: 'k', secret: 's' })
    expect(cfg.exchange).toBe('binance')
    expect(cfg.tradingMode).toBe('usdm-futures')
    expect(cfg.sandbox).toBe(false)
  })

  it('Binance COINM Futures sets exchange=binance, tradingMode=coinm-futures, sandbox=false', () => {
    const cfg = BINANCE_COINM_FUTURES_PRESET.toEngineConfig({ apiKey: 'k', secret: 's' })
    expect(cfg.exchange).toBe('binance')
    expect(cfg.tradingMode).toBe('coinm-futures')
    expect(cfg.sandbox).toBe(false)
  })

  it('Mock Paper produces empty engine config', () => {
    const cfg = MOCK_PAPER_PRESET.toEngineConfig({})
    expect(cfg).toEqual({})
  })
})

// ==================== isPaper helper ====================

describe('isPaperPreset', () => {
  it('Binance Cross Margin is never paper (real money)', () => {
    expect(isPaperPreset('binance-cross-margin', { apiKey: 'k', secret: 's' })).toBe(false)
  })

  it('mock-paper is always paper', () => {
    expect(isPaperPreset('mock-paper', {})).toBe(true)
  })

  it('getBrokerPreset throws for deleted preset ids (okx, bybit, alpaca, ibkr-tws, etc.)', () => {
    const deletedIds = ['okx', 'bybit', 'hyperliquid', 'bitget', 'alpaca', 'ibkr-tws', 'longbridge', 'leverup-monad', 'ccxt-custom']
    for (const id of deletedIds) {
      expect(() => getBrokerPreset(id)).toThrow(/Unknown broker preset/)
    }
  })
})

// ==================== Serialization ====================

describe('BUILTIN_BROKER_PRESETS', () => {
  it('serializes every catalog preset', () => {
    expect(BUILTIN_BROKER_PRESETS.map(p => p.id).sort()).toEqual(BROKER_PRESET_CATALOG.map(p => p.id).sort())
  })

  it('writeOnly markers applied to Binance credential fields', () => {
    const binance = BUILTIN_BROKER_PRESETS.find(p => p.id === 'binance-cross-margin')!
    const props = (binance.schema as { properties: Record<string, { writeOnly?: boolean }> }).properties
    expect(props.apiKey.writeOnly).toBe(true)
    expect(props.secret.writeOnly).toBe(true)
  })
})
