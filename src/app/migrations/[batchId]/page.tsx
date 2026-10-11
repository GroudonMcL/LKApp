'use client'

import Link from 'next/link'
import { use, useEffect, useRef, useState } from 'react'
import { LkBlocksPreview } from '@/components/lk-preview'
import { Badge, Button, Card, Empty, ErrorBox, Loading, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { MigrationDetail, MigrationRow, MigrationView } from '@/lib/types'

type Filter = 'all' | 'review' | 'numbers' | 'unmapped' | 'blocked' | 'approved' | 'failed' | 'done' | 'skipped'

const FILTERS: { id: Filter; label: string; test: (i: MigrationRow) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'review', label: 'To review', test: (i) => i.status === 'awaiting_review' },
  { id: 'numbers', label: 'Numbers changed', test: (i) => i.flags.includes('mechanics_changed') },
  { id: 'unmapped', label: 'Text that did not fit', test: (i) => i.flags.includes('unmapped') },
  { id: 'blocked', label: 'Needs fixing', test: (i) => i.flags.includes('errors') || i.draftChanged },
  { id: 'approved', label: 'Approved', test: (i) => i.status === 'approved' },
  { id: 'failed', label: 'Failed / unresolved', test: (i) => i.status === 'failed' || i.status === 'needs_reconciliation' },
  { id: 'done', label: 'Migrated', test: (i) => i.status === 'succeeded' },
  { id: 'skipped', label: 'Skipped', test: (i) => i.status === 'skipped' || i.status === 'cancelled' },
]

const FLAG_LABELS: Record<string, [string, 'warn' | 'bad' | 'info' | 'neutral' | 'good']> = {
  mechanics_changed: ['numbers changed', 'warn'],
  unmapped: ['text kept in notes', 'warn'],
  reworded: ['reworded text', 'warn'],
  links: ['links added back', 'info'],
  kept_blocks: ['blocks kept as is', 'neutral'],
  formatting: ['formatting simplified', 'neutral'],
  errors: ['needs fixing', 'bad'],
  restored: ['restored', 'info'],
}

export default function MigrationJobPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = use(params)
  const { data, error, loading, reload, setData } = useApi<MigrationView>(`/api/migrations/${encodeURIComponent(batchId)}`)
  const action = useAction()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [acks, setAcks] = useState<Record<string, string[]>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [restoreReport, setRestoreReport] = useState<{ page: string; outcome: string; message: string }[] | null>(null)

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
      const view = await api.post<MigrationView & { restoreResults?: { page: string; outcome: string; message: string }[] }>(`/api/migrations/${batchId}/actions`, body)
      setData(view)
      setMessage(done ?? null)
      if (view.restoreResults) setRestoreReport(view.restoreResults)
    })

  if (error) return <ErrorBox error={error} />
  if (loading && !data) return <Loading />
  if (!data) return null

  const { batch, overview, counts } = data
  const closed = batch.status === 'completed' || batch.status === 'cancelled'
  const disabled = busy || action.busy
  const visible = data.items.filter(FILTERS.find((f) => f.id === filter)!.test)
  const selectedItems = data.items.filter((i) => selected.has(i.id))
  const selectedIds = selectedItems.map((i) => i.id)
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const approve = (ids: string[]) =>
    act({ action: 'approve', itemIds: ids, acknowledged: Object.fromEntries(ids.map((id) => [id, acks[id] ?? []])), confirm: true }, 'Approved. Pages that could not be approved show the reason.')
  const pending = counts.pending + counts.failed

  return (
    <>
      <div className="page-header">
        <p>
          <Link href="/migrations">← Template migration</Link>
        </p>
        <h1>{batch.name}</h1>
        <p>
          <Badge tone={statusTone(batch.status)}>{batch.status}</Badge> {data.phase && <Badge tone="info">{data.phase}…</Badge>}{' '}
          <span className="small muted">
            Created {formatDate(batch.createdAt)} · {data.mode === 'ai' ? 'AI drafting' : 'structural drafting (no AI)'}
            {data.recipe && (
              <>
                {' '}
                · recipe <Link href={`/recipes/${data.recipe.id}`}>{data.recipe.name}</Link> version {data.recipe.version}
              </>
            )}
          </span>
        </p>
        <p className="small">
          Target layout: <strong>{data.template.name}</strong> — {data.template.explanation}
        </p>
      </div>

      {batch.error && <Notice tone="error">{batch.error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {restoreReport && (
        <Notice tone={restoreReport.every((r) => r.outcome === 'restored') ? 'success' : 'warning'}>
          {restoreReport.map((r) => (
            <div key={r.page}>
              <strong>{r.page}</strong>: {r.outcome} — {r.message}
            </div>
          ))}
        </Notice>
      )}
      <ErrorBox error={action.error} />

      <Card title="Overview">
        <div className="stats">
          <Stat label="Pages" value={overview.pages} />
          <Stat label="Compared" value={overview.analysed} />
          <Stat label="Numbers changed" value={overview.numberChanges} tone={overview.numberChanges ? 'warn' : undefined} />
          <Stat label="Text kept in notes" value={overview.unmapped} tone={overview.unmapped ? 'warn' : undefined} />
          <Stat label="Need fixing" value={overview.blocked} tone={overview.blocked ? 'bad' : undefined} />
          <Stat label="Approved" value={overview.approved} />
          <Stat label="Migrated" value={overview.succeeded} tone={overview.succeeded ? 'good' : undefined} />
          <Stat label="Restored" value={overview.restored} />
          <Stat label="Failed / unresolved" value={overview.failedOrUnresolved} tone={overview.failedOrUnresolved ? 'bad' : undefined} />
        </div>
        {(data.usage.input > 0 || data.usage.output > 0) && (
          <p className="small muted">
            AI usage: {data.usage.input.toLocaleString('en-GB')} input and {data.usage.output.toLocaleString('en-GB')} output tokens
            {data.usage.estimatedCostUsd !== null ? <> — roughly ${data.usage.estimatedCostUsd.toFixed(2)} at {data.usage.model} list prices ({data.usage.pricesAsOf}); your Anthropic bill is authoritative.</> : '.'}
          </p>
        )}
        <div className="row">
          <a className="btn btn-ghost" href={`/api/migrations/${batchId}/export?report=results&format=csv`}>
            Export CSV
          </a>
          <a className="btn btn-ghost" href={`/api/migrations/${batchId}/export?report=results&format=json`}>
            Export JSON
          </a>
        </div>
      </Card>

      {!closed && (
        <Card title="Steps">
          <ol className="steps-list">
            <li>
              <strong>Compare.</strong> Reads each page and builds the proposed version. Nothing is changed in LegendKeeper.{' '}
              {pending > 0 && (
                <Button onClick={() => act({ action: 'analyse' }, 'Comparing pages')} disabled={disabled}>
                  Compare {pending} page(s)
                </Button>
              )}
            </li>
            <li>
              <strong>Review.</strong> Open each page’s comparison. Tick off every changed number after checking it. To correct something, edit the page’s draft, then refresh
              the comparison.
            </li>
            <li>
              <strong>Approve.</strong> Approve pages one by one in their comparison, or select several below.
            </li>
            <li>
              <strong>Check (optional).</strong> A dry run reads each page again to confirm it has not changed since the comparison.{' '}
              <Button onClick={() => act({ action: 'dry_run' }, 'Dry run started')} disabled={disabled || counts.approved + counts.awaiting_review === 0}>
                Dry run
              </Button>{' '}
              {data.hasDryRun && (
                <>
                  <a className="btn btn-ghost" href={`/api/migrations/${batchId}/export?report=dry_run&format=csv`}>
                    Dry run CSV
                  </a>{' '}
                  <a className="btn btn-ghost" href={`/api/migrations/${batchId}/export?report=dry_run&format=json`}>
                    Dry run JSON
                  </a>
                </>
              )}
            </li>
            <li>
              <strong>Apply.</strong> Saves each original in this app, then replaces the page content, one page at a time, only if the page is unchanged since the comparison.{' '}
              <Button
                variant="primary"
                disabled={disabled || counts.approved === 0}
                onClick={() => {
                  if (window.confirm(`Migrate ${counts.approved} page(s) in LegendKeeper? Each original is saved first and can be restored while the page is unchanged.`)) act({ action: 'run', confirm: true }, 'Migrating')
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
                if (window.confirm('Cancel this job? Pages already migrated stay migrated (and can still be restored); nothing else will be written.')) act({ action: 'cancel', confirm: true }, 'Job cancelled')
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
          <Button onClick={() => setSelected(new Set(visible.map((i) => i.id)))} disabled={visible.length === 0}>
            Select shown ({visible.length})
          </Button>
          <Button onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            Clear selection
          </Button>
          <span className="small muted">{selected.size} selected</span>
          {!closed && (
            <>
              <Button variant="primary" disabled={disabled || !selectedItems.some((i) => i.status === 'awaiting_review')} onClick={() => approve(selectedIds)}>
                Approve selected
              </Button>
              <Button onClick={() => act({ action: 'unapprove', itemIds: selectedIds })} disabled={disabled || !selectedItems.some((i) => i.status === 'approved')}>
                Withdraw approval
              </Button>
              <Button onClick={() => act({ action: 'refresh', itemIds: selectedIds }, 'Comparisons refreshed')} disabled={disabled || !selectedItems.some((i) => i.plan)}>
                Refresh comparison
              </Button>
              <Button onClick={() => act({ action: 'retry', itemIds: selectedIds }, 'Ready to compare again')} disabled={disabled || !selectedItems.some((i) => i.status === 'failed')}>
                Retry failed
              </Button>
              <Button onClick={() => act({ action: 'skip', itemIds: selectedIds }, 'Skipped')} disabled={disabled || selectedItems.length === 0}>
                Skip
              </Button>
            </>
          )}
          <Button
            variant="danger"
            disabled={disabled || !selectedItems.some((i) => i.status === 'succeeded' && i.backup?.status === 'applied')}
            onClick={() => {
              if (window.confirm('Restore the selected pages to their saved originals? Pages edited after the migration are left alone.')) act({ action: 'restore', itemIds: selectedIds, overwriteLaterEdits: false, confirm: true }, 'Restore finished')
            }}
          >
            Restore selected
          </Button>
        </div>

        {visible.length === 0 ? (
          <Empty title="No pages match this filter." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Page</th>
                  <th>Status</th>
                  <th>Findings</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <ItemRow key={item.id} item={item} checked={selected.has(item.id)} onToggle={() => toggle(item.id)} open={open === item.id} onOpen={() => setOpen(open === item.id ? null : item.id)}>
                    {open === item.id && (
                      <Comparison
                        batchId={batchId}
                        item={item}
                        acked={acks[item.id] ?? []}
                        onAck={(ids) => setAcks({ ...acks, [item.id]: ids })}
                        disabled={disabled || closed}
                        onAct={act}
                        onApprove={() => approve([item.id])}
                      />
                    )}
                  </ItemRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function ItemRow({ item, checked, onToggle, open, onOpen, children }: { item: MigrationRow; checked: boolean; onToggle: () => void; open: boolean; onOpen: () => void; children: React.ReactNode }) {
  const plan = item.plan
  return (
    <>
      <tr>
        <td>
          <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Select ${item.title}`} />
        </td>
        <td>
          <strong>{item.title}</strong>
          {item.resourceId && (
            <div className="small">
              <Link href={`/pages/${encodeURIComponent(item.resourceId)}`}>Page details</Link>
            </div>
          )}
        </td>
        <td>
          <Badge tone={statusTone(item.status)} title={item.statusExplanation}>
            {item.status.replace(/_/g, ' ')}
          </Badge>
          {item.draftChanged && (
            <div>
              <Badge tone="warn">draft edited — refresh</Badge>
            </div>
          )}
          {item.error && <div className="small error-text">{item.error}</div>}
        </td>
        <td>
          <div className="tag-cloud small">
            {item.flags.map((f) => (
              <Badge key={f} tone={FLAG_LABELS[f]?.[1] ?? 'neutral'}>
                {FLAG_LABELS[f]?.[0] ?? f}
              </Badge>
            ))}
            {plan && item.flags.length === 0 && <Badge tone="good">no differences</Badge>}
          </div>
          {plan && (
            <div className="small muted">
              {plan.mechanics.length} number change(s) · {plan.unmapped.length} passage(s) in notes · {plan.kept.length} block(s) kept as is
            </div>
          )}
        </td>
        <td>
          {plan && (
            <Button variant="ghost" onClick={onOpen}>
              {open ? 'Hide comparison' : 'Review comparison'}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>{children}</td>
        </tr>
      )}
    </>
  )
}

const CHANGE_LABEL: Record<string, [string, 'good' | 'info' | 'warn' | 'bad' | 'neutral']> = {
  same: ['same', 'good'],
  relabelled: ['new label', 'info'],
  changed: ['value changed', 'bad'],
  new: ['new row', 'neutral'],
  moved_to_text: ['moved into the text', 'info'],
  split: ['split over several rows', 'info'],
  not_found: ['kept in notes', 'warn'],
}

function Comparison({
  batchId,
  item,
  acked,
  onAck,
  disabled,
  onAct,
  onApprove,
}: {
  batchId: string
  item: MigrationRow
  acked: string[]
  onAck: (ids: string[]) => void
  disabled: boolean
  onAct: (body: Record<string, unknown>, done?: string) => void
  onApprove: () => void
}) {
  const { data, error, loading } = useApi<MigrationDetail>(`/api/migrations/${batchId}/items/${item.id}?u=${encodeURIComponent(item.updatedAt)}`)
  if (error) return <ErrorBox error={error} />
  if (loading || !data) return <Loading />
  const plan = data.plan
  if (!plan) return <p className="muted">No comparison yet.</p>
  const names = plan.links.names
  const allAcked = plan.acknowledgements.every((a) => acked.includes(a.id))
  const backup = data.backup

  return (
    <div className="comparison">
      <div className="row">
        <span className="small">
          Target: <strong>{plan.template.name}</strong> ({plan.template.kind === 'native' ? 'copied LegendKeeper template' : plan.template.kind === 'example' ? 'layout from an example page' : plan.template.kind === 'local' ? 'defined in this app' : 'built-in'})
        </span>
        {item.jobId && <Link href={`/import/${item.jobId}`}>Edit the draft</Link>}
        <Button variant="ghost" onClick={() => onAct({ action: 'refresh', itemIds: [item.id] }, 'Comparison refreshed')} disabled={disabled}>
          Refresh comparison
        </Button>
        <a className="btn btn-ghost" href={`/api/migrations/${batchId}/items/${item.id}/original`}>
          Download original
        </a>
      </div>
      {data.draftChanged && <Notice tone="warning">The draft was edited after this comparison. Refresh the comparison before approving.</Notice>}

      {plan.findings.length > 0 && (
        <ul className="findings">
          {plan.findings.map((f, i) => (
            <li key={i}>
              <Badge tone={f.severity === 'error' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info'}>{f.severity}</Badge> {f.message}
            </li>
          ))}
        </ul>
      )}

      {plan.acknowledgements.length > 0 && (
        <div className="confirm-box">
          <strong>Check and tick off each change</strong>
          <p className="small muted">Numbers are game mechanics. Approval needs every box ticked; a high AI confidence never counts as a check.</p>
          {plan.acknowledgements.map((a) => (
            <label key={a.id} className="check">
              <input type="checkbox" checked={acked.includes(a.id)} disabled={item.status !== 'awaiting_review'} onChange={(e) => onAck(e.target.checked ? [...acked, a.id] : acked.filter((x) => x !== a.id))} />
              <span>{a.label}</span>
            </label>
          ))}
          {plan.reworded.length > 0 && (
            <details>
              <summary className="small">Sentences not word for word from the old page ({plan.reworded.length})</summary>
              <ul className="small">
                {plan.reworded.map((r, i) => (
                  <li key={i}>
                    {r.text} {r.section && <span className="muted">({r.section})</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {item.status === 'awaiting_review' && (
        <div className="row" style={{ margin: '0.5rem 0' }}>
          <Button variant="primary" onClick={onApprove} disabled={disabled || !allAcked || plan.blockers.length > 0 || data.draftChanged}>
            Approve this page
          </Button>
          {plan.blockers.length > 0 && <span className="small error-text">Fix first: {plan.blockers.join(' ')}</span>}
        </div>
      )}

      <h3>Fields</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Before</th>
              <th>After</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {plan.fields.map((f, i) => (
              <tr key={i}>
                <td className="small">{f.oldKey ? `${f.oldKey}: ${f.oldValue}` : <span className="muted">—</span>}</td>
                <td className="small">{f.newKey ? `${f.newKey}: ${f.newValue}` : <span className="muted">—</span>}</td>
                <td>
                  <Badge tone={CHANGE_LABEL[f.change]?.[1] ?? 'neutral'}>{CHANGE_LABEL[f.change]?.[0] ?? f.change}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-2">
        <div>
          <h3>Sections</h3>
          <p className="small">
            Kept: {plan.sections.kept.join(', ') || 'none'}
            <br />
            Added: {plan.sections.added.join(', ') || 'none'}
            <br />
            No longer a heading: {plan.sections.removed.join(', ') || 'none'}
          </p>
          <h3>Links</h3>
          <p className="small">
            {plan.links.before.length} before, {plan.links.after.length} after. Lost: {plan.links.lost.map((id) => names[id] ?? id).join(', ') || 'none'}. Added back as a list:{' '}
            {plan.links.addedBack.map((id) => names[id] ?? id).join(', ') || 'none'}. New links (known page names linked by the recipe’s link settings):{' '}
            {plan.links.added.map((id) => names[id] ?? id).join(', ') || 'none'}. Pages linking <em>to</em> this page are unaffected: it keeps its id.
          </p>
          <h3>Metadata</h3>
          <p className="small">
            Unchanged: {plan.metadata.unchanged.join(', ')}.
            {plan.metadata.tagsAfter.join('|') !== plan.metadata.tagsBefore.join('|') && (
              <>
                {' '}
                Tags: {plan.metadata.tagsBefore.join(', ') || 'none'} → {plan.metadata.tagsAfter.join(', ')}
              </>
            )}
          </p>
        </div>
        <div>
          <h3>Kept exactly as they are</h3>
          {plan.kept.length === 0 ? (
            <p className="small muted">Nothing special on this page.</p>
          ) : (
            <ul className="small">
              {plan.kept.map((k, i) => (
                <li key={i}>
                  {k.label} — {k.placement}
                </li>
              ))}
            </ul>
          )}
          {Object.keys(plan.dropped).length > 0 && <p className="small muted">Not carried over: {Object.entries(plan.dropped).map(([k, n]) => `${n} ${k === 'rule' ? 'divider line(s)' : k}`).join(', ')}.</p>}
          {plan.unmapped.length > 0 && (
            <>
              <h3>Old text kept in notes</h3>
              <ul className="small">
                {plan.unmapped.map((u, i) => (
                  <li key={i}>
                    {u.text} {u.section && <span className="muted">(was under {u.section})</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.relocated.length > 0 && (
            <details>
              <summary className="small">Moved or relabelled ({plan.relocated.length})</summary>
              <ul className="small">
                {plan.relocated.map((r, i) => (
                  <li key={i}>
                    {r.text} — {r.from ?? 'text'} → {r.to}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      <h3>Before and after</h3>
      <div className="grid grid-2 compare-panes">
        <div>
          <p className="small muted">Now in LegendKeeper (version {plan.sourceVersion})</p>
          <LkBlocksPreview blocks={plan.originalBlocks} names={names} />
        </div>
        <div>
          <p className="small muted">Proposed</p>
          <LkBlocksPreview blocks={plan.proposedBlocks} names={names} />
        </div>
      </div>

      {backup && (
        <p className="small">
          Recovery: original saved {formatDate(backup.createdAt)} — {backup.status === 'applied' ? 'migration applied; it can be restored while the page is unchanged.' : backup.status === 'restored' ? `restored ${formatDate(backup.restoredAt)}.` : backup.status === 'not_applied' ? 'the migration was not written.' : 'outcome being checked.'}
          {backup.status === 'applied' && (
            <>
              {' '}
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => {
                  if (window.confirm(`Restore “${item.title}” to its saved original?`)) onAct({ action: 'restore', itemIds: [item.id], overwriteLaterEdits: false, confirm: true }, 'Restore finished')
                }}
              >
                Restore original
              </Button>{' '}
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  if (window.confirm(`Restore “${item.title}” even if it was edited after the migration? Those later edits will be lost.`)) onAct({ action: 'restore', itemIds: [item.id], overwriteLaterEdits: true, confirm: true }, 'Restore finished')
                }}
              >
                Restore, overwriting later edits
              </Button>
            </>
          )}
        </p>
      )}
    </div>
  )
}
