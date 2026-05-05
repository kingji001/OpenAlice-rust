# v4 Open Decisions — Resolutions

**Date:** 2026-05-05
**Spec:** [v4 outline](../specs/2026-05-05-rust-migration-plan-v4-outline.md)
**Status:** Resolved (referenced by `RUST_MIGRATION_PLAN.v4.md` §11)

This document locks the four new open decisions raised in the v4 outline. Each
resolution is binding for v4; revisit only via an explicit `[v4-revisit]`
TODO.md entry tracked in a future migration phase.

---

## Decision 1 — §4.4 LeverUp scope

**Question:** Does LeverUp join the Rust port path, or stay TS-only like CCXT?

**Resolution:** Stay TS-only until LeverUp's TS impl stabilizes. Revisit
post-Phase-7.

**Rationale:** LeverUp's TODO.md entries (lines 232-257) indicate the TS
implementation is still in flux (whole-position close, no limit orders, EIP-712
signing). Porting an unstable TS impl to Rust would force the Rust port to
chase TS changes, violating P4 ("one concept per phase"). The Phase 4b
`Broker` trait still includes `BrokerCapabilities` (Phase 4b Deliverable 8) so
the trait shape doesn't need rework if §11 ever flips this decision later.

**v4 anchors:** §4.4 reads "stay TS until LeverUp's TS impl stabilizes" as
fact, not recommendation. §5 Phase 5 explicitly says "LeverUp NOT in scope."

---

## Decision 2 — §6.13 TODO.md as-is items

**Question:** Port "trading-git staging area lost on restart" and "cooldown
guard state lost on restart" as-is, or fix during port?

**Resolution:** Port as-is. Both bugs land in Rust as exact behavioral
parity with TS; fixes ride in separate post-Phase-7 PRs.

**Rationale:** P4 ("one concept per phase") forbids fix-during-port. Parity
fixtures pin current TS behavior; Rust port matches; later fix-PR updates
both impls together with new fixtures. Operator may misread the migration as
fixing these — mitigated by `[migration-deferred]` tags on TODO.md entries
(Phase 0 Deliverable 10) and explicit call-outs in Phase 3 / Phase 4c PR
bodies.

**v4 anchors:** §6.13 row 1 + row 2 — Decision column reads "Port-as-is."

---

## Decision 3 — §6.14 `getPortfolio` interleaving

**Question:** Accept current inconsistency between back-to-back
`getPositions()` + `getAccount()` calls, or introduce `getPortfolioSnapshot`
actor command for atomic read?

**Resolution:** Accept current inconsistency. `RustUtaProxy` does not ship
`getPortfolioSnapshot`. The hazard is documented in §6.14.

**Rationale:** Current TS code has the same inconsistency window — there is
no lock today either. Migrating preserves observed behavior (P4). A
`getPortfolioSnapshot` could land as a post-migration improvement once the
proxy is stable; design space is open then. Adding it to Phase 4f scope
mixes "port" with "fix," which is the explicit anti-pattern P4 forbids.

**v4 anchors:** §6.14 "Two options" subsection — option (a) is the chosen
path; option (b) is documented for future revisit.

---

## Decision 4 — §6.12.1 panic dedup threshold

**Question:** N consecutive `RUST_PANIC` errors → mark UTA disabled. What
is N?

**Resolution:** `N = 5`. Exposed via `tradingCore.panicDisableThreshold`
in the new config namespace (§6.10). Setting `N = 0` disables the
dedup behavior (panics never auto-disable; useful for development).

**Rationale:** 5 consecutive panics on the same UTA strongly suggests a
systemic bug, not a transient. Smaller N (e.g., 1-2) would auto-disable on
spurious panics that recover. Larger N (e.g., 10) would let a busted UTA
spin recovery indefinitely. 5 balances responsiveness with tolerance for
transient flakiness.

**v4 anchors:** §6.12.1 "Panic dedup" paragraph — "Default `N = 5`;
configurable via `tradingCore.panicDisableThreshold`."

---
