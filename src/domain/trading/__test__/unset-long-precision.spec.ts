import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { UNSET_LONG } from '@traderalice/ibkr-types'

/**
 * UNSET_LONG precision check — Phase 1b deliverable 5.
 *
 * Per v4 §6.1 caveat, `UNSET_LONG = BigInt(2 ** 63) - 1n` was suspected to be
 * lossy because `2 ** 63 = 9.223372036854776e18` (a JS Number that exceeds
 * Number.MAX_SAFE_INTEGER) is rounded BEFORE the BigInt(...) wrap.
 *
 * Investigation shows the rounding goes UP (+1): BigInt(2**63) =
 * 9223372036854775808n, and subtracting 1n yields exactly 9223372036854775807n
 * — the canonical i64::MAX. The TS constant is therefore precise by accident:
 * the Number rounding error is corrected by the -1n step.
 *
 * This test pins that invariant as a regression net. If the constant definition
 * ever changes and becomes genuinely lossy, both assertions must be revisited.
 *
 * No current IBKR field defaults to UNSET_LONG (verified in Phase 0's
 * decimal-inventory.md). For future i64-bound fields, prefer reconstructing
 * i64::MAX from a canonical string rather than relying on this arithmetic.
 */
describe('UNSET_LONG vs canonical i64::MAX', () => {
  it('UNSET_LONG equals canonical i64::MAX (Number rounding cancels out)', () => {
    const i64Max = BigInt('9223372036854775807')
    // BigInt(2**63) rounds up to 9223372036854775808n; -1n lands on exact i64::MAX.
    expect(UNSET_LONG).toBe(i64Max)
  })

  it('canonical i64::MAX string round-trips exactly through Decimal', () => {
    const canonical = '9223372036854775807'
    const d = new Decimal(canonical)
    expect(d.toFixed()).toBe(canonical)
  })
})
