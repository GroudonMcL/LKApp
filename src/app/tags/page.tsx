'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, Notice, formatDate, useApi } from '@/components/ui'
import type { BrowseResult, TagOverview } from '@/lib/types'

export default function TagAuditPage() {
  const [refresh, setRefresh] = useState(0)
  const { data, error, loading } = useApi<TagOverview>(`/api/tags${refresh ? `?refresh=1&n=${refresh}` : ''}`)
  const [filter, setFilter] = useState('')

  return (
    <>
      <div className="page-header">
        <h1>Tag audit</h1>
        <p className="lead">Which tags your project uses, and which pages have none. Read-only.</p>
        <More>
          <p className="small">
            Read-only. See which tags your project uses and which pages have none. To change tags, use the Tagging assistant.
          </p>
        </More>
      </div>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Tags" actions={<Button onClick={() => setRefresh(refresh + 1)} busy={loading}>Refresh</Button>}>
            <Notice tone={data.source === 'api' ? 'success' : data.source === 'index' ? 'info' : 'warning'}>
              <strong>Source: {data.source === 'api' ? 'live from LegendKeeper' : data.source === 'index' ? 'local resource index' : 'none'}.</strong> {data.sourceNote}
            </Notice>
            {data.tags.length === 0 ? (
              <Empty title="No tags to show" />
            ) : (
              <>
                <input type="search" aria-label="Filter tags" placeholder="Filter tags" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: '20rem', marginBottom: '0.5rem' }} />
                <div className="table-wrap" style={{ maxHeight: '28rem', overflowY: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Tag</th>
                        <th>Pages</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.tags
                        .filter((t) => t.tag.toLowerCase().includes(filter.toLowerCase()))
                        .map((t) => (
                          <tr key={t.tag}>
                            <td>
                              <Badge>{t.tag}</Badge>
                            </td>
                            <td>{t.count ?? '—'}</td>
                            <td>
                              <Link href={`/pages?tag=${encodeURIComponent(t.tag)}`} className="small">
                                Browse
                              </Link>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <p className="small muted">{data.tags.length} distinct tags. Tags match exactly, including case — near-duplicates like “NPC” and “Npc” show up as separate rows.</p>
              </>
            )}
          </Card>
          <Untagged scannedAt={data.indexScannedAt} />
        </>
      )}
    </>
  )
}

function Untagged({ scannedAt }: { scannedAt: string | null }) {
  const [page, setPage] = useState(1)
  const { data, error, loading } = useApi<BrowseResult>(`/api/resources?untagged=1&pageSize=50&page=${page}`)
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  return (
    <Card title={`Pages without tags${data ? ` (${data.total.toLocaleString('en-GB')})` : ''}`}>
      <p className="small muted">From the local resource index{scannedAt ? `, last complete scan ${formatDate(scannedAt)}` : ' (no complete scan yet)'}.</p>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && data.total === 0 && <Empty title="Nothing to show">{data.projectId ? 'Every indexed page has at least one tag.' : 'Run a project scan in the page browser first.'}</Empty>}
      {data && data.total > 0 && (
        <>
          <ul>
            {data.items.map((item) => (
              <li key={item.id}>
                <Link href={`/pages/${item.id}`}>{item.name}</Link> <span className="small muted">{item.documents.map((d) => d.type).join(', ')}</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="muted">
              Page {page} of {pages}
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
