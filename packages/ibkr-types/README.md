# @traderalice/ibkr-types

Pure DTO types for IBKR TWS API v10.44.01. No I/O, no protocol logic, no
network code.

Includes the data classes (`Order`, `Contract`, `ContractDetails`,
`Execution`, `OrderState`, etc.), enums (`TickType`, `IneligibilityReason`,
`AccountSummaryTags`), and constants (`UNSET_DECIMAL`, `UNSET_DOUBLE`,
`UNSET_INTEGER`, `UNSET_LONG`).

For the I/O layer (Connection, EClient, EReader, Decoder, protobuf
wrappers), see [`@traderalice/ibkr-client`](../ibkr-client/).

For the back-compat re-export shim, see [`@traderalice/ibkr`](../ibkr/).
This shim package re-exports both `ibkr-types` and `ibkr-client` and is
kept for ≥1 minor release after Phase 1a.

## Why split

v3 shipped both DTOs and I/O in one package. v4 Phase 1a (per
[`docs/RUST_MIGRATION_PLAN.v4.md`](../../docs/RUST_MIGRATION_PLAN.v4.md))
split them so the Rust port can target the type surface independently
of the I/O implementation.
