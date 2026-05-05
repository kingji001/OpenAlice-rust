/**
 * Tests for GET /api/status — the release-gate health endpoint.
 *
 * Returns { ok: true, version: <package.json>, uptimeSeconds: <int>, ffiLoaded: false }.
 * `ffiLoaded` is `false` until Phase 4f wires RustUtaProxy.
 */

import { describe, it, expect } from 'vitest'
import { createStatusRoutes } from './status.js'

describe('GET /api/status', () => {
  it('returns ok=true with version and ffiLoaded=false', async () => {
    const app = createStatusRoutes()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; version: string; uptimeSeconds: number; ffiLoaded: boolean }
    expect(body.ok).toBe(true)
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)  // semver-ish
    expect(typeof body.uptimeSeconds).toBe('number')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(body.ffiLoaded).toBe(false)
  })

  it('uptimeSeconds increases between calls', async () => {
    const app = createStatusRoutes()
    const r1 = await app.request('/')
    const b1 = await r1.json() as { uptimeSeconds: number }
    await new Promise((r) => setTimeout(r, 1100))  // > 1s so the integer second ticks
    const r2 = await app.request('/')
    const b2 = await r2.json() as { uptimeSeconds: number }
    expect(b2.uptimeSeconds).toBeGreaterThan(b1.uptimeSeconds)
  })
})
