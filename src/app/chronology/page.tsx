'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { Citation, KnowledgeItemCard, type CitationView, type KnowledgeItemView } from '@/components/knowledge-item'
import { TimelineWritePanel } from '@/components/timeline-write-panel'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'

interface DatePointView {
  year: number | null
  yearAsWritten: number | null
  era: string | null
  eraAssumed: boolean
  month: string | null
  day: number | null
}
interface ChronoDateView {
  original: string
  calendarId: string
  kind: string
  precision: string
  approximate: boolean
  qualifier: string | null
  start: DatePointView | null
  end: DatePointView | null
  relative: { relation: string; anchor: string } | null
  sort: { lo: number; hi: number } | null
  notes: string[]
}
interface EntryView {
  id: string
  origin: 'event_page' | 'page_field' | 'native_timeline' | 'accepted_candidate'
  title: string
  date: ChronoDateView
  display: string
  status: 'dated' | 'approximate' | 'relative' | 'undated' | 'unplaced'
  resourceId: string | null
  summary: string | null
  sources: CitationView[]
  participants: { resourceId: string; name: string; kind: string }[]
  categories: string[]
  timeline: { resourceId: string; documentId: string; name: string; lane: string | null; eventId: string } | null
  group: string
  conflictsWith: string[]
  period: number | null
}
interface ConflictView {
  key: string
  kind: string
  title: string
  explanation: string
  entryIds: string[]
  certainty: string
  itemId: string | null
  decision: string | null
}
interface TimelineView {
  resourceId: string
  documentId: string
  resourceName: string
  name: string
  calendarId: string | null
  lanes: { id: string; name: string; external: boolean }[]
  eventCount: number
  fetchedAt: string
  error: string | null
}
interface ChronologyView {
  calendar: string
  calendars: { id: string; name: string; lkCalendarIds: string[]; count: number }[]
  settings: unknown
  autoLinked: { lkCalendarId: string; calendarId: string }[]
  grouping: 'year' | 'decade' | 'century'
  entries: EntryView[]
  total: number
  periods: { start: number; count: number; label: string }[]
  counts: { all: number; dated: number; uncertain: number; undated: number; conflicts: number }
  conflicts: ConflictView[]
  sources: { indexed: number; read: number; readWithFields: number; lastRead: string | null; eventPages: number; pageFields: number; accepted: number; native: number; timelines: TimelineView[] }
  lkCalendars: { id: string; name: string; positiveEras: { abbr: string }[]; negativeEra: { abbr: string } | null; months: string[]; builtIn: boolean }[]
  participants: { resourceId: string; name: string; kind: string; count: number }[]
  categories: { name: string; count: number }[]
}

const ORIGIN_LABEL: Record<EntryView['origin'], string> = {
  event_page: 'Event page',
  page_field: 'Page field',
  native_timeline: 'LegendKeeper timeline',
  accepted_candidate: 'Accepted event',
}
const STATUS_TONE: Record<EntryView['status'], 'good' | 'info' | 'warn' | 'neutral'> = { dated: 'good', approximate: 'info', relative: 'info', undated: 'warn', unplaced: 'warn' }
const STATUS_LABEL: Record<EntryView['status'], string> = { dated: 'dated', approximate: 'approximate', relative: 'relative', undated: 'no date', unplaced: 'not placed' }

type Tab = 'timeline' | 'uncertain' | 'conflicts' | 'native' | 'calendars'

export default function ChronologyPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Chronology />
    </Suspense>
  )
}

function Chronology() {
  const params = useSearchParams()
  const [tab, setTab] = useState<Tab>('timeline')
  const [filters, setFilters] = useState<Record<string, string>>(() => ({ status: 'all', grouping: 'auto', ...(params.get('participant') ? { participant: params.get('participant')! } : {}) }))
  const statusForTab = tab === 'uncertain' ? 'uncertain' : tab === 'conflicts' ? 'conflicts' : filters.status
  const query = useMemo(() => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...filters, status: statusForTab })) if (v) params.set(k, v)
    return `/api/chronology?${params}`
  }, [filters, statusForTab])
  const { data, error, loading, reload } = useApi<ChronologyView>(query)
  const action = useAction()
  const [message, setMessage] = useState<string | null>(null)
  const set = (key: string, value: string) => setFilters((f) => ({ ...f, [key]: value }))

  const readTimelines = () =>
    action.run(async () => {
      const r = await api.post<{ timelines: number; events: number; failed: string[]; sync: { conflicts: number; created: number } }>('/api/chronology', { action: 'readTimelines' })
      setMessage(`Read ${r.timelines} timeline(s) with ${r.events} event(s).${r.failed.length ? ` ${r.failed.length} could not be read.` : ''} ${r.sync.conflicts} conflict(s) found, ${r.sync.created} new.`)
      await reload()
    })
  const checkConflicts = () =>
    action.run(async () => {
      const r = await api.post<{ conflicts: number; created: number; resolved: number }>('/api/chronology', { action: 'checkConflicts' })
      setMessage(`${r.conflicts} conflict(s) found: ${r.created} new, ${r.resolved} no longer present. They are in the review queue.`)
      await reload()
    })

  return (
    <>
      <div className="page-header">
        <h1>Chronology</h1>
        <p className="lead">Dated events from your pages, timelines and accepted discoveries, in order. Read-only.</p>
        <More>
          <p className="small">
            A <strong>local chronology</strong> built from your pages (event pages, and dated fields such as Born, Died and Founded), the LegendKeeper timelines as last
          read, and the events you accepted from <Link href="/chronology/discover">event discovery</Link>. Dates are shown as the sources write them; uncertainty is kept,
          and disagreements are reported, never resolved for you. Viewing this changes nothing in LegendKeeper. It is <em>not</em> a LegendKeeper timeline: an event
          only reaches a LegendKeeper timeline when you add it there yourself, through the approval step on the event discovery page.
          </p>
        </More>
      </div>
      <ErrorBox error={error} />
      <ErrorBox error={action.error} />
      {message && <Notice tone="success">{message}</Notice>}
      {data && <Sources data={data} busy={action.busy} onReadTimelines={readTimelines} onCheck={checkConflicts} />}

      <div className="tabs" role="tablist">
        {(
          [
            ['timeline', `Timeline${data ? ` (${data.counts.all})` : ''}`],
            ['uncertain', `Uncertain & undated${data ? ` (${data.counts.uncertain + data.counts.undated})` : ''}`],
            ['conflicts', `Conflicts${data ? ` (${data.conflicts.length})` : ''}`],
            ['native', 'LegendKeeper timelines'],
            ['calendars', 'Calendars'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {loading && !data && <Loading />}
      {data && (tab === 'timeline' || tab === 'uncertain') && (
        <>
          <Filters data={data} filters={filters} set={set} uncertain={tab === 'uncertain'} />
          {tab === 'timeline' && data.periods.length > 1 && <PeriodChart data={data} filters={filters} setFilters={setFilters} />}
          {tab === 'uncertain' && (
            <div className="row toolbar">
              {(['uncertain', 'undated'] as const).map((s) => (
                <Button key={s} variant={filters.status === s || (s === 'uncertain' && filters.status !== 'undated') ? 'primary' : 'secondary'} onClick={() => set('status', s)}>
                  {s === 'uncertain' ? `Approximate, relative or unplaced (${data.counts.uncertain})` : `No date (${data.counts.undated})`}
                </Button>
              ))}
            </div>
          )}
          <EntryList data={tab === 'uncertain' && filters.status === 'undated' ? { ...data, entries: data.entries.filter((e) => e.status === 'undated') } : data} />
        </>
      )}
      {data && tab === 'conflicts' && <Conflicts data={data} onChanged={reload} />}
      {data && tab === 'native' && <NativeTimelines data={data} busy={action.busy} onRead={readTimelines} />}
      {data && tab === 'calendars' && <Calendars data={data} onSaved={reload} />}
    </>
  )
}

function Sources({ data, busy, onReadTimelines, onCheck }: { data: ChronologyView; busy: boolean; onReadTimelines: () => void; onCheck: () => void }) {
  const s = data.sources
  return (
    <Card
      title="What this is built from"
      actions={
        <div className="row">
          <Button busy={busy} onClick={onReadTimelines} title="Reads every LegendKeeper timeline found by the last scan (read-only)">
            Read LegendKeeper timelines
          </Button>
          <Button busy={busy} onClick={onCheck} title="Records conflicts and undated event pages in the review queue">
            Check for conflicts
          </Button>
          <a className="btn btn-ghost" href={`/api/exports/chronology?format=csv&calendar=${encodeURIComponent(data.calendar)}`}>
            Export CSV
          </a>
          <a className="btn btn-ghost" href={`/api/exports/chronology?format=json&calendar=${encodeURIComponent(data.calendar)}`}>
            Export JSON
          </a>
        </div>
      }
    >
      <div className="stats">
        <div className="stat">
          <div className="stat-value">
            {s.read}/{s.indexed}
          </div>
          <div className="stat-label">pages read by audits</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s.eventPages}</div>
          <div className="stat-label">event pages</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s.pageFields}</div>
          <div className="stat-label">dated fields</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s.native}</div>
          <div className="stat-label">timeline events ({s.timelines.length} timeline{s.timelines.length === 1 ? '' : 's'})</div>
        </div>
        <div className="stat">
          <div className="stat-value">{s.accepted}</div>
          <div className="stat-label">accepted events</div>
        </div>
      </div>
      <p className="small muted">
        Page content is as of the last <Link href="/health">Wiki Health audit</Link> that read each page (latest {formatDate(s.lastRead)}). Run an audit to bring it up to
        date.
        {s.read > 0 && s.readWithFields < s.read && ` ${s.read - s.readWithFields} page(s) were read before infobox fields were recorded; audit them again to include their Date, Born and Died fields.`}
      </p>
    </Card>
  )
}

function Filters({ data, filters, set, uncertain }: { data: ChronologyView; filters: Record<string, string>; set: (k: string, v: string) => void; uncertain: boolean }) {
  return (
    <Card title="Filters">
      <div className="filter-grid">
        <label>
          Calendar
          <select value={filters.calendar ?? data.calendar} onChange={(e) => set('calendar', e.target.value)}>
            {data.calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        </label>
        {!uncertain && (
          <>
            <label>
              From year
              <input type="number" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value)} placeholder="e.g. 500" />
            </label>
            <label>
              To year
              <input type="number" value={filters.to ?? ''} onChange={(e) => set('to', e.target.value)} placeholder="e.g. 600" />
            </label>
          </>
        )}
        <label>
          Search
          <input value={filters.q ?? ''} onChange={(e) => set('q', e.target.value)} placeholder="Title, people, wording" />
        </label>
        <label>
          Involving
          <select value={filters.participant ?? ''} onChange={(e) => set('participant', e.target.value)}>
            <option value="">Anyone or anywhere</option>
            {data.participants.map((p) => (
              <option key={p.resourceId} value={p.resourceId}>
                {p.name} ({p.kind}, {p.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          Involving any
          <select value={filters.participantKind ?? ''} onChange={(e) => set('participantKind', e.target.value)}>
            <option value="">—</option>
            {['person', 'deity', 'faction', 'place', 'creature'].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category (tag or lane)
          <select value={filters.category ?? ''} onChange={(e) => set('category', e.target.value)}>
            <option value="">All</option>
            {data.categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select value={filters.origin ?? ''} onChange={(e) => set('origin', e.target.value)}>
            <option value="">All sources</option>
            {Object.entries(ORIGIN_LABEL).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!uncertain && (
          <label>
            Group by
            <select value={filters.grouping ?? 'auto'} onChange={(e) => set('grouping', e.target.value)}>
              {['auto', 'year', 'decade', 'century'].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="small muted">
        Showing {Math.min(data.entries.length, data.total)} of {data.total} matching entr{data.total === 1 ? 'y' : 'ies'} in this calendar.
      </p>
    </Card>
  )
}

/** Events per period: bars, not labels, so dense periods stay readable. Click a bar to focus on it. */
function PeriodChart({ data, filters, setFilters }: { data: ChronologyView; filters: Record<string, string>; setFilters: (f: (old: Record<string, string>) => Record<string, string>) => void }) {
  const max = Math.max(...data.periods.map((p) => p.count))
  const width = data.grouping === 'year' ? 0 : data.grouping === 'decade' ? 9 : 99
  return (
    <Card title={`Events per ${data.grouping}`}>
      <div className="period-chart" role="list">
        {data.periods.map((p) => {
          const selected = filters.from === String(p.start) && filters.to === String(p.start + width)
          return (
            <button
              key={p.start}
              role="listitem"
              className="period-row"
              aria-pressed={selected}
              title={`${p.count} event(s), ${p.label}. Click to show only this period.`}
              onClick={() => setFilters((f) => (selected ? { ...f, from: '', to: '' } : { ...f, from: String(p.start), to: String(p.start + width) }))}
            >
              <span className="period-label">{p.label}</span>
              <span className="period-bar" style={{ width: `${Math.max(1, (p.count / max) * 100)}%` }} />
              <span className="small">{p.count}</span>
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function EntryList({ data }: { data: ChronologyView }) {
  if (data.entries.length === 0)
    return (
      <Empty title="No events here">
        Event pages (tagged Event, History or similar), dated fields (Born, Died, Founded) and accepted events appear once their pages have been read by a{' '}
        <Link href="/health">Wiki Health audit</Link>. Use <Link href="/chronology/discover">event discovery</Link> to find events mentioned in ordinary pages.
      </Empty>
    )
  let lastPeriod: number | null | undefined
  const label = new Map(data.periods.map((p) => [p.start, p.label]))
  return (
    <Card>
      <ul className="chrono-list">
        {data.entries.map((e) => {
          const header = e.period !== lastPeriod
          lastPeriod = e.period
          return (
            <li key={e.id}>
              {header && <h3 className="chrono-period">{e.period === null ? 'Not placed in order' : label.get(e.period) ?? e.period}</h3>}
              <Entry entry={e} all={data.entries} />
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function Entry({ entry, all }: { entry: EntryView; all: EntryView[] }) {
  const [addTo, setAddTo] = useState(false)
  const conflicts = entry.conflictsWith.map((id) => all.find((e) => e.id === id)).filter((e): e is EntryView => Boolean(e))
  return (
    <div className="chrono-entry">
      <div>
        <div className="chrono-date">{entry.display}</div>
        <Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Badge>
      </div>
      <div>
        <div className="row">
          {entry.resourceId ? <Link href={`/pages/${encodeURIComponent(entry.resourceId)}`}>{entry.title}</Link> : <strong>{entry.title}</strong>}
          <Badge>{ORIGIN_LABEL[entry.origin]}</Badge>
          {conflicts.length > 0 && <Badge tone="bad">conflicting date</Badge>}
        </div>
        {entry.summary && <div className="small">{entry.summary}</div>}
        {entry.participants.length > 0 && (
          <div className="pill-list small">
            {entry.participants.map((p) => (
              <Link key={p.resourceId} href={`/pages/${encodeURIComponent(p.resourceId)}`} className="badge badge-neutral" title={p.kind}>
                {p.name}
              </Link>
            ))}
          </div>
        )}
        <details>
          <summary className="small">Date and sources</summary>
          <dl className="kv small">
            <div>
              <dt>As written</dt>
              <dd>
                <code>{entry.date.original || '(nothing)'}</code>
              </dd>
            </div>
            <div>
              <dt>Read as</dt>
              <dd>
                {entry.date.kind}, precision {entry.date.precision}
                {entry.date.sort && ` · placed at ${Math.floor(entry.date.sort.lo)}${Math.floor(entry.date.sort.hi) !== Math.floor(entry.date.sort.lo) ? `–${Math.floor(entry.date.sort.hi)}` : ''} on the primary count`}
              </dd>
            </div>
            {entry.date.notes.length > 0 && (
              <div>
                <dt>Notes</dt>
                <dd>{entry.date.notes.join(' ')}</dd>
              </div>
            )}
            {entry.timeline && (
              <div>
                <dt>Timeline</dt>
                <dd>
                  <Link href={`/pages/${encodeURIComponent(entry.timeline.resourceId)}`}>{entry.timeline.name}</Link>
                  {entry.timeline.lane && `, lane “${entry.timeline.lane}”`} · event <code>{entry.timeline.eventId}</code>
                </dd>
              </div>
            )}
          </dl>
          {entry.sources.map((s, i) => (
            <Citation key={i} citation={s} />
          ))}
          {conflicts.length > 0 && (
            <Notice tone="warning">
              Other sources date this differently:{' '}
              {conflicts.map((c) => `${c.sources[0]?.resourceName ?? c.title}: “${c.date.original}”`).join('; ')}. Both are kept; decide in the Conflicts tab.
            </Notice>
          )}
          {entry.origin !== 'native_timeline' && (entry.status === 'dated' || entry.date.kind === 'range') && (
            <Button variant="ghost" onClick={() => setAddTo(!addTo)}>
              {addTo ? 'Hide' : 'Add to a LegendKeeper timeline'}
            </Button>
          )}
          {addTo && <TimelineWritePanel entryId={entry.id} defaultName={entry.title} />}
        </details>
      </div>
    </div>
  )
}

function Conflicts({ data, onChanged }: { data: ChronologyView; onChanged: () => void }) {
  const items = useApi<{ items: KnowledgeItemView[] }>('/api/knowledge?kinds=chronology_conflict,unresolved_date&limit=500')
  useEffect(() => {
    void items.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  if (data.conflicts.length === 0 && !items.data?.items.length)
    return <Empty title="No conflicting dates found">Dates that disagree between sources, deaths before births and events after a recorded death are listed here.</Empty>
  const recorded = new Set(items.data?.items.map((i) => i.id))
  return (
    <>
      <Notice tone="info">
        Each conflict cites the sources that disagree. The app does not choose between them: mark a conflict intentional (an unreliable source, a deliberate mystery),
        resolved once you have corrected a page, or as needing research. Decisions persist; a conflict comes back only if the cited wording changes.
      </Notice>
      {data.conflicts
        .filter((c) => !c.itemId || !recorded.has(c.itemId))
        .map((c) => (
          <div key={c.key} className="knowledge-item">
            <strong>{c.title}</strong> <Badge tone="warn">not yet recorded</Badge>
            <p className="small">{c.explanation}</p>
            <p className="small muted">Press “Check for conflicts” to add it to the review queue.</p>
          </div>
        ))}
      {items.data?.items.map((item) => (
        <KnowledgeItemCard key={item.id} item={item} onChanged={() => onChanged()} />
      ))}
    </>
  )
}

function NativeTimelines({ data, busy, onRead }: { data: ChronologyView; busy: boolean; onRead: () => void }) {
  const timelines = data.sources.timelines
  return (
    <>
      <Notice tone="info">
        LegendKeeper timelines are read with the documented API (read-only here). Their events appear in the chronology when the timeline&apos;s calendar is linked to one
        of your calendar settings (Calendars tab). LegendKeeper stores a date&apos;s precision (year, month or day) but not whether it is approximate, so events read
        from a timeline are shown as exact unless a range was entered.
      </Notice>
      {timelines.length === 0 ? (
        <Empty title="No timelines read yet">
          <Button busy={busy} onClick={onRead}>
            Read LegendKeeper timelines
          </Button>
        </Empty>
      ) : (
        <Card title="Timelines">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timeline</th>
                  <th>Calendar</th>
                  <th>Lanes</th>
                  <th>Events</th>
                  <th>Read</th>
                </tr>
              </thead>
              <tbody>
                {timelines.map((t) => {
                  const linked = data.calendars.find((c) => c.lkCalendarIds.includes(t.calendarId ?? ''))
                  const lk = data.lkCalendars.find((c) => c.id === t.calendarId)
                  return (
                    <tr key={t.documentId}>
                      <td>
                        <Link href={`/pages/${encodeURIComponent(t.resourceId)}`}>{t.resourceName}</Link> / {t.name}
                        {t.error && <div className="small error-text">{t.error}</div>}
                      </td>
                      <td className="small">
                        {lk?.name ?? t.calendarId ?? '—'} <code>{t.calendarId}</code>
                        <div>
                          {linked ? <Badge tone="good">uses {linked.name}</Badge> : <Badge tone="warn">not linked to a calendar setting</Badge>}{' '}
                          {data.autoLinked.some((a) => a.lkCalendarId === t.calendarId) && <span className="small muted">(linked automatically: same months and eras)</span>}
                        </div>
                      </td>
                      <td className="small">{t.lanes.filter((l) => !l.external).map((l) => l.name).join(', ') || '—'}</td>
                      <td>{t.eventCount}</td>
                      <td className="small">{formatDate(t.fetchedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}

function Calendars({ data, onSaved }: { data: ChronologyView; onSaved: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(data.settings, null, 2))
  const action = useAction()
  const [saved, setSaved] = useState(false)
  const save = (body: Record<string, unknown>) =>
    action.run(async () => {
      const r = await api.post<{ settings: unknown }>('/api/chronology', body)
      setText(JSON.stringify(r.settings, null, 2))
      setSaved(true)
      onSaved()
    })
  return (
    <>
      <Card title="Calendar settings">
        <p className="small">
          Each calendar lists its eras, months and the LegendKeeper calendars that use it (<code>lkCalendarIds</code>). An era converts to the primary era only when it
          has an <code>offset</code>; eras without one are read and kept as written but not placed in order. Nothing assumes calendars share months, year lengths or
          eras. Changes affect only how the app reads dates; they change nothing in LegendKeeper.
        </p>
        <textarea className="code" value={text} onChange={(e) => (setText(e.target.value), setSaved(false))} aria-label="Calendar settings (JSON)" spellCheck={false} />
        <div className="row">
          <Button
            variant="primary"
            busy={action.busy}
            onClick={() => {
              let parsed: unknown
              try {
                parsed = JSON.parse(text)
              } catch {
                action.setError({ message: 'That is not valid JSON.', code: 'INVALID_JSON', issues: [], requestId: null, kind: null, status: 400 })
                return
              }
              void save({ action: 'saveCalendars', settings: parsed })
            }}
          >
            Save calendars
          </Button>
          <Button busy={action.busy} onClick={() => void save({ action: 'resetCalendars' })}>
            Reset to the defaults
          </Button>
          {saved && <span className="small muted">Saved.</span>}
        </div>
        <ErrorBox error={action.error} />
      </Card>
      <Card title="Calendars in LegendKeeper">
        {data.lkCalendars.length === 0 ? (
          <p className="small muted">Read the LegendKeeper timelines to list the project&apos;s calendars.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Calendar</th>
                  <th>Id</th>
                  <th>Eras</th>
                  <th>Months</th>
                  <th>Linked to</th>
                </tr>
              </thead>
              <tbody>
                {data.lkCalendars.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.name} {!c.builtIn && <Badge>custom</Badge>}
                    </td>
                    <td>
                      <code>{c.id}</code>
                    </td>
                    <td className="small">
                      {c.positiveEras.map((e) => e.abbr).join(', ')}
                      {c.negativeEra && `; before year 1: ${c.negativeEra.abbr}`}
                    </td>
                    <td className="small">{c.months.length}</td>
                    <td className="small">{data.calendars.find((x) => x.lkCalendarIds.includes(c.id))?.name ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
