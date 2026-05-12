#!/usr/bin/env tsx
/**
 * parity/replay/replay.ts
 *
 * Phase 5 D4 — Replay harness skeleton.
 *
 * Skeleton only: parses CLI arguments, validates that the fixture path exists
 * when provided, and exits 0 with a status message.
 * Actual TS and Rust client replay will be added in the Phase 5 LIVE
 * deliverable or Phase 6.
 *
 * Usage:
 *   pnpm tsx parity/replay/replay.ts --fixture parity/replay/captured/alpaca/buy-1share/2026-05-12T14-30-00Z.json --target ts
 *   pnpm tsx parity/replay/replay.ts --help
 */

import { existsSync } from 'node:fs'

interface Args {
  fixture?: string
  target?: string
  verbose: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { verbose: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--fixture':
        args.fixture = argv[++i]
        break
      case '--target':
        args.target = argv[++i]
        break
      case '--verbose':
      case '-v':
        args.verbose = true
        break
      default:
        // Unknown flags are silently ignored in the skeleton.
        break
    }
  }
  return args
}

function printHelp(): void {
  console.log(`
parity/replay/replay.ts — broker fixture replayer (Phase 5 skeleton)

Usage:
  pnpm tsx parity/replay/replay.ts [options]

Options:
  --fixture <path>    Path to a captured fixture file (.json or .bin)
  --target <ts|rust>  Client implementation to replay against
  --verbose, -v       Print each replayed message
  --help, -h          Show this help message

Examples:
  pnpm tsx parity/replay/replay.ts \\
    --fixture parity/replay/captured/alpaca/buy-1share/2026-05-12T14-30-00Z.json \\
    --target ts

  pnpm tsx parity/replay/replay.ts \\
    --fixture parity/replay/captured/ibkr/place-limit-order/2026-05-12T14-30-00Z.bin \\
    --target rust

Status: SKELETON — no replay implemented for the Phase 5 offline half.
        Actual replay will be added in the Phase 5 LIVE or Phase 6 deliverable.
`.trim())
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  // If a fixture path was provided, validate it exists so callers get early feedback.
  if (args.fixture !== undefined) {
    if (!existsSync(args.fixture)) {
      console.error(`replay.ts — fixture not found: ${args.fixture}`)
      process.exit(1)
    }
  }

  const fixture = args.fixture ?? '(not specified)'
  const target = args.target ?? '(not specified)'
  console.log(`replay.ts — fixture=${fixture} target=${target}`)
  console.log('skeleton — no replay implemented for offline half')

  process.exit(0)
}

main()
