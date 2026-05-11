/**
 * PersistedCommit decoder — v4 §5 Phase 2 Deliverable 4.
 *
 * Discriminates a GitCommit (off disk or in-memory) by its hashVersion:
 *   - hashVersion === 2 → 'v2'; verify intentFullHash on demand.
 *   - hashVersion absent or === 1 → 'v1-opaque'; never recomputed.
 *
 * The verifier expects c.operations to be REHYDRATED (Decimal instances,
 * not strings) — wire-conversion expects Decimal class instances. Callers
 * run rehydrateOperation first.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from '../canonical-json.js'
import { operationToWire } from './operation-wire.js'
import type { GitCommit } from './types.js'

// ---- Variant types ----

export interface PersistedCommitV1Opaque {
  kind: 'v1-opaque'
  raw: GitCommit
}

export interface PersistedCommitV2 {
  kind: 'v2'
  commit: GitCommit
}

export type PersistedCommit = PersistedCommitV1Opaque | PersistedCommitV2

// ---- Classifier ----

export function classifyCommit(raw: GitCommit): PersistedCommit {
  if (raw.hashVersion === 2) return { kind: 'v2', commit: raw }
  return { kind: 'v1-opaque', raw }
}

// ---- Verifier ----

export interface VerifyResult {
  kind: 'verified' | 'mismatch' | 'skipped'
  hash: string
  expectedIntentFullHash?: string
  actualIntentFullHash?: string
  message?: string
}

export interface VerifyOptions {
  strict?: boolean
}

export function verifyCommit(persisted: PersistedCommit, opts: VerifyOptions = {}): VerifyResult {
  if (persisted.kind === 'v1-opaque') {
    return { kind: 'skipped', hash: persisted.raw.hash }
  }

  const c = persisted.commit
  if (c.intentFullHash === undefined || c.hashInputTimestamp === undefined) {
    const msg = `v2 commit ${c.hash} is missing intentFullHash or hashInputTimestamp`
    if (opts.strict) throw new Error(msg)
    return { kind: 'mismatch', hash: c.hash, message: msg }
  }

  const canonical = canonicalJson({
    hashVersion: 2,
    parentHash: c.parentHash,
    message: c.message,
    operations: c.operations.map(operationToWire),
    hashInputTimestamp: c.hashInputTimestamp,
  })
  const actualIntentFullHash = createHash('sha256').update(canonical).digest('hex')

  if (actualIntentFullHash !== c.intentFullHash) {
    const msg = `v2 commit ${c.hash}: intentFullHash mismatch (expected ${c.intentFullHash.slice(0, 8)}…, got ${actualIntentFullHash.slice(0, 8)}…)`
    if (opts.strict) throw new Error(msg)
    return {
      kind: 'mismatch',
      hash: c.hash,
      expectedIntentFullHash: c.intentFullHash,
      actualIntentFullHash,
      message: msg,
    }
  }

  return {
    kind: 'verified',
    hash: c.hash,
    actualIntentFullHash,
    expectedIntentFullHash: c.intentFullHash,
  }
}

// ---- Round-trip serialization ----

export function serializeCommit(persisted: PersistedCommit): GitCommit {
  return persisted.kind === 'v1-opaque' ? persisted.raw : persisted.commit
}
