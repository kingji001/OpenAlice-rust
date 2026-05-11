/**
 * Canonical JSON serializer.
 *
 * Public module per v4 §5 Phase 1c. Lifted from Phase 0's private helper
 * (parity/generators/_canonical-json.ts), deleted in Phase 1c Task C.
 *
 * Rules:
 *   - Sort object keys recursively (alphabetical).
 *   - Arrays preserve order (semantic).
 *   - No whitespace by default; pretty-printed via the `pretty` option.
 *   - Strings/numbers/null/booleans serialize via standard JSON rules.
 *
 * The caller is responsible for converting Decimals to canonical strings
 * BEFORE calling this — canonical-json operates on plain JSON values only.
 */

export type CanonicalJsonValue =
  | string | number | boolean | null
  | CanonicalJsonValue[]
  | { [k: string]: CanonicalJsonValue }

export function canonicalJson(value: CanonicalJsonValue, opts: { pretty?: boolean } = {}): string {
  const sortedReplacer = (_: string, v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k]
      }
      return sorted
    }
    return v
  }
  return opts.pretty
    ? JSON.stringify(value, sortedReplacer, 2)
    : JSON.stringify(value, sortedReplacer)
}
