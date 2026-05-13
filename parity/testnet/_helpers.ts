#!/usr/bin/env tsx
/**
 * parity/testnet/_helpers.ts
 *
 * Shared helpers for Binance testnet parity scripts.
 * Provides env-var gating, credential redaction, structured logging,
 * dry-run mode, and Binance error code hints.
 *
 * SECURITY: never log or persist raw API keys or secrets.
 */

/**
 * Check that all named env vars are set. Returns a map of name→value if all
 * are present, or null if any are missing. Callers should call logSkip() and
 * exit when null is returned.
 */
export function requireEnv(...names: string[]): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = process.env[name]
    if (!value) return null
    out[name] = value
  }
  return out
}

/**
 * Redact a credential value for safe logging.
 * Shows first 4 + last 4 chars only; collapses short values to ****.
 */
export function redact(value: string | undefined): string {
  if (!value) return '<unset>'
  if (value.length < 8) return '****'
  return value.slice(0, 4) + '…' + value.slice(-4)
}

/**
 * Log a [skip] line and exit 0 (clean skip — not a failure).
 * Used when required env vars are absent so CI stays green.
 */
export function logSkip(reason: string): never {
  console.log(`[skip] ${reason}`)
  process.exit(0)
}

/** Log a [ok] success line. */
export function logOk(message: string): void {
  console.log(`[ok] ${message}`)
}

/** Log a [fail] error line with optional error detail. Never logs raw credentials. */
export function logFail(message: string, err?: unknown): void {
  console.error(`[fail] ${message}`)
  if (err !== undefined) {
    console.error(`       ${explainBinanceError(err)}`)
  }
}

/** Log a [cleanup] line to make the cleanup path observable. */
export function logCleanup(message: string): void {
  console.log(`[cleanup] ${message}`)
}

/**
 * Require BINANCE_DEMO_KEY and BINANCE_DEMO_SECRET env vars.
 * Returns { apiKey, secret } if both are set, or null if either is missing.
 * One demo account covers both USDⓈ-M and COIN-M futures via CCXT enableDemoTrading(true).
 * Register at https://demo.binance.com/
 */
export function requireDemoEnv(): { apiKey: string; secret: string } | null {
  const apiKey = process.env['BINANCE_DEMO_KEY']
  const secret = process.env['BINANCE_DEMO_SECRET']
  if (!apiKey || !secret) return null
  return { apiKey, secret }
}

// ── Dry-run mode ─────────────────────────────────────────────────────────────

/**
 * Returns true when BINANCE_TESTNET_DRY_RUN=1. In dry-run mode, scripts
 * print their intended call sequence without making any real network calls.
 */
export function shouldDryRun(): boolean {
  return process.env['BINANCE_TESTNET_DRY_RUN'] === '1'
}

/**
 * Log a single [dry-run] call entry.
 */
export function logDryRun(method: string, args: unknown): void {
  console.log(`[dry-run] ${method}(${JSON.stringify(args)})`)
}

// ── Binance error code hints ──────────────────────────────────────────────────

const BINANCE_ERROR_HINTS: Record<string, string> = {
  '-1003': 'rate limit exceeded — back off or check IP weight',
  '-1021': 'timestamp drift — sync system clock',
  '-1100': 'illegal characters in symbol — check CCXT canonical naming',
  '-1121': 'invalid symbol — symbol not on this product family (e.g., spot symbol on futures endpoint)',
  '-2010': 'insufficient balance — fund the testnet account first',
  '-2011': 'unknown order — already cancelled or never existed',
  '-2014': 'API key format invalid',
  '-2015': 'API key invalid, IP banned, or permissions missing',
  '-3045': 'no need to change position mode — already set',
  '-4046': 'no need to change margin type — already set',
  '-4059': 'no need to change position side — already set',
  '-4061': 'order side does not match position direction',
  '-5021': 'order would immediately match (use Post-Only to avoid)',
}

/**
 * Expand a Binance error with a human-readable hint when the CCXT error
 * message contains a recognisable Binance error code (-XXXX).
 */
export function explainBinanceError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const match = /(-\d{4,5})/.exec(err.message)
  if (match) {
    const code = match[1]
    const hint = BINANCE_ERROR_HINTS[code]
    if (hint) return `${err.message}\n       hint: ${hint}`
  }
  return err.message
}
