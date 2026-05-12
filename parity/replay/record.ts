#!/usr/bin/env tsx
/**
 * parity/replay/record.ts
 *
 * Phase 5 D4 — Record harness skeleton.
 *
 * Skeleton only: parses CLI arguments and exits 0 with a status message.
 * Actual HTTP (Alpaca) and TCP (IBKR) capture will be added in the Phase 5
 * LIVE deliverable or Phase 6.
 *
 * Usage:
 *   pnpm tsx parity/replay/record.ts --broker alpaca --scenario buy-1share
 *   pnpm tsx parity/replay/record.ts --help
 */

interface Args {
  broker?: string
  scenario?: string
  out?: string
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--broker':
        args.broker = argv[++i]
        break
      case '--scenario':
        args.scenario = argv[++i]
        break
      case '--out':
        args.out = argv[++i]
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
parity/replay/record.ts — broker interaction recorder (Phase 5 skeleton)

Usage:
  pnpm tsx parity/replay/record.ts [options]

Options:
  --broker <name>     Broker to record from: alpaca | ibkr
  --scenario <name>   Scenario name used in the fixture filename (kebab-case)
  --out <path>        Override output path (default: auto-generated)
  --help, -h          Show this help message

Fixture layout:
  parity/replay/captured/<broker>/<scenario>/<ISO-timestamp>.json   (HTTP)
  parity/replay/captured/<broker>/<scenario>/<ISO-timestamp>.bin    (TCP)

Status: SKELETON — no recording implemented for the Phase 5 offline half.
        Actual capture will be added in the Phase 5 LIVE or Phase 6 deliverable.
`.trim())
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  // Log what was requested so the caller knows the script ran correctly.
  const broker = args.broker ?? '(not specified)'
  const scenario = args.scenario ?? '(not specified)'
  console.log(`record.ts — broker=${broker} scenario=${scenario}`)
  console.log('skeleton — no recording implemented for offline half')

  process.exit(0)
}

main()
