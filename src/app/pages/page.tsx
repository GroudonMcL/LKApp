'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { BrowseResult, ResourcePage, ScanStatus, SearchHit } from '@/lib/types'

export default function PageBrowser() {
  return (
    <>
      <div className="page-header">
        <h1>Page browser</h1>
        <p className="lead">Browse your LegendKeeper pages. Read-only.</p>
        <More>
          <p className="small">
            Read-only. Browse your LegendKeeper resources, filter them, and open one to see its documents, properties and blocks.
          </p>
        </More>
      </div>
      <ScanPanel />
      <Suspense fallback={<Loading />}>
        <IndexBrowser />
      </Suspense>
      <LiveSearch />
    </>
  )
}

function ScanPanel() {
  const { data, error, reload, setData } = useApi<ScanStatus>('/api/index')
  const action = useAction()
  const running = data?.running ?? false

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void reload(), 1500)
    return () => clearInterval(timer)
  }, [running, reload])

  const latest = data?.latest
  return (
    <Card
      title="Resource index"
      actions={
        <>
          <Button variant="primary" busy={action.busy && !running} disabled={running} onClick={() => action.run(async () => setData(await api.post('/api/index', { action: 'start' })))}>
            {latest && ['paused', 'interrupted', 'failed'].includes(latest.status) ? 'Resume scan' : 'Scan project'}
          </Button>
          <Button disabled={!running} onClick={() => action.run(async () => setData(await api.post('/api/index', { action: 'pause' })))}>
            Pause
          </Button>
          <Button
            variant="ghost"
            disabled={running || !data?.stats?.total}
            onClick={() => {
              if (confirm('Delete the local index? Nothing in LegendKeeper is affected.')) void action.run(async () => setData(await api.del('/api/index')))
            }}
          >
            Clear index
          </Button>
        </>
      }
    >
      <p className="muted small">
        LegendKeeper’s API lists resources page by page and cannot filter by name or tag, so the app keeps a local, metadata-only index (names, parents, tags, aliases — no page
        content). The scan reads 100 resources at a time with a pause between requests, saves its position, and can be paused or resumed.
      </p>
      <ErrorBox error={error ?? action.error} />
      {latest ? (
        <p>
          <Badge tone={statusTone(latest.status)}>{latest.status}</Badge> {latest.resources.toLocaleString('en-GB')} resources in {latest.pages} pages · started {formatDate(latest.startedAt)}
          {latest.finishedAt && <> · finished {formatDate(latest.finishedAt)}</>}
          {latest.error && <span className="muted"> · {latest.error}</span>}
          {running && <span className="spinner" aria-label="Scanning" style={{ marginLeft: '0.5rem' }} />}
        </p>
      ) : (
        <p className="muted">No scan yet. {data?.projectId ? '' : 'Test the connection first.'}</p>
      )}
    </Card>
  )
}

function IndexBrowser() {
  const search = useSearchParams()
  const initial = { q: search.get('q') ?? '', tag: search.get('tag') ?? '', untagged: search.get('untagged') === '1' }
  const [q, setQ] = useState(initial.q)
  const [tag, setTag] = useState(initial.tag)
  const [untagged, setUntagged] = useState(initial.untagged)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState(initial)
  const params = new URLSearchParams({ page: String(page), pageSize: '50' })
  if (query.q) params.set('q', query.q)
  if (query.tag) params.set('tag', query.tag)
  if (query.untagged) params.set('untagged', '1')
  const { data, error, loading } = useApi<BrowseResult>(`/api/resources?${params}`)

  if (data && !data.projectId) return <LiveBrowser />
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <Card title="Resources">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          setPage(1)
          setQuery({ q, tag, untagged })
        }}
        style={{ marginBottom: '0.75rem' }}
      >
        <div style={{ flex: 2, minWidth: '12rem' }}>
          <label htmlFor="q">Name, alias or ID</label>
          <input id="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Greyhawk" />
        </div>
        <div style={{ flex: 1, minWidth: '10rem' }}>
          <label htmlFor="tag">Tag (exact)</label>
          <input id="tag" type="text" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. NPC" />
        </div>
        <label className="check" style={{ alignSelf: 'flex-end' }}>
          <input type="checkbox" checked={untagged} onChange={(e) => setUntagged(e.target.checked)} /> Only pages with no tags
        </label>
        <div style={{ alignSelf: 'flex-end' }}>
          <Button type="submit" variant="primary">
            Filter
          </Button>
        </div>
      </form>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data && data.total === 0 && (
        <Empty title="No resources match">{query.q || query.tag || query.untagged ? 'Try a different filter.' : 'Run a project scan to fill the index.'}</Empty>
      )}
      {data && data.total > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Tags</th>
                  <th>Documents</th>
                  <th>Parent</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/pages/${item.id}`}>{item.name}</Link>
                      {item.aliases.length > 0 && <div className="muted small">aka {item.aliases.join(', ')}</div>}
                      {item.isHidden && <Badge>hidden</Badge>}
                      {item.isTemplate && <Badge tone="info" title="A LegendKeeper template (or inside one). Templates are left out of Wiki Health, tagging, links and analysis.">template</Badge>}
                    </td>
                    <td>{item.tags.length ? <div className="pill-list">{item.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div> : item.isTemplate ? <span className="muted small">—</span> : <Badge tone="warn">no tags</Badge>}</td>
                    <td className="small">{item.documents.map((d) => `${d.name} (${d.type})`).join(', ')}</td>
                    <td className="small">{item.parentId === 'templates' ? <span className="muted">templates</span> : item.parentId ? <Link href={`/pages/${item.parentId}`}>{item.parentId}</Link> : <span className="muted">top level</span>}</td>
                    <td>
                      <code className="small">{item.id}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="muted">
              Page {page} of {pages} · {data.total.toLocaleString('en-GB')} resources
            </span>
            <Button disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

/** Before the first scan: page through LegendKeeper directly, 50 at a time. */
function LiveBrowser() {
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const cursor = cursors[cursors.length - 1] ?? null
  const { data, error, loading } = useApi<ResourcePage>(`/api/resources/live${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
  return (
    <Card title="Resources (live)">
      <Notice>No local index yet, so this lists resources straight from LegendKeeper, 50 at a time, without filtering. Run a scan for filtering and tag audits.</Notice>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && (
        <>
          <ul>
            {data.items.map((item) => (
              <li key={item.id}>
                <Link href={`/pages/${item.id}`}>{item.name}</Link> <span className="muted small">{item.tags.join(', ') || 'no tags'}</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <Button disabled={cursors.length <= 1} onClick={() => setCursors(cursors.slice(0, -1))}>
              Previous
            </Button>
            <Button disabled={!data.hasMore} onClick={() => setCursors([...cursors, data.nextCursor])}>
              Next
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

function LiveSearch() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const search = useAction()
  return (
    <Card title="Search LegendKeeper">
      <p className="muted small">Uses LegendKeeper’s own search, which also matches page content. Returns up to 20 results.</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void search.run(async () => setHits((await api.get<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`)).hits))
        }}
      >
        <input type="search" aria-label="Search query" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <Button type="submit" busy={search.busy} disabled={!q.trim()}>
          Search
        </Button>
      </form>
      <ErrorBox error={search.error} />
      {hits && hits.length === 0 && <p className="muted">No results.</p>}
      {hits && hits.length > 0 && (
        <ul>
          {hits.map((hit, i) => (
            <li key={`${hit.resourceId}-${i}`}>
              <Link href={`/pages/${hit.resourceId}`}>{hit.name}</Link> <span className="muted small">{hit.path.join(' / ')}</span>
              {hit.highlight && <div className="small muted">“…{hit.highlight}…” {hit.documentName && <>in {hit.documentName}</>}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
