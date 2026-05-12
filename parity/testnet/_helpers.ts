#!/usr/bin/env tsx
/**
 * parity/testnet/_helpers.ts
 *
 * Shared helpers for Binance testnet parity scripts.
 * Provides env-var gating, credential redaction, and structured logging.
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
  if (err instanceof Error) {
    console.error(`       ${err.message}`)
  } else if (err) {
    console.error(`       ${String(err)}`)
  }
}

/** Log a [cleanup] line to make the cleanup path observable. */
export function logCleanup(message: string): void {
  console.log(`[cleanup] ${message}`)
}
