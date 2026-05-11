/**
 * Hash v2 algorithm — canonical SHA-256 over wire-form commit intent.
 *
 * Per v4 §5 Phase 2: new commits embed `hashVersion: 2` + `intentFullHash`
 * (64-char SHA-256) + `hashInputTimestamp`. The hash input is the
 * canonical JSON of:
 *   { hashVersion: 2, parentHash, message, operations (wire form), hashInputTimestamp }
 *
 * The `hashVersion: 2` literal is embedded in the canonical input, binding
 * the hash to this algorithm version. A future v3 would have `hashVersion: 3`
 * in its input and produce different bytes.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from '../canonical-json.js'
import { operationToWire } from './operation-wire.js'
import type { CommitHash, Operation } from './types.js'

export interface HashV2Input {
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  hashInputTimestamp: string
}

export function generateIntentHashV2(input: HashV2Input): {
  intentFullHash: string
  shortHash: CommitHash
} {
  const canonical = canonicalJson({
    hashVersion: 2,
    parentHash: input.parentHash,
    message: input.message,
    operations: input.operations.map(operationToWire),
    hashInputTimestamp: input.hashInputTimestamp,
  })
  const intentFullHash = createHash('sha256').update(canonical).digest('hex')
  return { intentFullHash, shortHash: intentFullHash.slice(0, 8) }
}
