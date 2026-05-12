#!/usr/bin/env tsx
/**
 * parity/run-rust.ts — Rust scenario runner mirroring run-ts.ts --scenario mode.
 *
 * Drives the Rust TradingGit (via napi binding) through the same lifecycle as
 * run-ts.ts --scenario. Outputs canonical JSON of the final GitExportState
 * so that parity/check-git.ts can do structural comparison vs the TS runner.
 * (Live byte parity needs Phase 4d work — see check-git.ts header.)
 *
 * Usage:
 *   pnpm tsx parity/run-rust.ts --scenario=<file> [--emit-git-state=<out>]
 *
 * Notes:
 *   - sync step type is NOT supported (Phase 4d). Scripts using `sync` op will error.
 *   - `stageSyncOrders` is supported (it's just a regular operation push).
 *   - Timestamps in Rust are real clock values; the parity harness compares
 *     exportState fields that DON'T include timestamps (canonical JSON of
 *     the structural fields only).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { TradingGit } from '../packages/trading-core-bindings/index.d.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const require = createRequire(import.meta.url)

const binding = require('../packages/trading-core-bindings/index.js') as {
  TradingGit: {
    create(): TradingGit
    restore(stateJson: string): TradingGit
  }
  ping(): string
}

// ---- Fixture types ----

interface OperationFixture {
  name: string
  operation: unknown
}

interface ScenarioFixture {
  name: string
  description?: string
  steps: ScenarioStep[]
}

type ScenarioStep =
  | { op: 'stagePlaceOrder' | 'stageModifyOrder' | 'stageClosePosition' | 'stageCancelOrder' | 'stageSyncOrders'; fixture: string }
  | { op: 'commit'; message: string }
  | { op: 'push'; stubResults?: unknown[] }
  | { op: 'reject'; reason?: string }
  | { op: 'sync'; updates: unknown[]; currentState: unknown }

async function loadOperationFixture(path: string): Promise<unknown> {
  const raw = JSON.parse(await readFile(path, 'utf-8')) as OperationFixture
  return raw.operation
}

// ---- Scenario runner ----

async function runScenario(scenarioPath: string): Promise<string> {
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf-8')) as ScenarioFixture
  const git = binding.TradingGit.create()

  for (const step of scenario.steps) {
    if (step.op === 'stagePlaceOrder' || step.op === 'stageModifyOrder' ||
        step.op === 'stageClosePosition' || step.op === 'stageCancelOrder' ||
        step.op === 'stageSyncOrders') {
      const fixturePath = resolve((step as { fixture: string }).fixture)
      const op = await loadOperationFixture(fixturePath)
      git.add(JSON.stringify(op))
    } else if (step.op === 'commit') {
      git.commit((step as { message: string }).message)
    } else if (step.op === 'push') {
      const pushStep = step as { stubResults?: unknown[] }
      const stubResults = pushStep.stubResults ?? []
      git.push(JSON.stringify(stubResults))
    } else if (step.op === 'reject') {
      const rejectStep = step as { reason?: string }
      git.reject(rejectStep.reason ?? undefined)
    } else if (step.op === 'sync') {
      // sync step type not supported in Phase 3 (Phase 4d adds it)
      throw new Error(`sync step type not supported in Phase 3 Rust binding (scenario: ${scenario.name})`)
    }
  }

  return git.canonicalExportState()
}

// ---- CLI dispatch ----

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const scenarioArg = args.find((a) => a.startsWith('--scenario='))
  if (!scenarioArg) {
    console.error('Usage: pnpm tsx parity/run-rust.ts --scenario=<file> [--emit-git-state=<out>]')
    process.exit(2)
  }

  const scenarioPath = scenarioArg.slice('--scenario='.length)
  const canonicalState = await runScenario(scenarioPath)

  const emitArg = args.find((a) => a.startsWith('--emit-git-state='))
  if (emitArg) {
    const out = emitArg.slice('--emit-git-state='.length)
    await writeFile(out, canonicalState)
    console.log(`wrote ${out}`)
  } else {
    console.log(canonicalState)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
