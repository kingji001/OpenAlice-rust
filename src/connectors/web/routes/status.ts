import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const startedAt = process.hrtime.bigint()
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }

/** Release-gate health endpoint — referenced by RUST_MIGRATION_PLAN.v4.md §3.4. */
export function createStatusRoutes() {
  const app = new Hono()

  app.get('/', (c) => {
    const elapsedNs = process.hrtime.bigint() - startedAt
    const uptimeSeconds = Number(elapsedNs / 1_000_000_000n)
    return c.json({
      ok: true,
      version: packageJson.version,
      uptimeSeconds,
      ffiLoaded: false,  // flips to true in Phase 4f when RustUtaProxy is wired
    })
  })

  return app
}
