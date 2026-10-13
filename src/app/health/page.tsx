'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { FindingRow, HealthDashboard } from '@/lib/types'

type Mode = 'all' | 'page_types' | 'folder' | 'criteria' | 'open_findings'
const PAGE_TYPES = [
  ['npc', 'NPC'],
  ['creature', 'Creature / statblock'],
  ['location', 'Location'],
  ['magic_item', 'Magic item'],
  ['rule', 'Rule / reference'],
  ['historical_event', 'Historical event'],
] as const

const SEVERITY_TONE = { problem: 'bad', suggestion: 'warn', info: 'neutral' } as const

export default function HealthPage() {
  const dash = useApi<HealthDashboard>('/api/health')
  const [category, setCategory] = useState<string>('')
  const [status, setStatus] = useState('open,queued')
  const [severity, setSeverity] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const query = new URLSearchParams({ status, limit: '100', offset: String(offset), ...(category ? { category } : {}), ...(severity ? { severity } : {}), ...(search ? { q: search } : {}) })
  const findings = useApi<{ items: FindingRow[]; total: number }>(`/api/health/findings?${query.toString()}`)
  const running = dash.data?.running ?? null

  const reloadDash = dash.reload
  const reloadFindings = findings.reload
  const runningId = running?.id ?? null
  useEffect(() => {
    if (!runningId) return
    const timer = setInterval(() => {
      void reloadDash()
      void reloadFindings()
    }, 2000)
    return () => {
      clearInterval(timer)
      // One last refresh when the audit ends.
      void reloadDash()
      void reloadFindings()
    }
  }, [runningId, reloadDash, reloadFindings])

  return (
    <>
      <div className="page-header">
        <h1>Wiki Health</h1>
        <p className="lead">A read-only check of your project for things worth a look.</p>
        <More>
          <p className="small">
            A read-only check of your LegendKeeper project. It never changes anything; it lists things worth a look, says how sure it is, and remembers what you dismissed or
          marked intentional. Fixes happen in the Tagging assistant, Template migration, or LegendKeeper itself.
          </p>
        </More>
      </div>
      <ErrorBox error={dash.error} />
      {dash.loading && !dash.data && <Loading />}
      {dash.data && !dash.data.projectId && <Notice tone="warning">Not connected to LegendKeeper yet. Check the Connection page.</Notice>}
      {dash.data?.projectId && (
        <>
          <Card title="Overview">
            <div className="stats">
              <Tile label="Pages in the index" value={dash.data.indexed} note={`${dash.data.contentRead} read by audits`} />
              <Tile label="Untagged pages" value={dash.data.untaggedInIndex} onClick={() => setCategory('untagged')} />
              {dash.data.categories
                .filter((c) => c.id !== 'untagged')
                .map((c) => (
                  <Tile key={c.id} label={c.label} value={c.open} note={c.problems ? `${c.problems} problem(s)` : undefined} onClick={() => setCategory(c.id)} active={category === c.id} />
                ))}
              <Tile label="Outstanding review items" value={dash.data.totals?.needsReview ?? 0} />
              <Tile label="Completed maintenance jobs" value={dash.data.completedMaintenanceJobs} />
            </div>
            <p className="small muted">
              Counts come from the latest audits and the project index. Editing page text in LegendKeeper does not change a page’s “last updated” time, so content changes
              are only noticed by the next audit.
            </p>
          </Card>
          <RunAudit dash={dash.data} onChange={() => { void dash.reload(); void findings.reload() }} />
          <Card
            title={`Findings (${findings.data?.total ?? 0})`}
            actions={
              <div className="row">
                <a className="btn btn-ghost" href={`/api/health/export?format=csv&status=${status}`}>
                  Export CSV
                </a>
                <a className="btn btn-ghost" href={`/api/health/export?format=json&status=${status}`}>
                  Export JSON
                </a>
              </div>
            }
          >
            <div className="row toolbar">
              <select aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setOffset(0) }}>
                <option value="">All categories</option>
                {dash.data.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0) }}>
                <option value="open,queued">Open and queued</option>
                <option value="open">Open</option>
                <option value="queued">Maintenance queue</option>
                <option value="dismissed,intentional">Dismissed or intentional</option>
                <option value="resolved">Resolved</option>
              </select>
              <select aria-label="Severity" value={severity} onChange={(e) => { setSeverity(e.target.value); setOffset(0) }}>
                <option value="">Problems and suggestions</option>
                <option value="problem">Problems only</option>
                <option value="suggestion">Suggestions only</option>
                <option value="info">For information</option>
              </select>
              <input aria-label="Search findings" type="search" placeholder="Search page names" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} />
            </div>
            <FindingsTable data={findings.data} loading={findings.loading} onChange={() => { void findings.reload(); void dash.reload() }} />
            {findings.data && findings.data.total > 100 && (
              <div className="row">
                <Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
                  Previous
                </Button>
                <span className="small">
                  {offset + 1}–{Math.min(offset + 100, findings.data.total)} of {findings.data.total}
                </span>
                <Button variant="ghost" disabled={offset + 100 >= findings.data.total} onClick={() => setOffset(offset + 100)}>
                  Next
                </Button>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  )
}

function Tile({ label, value, note, onClick, active }: { label: string; value: number; note?: string; onClick?: () => void; active?: boolean }) {
  const body = (
    <>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="small muted">{note}</div>}
    </>
  )
  return onClick ? (
    <button type="button" className={`stat stat-button${active ? ' stat-active' : ''}`} onClick={onClick} title={`Show ${label.toLowerCase()}`}>
      {body}
    </button>
  ) : (
    <div className="stat">{body}</div>
  )
}

function RunAudit({ dash, onChange }: { dash: HealthDashboard; onChange: () => void }) {
  const action = useAction()
  const [mode, setMode] = useState<Mode>('all')
  const [types, setTypes] = useState<string[]>([])
  const [folderId, setFolderId] = useState('')
  const [tag, setTag] = useState('')
  const [nameContains, setNameContains] = useState('')
  const [untaggedOnly, setUntaggedOnly] = useState(false)
  const [readContent, setReadContent] = useState(true)
  const [checks, setChecks] = useState<string[]>(dash.categories.map((c) => c.id))
  const run = dash.running
  const last = dash.runs[0]
  const start = () =>
    action.run(async () => {
      await api.post('/api/health/audits', {
        mode,
        pageTypes: types,
        folderId: folderId || null,
        criteria: { tag: tag || null, nameContains: nameContains || null, untaggedOnly },
        readContent,
        checks,
      })
      onChange()
    })
  return (
    <Card title="Run an audit">
      <ErrorBox error={action.error} />
      {run && (
        <Notice>
          Auditing… {run.processed} of {run.total} page(s) read
          {run.total > 0 && <progress value={run.processed} max={run.total} style={{ marginLeft: '0.5rem' }} />}{' '}
          <Button variant="ghost" onClick={() => void action.run(async () => { await api.post(`/api/health/audits/${run.id}`, { action: 'stop' }); onChange() })}>
            Stop
          </Button>
        </Notice>
      )}
      {!run && last && (
        <p className="small">
          Last audit: {formatDate(last.startedAt)} — <Badge tone={last.status === 'completed' ? 'good' : last.status === 'interrupted' ? 'warn' : 'neutral'}>{last.status}</Badge>{' '}
          {String((last.summary as { findings?: number }).findings ?? '')} finding(s), {last.fetched} page(s) read{last.error ? ` · ${last.error}` : ''}{' '}
          {(last.status === 'interrupted' || last.status === 'cancelled') && (
            <Button variant="ghost" onClick={() => void action.run(async () => { await api.post(`/api/health/audits/${last.id}`, { action: 'resume' }); onChange() })}>
              Resume
            </Button>
          )}
        </p>
      )}
      <More label="Audit options" open={mode !== 'all' || checks.length !== dash.categories.length || !readContent}>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="a-mode">What to check</label>
          <select id="a-mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="all">The whole project</option>
            <option value="page_types">Pages of some types (by their tags)</option>
            <option value="folder">One folder (a page and everything under it)</option>
            <option value="criteria">Pages matching a tag or name</option>
            <option value="open_findings">Pages with open findings (check them again)</option>
          </select>
          {mode === 'page_types' && (
            <div className="row">
              {PAGE_TYPES.map(([id, label]) => (
                <label key={id} className="check">
                  <input type="checkbox" checked={types.includes(id)} onChange={(e) => setTypes(e.target.checked ? [...types, id] : types.filter((t) => t !== id))} /> {label}
                </label>
              ))}
            </div>
          )}
          {mode === 'folder' && (
            <>
              <label htmlFor="a-folder">Folder page ID</label>
              <input id="a-folder" type="text" value={folderId} onChange={(e) => setFolderId(e.target.value)} placeholder="from the Page browser" />
            </>
          )}
          {mode === 'criteria' && (
            <>
              <label htmlFor="a-tag">Has tag</label>
              <input id="a-tag" type="text" value={tag} onChange={(e) => setTag(e.target.value)} />
              <label htmlFor="a-name">Name contains</label>
              <input id="a-name" type="text" value={nameContains} onChange={(e) => setNameContains(e.target.value)} />
              <label className="check">
                <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} /> Only untagged pages
              </label>
            </>
          )}
          <label className="check" style={{ marginTop: '0.5rem' }}>
            <input type="checkbox" checked={readContent} onChange={(e) => setReadContent(e.target.checked)} /> Read page content (needed for layout, field, link and source checks; about 4 pages a second)
          </label>
        </div>
        <div className="field">
          <label>Checks</label>
          {dash.categories.map((c) => (
            <label key={c.id} className="check" title={c.description}>
              <input type="checkbox" checked={checks.includes(c.id)} onChange={(e) => setChecks(e.target.checked ? [...checks, c.id] : checks.filter((x) => x !== c.id))} /> {c.label}
              {c.needsContent && <span className="muted small"> (reads content)</span>}
            </label>
          ))}
        </div>
      </div>
      </More>
      <div className="row">
        <Button variant="primary" busy={action.busy} disabled={Boolean(run) || checks.length === 0} onClick={() => void start()}>
          Start audit
        </Button>
        <span className="small muted">{mode === 'all' && checks.length === dash.categories.length ? 'Every check, on the whole project.' : 'With the options you chose.'}</span>
      </div>
    </Card>
  )
}

function FindingsTable({ data, loading, onChange }: { data: { items: FindingRow[]; total: number } | null; loading: boolean; onChange: () => void }) {
  const action = useAction()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const ids = [...selected]
  const mark = (status: string) =>
    action.run(async () => {
      await api.post('/api/health/findings', { ids, status })
      setSelected(new Set())
      onChange()
    })
  if (loading && !data) return <Loading />
  if (!data || data.items.length === 0) return <Empty title="No findings here">Run an audit, or change the filters.</Empty>
  return (
    <>
      <ErrorBox error={action.error} />
      <div className="row toolbar">
        <Button variant="ghost" onClick={() => setSelected(new Set(data.items.map((f) => f.id)))}>
          Select all shown
        </Button>
        <Button disabled={!ids.length} busy={action.busy} onClick={() => void mark('queued')}>
          Add to maintenance queue
        </Button>
        <Button disabled={!ids.length} busy={action.busy} onClick={() => void mark('intentional')} title="The difference is on purpose; it will not be shown again unless the page changes">
          Mark intentional
        </Button>
        <Button disabled={!ids.length} busy={action.busy} onClick={() => void mark('dismissed')}>
          Dismiss
        </Button>
        <Button variant="ghost" disabled={!ids.length} busy={action.busy} onClick={() => void mark('open')}>
          Reopen
        </Button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th aria-label="Select" />
              <th>Finding</th>
              <th>How sure</th>
              <th>Status</th>
              <th>Seen</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((f) => (
              <tr key={f.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${f.title}`}
                    checked={selected.has(f.id)}
                    onChange={() => {
                      const next = new Set(selected)
                      if (next.has(f.id)) next.delete(f.id)
                      else next.add(f.id)
                      setSelected(next)
                    }}
                  />
                </td>
                <td>
                  <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge> {f.resourceId ? <Link href={`/pages/${f.resourceId}`}>{f.title}</Link> : f.title}
                  <div className="small">{f.explanation}</div>
                  <details className="small">
                    <summary>Evidence and remedy</summary>
                    <p>
                      <strong>What to do:</strong> {f.remedy}
                    </p>
                    {f.related.length > 0 && (
                      <p>
                        Related:{' '}
                        {f.related.map((r, i) => (
                          <span key={r.id}>
                            {i > 0 && ', '}
                            <Link href={`/pages/${r.id}`}>{r.name}</Link>
                          </span>
                        ))}
                      </p>
                    )}
                    <pre className="source-text">{JSON.stringify(f.evidence, null, 2)}</pre>
                  </details>
                  {f.statusNote && <div className="small muted">{f.statusNote}</div>}
                </td>
                <td className="small">
                  {f.certainty}
                  {f.needsReview && <div className="muted">needs review</div>}
                </td>
                <td className="small">
                  {f.status}
                  {f.changedSinceAudit && (
                    <div>
                      <Badge tone="warn" title="The page’s name, tags or place changed after this audit">changed since</Badge>
                    </div>
                  )}
                  {f.exists === false && <div className="error-text">page no longer indexed</div>}
                </td>
                <td className="small">{formatDate(f.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
