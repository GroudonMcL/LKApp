'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Loading, More, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import { ParentPicker } from '@/components/parent-picker'

interface DestinationRow {
  key: string
  label: string
  pageType: string
  pageTypeLabel: string
  fields: string[]
  sections: string[]
  layout: 'exact' | 'fit' | 'custom' | 'own'
  enabled: boolean
  reason: string | null
  lkTemplateId: string | null
}
interface Destinations {
  destinations: DestinationRow[]
  active: { key: string; label: string; builtIn: boolean }[]
  usingBuiltIn: boolean
}
interface ImportRow {
  id: string
  name: string
  status: string
  createdAt: string
  phase: string | null
  created: number
  toReview: number
  total: number
}

const ACCEPT = '.txt,.text,.md,.markdown,.json,.html,.htm,.docx,.pdf,.png,.jpg,.jpeg,.webp,.gif'
const PARENT_KEY = 'lkc.import.parent'

export default function ImportPage() {
  return (
    <>
      <div className="page-header">
        <h1>Import</h1>
        <p className="lead">Add files, a saved web page or some text. The AI finds each subject worth a page, picks the right template for it and leaves out clutter. You see the result and choose what is created.</p>
      </div>
      <NewImport />
      <RecentImports />
      <PageKinds />
      <More label="Other ways to import">
        <ul className="small">
          <li>
            <Link href="/import/classic">Import with a recipe</Link>: one source, one page, with a recipe you choose.
          </li>
          <li>
            <Link href="/batches/new">Batch import with a recipe</Link>: many records split by fixed rules (headings, statblocks, JSON).
          </li>
        </ul>
      </More>
    </>
  )
}

function NewImport() {
  const router = useRouter()
  const create = useAction()
  const [files, setFiles] = useState<File[]>([])
  const [text, setText] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [parent, setParent] = useState<{ id: string; name: string } | null>(null)
  const [name, setName] = useState('')
  const [attribution, setAttribution] = useState('')
  const [citation, setCitation] = useState('')
  const [noAi, setNoAi] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PARENT_KEY)
      if (saved) setParent(JSON.parse(saved) as { id: string; name: string })
    } catch {
      /* no saved choice */
    }
  }, [])
  const chooseParent = (value: { id: string; name: string } | null) => {
    setParent(value)
    try {
      if (value) window.localStorage.setItem(PARENT_KEY, JSON.stringify(value))
      else window.localStorage.removeItem(PARENT_KEY)
    } catch {
      /* not remembered */
    }
  }

  const add = (list: FileList | null) => {
    if (!list) return
    setFiles((current) => [...current, ...Array.from(list)].slice(0, 100))
  }

  const start = () =>
    create.run(async () => {
      setProgress('Starting…')
      const created = await api.post<{ batch: { id: string } }>('/api/smart-imports', {
        name: name.trim() || undefined,
        mode: noAi ? 'rules' : 'ai',
        parentId: parent?.id ?? null,
        attributionTitle: attribution.trim() || null,
        citation: citation.trim() || null,
      })
      const id = created.batch.id
      for (const [i, file] of files.entries()) {
        setProgress(`Reading ${file.name} (${i + 1} of ${files.length})…`)
        const form = new FormData()
        form.set('file', file)
        await api.upload(`/api/batches/${id}/sources`, form)
      }
      if (text.trim()) {
        const form = new FormData()
        form.set('text', text)
        form.set('name', name.trim() || 'Pasted text')
        await api.upload(`/api/batches/${id}/sources`, form)
      }
      await api.post(`/api/smart-imports/${id}/actions`, { action: 'start', mode: noAi ? 'rules' : 'ai' })
      router.push(`/import/run/${id}`)
    }).finally(() => setProgress(null))

  const ready = files.length > 0 || text.trim() !== ''

  return (
    <Card title="New import">
      <div
        className={`drop-zone${dragging ? ' dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') input.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          add(e.dataTransfer.files)
        }}
      >
        <strong>Drop files here, or click to choose</strong>
        <div className="small muted">Text, Markdown, JSON, saved web pages (.html), Word (.docx), PDF and images</div>
        <input ref={input} type="file" multiple accept={ACCEPT} onChange={(e) => add(e.target.files)} />
      </div>
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((file, i) => (
            <li key={`${file.name}-${i}`}>
              <Badge>
                {file.name}{' '}
                <button type="button" className="link-button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  ×
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {showPaste ? (
        <div className="field" style={{ marginTop: '0.75rem' }}>
          <label htmlFor="paste">Text</label>
          <textarea id="paste" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a statblock, notes, or a whole article…" />
        </div>
      ) : (
        <p>
          <button type="button" className="link-button" onClick={() => setShowPaste(true)}>
            Or paste text
          </button>
        </p>
      )}

      <div className="field" style={{ marginTop: '0.75rem' }}>
        <label>
          Put new pages under <span className="hint">(optional; without a parent, pages go at the top of the project, which needs an Admin key)</span>
        </label>
        <ParentPicker value={parent} onChange={chooseParent} />
      </div>

      <More label="More options">
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="name">Name of this import</label>
            <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the first file’s name" />
          </div>
          <div className="field">
            <label htmlFor="attribution">
              Source title <span className="hint">(e.g. “World of Greyhawk Gazetteer”)</span>
            </label>
            <input id="attribution" type="text" value={attribution} onChange={(e) => setAttribution(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="citation">
              Citation <span className="hint">(page, chapter, edition…)</span>
            </label>
            <input id="citation" type="text" value={citation} onChange={(e) => setCitation(e.target.value)} />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={noAi} onChange={(e) => setNoAi(e.target.checked)} />
          <span>
            Without AI <span className="muted small">(split by headings or statblocks, fill fields from “Label: value” lines; nothing is sent anywhere)</span>
          </span>
        </label>
        <p className="small muted">
          With AI, the text is sent to your configured AI provider (on OpenRouter, free models only): once to sort it, then once per page found. Nothing is written to LegendKeeper until you choose
          which pages to create.
        </p>
      </More>

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <Button variant="primary" busy={create.busy} disabled={!ready} onClick={() => void start()}>
          Import
        </Button>
        {progress && <span className="muted small">{progress}</span>}
      </div>
      <ErrorBox error={create.error} title="The import could not start" />
    </Card>
  )
}

function RecentImports() {
  const { data, error } = useApi<{ imports: ImportRow[] }>('/api/smart-imports')
  if (error) return <ErrorBox error={error} />
  if (!data || data.imports.length === 0) return null
  const open = data.imports.filter((row) => row.status !== 'completed' && row.status !== 'cancelled')
  const done = data.imports.filter((row) => row.status === 'completed' || row.status === 'cancelled')
  const list = (rows: ImportRow[]) => (
    <ul className="queue-list">
      {rows.map((row) => (
        <li key={row.id} className="row">
          <Link href={`/import/run/${row.id}`}>{row.name}</Link>
          {row.phase ? <Badge tone="info">{row.phase}</Badge> : row.toReview > 0 ? <Badge tone="warn">{row.toReview} to look at</Badge> : null}
          {row.created > 0 && <Badge tone="good">{row.created} created</Badge>}
          <span className="spacer" />
          <span className="muted small">{formatDate(row.createdAt)}</span>
        </li>
      ))}
    </ul>
  )
  return (
    <Card title="Your imports">
      {open.length ? list(open) : <p className="muted">Nothing in progress.</p>}
      {done.length > 0 && <More label={`Finished (${done.length})`}>{list(done)}</More>}
    </Card>
  )
}

function PageKinds() {
  const { data, error, loading, reload, setData } = useApi<Destinations>('/api/destinations')
  const setup = useAction()
  const toggle = useAction()
  const [report, setReport] = useState<{ added: DestinationRow[]; skipped: { name: string; reason: string }[] } | null>(null)
  const runSetup = () =>
    setup.run(async () => {
      const result = await api.post<{ added: DestinationRow[]; skipped: { name: string; reason: string }[] }>('/api/destinations', { action: 'setup' })
      setReport(result)
      await reload()
    })
  const summary = data ? (data.usingBuiltIn ? 'built-in page types' : data.destinations.filter((d) => d.enabled).map((d) => d.label).join(', ')) : ''
  return (
    <Card title="Page kinds" actions={<Button busy={setup.busy} onClick={() => void runSetup()}>Set up from my LegendKeeper templates</Button>}>
      {loading && !data && <Loading />}
      <ErrorBox error={error} />
      <ErrorBox error={setup.error} title="Templates could not be read" />
      {data && (
        <p>
          The AI chooses between: <strong>{summary || 'none'}</strong>.
        </p>
      )}
      {data?.usingBuiltIn && <Notice tone="info">Set up page kinds from your LegendKeeper templates so new pages are real copies of them, filled in place. Reading the templates changes nothing in LegendKeeper.</Notice>}
      {report && (
        <Notice tone={report.skipped.length ? 'warning' : 'success'}>
          {report.added.length ? `Added: ${report.added.map((d) => d.label).join(', ')}.` : 'No new templates found.'}
          {report.skipped.length > 0 && (
            <ul>
              {report.skipped.map((s) => (
                <li key={s.name}>
                  {s.name}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      {data && data.destinations.length > 0 && (
        <More label="Show the page kinds">
          <ErrorBox error={toggle.error} />
          <ul className="page-list">
            {data.destinations.map((d) => (
              <li key={d.key} className="page-row">
                <div className="page-row-head">
                  <label className="check" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      disabled={toggle.busy}
                      onChange={(e) =>
                        void toggle.run(async () => {
                          const next = await api.post<{ destinations: DestinationRow[] }>('/api/destinations', { action: 'enable', key: d.key, enabled: e.target.checked })
                          setData({ ...data, destinations: next.destinations, usingBuiltIn: !next.destinations.some((x) => x.enabled) })
                        })
                      }
                    />
                    <span className="page-row-title">{d.label}</span>
                  </label>
                  <Badge>{d.pageTypeLabel}</Badge>
                  <Badge tone="info">{d.layout === 'exact' ? 'exactly as the template' : d.layout === 'fit' ? 'fitted to each page' : d.layout === 'custom' ? 'own layout rules' : 'app layout'}</Badge>
                  <Link className="small" href="/recipes">
                    change
                  </Link>
                </div>
                <More label="Details">
                  <p className="small">
                    <strong>Fields:</strong> {d.fields.join(', ') || '—'}
                  </p>
                  <p className="small">
                    <strong>Boxes:</strong> {d.sections.join(', ') || '—'}
                  </p>
                  {d.reason && <p className="small muted">{d.reason}</p>}
                </More>
              </li>
            ))}
          </ul>
        </More>
      )}
    </Card>
  )
}
