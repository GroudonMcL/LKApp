'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { KnowledgeItemCard, type KnowledgeItemView } from '@/components/knowledge-item'
import { Badge, Button, Card, Empty, ErrorBox, KeyValue, Loading, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'

type Kind = 'relationship' | 'link_suggestion' | 'missing_page' | 'contradiction' | 'terminology'
const TABS: { id: Kind; label: string; help: string }[] = [
  {
    id: 'relationship',
    label: 'Suggested relationships',
    help: 'Relationships the wording states (“…is worshipped by…”, “…lies in…”) where neither page links to the other or names it in a field. Accepting records your agreement here; nothing is written to LegendKeeper. Add the link or field in LegendKeeper (or with a template migration) if you want it there.',
  },
  {
    id: 'link_suggestion',
    label: 'Unlinked mentions',
    help: 'A page names another page exactly, without linking to it. Names shared by several pages are skipped. To add links, edit the page in LegendKeeper, or run a template migration on it: migrations add links to existing pages and change nothing else.',
  },
  {
    id: 'missing_page',
    label: 'Missing pages',
    help: 'Names used on several pages that have no page or alias of their own. Generic words, single words at the start of sentences, and names that are part of an existing page’s name are left out. Accept one to draft a page with a recipe; nothing is created automatically.',
  },
  {
    id: 'contradiction',
    label: 'Contradictions',
    help: 'Places where pages disagree (fields of same-named pages, titles used for a person elsewhere, and AI comparisons you ran). Both sides are cited; the app never decides which is right. Dates that disagree are on the Chronology page.',
  },
  {
    id: 'terminology',
    label: 'Naming',
    help: 'Spellings that differ from a page’s name only in spacing, hyphens or capitals (“Sea-Princes”), and pages with near-identical names. Nothing is renamed or merged; add an alias in LegendKeeper if both spellings are right.',
  },
]

interface Run {
  id: string
  status: string
  scope: Record<string, unknown>
  summary: { pages?: number; found?: Record<string, number>; recorded?: number; created?: number; resolved?: number; kept?: number }
  ai: Record<string, unknown> | null
  error: string | null
  startedAt: string
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Knowledge />
    </Suspense>
  )
}

function Knowledge() {
  const params = useSearchParams()
  const [tab, setTab] = useState<Kind>((params.get('tab') as Kind) || 'missing_page')
  const [status, setStatus] = useState('open')
  const meta = useApi<{ checks: Record<string, string>; runs: Run[] }>('/api/knowledge/analysis')
  const list = useApi<{ items: KnowledgeItemView[]; total: number; counts: { kind: string; status: string; n: number }[] }>(`/api/knowledge?kinds=${tab}&limit=300${status ? `&statuses=${status}` : ''}`)
  const recipes = useApi<{ recipes: { id: string; definition: { name: string } }[] }>('/api/recipes')
  const action = useAction()
  const [checks, setChecks] = useState<string[]>(['relationships', 'links', 'missing', 'contradictions', 'terminology'])
  const [mode, setMode] = useState<'all' | 'folder' | 'criteria'>('all')
  const [scopeValue, setScopeValue] = useState('')
  const [comparePages, setComparePages] = useState('')
  const [comparePreview, setComparePreview] = useState<{ provider: string; model: string; sends: { name: string; chars: number }[] } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const openCount = (kind: string) => list.data?.counts.filter((c) => c.kind === kind && c.status === 'open').reduce((a, c) => a + c.n, 0) ?? 0
  const last = meta.data?.runs[0]
  const current = TABS.find((t) => t.id === tab)!

  const run = () =>
    action.run(async () => {
      const scope = mode === 'folder' ? { mode: 'folder', folderId: scopeValue.match(/resources\/([a-z0-9]+)/i)?.[1] ?? scopeValue.trim() } : mode === 'criteria' ? { mode: 'criteria', tag: scopeValue.trim() || null } : { mode: 'all' }
      const r = await api.post<{ summary: { pages: number; recorded: number; created: number; resolved: number } }>('/api/knowledge/analysis', { action: 'run', input: { scope, checks } })
      setMessage(`Analysed ${r.summary.pages} page(s): ${r.summary.recorded} finding(s), ${r.summary.created} new, ${r.summary.resolved} no longer found.`)
      await Promise.all([meta.reload(), list.reload()])
    })

  return (
    <>
      <div className="page-header">
        <h1>Knowledge analysis</h1>
        <p>
          Connections and maintenance opportunities across your wiki, worked out from the local page index and the page content <Link href="/health">Wiki Health audits</Link>{' '}
          read. Running it changes nothing in LegendKeeper. Every finding cites the page and words it rests on and says whether it is stated (a link, a field, the exact
          wording) or only suggested. Explore one page&apos;s connections in the <Link href="/relationships">relationship browser</Link>.
        </p>
      </div>
      <ErrorBox error={action.error} />
      {message && <Notice tone="success">{message}</Notice>}
      <Card title="Run the analysis (no AI)">
        <div className="row toolbar">
          {(
            [
              ['all', 'All read pages'],
              ['folder', 'A folder'],
              ['criteria', 'Pages with a tag'],
            ] as const
          ).map(([id, label]) => (
            <Button key={id} variant={mode === id ? 'primary' : 'secondary'} onClick={() => setMode(id)}>
              {label}
            </Button>
          ))}
          {mode !== 'all' && <input className="inline-input" value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} placeholder={mode === 'folder' ? 'Folder page id or link' : 'Tag'} />}
        </div>
        <div className="rule-grid">
          {Object.entries(meta.data?.checks ?? {}).map(([id, label]) => (
            <label key={id} className="check">
              <input type="checkbox" checked={checks.includes(id)} onChange={(e) => setChecks(e.target.checked ? [...checks, id] : checks.filter((c) => c !== id))} /> {label}
            </label>
          ))}
        </div>
        <div className="row">
          <Button variant="primary" busy={action.busy} disabled={!checks.length} onClick={() => void run()}>
            Analyse
          </Button>
          {last && (
            <span className="small muted">
              Last run {formatDate(last.startedAt)}: {last.summary.pages ?? '—'} page(s), {last.summary.recorded ?? last.summary.kept ?? 0} finding(s)
            </span>
          )}
          <a className="btn btn-ghost" href="/api/exports/knowledge?format=csv">
            Export CSV
          </a>
          <a className="btn btn-ghost" href="/api/exports/knowledge?format=json">
            Export JSON
          </a>
        </div>
      </Card>

      <Card title="Compare a few pages with the AI (optional)">
        <p className="small">
          For a closer reading, the AI can compare 2–5 pages (e.g. two biographies of the same person) and list where they contradict each other. One request; each
          finding must quote at least two of the pages word for word, or it is dropped. The AI&apos;s explanation is a suggestion, never a verdict.
        </p>
        <textarea className="inline-input" rows={3} style={{ width: '100%' }} value={comparePages} onChange={(e) => (setComparePages(e.target.value), setComparePreview(null))} placeholder="Page names, ids or links, one per line" />
        <div className="row">
          <Button busy={action.busy} onClick={() => void action.run(async () => setComparePreview(await api.post('/api/knowledge/analysis', { action: 'comparePreview', input: { pageRefs: comparePages.split('\n').map((s) => s.trim()).filter(Boolean) } })))}>
            Check what will be sent
          </Button>
          <Button
            variant="primary"
            disabled={!comparePreview}
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                const r = await api.post<{ kept: number; dropped: number; created: number }>('/api/knowledge/analysis', { action: 'compare', input: { pageRefs: comparePages.split('\n').map((s) => s.trim()).filter(Boolean) } })
                setMessage(`AI comparison: ${r.kept} finding(s) with verified quotes (${r.created} new), ${r.dropped} dropped.`)
                setTab('contradiction')
                await list.reload()
              })
            }
          >
            Compare with AI
          </Button>
        </div>
        {comparePreview && (
          <Notice tone="warning">
            <strong>
              Sent to the AI ({comparePreview.provider}, {comparePreview.model}):
            </strong>{' '}
            the name and text of {comparePreview.sends.map((s) => `${s.name} (${s.chars.toLocaleString()} characters)`).join(', ')}, with fixed instructions. Nothing else.
          </Notice>
        )}
      </Card>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {tab === t.id && list.data ? ` (${openCount(t.id)} open)` : ''}
          </button>
        ))}
      </div>
      <Card
        actions={
          <select className="inline-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show">
            <option value="open">Waiting for a decision</option>
            <option value="accepted,drafted">Accepted</option>
            <option value="deferred">Needs research</option>
            <option value="intentional">Intentional</option>
            <option value="rejected">Rejected</option>
            <option value="resolved">Resolved</option>
            <option value="">All</option>
          </select>
        }
        title={current.label}
      >
        <p className="small muted">{current.help}</p>
        {list.loading && !list.data && <Loading />}
        <ErrorBox error={list.error} />
        {list.data && list.data.items.length === 0 && <Empty title="Nothing here">Run the analysis above.</Empty>}
        {list.data?.items.map((item) => (
          <KnowledgeItemCard key={item.id} item={item} onChanged={() => void list.reload()}>
            {item.kind === 'missing_page' && <MissingExtras item={item} recipes={recipes.data?.recipes ?? []} onChanged={() => void list.reload()} />}
            {item.kind === 'relationship' && <RelationExtras item={item} />}
          </KnowledgeItemCard>
        ))}
        {list.data && list.data.total > list.data.items.length && <p className="small muted">Showing {list.data.items.length} of {list.data.total}. Export to see all.</p>}
      </Card>
      {last?.ai && (
        <Card title="Last AI comparison">
          <KeyValue rows={Object.entries(last.ai).filter(([k]) => ['provider', 'model', 'servedBy', 'requests', 'proposed', 'dropped'].includes(k)).map(([k, v]) => [k, String(v)])} />
        </Card>
      )}
    </>
  )
}

function RelationExtras({ item }: { item: KnowledgeItemView }) {
  const d = item.data as { from: string; to: string; fromName: string; toName: string }
  return (
    <p className="small">
      <Link href={`/relationships?id=${d.from}`}>{d.fromName}</Link> → <Link href={`/relationships?id=${d.to}`}>{d.toName}</Link> <Badge tone="info">inferred from wording</Badge>
    </p>
  )
}

function MissingExtras({ item, recipes, onChanged }: { item: KnowledgeItemView; recipes: { id: string; definition: { name: string } }[]; onChanged: () => void }) {
  const d = item.data as { kindGuess: string | null; pageCount: number }
  const [recipeId, setRecipeId] = useState('')
  const action = useAction()
  return (
    <div className="row small">
      {d.kindGuess ? <Badge>looks like a {d.kindGuess}</Badge> : <Badge>kind unclear</Badge>} <span className="muted">named on {d.pageCount} page(s)</span>
      {item.status === 'accepted' && (
        <>
          <select className="inline-select" value={recipeId} onChange={(e) => setRecipeId(e.target.value)} aria-label="Recipe">
            <option value="">Recipe…</option>
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
          >
            Make a draft page
          </Button>
        </>
      )}
      {item.draftJobId && <Link href={`/import/${item.draftJobId}`}>Open the draft →</Link>}
      <ErrorBox error={action.error} />
    </div>
  )
}
