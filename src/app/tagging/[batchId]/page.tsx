'use client'

import Link from 'next/link'
import { use, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { TaggingItem, TaggingView } from '@/lib/types'

type Filter = 'all' | 'review' | 'untagged' | 'confident' | 'manual' | 'approved' | 'failed' | 'done' | 'skipped'

const live = (i: TaggingItem) => i.plan?.suggestions.filter((s) => s.refused === null) ?? []
const needsManual = (i: TaggingItem) => i.status === 'awaiting_review' && (i.flags.includes('new_tags') || (live(i).length > 0 && live(i).every((s) => s.certainty === 'possible')))

const FILTERS: { id: Filter; label: string; test: (i: TaggingItem) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'review', label: 'To review', test: (i) => i.status === 'awaiting_review' },
  { id: 'untagged', label: 'Untagged', test: (i) => i.flags.includes('untagged') },
  { id: 'confident', label: 'High confidence', test: (i) => i.flags.includes('confident') },
  { id: 'manual', label: 'Needs manual review', test: needsManual },
  { id: 'approved', label: 'Approved', test: (i) => i.status === 'approved' },
  { id: 'failed', label: 'Failed / unresolved', test: (i) => i.status === 'failed' || i.status === 'needs_reconciliation' },
  { id: 'done', label: 'Done', test: (i) => i.status === 'succeeded' },
  { id: 'skipped', label: 'Skipped', test: (i) => i.status === 'skipped' || i.status === 'cancelled' },
]

const CERTAINTY_TONE = { definite: 'good', likely: 'info', possible: 'neutral' } as const
const SOURCE_LABEL: Record<string, string> = {
  rule: 'your rule',
  page_type: 'page type',
  folder: 'folder',
  siblings: 'sibling pages',
  links: 'linked pages',
  text: 'page text',
  ai: 'AI',
}

export default function TaggingJobPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = use(params)
  const { data, error, loading, reload, setData } = useApi<TaggingView>(`/api/tagging/${encodeURIComponent(batchId)}`)
  const action = useAction()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [typeFilter, setTypeFilter] = useState('')
  const [pathFilter, setPathFilter] = useState('')
  const [approveNew, setApproveNew] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const busy = data ? data.phase !== null || data.batch.status === 'processing' || data.batch.status === 'running' : false
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !busy) setMessage('Finished. The table below shows the outcome for each page.')
    wasBusy.current = busy
    if (!busy) return
    const timer = setInterval(() => void reload(), 1500)
    return () => clearInterval(timer)
  }, [busy, reload])

  const act = (body: Record<string, unknown>, done?: string) =>
    action.run(async () => {
      const view = await api.post<TaggingView>(`/api/tagging/${batchId}/actions`, body)
      setData(view)
      setMessage(done ?? null)
    })

  if (error) return <ErrorBox error={error} />
  if (loading && !data) return <Loading />
  if (!data) return null

  const { batch, overview, counts } = data
  const closed = batch.status === 'completed' || batch.status === 'cancelled'
  const pageTypes = [...new Set(data.items.map((i) => i.plan?.pageType).filter((t): t is string => Boolean(t)))].sort()
  const visible = data.items
    .filter(FILTERS.find((f) => f.id === filter)!.test)
    .filter((i) => !typeFilter || i.plan?.pageType === typeFilter)
    .filter((i) => !pathFilter || (i.plan?.path ?? '').toLowerCase().includes(pathFilter.toLowerCase()))
  const selectedItems = data.items.filter((i) => selected.has(i.id))
  const selectedIds = selectedItems.map((i) => i.id)
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const reviewable = selectedItems.filter((i) => i.status === 'awaiting_review')
  const selectedNewTags = [...new Set(reviewable.flatMap((i) => live(i).filter((s) => s.selected && s.existence === 'new' && s.action === 'add').map((s) => s.tag)))]
  const pending = counts.pending + counts.failed
  const disabled = busy || action.busy

  return (
    <>
      <div className="page-header">
        <p>
          <Link href="/tagging">← Tagging assistant</Link>
        </p>
        <h1>{batch.name}</h1>
        <p>
          <Badge tone={statusTone(batch.status)}>{batch.status}</Badge> {data.phase && <Badge tone="info">{data.phase}…</Badge>}{' '}
          <span className="small muted">
            Created {formatDate(batch.createdAt)} · policy {policyLabel(data.taxonomy.policy)}
            {data.taxonomy.useAi ? ' · AI suggestions on' : ' · no AI'}
          </span>
        </p>
      </div>

      {batch.error && <Notice tone="error">{batch.error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {data.currentTaxonomyRevision !== data.taxonomyRevision && (
        <Notice tone="warning">Your tagging settings have changed since this job started. This job keeps the settings it started with; start a new job to use the new ones.</Notice>
      )}
      <ErrorBox error={action.error} />

      <Card title="Overview">
        <div className="stats">
          <Stat label="Pages" value={overview.pages} />
          <Stat label="With suggestions" value={overview.withSuggestions} />
          <Stat label="High confidence" value={overview.confident} />
          <Stat label="Would add new tags" value={overview.newTags} tone={overview.newTags ? 'warn' : undefined} />
          <Stat label="Approved" value={overview.approved} />
          <Stat label="Updated" value={overview.succeeded} tone={overview.succeeded ? 'good' : undefined} />
          <Stat label="Failed / unresolved" value={overview.failedOrUnresolved} tone={overview.failedOrUnresolved ? 'bad' : undefined} />
        </div>
        {(data.usage.input > 0 || data.usage.output > 0) && (
          <p className="small muted">
            AI usage: {data.usage.input.toLocaleString('en-GB')} input and {data.usage.output.toLocaleString('en-GB')} output tokens
            {data.usage.estimatedCostUsd === 0 ? <> — free model ({data.usage.model}), no charge.</> : data.usage.estimatedCostUsd !== null ? <> — roughly ${data.usage.estimatedCostUsd.toFixed(2)} at {data.usage.model} list prices ({data.usage.pricesAsOf}); your Anthropic bill is authoritative.</> : '.'}
          </p>
        )}
        <div className="row">
          <a className="btn btn-ghost" href={`/api/tagging/${batchId}/export?report=results&format=csv`}>
            Export CSV
          </a>
          <a className="btn btn-ghost" href={`/api/tagging/${batchId}/export?report=results&format=json`}>
            Export JSON
          </a>
        </div>
      </Card>

      {!closed && (
        <Card title="Steps">
          <ol className="steps-list">
            <li>
              <strong>Suggest.</strong> The app reads each page and proposes tags. Nothing is changed in LegendKeeper.{' '}
              {pending > 0 && (
                <Button onClick={() => act({ action: 'suggest' }, 'Suggesting tags')} busy={action.busy} disabled={disabled}>
                  Suggest tags for {pending} page(s)
                </Button>
              )}
            </li>
            <li>
              <strong>Review.</strong> Suggestions marked <Badge tone="good">definite</Badge> or <Badge tone="info">likely</Badge> for tags you already use are ticked
              for you. Everything else, including every new tag, waits for you to tick it.
            </li>
            <li>
              <strong>Approve.</strong> Select pages in the table and approve them. Approval fixes the exact tag list each page will get.
            </li>
            <li>
              <strong>Check (optional).</strong> A dry run reads each page’s current tags and shows the result without writing.{' '}
              <Button onClick={() => act({ action: 'dry_run' }, 'Dry run started')} disabled={disabled || counts.approved + counts.awaiting_review === 0}>
                Dry run
              </Button>{' '}
              {data.hasDryRun && (
                <>
                  <a className="btn btn-ghost" href={`/api/tagging/${batchId}/export?report=dry_run&format=csv`}>
                    Dry run CSV
                  </a>{' '}
                  <a className="btn btn-ghost" href={`/api/tagging/${batchId}/export?report=dry_run&format=json`}>
                    Dry run JSON
                  </a>
                </>
              )}
            </li>
            <li>
              <strong>Apply.</strong> Writes the approved tags, one page at a time. Just before each write the app re-reads the page; if its tags changed meanwhile,
              that page is sent back for review instead of being written.{' '}
              <Button
                variant="primary"
                disabled={disabled || counts.approved === 0}
                onClick={() => {
                  if (window.confirm(`Update the tags on ${counts.approved} page(s) in LegendKeeper?`)) act({ action: 'run', confirm: true }, 'Applying tags')
                }}
              >
                Apply to {counts.approved} approved page(s)
              </Button>{' '}
              {busy && (
                <Button onClick={() => act({ action: 'stop' }, 'Stopping after the current page')} disabled={action.busy}>
                  Stop
                </Button>
              )}
              {counts.needs_reconciliation > 0 && (
                <Button onClick={() => act({ action: 'reconcile' }, 'Checked unresolved pages')} disabled={disabled}>
                  Check {counts.needs_reconciliation} unresolved page(s)
                </Button>
              )}
            </li>
          </ol>
          <div className="row">
            <Button onClick={() => act({ action: 'close' }, 'Job closed')} disabled={disabled}>
              Close job
            </Button>
            <Button
              variant="danger"
              disabled={disabled}
              onClick={() => {
                if (window.confirm('Cancel this job? Pages already updated keep their new tags; nothing else will be written.')) act({ action: 'cancel', confirm: true }, 'Job cancelled')
              }}
            >
              Cancel job
            </Button>
          </div>
        </Card>
      )}

      <Card title="Pages">
        <div className="row toolbar">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`btn btn-ghost${filter === f.id ? ' stat-active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label} ({data.items.filter(f.test).length})
            </button>
          ))}
        </div>
        <div className="row toolbar">
          <select className="inline-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Page type">
            <option value="">All page types</option>
            {pageTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input className="inline-select" placeholder="Folder or region contains…" value={pathFilter} onChange={(e) => setPathFilter(e.target.value)} aria-label="Folder" />
        </div>

        {!closed && (
          <div className="row toolbar">
            <Button onClick={() => setSelected(new Set(visible.map((i) => i.id)))} disabled={visible.length === 0}>
              Select shown ({visible.length})
            </Button>
            <Button onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              Clear selection
            </Button>
            <span className="small muted">{selected.size} selected</span>
            <label className="check">
              <input type="checkbox" checked={approveNew} onChange={(e) => setApproveNew(e.target.checked)} />
              <span>Approve new tags{selectedNewTags.length > 0 && <>: {selectedNewTags.map((t) => `“${t}”`).join(', ')}</>}</span>
            </label>
            <Button
              variant="primary"
              disabled={disabled || reviewable.length === 0}
              onClick={() => act({ action: 'approve', itemIds: selectedIds, approveNewTags: approveNew, confirm: true }, 'Approved. Pages that could not be approved show the reason.')}
            >
              Approve {reviewable.length} page(s)
            </Button>
            <Button onClick={() => act({ action: 'unapprove', itemIds: selectedIds })} disabled={disabled || !selectedItems.some((i) => i.status === 'approved')}>
              Withdraw approval
            </Button>
            <Button onClick={() => act({ action: 'retry', itemIds: selectedIds }, 'Ready to try again')} disabled={disabled || !selectedItems.some((i) => i.status === 'failed')}>
              Retry failed
            </Button>
            <Button onClick={() => act({ action: 'skip', itemIds: selectedIds }, 'Skipped')} disabled={disabled || selectedItems.length === 0}>
              Skip
            </Button>
          </div>
        )}

        {visible.length === 0 ? (
          <Empty title="No pages match this filter." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Page</th>
                  <th>Tags before</th>
                  <th>Suggestions</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    checked={selected.has(item.id)}
                    onToggle={() => toggle(item.id)}
                    readOnly={closed || disabled}
                    onSelect={(selections) => act({ action: 'select', itemId: item.id, selections })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

function policyLabel(policy: string) {
  return policy === 'existing_only' ? 'A (existing tags only)' : policy === 'allow_new' ? 'B (new tags allowed with approval)' : 'C (approved taxonomy)'
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

type Selection = { tag: string; action: 'add' | 'remove'; selected: boolean }

function ItemRow({ item, checked, onToggle, readOnly, onSelect }: { item: TaggingItem; checked: boolean; onToggle: () => void; readOnly: boolean; onSelect: (s: Selection[]) => void }) {
  const plan = item.plan
  const editable = !readOnly && (item.status === 'awaiting_review' || item.status === 'approved')
  const before = plan?.before ?? []
  const after = item.proposedAfter ?? before
  const added = after.filter((t) => !before.includes(t))
  const removed = before.filter((t) => !after.includes(t))
  return (
    <tr>
      <td>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Select ${item.title}`} />
      </td>
      <td>
        <strong>{item.title}</strong>
        <div className="small muted">{plan?.path ?? ''}</div>
        <div>
          <Badge tone={statusTone(item.status)} title={item.statusExplanation}>
            {item.status.replace(/_/g, ' ')}
          </Badge>{' '}
          {plan?.pageType && <Badge>{plan.pageType}</Badge>}
        </div>
        {item.error && <div className="small error-text">{item.error}</div>}
      </td>
      <td>
        <div className="tag-cloud small">{before.length ? before.map((t) => <Badge key={t}>{t}</Badge>) : <span className="muted">none</span>}</div>
      </td>
      <td>
        {!plan ? (
          <span className="small muted">Not suggested yet.</span>
        ) : plan.suggestions.length === 0 ? (
          <span className="small muted">No suggestions.</span>
        ) : (
          <ul className="suggestion-list">
            {plan.suggestions.map((s) => (
              <li key={`${s.action}:${s.tag}`} className={s.refused ? 'muted' : undefined}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.selected && !s.refused}
                    disabled={!editable || s.refused !== null}
                    onChange={(e) => onSelect([{ tag: s.tag, action: s.action, selected: e.target.checked }])}
                  />
                  <span>
                    {s.action === 'remove' ? 'Remove ' : ''}
                    <strong>{s.tag}</strong> {s.existence === 'new' ? <Badge tone="warn">NEW</Badge> : <Badge>existing</Badge>}{' '}
                    <Badge tone={CERTAINTY_TONE[s.certainty]}>{s.certainty}</Badge> <span className="small muted">({SOURCE_LABEL[s.source] ?? s.source})</span>
                    <div className="small muted">{s.reason}</div>
                    {s.refused && <div className="small">Not allowed: {s.refused}</div>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {plan?.notes.map((n, i) => (
          <div key={i} className="small muted">
            {n}
          </div>
        ))}
      </td>
      <td>
        {plan && (
          <>
            <div className="tag-cloud small">{after.length ? after.map((t) => <Badge key={t} tone={added.includes(t) ? 'good' : 'neutral'}>{t}</Badge>) : <span className="muted">none</span>}</div>
            {(added.length > 0 || removed.length > 0) && (
              <div className="small muted">
                {added.length > 0 && <>+{added.join(', ')} </>}
                {removed.length > 0 && <>−{removed.join(', ')}</>}
              </div>
            )}
          </>
        )}
        {item.resourceId && (
          <div className="small">
            <Link href={`/pages/${encodeURIComponent(item.resourceId)}`}>Page details</Link>
          </div>
        )}
      </td>
    </tr>
  )
}
