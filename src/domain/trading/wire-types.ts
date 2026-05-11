/**
 * Wire-format types for IBKR DTO classes — Phase 1b.
 *
 * Wire types are the FFI-crossing form: canonical, sentinel-aware,
 * IEEE-754-safe. Phase 1b ships these types + adapters as dead code.
 * Phase 2 wires them into TradingGit's hash inputs.
 *
 * See docs/superpowers/specs/2026-05-12-phase-1b-wire-types-design.md
 * for the design rationale.
 */

/** Canonical decimal-string form: no exponent, no leading +, no trailing
 *  decimal point, "0" for zero (never "-0"). Validated by wire-canonical-decimal.ts. */
export type DecimalString = string

/** Decimal field on the wire. Sentinels (UNSET_DECIMAL = 2^127-1) become
 *  { kind: 'unset' }; real values become { kind: 'value', value: <DecimalString> }. */
export type WireDecimal =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }

/** Floating-point field on the wire. Sentinels (UNSET_DOUBLE = Number.MAX_VALUE)
 *  become { kind: 'unset' }. Real values are string-encoded as DecimalString to
 *  avoid IEEE-754 drift across the FFI. */
export type WireDouble =
  | { kind: 'unset' }
  | { kind: 'value'; value: DecimalString }

/** Integer field on the wire. Sentinels (UNSET_INTEGER = 2^31-1) become
 *  { kind: 'unset' }; real values are unboxed numbers (safe-integer range). */
export type WireInteger =
  | { kind: 'unset' }
  | { kind: 'value'; value: number }
