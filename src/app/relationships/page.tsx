'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useMemo, useState } from 'react'
import { Badge, Card, Empty, ErrorBox, Loading, Notice, useApi } from '@/components/ui'

interface Edge {
  from: string
  to: string
  type: string
  support: 'api' | 'link' | 'field' | 'text' | 'ai'
  direction: 'outgoing' | 'incoming'
  other: string
  decision: string | null
  evidence: { resourceId: string; resourceName: string; field: string | null; passage: string }
}
interface View {
  page: { id: string; name: string; kind: string; tags: string[]; aliases: string[]; read: boolean }
  edges: Edge[]
  neighbours: { id: string; name: string; kind: string; tags: string[]; read: boolean }[]
  labels: Record<string, string>
  coverage: { indexed: number; read: number }
  note: string
}

const SUPPORT: Record<Edge['support'], { label: string; dash: string; tone: 'good' | 'info' | 'neutral' | 'warn' }> = {
  api: { label: 'LegendKeeper data (page tree)', dash: '2 4', tone: 'good' },
  link: { label: 'link in the page', dash: '', tone: 'good' },
  field: { label: 'stated in a field', dash: '', tone: 'good' },
  text: { label: 'inferred from wording', dash: '6 4', tone: 'info' },
  ai: { label: 'AI suggestion you accepted', dash: '1 3', tone: 'warn' },
}
const KIND_COLOUR: Record<string, string> = {
  person: 'var(--info)',
  deity: 'var(--warn)',
  faction: 'var(--good)',
  place: 'var(--accent)',
  event: 'var(--bad)',
  creature: '#8a6d3b',
  item: '#6b7280',
  rule: '#6b7280',
  other: '#9ca3af',
}
const MAX_NODES = 30

export default function RelationshipsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Browser />
    </Suspense>
  )
}

function Browser() {
  const params = useSearchParams()
  const router = useRouter()
  const id = params.get('id')
  const [q, setQ] = useState('')
  const suggestions = useApi<{ rows: { id: string; name: string; kind: string; folder: string }[] }>(q.trim().length >= 2 ? `/api/advanced-search?q=${encodeURIComponent(q)}&limit=10` : null)
  const { data, error, loading } = useApi<View>(id ? `/api/relationships/${encodeURIComponent(id)}` : null)
  const [types, setTypes] = useState<Set<string>>(new Set())
  const [supports, setSupports] = useState<Set<string>>(new Set())
  const [kinds, setKinds] = useState<Set<string>>(new Set())
  const go = (target: string) => router.push(`/relationships?id=${encodeURIComponent(target)}`)

  const filtered = useMemo(() => {
    if (!data) return []
    const kindOf = new Map(data.neighbours.map((n) => [n.id, n.kind]))
    return data.edges.filter((e) => (!types.size || types.has(e.type)) && (!supports.size || supports.has(e.support)) && (!kinds.size || kinds.has(kindOf.get(e.other) ?? 'other')))
  }, [data, types, supports, kinds])

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, value: string) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }

  return (
    <>
      <div className="page-header">
        <h1>Relationship browser</h1>
        <p>
          One page and the pages it is connected to: its place in the page tree (from LegendKeeper), its links and labelled fields, and relationships inferred from
          wording. Click a neighbour to move to it. Incoming links are found by reading the pages audits have read, because LegendKeeper has no backlinks endpoint.
        </p>
      </div>
      <Card title="Choose a page">
        <input className="inline-input" style={{ width: '100%' }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a page name or alias" aria-label="Page name" />
        {suggestions.data && q.trim().length >= 2 && (
          <div className="pill-list" style={{ marginTop: '0.5rem' }}>
            {suggestions.data.rows.map((r) => (
              <button key={r.id} className="badge badge-neutral" style={{ cursor: 'pointer' }} onClick={() => (setQ(''), go(r.id))} title={r.folder}>
                {r.name} ({r.kind})
              </button>
            ))}
            {suggestions.data.rows.length === 0 && <span className="small muted">No page with that name in the last scan.</span>}
          </div>
        )}
      </Card>
      <ErrorBox error={error} />
      {!id && <Empty title="No page chosen">Pick a page above, or open one from the Knowledge analysis or the Task Assistant.</Empty>}
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card
            title={data.page.name}
            actions={
              <div className="row">
                <Link className="btn btn-ghost" href={`/pages/${encodeURIComponent(data.page.id)}`}>
                  Page details
                </Link>
                <a className="btn btn-ghost" href={`/api/exports/relationships?format=csv&resourceId=${encodeURIComponent(data.page.id)}`}>
                  Export CSV
                </a>
                <a className="btn btn-ghost" href={`/api/exports/relationships?format=json&resourceId=${encodeURIComponent(data.page.id)}`}>
                  Export JSON
                </a>
              </div>
            }
          >
            <div className="row small">
              <Badge>{data.page.kind}</Badge>
              {data.page.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              {data.page.aliases.length > 0 && <span className="muted">also: {data.page.aliases.join(', ')}</span>}
              {!data.page.read && <Badge tone="warn">content not read yet</Badge>}
            </div>
            <Filters data={data} types={types} supports={supports} kinds={kinds} toggle={toggle} setTypes={setTypes} setSupports={setSupports} setKinds={setKinds} />
            {filtered.length === 0 ? <p className="small muted">No relationships match.</p> : <Graph data={data} edges={filtered} onPick={go} />}
            <p className="small muted">{data.note}</p>
          </Card>
          <Card title={`Relationships (${filtered.length})`}>
            <EdgeTable data={data} edges={filtered} />
          </Card>
        </>
      )}
      {data && data.coverage.read < data.coverage.indexed && (
        <Notice tone="info">
          {data.coverage.indexed - data.coverage.read} page(s) have not been read by an audit, so links from them are not known here. Run a Wiki Health audit to include them.
        </Notice>
      )}
    </>
  )
}

function Filters(props: {
  data: View
  types: Set<string>
  supports: Set<string>
  kinds: Set<string>
  toggle: (set: Set<string>, setter: (s: Set<string>) => void, value: string) => void
  setTypes: (s: Set<string>) => void
  setSupports: (s: Set<string>) => void
  setKinds: (s: Set<string>) => void
}) {
  const { data, types, supports, kinds, toggle } = props
  const present = <T extends string>(values: T[]) => [...new Set(values)]
  return (
    <div className="small" style={{ margin: '0.5rem 0' }}>
      <div className="row">
        <span className="muted">Relationship:</span>
        {present(data.edges.map((e) => e.type)).map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={types.has(t)} onChange={() => toggle(types, props.setTypes, t)} /> {data.labels[t]}
          </label>
        ))}
      </div>
      <div className="row">
        <span className="muted">Support:</span>
        {present(data.edges.map((e) => e.support)).map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={supports.has(s)} onChange={() => toggle(supports, props.setSupports, s)} /> {SUPPORT[s].label}
          </label>
        ))}
      </div>
      <div className="row">
        <span className="muted">Neighbour kind:</span>
        {present(data.neighbours.map((n) => n.kind)).map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={kinds.has(k)} onChange={() => toggle(kinds, props.setKinds, k)} /> {k}
          </label>
        ))}
      </div>
    </div>
  )
}

/** The page in the middle, its neighbours around it; line style shows how the connection is supported. */
function Graph({ data, edges, onPick }: { data: View; edges: Edge[]; onPick: (id: string) => void }) {
  const byNeighbour = new Map<string, Edge[]>()
  for (const e of edges) byNeighbour.set(e.other, [...(byNeighbour.get(e.other) ?? []), e])
  const ordered = [...byNeighbour.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_NODES)
  const hidden = byNeighbour.size - ordered.length
  const W = 760
  const H = 520
  const cx = W / 2
  const cy = H / 2
  const R = Math.min(W, H) / 2 - 70
  const info = new Map(data.neighbours.map((n) => [n.id, n]))
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${data.page.name} and ${ordered.length} connected pages`} style={{ width: '100%', maxHeight: '32rem' }}>
        <defs>
          <marker id="rel-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
          </marker>
        </defs>
        {ordered.map(([id, es], i) => {
          const a = (2 * Math.PI * i) / ordered.length - Math.PI / 2
          const x = cx + R * Math.cos(a)
          const y = cy + R * Math.sin(a)
          const strongest = es.find((e) => e.support === 'field') ?? es.find((e) => e.support === 'link') ?? es[0]!
          const out = es.some((e) => e.direction === 'outgoing')
          const inc = es.some((e) => e.direction === 'incoming')
          return (
            <line
              key={`l-${id}`}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke="var(--muted)"
              strokeWidth={1 + Math.min(es.length, 4) * 0.5}
              strokeDasharray={SUPPORT[strongest.support].dash}
              markerEnd={out ? 'url(#rel-arrow)' : undefined}
              markerStart={inc ? 'url(#rel-arrow)' : undefined}
              opacity={0.7}
            >
              <title>{es.map((e) => `${e.direction === 'outgoing' ? data.page.name : info.get(id)?.name} ${data.labels[e.type]} ${e.direction === 'outgoing' ? info.get(id)?.name : data.page.name} (${SUPPORT[e.support].label})`).join('\n')}</title>
            </line>
          )
        })}
        {ordered.map(([id], i) => {
          const a = (2 * Math.PI * i) / ordered.length - Math.PI / 2
          const x = cx + R * Math.cos(a)
          const y = cy + R * Math.sin(a)
          const n = info.get(id)
          const anchor = Math.abs(Math.cos(a)) < 0.2 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end'
          const dx = anchor === 'start' ? 12 : anchor === 'end' ? -12 : 0
          const dy = anchor === 'middle' ? (Math.sin(a) > 0 ? 22 : -14) : 4
          const label = (n?.name ?? id).length > 26 ? `${(n?.name ?? id).slice(0, 25)}…` : n?.name ?? id
          return (
            <g key={`n-${id}`} role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => onPick(id)} onKeyDown={(e) => e.key === 'Enter' && onPick(id)}>
              <title>{`${n?.name ?? id} (${n?.kind ?? 'other'}). Click to move here.`}</title>
              <circle cx={x} cy={y} r={9} fill={KIND_COLOUR[n?.kind ?? 'other'] ?? '#9ca3af'} stroke="var(--surface)" strokeWidth={2} />
              <text x={x + dx} y={y + dy} textAnchor={anchor} fontSize={12} fill="var(--text)">
                {label}
              </text>
            </g>
          )
        })}
        <circle cx={cx} cy={cy} r={16} fill={KIND_COLOUR[data.page.kind] ?? '#9ca3af'} stroke="var(--text)" strokeWidth={2} />
        <text x={cx} y={cy + 34} textAnchor="middle" fontSize={14} fontWeight={600} fill="var(--text)">
          {data.page.name}
        </text>
      </svg>
      <figcaption className="small muted">
        Solid line: link or field · dashed: inferred from wording · dotted: page tree or accepted AI suggestion · arrow: direction · thicker: several connections.
        {hidden > 0 && ` ${hidden} more neighbour(s) are listed in the table below.`}
      </figcaption>
    </figure>
  )
}

function EdgeTable({ data, edges }: { data: View; edges: Edge[] }) {
  const name = new Map(data.neighbours.map((n) => [n.id, n.name]))
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Relationship</th>
            <th>Support</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e, i) => (
            <tr key={i}>
              <td>
                <Link href={`/relationships?id=${encodeURIComponent(e.other)}`}>{name.get(e.other) ?? e.other}</Link>
              </td>
              <td className="small">
                {e.direction === 'outgoing' ? `${data.page.name} ${data.labels[e.type]} this` : `this ${data.labels[e.type]} ${data.page.name}`}
              </td>
              <td>
                <Badge tone={SUPPORT[e.support].tone}>{SUPPORT[e.support].label}</Badge>
                {e.decision && <div className="small muted">your decision: {e.decision}</div>}
              </td>
              <td className="small">
                <Link href={`/pages/${encodeURIComponent(e.evidence.resourceId)}`}>{e.evidence.resourceName}</Link>
                {e.evidence.field && ` · ${e.evidence.field}`}: “{e.evidence.passage}”
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
