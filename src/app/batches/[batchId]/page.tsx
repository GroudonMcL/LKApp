'use client'

import Link from 'next/link'
import { use, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, KeyValue, Loading, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { BatchItemRow, BatchView } from '@/lib/types'
import type { RecordRules } from '@/core/records'

type Filter = 'all' | 'review' | 'approved' | 'duplicates' | 'errors' | 'missing' | 'failed' | 'done' | 'skipped'

const FILTERS: { id: Filter; label: string; test: (i: BatchItemRow) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'review', label: 'To review', test: (i) => i.status === 'awaiting_review' },
  { id: 'approved', label: 'Approved', test: (i) => i.status === 'approved' },
  { id: 'duplicates', label: 'Possible duplicates', test: (i) => i.flags.includes('possible_duplicate') || i.flags.includes('duplicate_in_batch') },
  { id: 'errors', label: 'With errors', test: (i) => (i.draft?.errors ?? 0) > 0 },
  { id: 'missing', label: 'Missing required fields', test: (i) => (i.draft?.missingRequired ?? 0) > 0 },
  { id: 'failed', label: 'Failed / unresolved', test: (i) => i.status === 'failed' || i.status === 'needs_reconciliation' },
  { id: 'done', label: 'Created', test: (i) => i.status === 'succeeded' },
  { id: 'skipped', label: 'Skipped', test: (i) => i.status === 'skipped' || i.status === 'cancelled' },
]

const MATCH_TONE: Record<string, 'bad' | 'warn' | 'neutral' | 'good'> = { exact: 'bad', strong: 'warn', ambiguous: 'warn', none: 'good' }

export default function BatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = use(params)
  const { data, error, loading, reload, setData } = useApi<BatchView>(`/api/batches/${encodeURIComponent(batchId)}`)
  const action = useAction()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [acknowledge, setAcknowledge] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const busy = data ? data.phase !== null || data.batch.status === 'processing' || data.batch.status === 'running' : false
  const wasBusy = useRef(false)
  useEffect(() => {
    // When background work ends, replace the "started" message so it does not linger.
    if (wasBusy.current && !busy) setMessage('Finished. The table below shows the outcome of each record.')
    wasBusy.current = busy
    if (!busy) return
    const timer = setInterval(() => void reload(), 1500)
    return () => clearInterval(timer)
  }, [busy, reload])

  const act = (body: Record<string, unknown>, done?: string) =>
    action.run(async () => {
      const view = await api.post<BatchView & { deferred?: number }>(`/api/batches/${batchId}/actions`, body)
      setData(view)
      setMessage(view.deferred ? `${done ?? 'Started'}. ${view.deferred} record(s) were left for the next run (AI limit per run).` : done ?? null)
    })

  if (error) return <ErrorBox error={error} />
  if (loading && !data) return <Loading />
  if (!data) return null

  const { batch, overview, recipe } = data
  const closed = batch.status === 'completed' || batch.status === 'cancelled'
  const visible = data.items.filter(FILTERS.find((f) => f.id === filter)!.test)
  const selectedIds = [...selected].filter((id) => data.items.some((i) => i.id === id))
  const selectedItems = data.items.filter((i) => selected.has(i.id))
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <>
      <div className="page-header">
        <p>
          <Link href="/batches">← Batch jobs</Link>
        </p>
        <h1>{batch.name}</h1>
        <p>
          <Badge tone={statusTone(batch.status)}>{batch.status}</Badge> {data.phase && <Badge tone="info">{data.phase}…</Badge>}{' '}
          {recipe && (
            <span className="small">
              Recipe <Link href={`/recipes/${recipe.id}`}>{recipe.name}</Link> version {recipe.version}
              {recipe.latestVersion && recipe.latestVersion !== recipe.version && <> (newer version {recipe.latestVersion} exists; this batch keeps using version {recipe.version})</>}
              {data.template && <> · template “{data.template}”</>}
            </span>
          )}
        </p>
      </div>

      {batch.error && <Notice tone="error">{batch.error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      <ErrorBox error={action.error} />

      <Card title="Overview">
        <div className="stats">
          <Stat label="Input files" value={overview.inputFiles} note={overview.failedFiles ? `${overview.failedFiles} unreadable` : undefined} />
          <Stat label="Records" value={overview.records} />
          <Stat label="Valid drafts" value={overview.validDrafts} />
          <Stat label="To review" value={overview.needsReview} />
          <Stat label="Possible duplicates" value={overview.possibleDuplicates} tone={overview.possibleDuplicates ? 'warn' : undefined} />
          <Stat label="Missing required fields" value={overview.missingRequired} tone={overview.missingRequired ? 'warn' : undefined} />
          <Stat label="Approved" value={overview.approved} />
          <Stat label="Created" value={overview.succeeded} tone={overview.succeeded ? 'good' : undefined} />
          <Stat label="Failed / unresolved" value={overview.failedOrUnresolved} tone={overview.failedOrUnresolved ? 'bad' : undefined} />
          <Stat label="Skipped" value={overview.skipped} />
        </div>
        {(data.usage.input > 0 || data.usage.output > 0) && (
          <p className="small muted">
            AI usage: {data.usage.input.toLocaleString('en-GB')} input and {data.usage.output.toLocaleString('en-GB')} output tokens
            {data.usage.estimatedCostUsd !== null ? <> — roughly ${data.usage.estimatedCostUsd.toFixed(2)} at {data.usage.model} list prices ({data.usage.pricesAsOf}); your Anthropic bill is authoritative.</> : '.'}
          </p>
        )}
      </Card>

      <Sources data={data} batchId={batchId} closed={closed} onChange={setData} />
      {!closed && recipe && <RecordRulesCard data={data} busy={busy || action.busy} onExtract={(rules) => act({ action: 'extract', rules }, 'Records extracted')} />}

      {!closed && data.items.length > 0 && (
        <Card title="3. Drafts">
          <p>
            Each record becomes a draft. <strong>Structural</strong> drafting reads labels and headings on this computer (no AI). <strong>AI</strong> drafting sends each
            record’s text, the recipe’s instructions and your tag names to the AI provider, at most {String((batch.options as { aiItemLimit?: number }).aiItemLimit ?? 25)} records per run;
            identical records are not sent twice.
          </p>
          <div className="row">
            <Button busy={action.busy} disabled={busy || overview.pending === 0} onClick={() => void act({ action: 'draft', mode: 'structural' }, 'Drafting started')}>
              Draft pending records (no AI)
            </Button>
            <Button busy={action.busy} disabled={busy || overview.pending === 0} onClick={() => void act({ action: 'draft', mode: 'ai' }, 'AI drafting started')}>
              Draft pending records with AI
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void act({ action: 'match' }, 'Duplicates checked again')}>
              Check duplicates again
            </Button>
          </div>
        </Card>
      )}

      <Card
        title={`Records (${data.items.length})`}
        actions={
          <div className="row">
            <a className="btn btn-ghost" href={`/api/batches/${batchId}/export?report=results&format=csv`}>
              Export CSV
            </a>
            <a className="btn btn-ghost" href={`/api/batches/${batchId}/export?report=results&format=json`}>
              Export JSON
            </a>
          </div>
        }
      >
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} ({data.items.filter(f.test).length})
            </button>
          ))}
        </div>
        {data.items.length === 0 && <Empty title="No records yet">Extract records from the files first.</Empty>}
        {visible.length > 0 && (
          <>
            {!closed && (
              <div className="row toolbar">
                <Button variant="ghost" onClick={() => setSelected(new Set(visible.map((i) => i.id)))}>
                  Select all shown
                </Button>
                <Button variant="ghost" disabled={!selectedIds.length} onClick={() => setSelected(new Set())}>
                  Clear selection ({selectedIds.length})
                </Button>
                <Button disabled={!selectedIds.length || busy} onClick={() => void act({ action: 'decide', itemIds: selectedIds, decision: 'create' }, 'Marked: create a new page despite the match')}>
                  Create anyway
                </Button>
                <Button disabled={!selectedIds.length || busy} onClick={() => void act({ action: 'decide', itemIds: selectedIds, decision: 'skip' }, 'Skipped')}>
                  Skip
                </Button>
                <Button disabled={!selectedItems.some((i) => i.status === 'skipped') || busy} onClick={() => void act({ action: 'decide', itemIds: selectedIds, decision: 'include' }, 'Included again')}>
                  Include
                </Button>
                <Button disabled={!selectedItems.some((i) => i.status === 'failed') || busy} onClick={() => void act({ action: 'retry', itemIds: selectedIds }, 'Ready to retry')}>
                  Retry failed
                </Button>
                <Button disabled={!selectedItems.some((i) => i.status === 'awaiting_review') || busy} onClick={() => void act({ action: 'draft', mode: 'structural', itemIds: selectedIds, regenerate: true }, 'Redrafting started')}>
                  Redraft (no AI)
                </Button>
                <Button disabled={!selectedItems.some((i) => i.status === 'approved') || busy} onClick={() => void act({ action: 'unapprove', itemIds: selectedIds }, 'Approval withdrawn')}>
                  Withdraw approval
                </Button>
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>#</th>
                    <th>Record</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Draft</th>
                    <th>Existing pages</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <ItemRow key={item.id} item={item} checked={selected.has(item.id)} onToggle={() => toggle(item.id)} disabled={closed} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {!closed && (
        <Card title="4. Check, approve and run">
          <ol className="small">
            <li>
              <strong>Dry run</strong> — every check of the final preview (connection, parent page, links, same-name search, validation, duplicates, key permissions) for the
              reviewed records. Nothing is written.
            </li>
            <li>
              <strong>Approve</strong> the selected records. Each approval is bound to the exact content checked; editing a draft afterwards withdraws it.
            </li>
            <li>
              <strong>Run</strong> creates the approved pages one at a time. Right before each write the app checks again that the parent exists and that no page with the same
              name has appeared. A failed record never stops the others.
            </li>
          </ol>
          <div className="row">
            <Button busy={action.busy} disabled={busy || (overview.needsReview === 0 && overview.approved === 0)} onClick={() => void act({ action: 'dry_run', itemIds: selectedIds.length ? selectedIds : undefined }, 'Dry run started')}>
              Dry run {selectedIds.length ? `(${selectedIds.length} selected)` : '(all reviewed)'}
            </Button>
            {data.hasDryRun && (
              <>
                <a className="btn btn-ghost" href={`/api/batches/${batchId}/export?report=dry_run&format=csv`}>
                  Dry-run report CSV
                </a>
                <a className="btn btn-ghost" href={`/api/batches/${batchId}/export?report=dry_run&format=json`}>
                  Dry-run report JSON
                </a>
              </>
            )}
          </div>
          <div className="confirm-box" style={{ marginTop: '0.75rem' }}>
            <label className="check">
              <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
              <span>I have reviewed the warnings of the selected records.</span>
            </label>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <Button
                variant="primary"
                busy={action.busy}
                disabled={busy || !selectedItems.some((i) => i.status === 'awaiting_review') || !recipe?.allowCreate}
                onClick={() => void act({ action: 'approve', itemIds: selectedIds, acknowledgeWarnings: acknowledge, confirm: true }, 'Approval started')}
              >
                Approve selected ({selectedItems.filter((i) => i.status === 'awaiting_review').length})
              </Button>
              <Button
                variant="primary"
                busy={action.busy}
                disabled={busy || overview.approved + overview.counts.needs_reconciliation === 0}
                onClick={() => {
                  if (confirm(`Create ${overview.approved} approved page(s) in LegendKeeper now?`)) void act({ action: 'run', confirm: true }, 'Running')
                }}
              >
                Run approved ({overview.approved})
              </Button>
              {overview.counts.needs_reconciliation > 0 && (
                <Button disabled={busy} onClick={() => void act({ action: 'reconcile' }, 'Outcomes checked')}>
                  Check unknown outcomes ({overview.counts.needs_reconciliation})
                </Button>
              )}
            </div>
            {recipe && !recipe.allowCreate && <p className="small">The recipe does not allow creating pages; turn on “Allow creation after approval” in a new recipe version and start a new batch.</p>}
          </div>
          <div className="row" style={{ marginTop: '1rem' }}>
            {busy && (
              <Button variant="ghost" onClick={() => void act({ action: 'stop' }, 'Stopping after the current record')}>
                Stop after the current record
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void act({ action: 'close' }, 'Batch closed')} title="Finish the batch: unwritten records are cancelled and stored source text is deleted">
              Close batch
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (confirm('Cancel this batch? Unwritten records are cancelled and the stored source text is deleted. Pages already created stay in LegendKeeper.')) void act({ action: 'cancel', confirm: true }, 'Batch cancelled')
              }}
            >
              Cancel batch
            </Button>
          </div>
        </Card>
      )}
      {closed && <Notice>This batch is {batch.status} ({formatDate(batch.finishedAt)}). Its source text has been deleted; the results and the audit history remain.</Notice>}
    </>
  )
}

function Stat({ label, value, note, tone }: { label: string; value: number; note?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="small muted">{note}</div>}
    </div>
  )
}

function ItemRow({ item, checked, onToggle, disabled }: { item: BatchItemRow; checked: boolean; onToggle: () => void; disabled: boolean }) {
  const match = item.match as { category: string; explanation: string; candidates: { resourceId: string; name: string; path: string | null }[]; withinBatch?: string[] } | null
  return (
    <tr>
      <td>
        <input type="checkbox" aria-label={`Select ${item.title}`} checked={checked} onChange={onToggle} disabled={disabled} />
      </td>
      <td className="small">{item.seq + 1}</td>
      <td>
        {item.jobId ? <Link href={`/import/${item.jobId}`}>{item.draft?.name || item.title}</Link> : item.title}
        {item.flagExplanations.length > 0 && (
          <div className="small muted">
            {item.flags
              .filter((f) => !['possible_duplicate', 'duplicate_in_batch', 'no_index'].includes(f))
              .map((f) => (
                <Badge key={f} tone="warn" title={item.flagExplanations.join(' ') ?? ''}>
                  {f.replace(/_/g, ' ')}
                </Badge>
              ))}
          </div>
        )}
        {item.error && <div className="small error-text">{item.error}</div>}
      </td>
      <td className="small">
        {item.record?.fileName ?? item.record?.documentTitle ?? '—'}
        {item.record?.section && <div className="muted">{item.record.section}</div>}
        {item.record?.page && <div className="muted">p. {item.record.page}</div>}
      </td>
      <td>
        <Badge tone={item.status === 'succeeded' ? 'good' : item.status === 'failed' || item.status === 'needs_reconciliation' ? 'bad' : item.status === 'approved' ? 'info' : item.status === 'awaiting_review' ? 'warn' : 'neutral'} title={item.statusExplanation}>
          {item.status.replace(/_/g, ' ')}
        </Badge>
        {item.decision && <div className="small muted">decision: {item.decision}</div>}
        {item.resourceId && (
          <div className="small">
            <Link href={`/pages/${item.resourceId}`}>open page</Link>
          </div>
        )}
      </td>
      <td className="small">
        {item.draft ? (
          <>
            {item.draft.errors > 0 && <Badge tone="bad">{item.draft.errors} error(s)</Badge>} {item.draft.warnings > 0 && <Badge tone="warn">{item.draft.warnings} warning(s)</Badge>}
            {item.draft.errors === 0 && item.draft.warnings === 0 && <Badge tone="good">valid</Badge>}
            <div className="muted">{item.draft.mode === 'ai' ? 'AI' : 'structural'}</div>
          </>
        ) : (
          <span className="muted">no draft</span>
        )}
      </td>
      <td className="small">
        {match ? (
          <details>
            <summary>
              <Badge tone={MATCH_TONE[match.category] ?? 'neutral'}>{match.category === 'none' ? 'no match' : match.category}</Badge>
              {match.withinBatch?.length ? <Badge tone="warn">same name in batch</Badge> : null}
            </summary>
            <p>{match.explanation}</p>
            {match.candidates.length > 0 && (
              <ul>
                {match.candidates.map((c) => (
                  <li key={c.resourceId}>
                    <Link href={`/pages/${c.resourceId}`}>{c.name}</Link> {c.path && <span className="muted">({c.path})</span>}
                  </li>
                ))}
              </ul>
            )}
            {item.matchBlocker && <p className="error-text">{item.matchBlocker}</p>}
          </details>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  )
}

function Sources({ data, batchId, closed, onChange }: { data: BatchView; batchId: string; closed: boolean; onChange: (view: BatchView) => void }) {
  const action = useAction()
  const [open, setOpen] = useState<string | null>(null)
  const [text, setText] = useState<{ id: string; text: string | null } | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const show = (id: string) =>
    action.run(async () => {
      if (open === id) {
        setOpen(null)
        return
      }
      const result = await api.get<{ text: string | null }>(`/api/batches/${batchId}/sources/${id}`)
      setText({ id, text: result.text })
      setOpen(id)
    })
  const upload = () =>
    action.run(async () => {
      let view: BatchView | null = null
      for (const file of files) {
        const form = new FormData()
        form.set('file', file)
        view = await api.upload<BatchView>(`/api/batches/${batchId}/sources`, form)
      }
      if (view) onChange(view)
      setFiles([])
    })
  return (
    <Card title="1. Files">
      <ErrorBox error={action.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Type</th>
              <th>Read by</th>
              <th>Size</th>
              <th>Records</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.sources.map((source) => (
              <tr key={source.id}>
                <td>
                  {source.fileName ?? source.title ?? 'Pasted text'}
                  {source.warnings.length > 0 && (
                    <ul className="small muted">
                      {source.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                  {open === source.id && text?.id === source.id && <pre className="source-text">{text.text ?? '(no text stored)'}</pre>}
                </td>
                <td>{source.originalFormat}</td>
                <td className="small">{source.method === 'ai_transcription' ? 'AI transcription' : 'parser (no AI)'}</td>
                <td className="small">
                  {(source.size / 1024).toFixed(1)} KB
                  {source.totalPages ? ` · ${source.totalPages} page(s)` : ''}
                  {source.chars ? ` · ${source.chars.toLocaleString('en-GB')} characters` : ''}
                </td>
                <td>{source.recordCount}</td>
                <td>
                  <Badge tone={source.status === 'extracted' ? 'good' : source.status === 'failed' ? 'bad' : 'warn'}>{source.status.replace('_', ' ')}</Badge>
                  {source.error && <div className="small error-text">{source.error}</div>}
                </td>
                <td className="nowrap">
                  {source.status === 'extracted' && !source.purgedAt && (
                    <Button variant="ghost" onClick={() => void show(source.id)}>
                      {open === source.id ? 'Hide text' : 'Show text'}
                    </Button>
                  )}
                  {source.status === 'needs_transcription' && !closed && (
                    <Button
                      busy={action.busy}
                      onClick={() => {
                        if (confirm(`Send “${source.fileName ?? 'this file'}” to the AI provider for transcription? The whole file is sent.`))
                          void action.run(async () => onChange(await api.post<BatchView>(`/api/batches/${batchId}/sources/${source.id}/transcribe`)))
                      }}
                    >
                      Transcribe with AI
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!closed && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <input type="file" multiple aria-label="Add files" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          <Button disabled={files.length === 0} busy={action.busy} onClick={() => void upload()}>
            Add {files.length || ''} file(s)
          </Button>
        </div>
      )}
    </Card>
  )
}

function RecordRulesCard({ data, busy, onExtract }: { data: BatchView; busy: boolean; onExtract: (rules: RecordRules) => void }) {
  const initial = data.recipe!.rules
  const [rules, setRules] = useState<RecordRules>(initial)
  const changed = useMemo(() => JSON.stringify(rules) !== JSON.stringify(initial), [rules, initial])
  const set = (patch: Partial<RecordRules>) => setRules({ ...rules, ...patch })
  const hasRecords = data.items.length > 0
  return (
    <Card title="2. Records">
      <p>
        How each file is split into records. These come from the recipe; changes here apply to this batch only. Doubtful records (very short, very long, missing the expected
        labels, text before the first record) are flagged, never silently merged or dropped.
      </p>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="r-mode">Split</label>
          <select id="r-mode" value={rules.mode} onChange={(e) => set({ mode: e.target.value as RecordRules['mode'] })}>
            <option value="whole">Each file is one record</option>
            <option value="heading">At headings of one level</option>
            <option value="statblock">At each statblock (name + “Size Type, Alignment” line)</option>
            <option value="separator">At separator lines</option>
            <option value="paragraph">Each blank-line paragraph</option>
            <option value="json_array">Each item of a JSON list</option>
          </select>
        </div>
        {rules.mode === 'heading' && (
          <div className="field">
            <label htmlFor="r-level">Heading level</label>
            <select id="r-level" value={rules.headingLevel} onChange={(e) => set({ headingLevel: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {'#'.repeat(n)} (level {n})
                </option>
              ))}
            </select>
          </div>
        )}
        {rules.mode === 'separator' && (
          <div className="field">
            <label htmlFor="r-sep">Separator line</label>
            <input id="r-sep" type="text" value={rules.separator} onChange={(e) => set({ separator: e.target.value })} />
          </div>
        )}
        {rules.mode === 'json_array' && (
          <div className="field">
            <label htmlFor="r-path">Path to the list (empty = the file itself)</label>
            <input id="r-path" type="text" value={rules.jsonPath} onChange={(e) => set({ jsonPath: e.target.value })} placeholder="e.g. items" />
            <label htmlFor="r-name">Name field</label>
            <input id="r-name" type="text" value={rules.jsonNamePath} onChange={(e) => set({ jsonNamePath: e.target.value })} />
            <label htmlFor="r-id">Identifier field</label>
            <input id="r-id" type="text" value={rules.jsonIdPath} onChange={(e) => set({ jsonIdPath: e.target.value })} />
          </div>
        )}
        <div className="field">
          <label htmlFor="r-min">Flag records shorter than (characters)</label>
          <input id="r-min" type="number" min={0} value={rules.minChars} onChange={(e) => set({ minChars: Number(e.target.value) })} />
          <label htmlFor="r-labels">Each record should contain one of (comma-separated)</label>
          <input id="r-labels" type="text" value={rules.expectLabels.join(', ')} onChange={(e) => set({ expectLabels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="e.g. Armor Class, AC" />
        </div>
      </div>
      <KeyValue rows={[['Records so far', String(data.overview.records)]]} />
      <div className="row">
        <Button
          variant="primary"
          disabled={busy || data.overview.inputFiles - data.overview.failedFiles - data.overview.needsTranscription === 0}
          onClick={() => {
            if (!hasRecords || confirm('Extract the records again? Records that are not approved or written are replaced (their drafts are cancelled).')) onExtract(rules)
          }}
        >
          {hasRecords ? 'Extract records again' : 'Extract records'}
        </Button>
        {changed && <span className="small muted">Changed from the recipe (applies to this batch only).</span>}
      </div>
    </Card>
  )
}
