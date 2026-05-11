/**
 * Canonical decimal-string formatter — PHASE 1B INLINE HELPER.
 *
 * Phase 1c will replace this file with a re-export from
 * `src/domain/trading/canonical-decimal.ts`. Mirror of the Phase 0
 * private helper at `parity/generators/_canonical-decimal.ts`.
 *
 * Rules (v4 §6.1):
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

  let s = d.toFixed()

  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }

  if (s === '-0' || s === '0') return '0'

  return s
}
