/**
 * Declaration merges: extends IBKR Contract and Order classes with
 * Alice-specific optional fields.
 *
 * aliceId is Alice's unique asset identifier: "{utaId}|{nativeKey}"
 * e.g. "alpaca-paper|META", "bybit-main|ETH/USDT:USDT"
 *
 * Constructed by UTA layer (not broker). Broker uses symbol/localSymbol for resolution.
 * The @traderalice/ibkr package stays a pure IBKR replica.
 *
 * localSymbol semantics by broker:
 * - IBKR: exchange-native symbol (e.g., "AAPL", "ESZ4")
 * - Alpaca: ticker symbol (e.g., "AAPL")
 * - CCXT: unified market symbol (e.g., "ETH/USDT:USDT")
 * UTA uses localSymbol as nativeKey in aliceId: "{utaId}|{nativeKey}"
 */

import '@traderalice/ibkr'

declare module '@traderalice/ibkr' {
  interface Contract {
    aliceId?: string
  }

  interface Order {
    /**
     * Margin-trading parameters. When present, the order routes through the
     * margin endpoint with the given side-effect type. When absent, the order
     * is a spot order (default behavior).
     *
     * Matches MarginOrderParams from brokers/types.ts — kept inline here to
     * avoid a circular import (types.ts → contract-ext.ts → types.ts).
     */
    marginParams?: {
      sideEffectType?: 'NO_SIDE_EFFECT' | 'MARGIN_BUY' | 'AUTO_REPAY'
      isIsolated?: boolean
      autoRepayAtCancel?: boolean
    }
  }
}
