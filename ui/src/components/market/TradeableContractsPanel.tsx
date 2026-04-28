import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { tradingApi, type ContractSearchHit } from '../../api/trading'
import { Card } from './Card'

interface Props {
  /** The data-vendor symbol the user is currently viewing. */
  symbol: string
}

/**
 * Bridges the analysis surface to the trading surface without merging
 * their identities. Searches every configured UTA's broker for contracts
 * matching the data-side symbol heuristically and lists them with their
 * canonical alice ids so a curious user can answer "if I wanted to act
 * on this, where would I do it?" — and so we get a non-AI inspection
 * window into UTA contract state for debugging.
 */
export function TradeableContractsPanel({ symbol }: Props) {
  const [hits, setHits] = useState<ContractSearchHit[] | null>(null)
  const [accountsConfigured, setAccountsConfigured] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    tradingApi.searchContracts(symbol)
      .then((res) => {
        if (cancelled) return
        setHits(res.results)
        setAccountsConfigured(res.accountsConfigured ?? null)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [symbol])

  const info = [
    'Endpoint: /api/trading/contracts/search',
    'Heuristic broker-side fuzzy match — symbol on the analysis side is just a query string here, not the canonical id.',
    'Tradeable identity is the broker\u2019s aliceId (alias:broker:exchange-id). Use it to actually place orders.',
  ].join('\n')

  return (
    <Card title="Tradeable on configured brokers" info={info}>
      {loading && <div className="text-[12px] text-text-muted">Searching brokers…</div>}
      {error && !loading && <div className="text-[12px] text-red-400">{error}</div>}

      {!loading && !error && accountsConfigured === 0 && (
        <div className="text-[12px] text-text-muted">
          No trading accounts configured.{' '}
          <Link to="/trading" className="text-accent hover:underline">
            Add one in Trading
          </Link>
          {' '}to see matching contracts here.
        </div>
      )}

      {!loading && !error && accountsConfigured !== 0 && hits && hits.length === 0 && (
        <div className="text-[12px] text-text-muted">
          No tradeable contracts matching <span className="font-mono">{symbol}</span> on your configured brokers.
        </div>
      )}

      {!loading && !error && hits && hits.length > 0 && (
        <ul className="flex flex-col divide-y divide-border/40 -mx-3">
          {hits.map((h, i) => (
            <ContractRow key={`${h.source}:${h.contract.aliceId ?? i}`} hit={h} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function ContractRow({ hit }: { hit: ContractSearchHit }) {
  const c = hit.contract
  const aliceId = c.aliceId as string | undefined
  return (
    <li className="px-3 py-2 flex items-baseline gap-3 text-[12px] hover:bg-bg-tertiary/40 transition-colors">
      <span className="font-mono font-semibold text-text">{c.symbol ?? '—'}</span>
      {c.secType && (
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted font-medium">
          {c.secType}
        </span>
      )}
      <span className="text-text-muted/70 truncate flex-1">
        {[c.description || c.localSymbol, c.primaryExchange ?? c.exchange, c.currency]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <span className="text-[10px] text-text-muted/60 shrink-0">{hit.source}</span>
      {aliceId && (
        <code
          className="text-[10px] font-mono text-text-muted truncate max-w-[260px]"
          title={aliceId}
        >
          {aliceId}
        </code>
      )}
    </li>
  )
}
