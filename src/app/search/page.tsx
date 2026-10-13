'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'

interface Result {
  total: number
  rows: { id: string; name: string; kind: string; tags: string[]; folder: string; read: boolean; why: string[] }[]
  note: string | null
}
interface Saved {
  id: string
  name: string
  query: Record<string, string>
}

const FIELDS: { key: string; label: string; placeholder?: string; type?: 'select'; options?: string[] }[] = [
  { key: 'q', label: 'Name or alias contains', placeholder: 'e.g. Sea Princes' },
  { key: 'kind', label: 'Kind', type: 'select', options: ['', 'person', 'deity', 'faction', 'place', 'event', 'creature', 'item', 'rule', 'other'] },
  { key: 'tags', label: 'Has all tags (comma-separated)', placeholder: 'NPC, Saltreach' },
  { key: 'folder', label: 'Inside folder (page id)', placeholder: 'page id' },
  { key: 'text', label: 'Text contains', placeholder: 'words on the page' },
  { key: 'field', label: 'Has field', placeholder: 'e.g. Alignment' },
  { key: 'fieldValue', label: 'Field value contains', placeholder: 'e.g. evil' },
  { key: 'dateFrom', label: 'Dated from year', placeholder: 'e.g. 570' },
  { key: 'dateTo', label: 'Dated to year', placeholder: 'e.g. 585' },
  { key: 'linksTo', label: 'Links to (page id)', placeholder: 'page id' },
  { key: 'linkedFrom', label: 'Linked from (page id)', placeholder: 'page id' },
  { key: 'findings', label: 'Open findings', type: 'select', options: ['', 'any', 'audit', 'knowledge', 'none'] },
  { key: 'read', label: 'Content read', type: 'select', options: ['', 'read', 'unread'] },
]

const MAIN_FIELDS = ['q', 'kind', 'tags', 'text']

export default function SearchPage() {
  const [form, setForm] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState<Record<string, string> | null>(null)
  const [untagged, setUntagged] = useState(false)
  const url = useMemo(() => {
    if (!submitted) return null
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(submitted)) if (v) p.set(k, v)
    return `/api/advanced-search?${p}`
  }, [submitted])
  const { data, error, loading } = useApi<Result>(url)
  const saved = useApi<{ searches: Saved[] }>('/api/saved-searches')
  const action = useAction()
  const [saveName, setSaveName] = useState('')
  const query = () => ({ ...form, ...(untagged ? { untagged: 'true' } : {}) })
  const renderField = (f: (typeof FIELDS)[number]) => (
    <label key={f.key}>
      {f.label}
      {f.type === 'select' ? (
        <select value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>
          {f.options!.map((o) => (
            <option key={o} value={o}>
              {o || '—'}
            </option>
          ))}
        </select>
      ) : (
        <input value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} placeholder={f.placeholder} />
      )}
    </label>
  )
  // Opened from the dashboard with a search: run it straight away.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')?.trim()
    if (!q) return
    setForm({ q })
    setSubmitted({ q })
  }, [])

  return (
    <>
      <div className="page-header">
        <h1>Search</h1>
        <p className="lead">
          Searches the local index and the content audits read; nothing is sent anywhere. For LegendKeeper&apos;s own full-text search, use the <Link href="/pages">Page browser</Link>.
        </p>
      </div>
      <Card title="Filters">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSubmitted(query())
          }}
        >
          <div className="filter-grid">{FIELDS.filter((f) => MAIN_FIELDS.includes(f.key)).map(renderField)}</div>
          <More label="More filters" open={FIELDS.some((f) => !MAIN_FIELDS.includes(f.key) && form[f.key]) || untagged}>
            <div className="filter-grid">
              {FIELDS.filter((f) => !MAIN_FIELDS.includes(f.key)).map(renderField)}
              <label className="check">
                <input type="checkbox" checked={untagged} onChange={(e) => setUntagged(e.target.checked)} /> Untagged only
              </label>
            </div>
          </More>
          <div className="row">
            <Button type="submit" variant="primary">
              Search
            </Button>
            <Button onClick={() => (setForm({}), setUntagged(false), setSubmitted(null))}>Clear</Button>
            <input className="inline-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name to save these filters as" />
            <Button
              disabled={!saveName.trim()}
              busy={action.busy}
              onClick={() =>
                void action.run(async () => {
                  saved.setData(await api.post<{ searches: Saved[] }>('/api/saved-searches', { action: 'save', name: saveName, query: query() }))
                  setSaveName('')
                })
              }
            >
              Save search
            </Button>
          </div>
        </form>
        {saved.data && saved.data.searches.length > 0 && (
          <div className="row small" style={{ marginTop: '0.6rem' }}>
            <span className="muted">Saved:</span>
            {saved.data.searches.map((s) => (
              <span key={s.id} className="row" style={{ gap: '0.2rem' }}>
                <button
                  className="badge badge-info"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const { untagged: u, ...rest } = s.query
                    setForm(rest)
                    setUntagged(u === 'true')
                    setSubmitted(s.query)
                  }}
                >
                  {s.name}
                </button>
                <button className="btn btn-ghost small" aria-label={`Delete saved search ${s.name}`} onClick={() => void action.run(async () => saved.setData(await api.post('/api/saved-searches', { action: 'delete', id: s.id })))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <ErrorBox error={action.error} />
      </Card>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && (
        <Card title={`${data.total} page(s)`}>
          {data.note && <Notice tone="info">{data.note}</Notice>}
          {data.rows.length === 0 ? (
            <Empty title="No pages match" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Kind</th>
                    <th>Tags</th>
                    <th>Why it matched</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/pages/${encodeURIComponent(r.id)}`}>{r.name}</Link>
                        <div className="small muted">{r.folder}</div>
                      </td>
                      <td className="small">{r.kind}</td>
                      <td className="small">{r.tags.join(', ') || <Badge tone="warn">untagged</Badge>}</td>
                      <td className="small">
                        {r.why.join(' · ')}{' '}
                        <Link href={`/relationships?id=${encodeURIComponent(r.id)}`} className="small">
                          relationships
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  )
}
