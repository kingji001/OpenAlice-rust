/**
 * @traderalice/ibkr — re-export shim.
 *
 * v3 shipped this as a single package containing both DTO types and the
 * I/O layer. v4 Phase 1a split it into:
 *   - @traderalice/ibkr-types  (pure data classes, no I/O)
 *   - @traderalice/ibkr-client (connection, decoder, EClient)
 *
 * This shim re-exports both for back-compat. Kept for ≥1 minor release.
 * New code should import from the split packages directly.
 */

export * from '@traderalice/ibkr-types'
export * from '@traderalice/ibkr-client'
