# Archive: v4 Multi-Broker Plan (Pre-Pivot)

These documents reflect OpenAlice's pre-pivot architecture, which targeted multiple real brokers (Alpaca, IBKR, CCXT, Longbridge, LeverUp) on top of the Rust core.

On 2026-05-13 the project pivoted to **Binance Cross Margin exclusive** focus. See `docs/binance-pivot-plan.md` for the active plan.

Documents in this folder are historical reference only:

- `RUST_MIGRATION_PLAN.v4.md` — full 8-phase migration plan (Phases 0-4f shipped; 5-8 obsolete)
- `migration-broker-decision.md` — broker port decision document (selected path: pivot, neither Alpaca nor IBKR ported)
- `alpaca-spike-REPORT.md` — Phase 5 offline survey of Alpaca port feasibility (~4.5 eng-days estimated)
- `ibkr-spike-REPORT.md` — Phase 5 offline survey of IBKR port feasibility (~15-17 eng-days estimated)

The technical findings remain accurate for the brokers surveyed — if OpenAlice ever reverses the pivot or adds a second broker, this archive is the starting evidence base.
