// Types
export type {
  IBroker,
  Position,
  PlaceOrderResult,
  OpenOrder,
  AccountInfo,
  Quote,
  MarketClock,
  AccountCapabilities,
  BrokerConfigField,
  TpSlParams,
  // Margin trading types (Cross Margin / Binance pivot)
  MarginAccount,
  MarginAsset,
  MarginOrderParams,
  FundingTransfer,
  MarginOperationResult,
  // Futures trading types (USDM/COINM Futures expansion)
  FuturesOrderParams,
  FundingRate,
  LeverageSetting,
  MarkPriceSnapshot,
  PositionMode,
  MarginMode,
} from './types.js'

// Factory
export { createBroker } from './factory.js'

// Presets (the user-facing surface — many presets, few engines)
export { BROKER_PRESET_CATALOG, getBrokerPreset, isPaperPreset } from './preset-catalog.js'
export type { BrokerPresetDef, BrokerEngine, ModeOption, SubtitleSegment } from './preset-catalog.js'
export { BUILTIN_BROKER_PRESETS } from './presets.js'
export type { SerializedBrokerPreset } from './presets.js'

// CCXT
export { CcxtBroker } from './ccxt/index.js'
export { createCcxtProviderTools } from './ccxt/index.js'
export type { CcxtBrokerConfig } from './ccxt/index.js'

// Mock (test/paper infrastructure)
export { MockBroker } from './mock/MockBroker.js'
