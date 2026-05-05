# Legacy Path Fixtures

These two files match the legacy persister-path mapping at
`src/domain/trading/git-persistence.ts:18-22`:

| Fixture file | Loaded as if at | For accountId(s) |
|---|---|---|
| `crypto-trading-commit.json` | `data/crypto-trading/commit.json` | `bybit-main` |
| `securities-trading-commit.json` | `data/securities-trading/commit.json` | `alpaca-paper`, `alpaca-live` |

Both files are copies of `parity/fixtures/git-states/01-single-commit.json`
since the GitExportState shape is broker-agnostic (commits + head, not
account-specific).

`parity/load-legacy.ts` verifies that `loadGitState(<accountId>)` returns
the byte-identical file content when the legacy paths are populated.

The legacy path mapping is marked `TODO: remove before v1.0` in
git-persistence.ts. As long as that mapping exists, these fixtures
must remain in sync with the persister's path resolution logic.
