'use client'

import Link from 'next/link'
import { use, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Loading, More, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'

interface PageRow {
  id: string
  title: string
  status: string
  statusExplanation: string
  destination: { key: string | null; label: string } | null
  draftId: string | null
  jobId: string | null
  resourceId: string | null
  why: string | null
  confidence: string | null
  overlapsWith: string[]
  sourceId: string | null
  chars: number | null
  parentName: string | null
  tags: string[]
  links: number
  warnings: string[]
  problems: string[]
  checked: boolean
  ready: boolean
  error: string | null
}
interface Part {
  from: number
  to: number
  preview: string
  why?: string
}
interface View {
  batch: { id: string; name: string; status: string; createdAt: string; error: string | null; parentId: string | null }
  phase: string | null
  state: {
    mode: 'ai' | 'rules'
    stage: string
    notes: string[]
    deferred: number
    sources: { sourceId: string; name: string; discarded: Part[]; unplaced: Part[]; notes: string[]; requests: number }[]
  }
  sources: { id: string; name: string; status: string; chars: number; warnings: string[]; error: string | null }[]
  pages: PageRow[]
  destinations: { key: string; label: string; pageTypeLabel: string }[]
  totals: { pages: number; ready: number; needsLook: number; created: number; failed: number; waiting: number; noKind: number; discarded: number; unplaced: number; aiRequests: number }
  checkedAt: string | null
  keyRole: string | null
}

export default function ImportRunPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = use(params)
  const { data, error, loading, reload, setData } = useApi<View>(`/api/smart-imports/${batchId}`)
  const act = useAction()
  const busy = Boolean(data?.phase)

  // While work runs in the background, refresh every second and a half.
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void reload(), 1500)
    return () => clearInterval(timer)
  }, [busy, reload])

  const action = (body: Record<string, unknown>) =>
    act.run(async () => {
      setData(await api.post<View>(`/api/smart-imports/${batchId}/actions`, body))
    })

  if (loading && !data) return <Loading />
  if (!data) return <ErrorBox error={error} />
  const closed = data.batch.status === 'completed' || data.batch.status === 'cancelled'

  return (
    <>
      <div className="page-header">
        <p className="small">
          <Link href="/import">← Import</Link>
        </p>
        <h1>{data.batch.name}</h1>
        <Summary data={data} />
      </div>
      <ErrorBox error={error} />
      <ErrorBox error={act.error} />
      {data.batch.error && (
        <Notice tone="error">
          <strong>The import stopped.</strong> {data.batch.error}{' '}
          {!closed && (
            <Button variant="ghost" onClick={() => void action({ action: 'start' })}>
              Try again
            </Button>
          )}
        </Notice>
      )}
      {data.phase && (
        <Notice tone="info">
          <span className="row">
            <span className="spinner" aria-hidden="true" /> <strong>{capitalise(data.phase)}…</strong>
            <span className="spacer" />
            <Button variant="ghost" onClick={() => void action({ action: 'stop' })}>
              Stop
            </Button>
          </span>
        </Notice>
      )}
      {!data.phase && !closed && (data.totals.waiting > 0 || data.state.deferred > 0) && (
        <Notice tone="warning">
          {data.totals.waiting} page(s) still need a draft{data.state.deferred ? ' (the AI limit per run was reached)' : ''}.{' '}
          <Button variant="primary" busy={act.busy} onClick={() => void action({ action: 'continue' })}>
            Draft them
          </Button>
        </Notice>
      )}

      <Pages data={data} disabled={busy || closed || act.busy} onAction={action} />

      <LeftOut data={data} disabled={busy || closed || act.busy} onAction={action} />

      <More label="More information">
        <ul className="small">
          {data.sources.map((source) => (
            <li key={source.id}>
              {source.name}: {source.status === 'failed' ? <span className="error-text">{source.error}</span> : `${source.chars.toLocaleString('en-GB')} characters`}
              {source.warnings.length > 0 && <span className="muted"> — {source.warnings.join(' ')}</span>}
            </li>
          ))}
          <li>
            Sorted {data.state.mode === 'ai' ? 'by AI' : 'without AI'}; {data.totals.aiRequests} AI request(s) so far.
          </li>
          {data.checkedAt && (
            <li>
              Checked against LegendKeeper {formatDate(data.checkedAt)}
              {data.keyRole ? ` (key role: ${data.keyRole})` : ''}.
            </li>
          )}
          {[...data.state.notes, ...data.state.sources.flatMap((s) => s.notes)].map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
        {!closed && (
          <div className="row">
            <Button disabled={busy || act.busy} onClick={() => void action({ action: 'start' })}>
              Sort again
            </Button>
            {data.state.mode === 'ai' && (
              <Button disabled={busy || act.busy} onClick={() => void action({ action: 'start', mode: 'rules' })}>
                Sort again without AI
              </Button>
            )}
            <Button disabled={busy || act.busy} onClick={() => void action({ action: 'close' })}>
              Finish this import
            </Button>
            <Button variant="danger" disabled={busy || act.busy} onClick={() => confirm('Cancel this import? Pages already created stay in LegendKeeper.') && void action({ action: 'cancel', confirm: true })}>
              Cancel import
            </Button>
          </div>
        )}
        <p className="small">
          <Link href={`/batches/${data.batch.id}?classic=1`}>Open in the detailed batch view</Link>
        </p>
      </More>
    </>
  )
}

function Summary({ data }: { data: View }) {
  const t = data.totals
  const parts = [
    `${t.pages} page${t.pages === 1 ? '' : 's'} found`,
    t.created ? `${t.created} created` : null,
    t.ready ? `${t.ready} ready` : null,
    t.needsLook ? `${t.needsLook} to look at` : null,
    t.failed ? `${t.failed} failed` : null,
    t.discarded ? `${t.discarded} part${t.discarded === 1 ? '' : 's'} of clutter left out` : null,
  ].filter(Boolean)
  return <p className="lead">{data.state.stage === 'new' && data.phase ? 'Working on it…' : parts.join(' · ')}</p>
}

function Pages({ data, disabled, onAction }: { data: View; disabled: boolean; onAction: (body: Record<string, unknown>) => Promise<unknown> }) {
  const candidates = useMemo(() => data.pages.filter((p) => p.status === 'awaiting_review' || p.status === 'approved'), [data.pages])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false)
  const [includeWarnings, setIncludeWarnings] = useState(false)
  // Ready pages are chosen to begin with.
  useEffect(() => {
    if (!touched) setChosen(new Set(data.pages.filter((p) => p.ready).map((p) => p.id)))
  }, [data.pages, touched])
  const toggle = (id: string) => {
    setTouched(true)
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChosen(next)
  }
  const selected = data.pages.filter((p) => chosen.has(p.id) && candidates.includes(p))
  const withWarnings = selected.filter((p) => p.warnings.length).length
  const parent = data.pages.find((p) => p.parentName)?.parentName

  if (!data.pages.length) return data.phase ? null : <Card title="Pages">{<p className="muted">No pages found yet.</p>}</Card>

  return (
    <Card title="Pages">
      <ul className="page-list">
        {data.pages.map((page) => (
          <PageItem key={page.id} page={page} data={data} chosen={chosen.has(page.id)} selectable={candidates.includes(page) && !disabled} onToggle={() => toggle(page.id)} disabled={disabled} onAction={onAction} />
        ))}
      </ul>
      {candidates.length > 0 && (
        <div className="action-bar">
          <Button
            variant="primary"
            disabled={disabled || selected.length === 0 || (withWarnings === selected.length && !includeWarnings)}
            onClick={() => {
              setTouched(false)
              void onAction({ action: 'create', itemIds: selected.map((p) => p.id), includeWarnings, confirm: true })
            }}
          >
            Create {selected.length} page{selected.length === 1 ? '' : 's'} in LegendKeeper
          </Button>
          <span className="small muted">{parent ? `Under “${parent}”.` : 'At the top of the project.'} Each page is checked again right before it is written.</span>
          {withWarnings > 0 && (
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={includeWarnings} onChange={(e) => setIncludeWarnings(e.target.checked)} />
              <span className="small">Also create the {withWarnings} with warnings (I have looked at them)</span>
            </label>
          )}
        </div>
      )}
    </Card>
  )
}

function PageItem({
  page,
  data,
  chosen,
  selectable,
  onToggle,
  disabled,
  onAction,
}: {
  page: PageRow
  data: View
  chosen: boolean
  selectable: boolean
  onToggle: () => void
  disabled: boolean
  onAction: (body: Record<string, unknown>) => Promise<unknown>
}) {
  const [showSource, setShowSource] = useState(false)
  const source = useApi<{ text: string | null }>(showSource ? `/api/smart-imports/${data.batch.id}/source?itemId=${page.id}` : null)
  const state = stateOf(page)
  const firstProblem = page.problems[0] ?? (page.warnings.length ? `${page.warnings.length} warning${page.warnings.length === 1 ? '' : 's'}: ${page.warnings[0]}` : null)
  return (
    <li className="page-row">
      <div className="page-row-head">
        {page.status === 'succeeded' || page.status === 'skipped' ? (
          <span aria-hidden="true" style={{ width: '1rem' }} />
        ) : (
          <input type="checkbox" aria-label={`Create ${page.title}`} checked={chosen && selectable} disabled={!selectable} onChange={onToggle} />
        )}
        <span className="page-row-title">{page.title}</span>
        <select
          className="inline-select"
          aria-label={`Page kind of ${page.title}`}
          value={page.destination?.key ?? ''}
          disabled={disabled || ['approved', 'running', 'succeeded', 'needs_reconciliation', 'processing'].includes(page.status)}
          onChange={(e) => void onAction({ action: 'destination', itemId: page.id, key: e.target.value || null })}
        >
          <option value="">No page (skip)</option>
          {data.destinations.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        <Badge tone={state.tone}>{state.label}</Badge>
        {page.resourceId && <Link href={`/pages/${page.resourceId}`}>open page</Link>}
      </div>
      {firstProblem && page.status !== 'succeeded' && <p className="page-row-problem">{firstProblem}</p>}
      <More label="Details">
        <ul className="small">
          {page.why && (
            <li>
              Why this kind: {page.why}
              {page.confidence && page.confidence !== 'high' ? ` (confidence ${page.confidence})` : ''}
            </li>
          )}
          {page.overlapsWith.length > 0 && <li>Shares source lines with: {page.overlapsWith.join(', ')}</li>}
          {page.tags.length > 0 && <li>Tags: {page.tags.join(', ')}</li>}
          {page.links > 0 && <li>{page.links} link(s) to existing pages</li>}
          {page.problems.slice(1).map((p, i) => (
            <li key={`p${i}`} className="error-text">
              {p}
            </li>
          ))}
          {page.warnings.map((w, i) => (
            <li key={`w${i}`}>{w}</li>
          ))}
          <li>{page.statusExplanation}</li>
        </ul>
        <div className="row">
          {page.jobId && page.draftId && <Link href={`/import/${page.jobId}`}>Review and edit the draft</Link>}
          <button type="button" className="link-button" onClick={() => setShowSource(!showSource)}>
            {showSource ? 'Hide the source' : 'Show the source'}
          </button>
        </div>
        {showSource && (source.data ? <pre className="source-text">{source.data.text ?? 'The source text was deleted when the import finished.'}</pre> : <Loading />)}
      </More>
    </li>
  )
}

function stateOf(page: PageRow): { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' } {
  switch (page.status) {
    case 'succeeded':
      return { label: 'Created', tone: 'good' }
    case 'awaiting_review':
      return page.ready ? (page.warnings.length ? { label: 'Ready, with warnings', tone: 'warn' } : { label: 'Ready', tone: 'good' }) : page.checked ? { label: 'Needs a look', tone: 'warn' } : { label: 'Not checked yet', tone: 'neutral' }
    case 'approved':
      return { label: 'Approved', tone: 'info' }
    case 'running':
      return { label: 'Creating…', tone: 'info' }
    case 'processing':
      return { label: 'Drafting…', tone: 'info' }
    case 'pending':
      return { label: 'Waiting for a draft', tone: 'neutral' }
    case 'failed':
      return { label: 'Failed', tone: 'bad' }
    case 'needs_reconciliation':
      return { label: 'Outcome unknown', tone: 'bad' }
    case 'skipped':
      return { label: page.destination ? 'Skipped' : 'No page kind', tone: 'neutral' }
    default:
      return { label: page.status, tone: 'neutral' }
  }
}

function LeftOut({ data, disabled, onAction }: { data: View; disabled: boolean; onAction: (body: Record<string, unknown>) => Promise<unknown> }) {
  const parts = data.state.sources.flatMap((source) => [
    ...source.unplaced.map((part) => ({ ...part, sourceId: source.sourceId, sourceName: source.name, kind: 'unplaced' as const })),
    ...source.discarded.map((part) => ({ ...part, sourceId: source.sourceId, sourceName: source.name, kind: 'discarded' as const })),
  ])
  if (!parts.length) return null
  const unplaced = parts.filter((p) => p.kind === 'unplaced').length
  return (
    <Card title="Left out">
      <p className="small muted">
        {data.totals.discarded} part(s) were left out as clutter{unplaced ? ` and ${unplaced} part(s) were not placed on any page` : ''}. If something belongs on a page, make a page from it.
      </p>
      <More label="Show what was left out">
        <ul className="page-list">
          {parts.map((part) => (
            <LeftOutItem key={`${part.sourceId}-${part.kind}-${part.from}`} part={part} data={data} disabled={disabled} onAction={onAction} />
          ))}
        </ul>
      </More>
    </Card>
  )
}

function LeftOutItem({
  part,
  data,
  disabled,
  onAction,
}: {
  part: Part & { sourceId: string; sourceName: string; kind: 'unplaced' | 'discarded' }
  data: View
  disabled: boolean
  onAction: (body: Record<string, unknown>) => Promise<unknown>
}) {
  const [making, setMaking] = useState(false)
  const [title, setTitle] = useState('')
  const [key, setKey] = useState(data.destinations[0]?.key ?? '')
  return (
    <li className="page-row">
      <div className="page-row-head">
        <Badge tone={part.kind === 'unplaced' ? 'warn' : 'neutral'}>{part.kind === 'unplaced' ? 'Not placed' : part.why || 'Clutter'}</Badge>
        <span className="small break" style={{ flex: 1 }}>
          {part.preview}
        </span>
        {!making && (
          <Button variant="ghost" disabled={disabled} onClick={() => setMaking(true)}>
            Make a page
          </Button>
        )}
      </div>
      <p className="small muted">
        {part.sourceName}, lines {part.from}–{part.to}
      </p>
      {making && (
        <div className="row">
          <input type="text" className="inline-input" placeholder="Page name" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select className="inline-select" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Page kind">
            {data.destinations.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            disabled={disabled || !title.trim() || !key}
            onClick={() => void onAction({ action: 'add_lines', sourceId: part.sourceId, from: part.from, to: part.to, title, key }).then(() => setMaking(false))}
          >
            Add
          </Button>
          <Button variant="ghost" onClick={() => setMaking(false)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  )
}

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
