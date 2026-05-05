/**
 * Canonical decimal-string formatter — PRIVATE PHASE 0 HELPER.
 *
 * Phase 1c replaces this file with a re-export from
 * `src/domain/trading/canonical-decimal.ts`. Do not import this directly
 * from src/.
 *
 * Rules (mirror v4 §6.1):
 *   - No exponent / scientific notation.
 *   - No leading '+'.
 *   - No trailing decimal point.
 *   - Canonical zero = "0" (not "0.0", not "-0").
 *   - Negative sign only on nonzero values.
 *   - Reject NaN / Infinity / -0 with a thrown error.
 *   - Trailing zeros after decimal point are stripped.
 */

import Decimal from 'decimal.js'

export class CanonicalDecimalError extends Error {}

export function toCanonicalDecimalString(d: Decimal): string {
  if (d.isNaN()) throw new CanonicalDecimalError('NaN is not representable')
  if (!d.isFinite()) throw new CanonicalDecimalError('Infinity is not representable')

  // Use decimal.js's toFixed() to avoid exponent notation, then strip.
  // toFixed() with no arg returns the full precision without exponent.
  let s = d.toFixed()

  // Strip trailing zeros after decimal point (and the point itself if all zeros).
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }

  // Canonical zero handling: "-0" → "0", "0" stays "0".
  if (s === '-0' || s === '0') return '0'

  // No leading '+' to strip — decimal.js doesn't emit one.
  return s
}
