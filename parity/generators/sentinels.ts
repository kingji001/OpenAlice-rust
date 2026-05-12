/**
 * Sentinels fixture generator.
 *
 * Reads parity/decimal-inventory.md to find every numeric field flagged
 * value-or-unset, then emits one fixture per field (field set to its
 * sentinel; all other numeric fields at non-sentinel default) plus 5
 * "all sentinels at once" cases per type.
 *
 * Re-running overwrites the target dirs entirely. Idempotent.
 */

import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { UNSET_DECIMAL, UNSET_DOUBLE, UNSET_INTEGER } from '@traderalice/ibkr-types'
import { toCanonicalDecimalString } from '../../src/domain/trading/canonical-decimal.js'
import { canonicalJson, type CanonicalJsonValue } from '../../src/domain/trading/canonical-json.js'

interface FieldSpec {
  name: string
  type: 'decimal' | 'double' | 'integer'
}

/**
 * Parse parity/decimal-inventory.md to extract value-or-unset fields per type.
 * Returns a map of TypeName → FieldSpec[].
 *
 * Uses the Wire-type column (column 4) for authoritative type discrimination:
 *   WireDecimal  → decimal
 *   WireDouble   → double
 *   WireInteger  → integer
 */
async function parseInventory(): Promise<Map<string, FieldSpec[]>> {
  const md = await readFile(resolve('parity/decimal-inventory.md'), 'utf-8')
  const out = new Map<string, FieldSpec[]>()
  let currentType: string | null = null
  for (const line of md.split('\n')) {
    // Any level-2 heading resets the current type context.
    if (line.startsWith('## ')) {
      const headerMatch = line.match(/^## (Order|Contract|Execution|OrderState)$/)
      if (headerMatch) {
        currentType = headerMatch[1]
        out.set(currentType, [])
      } else {
        // Heading for a type we don't cover (Position, OpenOrder, etc.) — stop.
        currentType = null
      }
      continue
    }
    if (!currentType) continue
    // Match table rows with value-or-unset semantic class.
    // Row format: | `field` | `tsType` | value-or-unset | `WireType` | notes |
    const rowMatch = line.match(/^\| `([^`]+)` \| `[^`]+` \| value-or-unset \| `([^`]+)` \|/)
    if (rowMatch) {
      const [, field, wireType] = rowMatch
      let kind: FieldSpec['type']
      if (wireType === 'WireDecimal') {
        kind = 'decimal'
      } else if (wireType === 'WireDouble') {
        kind = 'double'
      } else if (wireType === 'WireInteger') {
        kind = 'integer'
      } else {
        // Fallback heuristic if wire type is unrecognised.
        kind = inferDoubleVsInteger(field)
      }
      out.get(currentType)!.push({ name: field, type: kind })
    }
  }
  return out
}

/**
 * Heuristic fallback: distinguish UNSET_DOUBLE vs UNSET_INTEGER when the
 * Wire-type column isn't one of the three expected values.
 * IBKR convention: most numeric fields are floating-point; integers are IDs,
 * sizes, counts, periods, strategy codes.
 */
function inferDoubleVsInteger(fieldName: string): 'double' | 'integer' {
  const integerPatterns = [/Id$/, /Size$/, /Count$/, /Days$/, /Period$/, /Number$/, /Strategy$/]
  for (const p of integerPatterns) {
    if (p.test(fieldName)) return 'integer'
  }
  return 'double'
}

function sentinelValue(field: FieldSpec): CanonicalJsonValue {
  if (field.type === 'decimal') return toCanonicalDecimalString(UNSET_DECIMAL)
  if (field.type === 'double') return UNSET_DOUBLE
  return UNSET_INTEGER
}

function emitFieldFixture(typeName: string, field: FieldSpec): CanonicalJsonValue {
  return {
    description: `${typeName}.${field.name} set to its sentinel; all other numeric fields at non-sentinel default.`,
    field: field.name,
    fieldKind: field.type,
    name: `${typeName}-${field.name}-unset`,
    sentinel: sentinelValue(field),
    type: typeName,
  }
}

function emitAllUnsetFixture(typeName: string, fields: FieldSpec[]): CanonicalJsonValue {
  const allFields: Record<string, CanonicalJsonValue> = {}
  for (const f of fields) {
    allFields[f.name] = sentinelValue(f)
  }
  return {
    description: `${typeName} with every value-or-unset field at its sentinel.`,
    fields: allFields,
    name: `${typeName}-all-unset`,
    type: typeName,
  }
}

async function emit(typeName: string, fields: FieldSpec[]): Promise<number> {
  const dirSlug = typeName.toLowerCase() + '-fields'
  const dir = resolve(`parity/fixtures/sentinels/${dirSlug}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  let n = 0
  for (const f of fields) {
    n++
    const idx = String(n).padStart(3, '0')
    await writeFile(
      join(dir, `case-${f.name}-unset-${idx}.json`),
      canonicalJson(emitFieldFixture(typeName, f), { pretty: true }),
    )
  }
  // Plus 5 "all unset" cases (variant by index — identical content; idempotent)
  for (let i = 1; i <= 5; i++) {
    n++
    const idx = String(n).padStart(3, '0')
    await writeFile(
      join(dir, `case-all-unset-${idx}.json`),
      canonicalJson(emitAllUnsetFixture(typeName, fields), { pretty: true }),
    )
  }
  return n
}

async function main(): Promise<void> {
  const inventory = await parseInventory()
  let total = 0
  for (const [typeName, fields] of inventory) {
    if (fields.length === 0) continue
    const n = await emit(typeName, fields)
    total += n
    console.log(`${typeName}: ${n} fixtures emitted (${fields.length} value-or-unset fields × 1 + 5 all-unset)`)
  }
  console.log(`Total sentinel fixtures: ${total}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
