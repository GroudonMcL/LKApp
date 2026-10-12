'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { KnowledgeItemCard, type KnowledgeItemView } from '@/components/knowledge-item'
import { TimelineWritePanel } from '@/components/timeline-write-panel'
import { Badge, Button, Card, Empty, ErrorBox, KeyValue, Loading, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'

interface Preview {
  pages: number
  readable: number
  notRead: { id: string; name: string }[]
  ai: { provider: string; model: string; pages: { id: string; name: string; chars: number }[]; sends: string; requests: number } | null
}
interface Run {
  id: string
  status: string
  scope: Record<string, unknown>
  summary: { pages?: number; candidates?: number; created?: number; resolved?: number; ruleBased?: number; fromAi?: number }
  ai: { requests: number; dropped: number; stopped: string | null; servedBy: string[]; suspectedInstructions: string[] } | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}
interface CandidateData {
  title: string
  eventKind: string
  date: string
  dateReading: { display: string; kind: string; precision: string; approximate: boolean; notes: string[] } | null
  summary: string
  participants: { resourceId: string; name: string; kind: string }[]
  unmatchedNames: string[]
  notes: string[]
  existing: { entryId: string; title: string; origin: string; resourceId: string | null; display: string; agrees: boolean | null }[]
  sourceCount: number
  singleSource: boolean
}
interface RecipeOption {
  id: string
  definition: { name: string; targetPageType: string; customPageType: { id: string; label: string } | null }
}

const KIND_LABEL: Record<string, string> = {
  battle_war: 'Battle or war',
  political: 'Political change',
  founding_destruction: 'Founding or destruction',
  journey_discovery: 'Journey or discovery',
  religious_supernatural: 'Religious or supernatural',
  life: 'Birth, death or life',
  treaty_raid_disaster: 'Treaty, raid or disaster',
  other: 'Other',
}
const ORIGIN_LABEL: Record<string, string> = { event_page: 'event page', page_field: 'dated field', native_timeline: 'LegendKeeper timeline', accepted_candidate: 'accepted event' }

export default function DiscoverPage() {
  const [mode, setMode] = useState<'all' | 'folder' | 'criteria' | 'refs'>('all')
  const [folder, setFolder] = useState('')
  const [tag, setTag] = useState('')
  const [refs, setRefs] = useState('')
  const [useAi, setUseAi] = useState(false)
  const [aiPageLimit, setAiPageLimit] = useState(5)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [statusFilter, setStatusFilter] = useState('open')
  const [onlyNew, setOnlyNew] = useState(false)
  const state = useApi<{ running: boolean; runs: Run[] }>('/api/discovery')
  const items = useApi<{ items: KnowledgeItemView[]; total: number }>(`/api/knowledge?kinds=event_candidate&limit=500${statusFilter ? `&statuses=${statusFilter}` : ''}`)
  const recipes = useApi<{ recipes: RecipeOption[] }>('/api/recipes')
  const action = useAction()

  const input = () => {
    const refsList = refs.split('\n').map((r) => r.trim()).filter(Boolean)
    const scope =
      mode === 'folder'
        ? { mode: 'folder', folderId: folder.match(/resources\/([a-z0-9]+)/i)?.[1] ?? folder.trim() }
        : mode === 'criteria'
          ? { mode: 'criteria', tag: tag.trim() || null }
          : { mode: 'all' }
    return { scope, pageRefs: mode === 'refs' ? refsList : undefined, useAi, aiPageLimit }
  }

  // While a run is going, check every few seconds.
  useEffect(() => {
    if (!state.data?.running) return
    const t = setInterval(() => {
      void state.reload()
      void items.reload()
    }, 3000)
    return () => clearInterval(t)
  }, [state.data?.running, state, items])

  const eventRecipes = (recipes.data?.recipes ?? []).filter((r) => r.definition.targetPageType === 'historical_event' || /event|history/i.test(`${r.definition.name} ${r.definition.customPageType?.label ?? ''}`))
  const shown = (items.data?.items ?? []).filter((i) => !onlyNew || !((i.data as unknown as CandidateData).existing?.length > 0))
  const last = state.data?.runs[0]

  return (
    <>
      <div className="page-header">
        <p>
          <Link href="/chronology">← Chronology</Link>
        </p>
        <h1>Event discovery</h1>
        <p>
          Finds historical events described in your ordinary pages (battles, foundings, deaths, raids, treaties…) and lists them for you to accept, edit, reject or defer.
          It reads the page content the last <Link href="/health">Wiki Health audit</Link> stored; nothing is read from or written to LegendKeeper. A candidate says what
          a page states, not that it is true; disagreements between pages are kept as separate candidates.
        </p>
      </div>

      <Card title="1. Choose pages">
        <div className="row toolbar">
          {(
            [
              ['all', 'All read pages'],
              ['folder', 'A folder'],
              ['criteria', 'Pages with a tag'],
              ['refs', 'Specific pages'],
            ] as const
          ).map(([id, label]) => (
            <Button key={id} variant={mode === id ? 'primary' : 'secondary'} onClick={() => (setMode(id), setPreview(null))}>
              {label}
            </Button>
          ))}
        </div>
        {mode === 'folder' && <input className="inline-input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Folder page id or LegendKeeper link" />}
        {mode === 'criteria' && <input className="inline-input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag, e.g. Location" />}
        {mode === 'refs' && <textarea className="inline-input" rows={5} style={{ width: '100%' }} value={refs} onChange={(e) => setRefs(e.target.value)} placeholder="One page name, id or link per line" />}
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={useAi} onChange={(e) => (setUseAi(e.target.checked), setPreview(null))} /> Also ask the AI to read up to
            <input type="number" min={1} max={25} value={aiPageLimit} onChange={(e) => (setAiPageLimit(Number(e.target.value) || 1), setPreview(null))} style={{ width: '4rem' }} /> page(s)
          </label>
          <p className="small muted">
            Optional. The rule-based reader always runs and needs no AI. With OpenRouter&apos;s free models, each page is one request out of your 50 a day.
          </p>
        </div>
        <div className="row">
          <Button busy={action.busy} onClick={() => void action.run(async () => setPreview(await api.post<Preview>('/api/discovery', { action: 'preview', input: input() })))}>
            Check what will be read
          </Button>
          <Button
            variant="primary"
            disabled={!preview || preview.readable === 0 || state.data?.running}
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api.post('/api/discovery', { action: 'start', input: input() })
                await state.reload()
              })
            }
          >
            Find events
          </Button>
        </div>
        {preview && (
          <div>
            <p className="small">
              {preview.readable} of {preview.pages} selected page(s) have been read and will be searched.
              {preview.notRead.length > 0 && ` Not read yet (audit them first): ${preview.notRead.map((p) => p.name).slice(0, 10).join(', ')}${preview.notRead.length > 10 ? '…' : ''}.`}
            </p>
            {preview.ai && (
              <Notice tone="warning">
                <strong>Sent to the AI ({preview.ai.provider}, {preview.ai.model}):</strong> {preview.ai.sends} {preview.ai.requests} request(s):{' '}
                {preview.ai.pages.map((p) => `${p.name} (${p.chars.toLocaleString()} characters)`).join(', ')}.
                {preview.ai.provider === 'openrouter' && ' Free model providers may log prompts.'}
              </Notice>
            )}
          </div>
        )}
        <ErrorBox error={action.error} />
      </Card>

      {last && (
        <Card title="Last run">
          <KeyValue
            rows={[
              ['Status', <Badge key="s" tone={last.status === 'completed' ? 'good' : last.status === 'running' ? 'info' : 'bad'}>{last.status}</Badge>],
              ['Pages searched', String(last.summary.pages ?? '—')],
              ['Candidates', last.summary.candidates !== undefined ? `${last.summary.candidates} (${last.summary.created ?? 0} new; ${last.summary.ruleBased ?? 0} rule-based passage(s), ${last.summary.fromAi ?? 0} from the AI)` : '—'],
              ['AI', last.ai ? `${last.ai.requests} request(s)${last.ai.dropped ? `; ${last.ai.dropped} proposal(s) dropped because their quote was not on the page` : ''}${last.ai.stopped ? `; stopped: ${last.ai.stopped}` : ''}` : 'not used'],
              ['Finished', formatDate(last.finishedAt)],
            ]}
          />
          {last.error && <Notice tone="error">{last.error}</Notice>}
          {last.ai?.suspectedInstructions.length ? <Notice tone="warning">Text that reads like instructions was found and ignored: {last.ai.suspectedInstructions.join('; ')}</Notice> : null}
        </Card>
      )}

      <Card
        title="2. Review candidates"
        actions={
          <div className="row">
            <select className="inline-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Show">
              <option value="open">Waiting for a decision</option>
              <option value="accepted,drafted">Accepted or drafted</option>
              <option value="deferred">Needs research</option>
              <option value="rejected">Rejected</option>
              <option value="">All</option>
            </select>
            <label className="check small">
              <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Only events with no existing record
            </label>
            <a className="btn btn-ghost" href="/api/exports/knowledge?format=csv&kinds=event_candidate">
              Export CSV
            </a>
          </div>
        }
      >
        {items.loading && !items.data && <Loading />}
        <ErrorBox error={items.error} />
        {items.data && shown.length === 0 && <Empty title="No candidates here">Choose pages above and press “Find events”.</Empty>}
        {shown.map((item) => (
          <Candidate key={item.id} item={item} recipes={eventRecipes} onChanged={() => void items.reload()} />
        ))}
      </Card>
    </>
  )
}

function Candidate({ item, recipes, onChanged }: { item: KnowledgeItemView; recipes: RecipeOption[]; onChanged: () => void }) {
  const d = item.data as unknown as CandidateData
  const edits = (item.edits ?? {}) as Partial<{ title: string; date: string; summary: string }>
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(edits.title ?? d.title)
  const [date, setDate] = useState(edits.date ?? d.date)
  const [summary, setSummary] = useState(edits.summary ?? d.summary)
  const [recipeId, setRecipeId] = useState('')
  const [showTimeline, setShowTimeline] = useState(false)
  const action = useAction()
  const accepted = item.status === 'accepted' || item.status === 'drafted'
  return (
    <KnowledgeItemCard item={{ ...item, title: edits.title ?? item.title }} onChanged={onChanged}>
      <div className="small">
        <Badge>{KIND_LABEL[d.eventKind] ?? d.eventKind}</Badge> Date: <strong>{edits.date ?? d.date ?? ''}</strong>
        {!(edits.date ?? d.date) && <span className="muted"> (none given)</span>}
        {d.dateReading && !edits.date && <span className="muted"> · read as {d.dateReading.display} ({d.dateReading.kind})</span>}
        {' · '}
        {d.singleSource ? <Badge tone="warn" title="Only one page says this">single source</Badge> : <Badge tone="info">{d.sourceCount} sources</Badge>}
      </div>
      {d.participants.length > 0 && (
        <div className="pill-list small">
          {d.participants.map((p) => (
            <Link key={p.resourceId} href={`/pages/${encodeURIComponent(p.resourceId)}`} className="badge badge-neutral" title={p.kind}>
              {p.name}
            </Link>
          ))}
        </div>
      )}
      {d.unmatchedNames.length > 0 && <p className="small muted">Not linked (no single matching page): {d.unmatchedNames.join(', ')}</p>}
      {d.existing.length > 0 && (
        <Notice tone="info">
          May already be recorded:{' '}
          {d.existing.map((e, i) => (
            <span key={e.entryId}>
              {i > 0 && '; '}
              {e.resourceId ? <Link href={`/pages/${encodeURIComponent(e.resourceId)}`}>{e.title}</Link> : e.title} ({ORIGIN_LABEL[e.origin] ?? e.origin}, {e.display}
              {e.agrees === false ? ', different date' : e.agrees ? ', same date' : ''})
            </span>
          ))}
        </Notice>
      )}
      {d.notes.length > 0 && (
        <ul className="small muted">
          {d.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <div className="row toolbar">
        {item.status !== 'drafted' && (
          <Button variant="ghost" onClick={() => setEditing(!editing)}>
            {editing ? 'Close editor' : 'Edit'}
          </Button>
        )}
        {accepted && item.status !== 'drafted' && (
          <>
            <select className="inline-select" value={recipeId} onChange={(e) => setRecipeId(e.target.value)} aria-label="Event recipe">
              <option value="">Event recipe…</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.definition.name}
                </option>
              ))}
            </select>
            <Button
              disabled={!recipeId}
              busy={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api.post(`/api/knowledge/${item.id}`, { action: 'draft', recipeId })
                  onChanged()
                })
              }
              title="Makes an ordinary import draft; it is written to LegendKeeper only after its own final preview and approval"
            >
              Make a draft page
            </Button>
          </>
        )}
        {item.draftJobId && <Link href={`/import/${item.draftJobId}`}>Open the draft →</Link>}
        {accepted && (
          <Button variant="ghost" onClick={() => setShowTimeline(!showTimeline)}>
            {showTimeline ? 'Hide timeline' : 'Add to a LegendKeeper timeline'}
          </Button>
        )}
      </div>
      {accepted && recipes.length === 0 && item.status !== 'drafted' && (
        <p className="small muted">
          No event recipe yet. Accepted events stay in the local chronology without a page; to make pages, create a recipe for historical events under{' '}
          <Link href="/recipes">Recipes &amp; templates</Link>.
        </p>
      )}
      {editing && (
        <div className="comparison">
          <label>
            Title <input className="inline-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Date, as you want it recorded (e.g. “576 CY”, “c. 300 CY”, “before the Greyhawk Wars”, or empty){' '}
            <input className="inline-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Summary <textarea className="inline-input" rows={3} style={{ width: '100%' }} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <div className="row">
            <Button
              variant="primary"
              busy={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api.post(`/api/knowledge/${item.id}`, { action: 'edit', edits: { title, date, summary } })
                  setEditing(false)
                  onChanged()
                })
              }
            >
              Save changes
            </Button>
            <span className="small muted">The cited passage is kept unchanged as the evidence.</span>
          </div>
        </div>
      )}
      {showTimeline && <TimelineWritePanel entryId={`item:${item.id}`} defaultName={edits.title ?? item.title} />}
      <ErrorBox error={action.error} />
    </KnowledgeItemCard>
  )
}
