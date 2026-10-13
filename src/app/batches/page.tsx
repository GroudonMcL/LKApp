'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, formatDate, statusTone, useApi } from '@/components/ui'
import type { BatchListing } from '@/lib/types'

const KINDS = [
  { id: '', label: 'All jobs' },
  { id: 'import', label: 'Imports' },
  { id: 'tagging', label: 'Tagging' },
  { id: 'migration', label: 'Migrations' },
]
const KIND_LABEL: Record<string, string> = { import: 'Import', tagging: 'Tagging', migration: 'Migration' }
const hrefFor = (kind: string, id: string) => (kind === 'import' ? `/batches/${id}` : kind === 'tagging' ? `/tagging/${id}` : `/migrations/${id}`)

export default function BatchesPage() {
  const [kind, setKind] = useState('')
  const [page, setPage] = useState(1)
  const { data, error, loading } = useApi<BatchListing>(`/api/batches?page=${page}${kind ? `&kind=${kind}` : ''}`)
  const pages = data ? Math.max(1, Math.ceil(data.total / 25)) : 1
  return (
    <>
      <div className="page-header">
        <h1>Batch jobs</h1>
        <p className="lead">Every batch job, and where it got to.</p>
        <More>
          <p className="small">
            Every job: imports of many records, tag applications and template migrations. Open one to continue where you left off; nothing is lost between visits or when the
          app restarts (a job that was interrupted says so, and any write in progress is checked before anything else).
          </p>
        </More>
      </div>
      <Card
        title="Jobs"
        actions={
          <div className="row">
            <a className="btn btn-ghost" href="/api/batches/history?format=csv">
              History CSV
            </a>
            <a className="btn btn-ghost" href="/api/batches/history?format=json">
              History JSON
            </a>
            <Link className="btn btn-primary" href="/batches/new">
              New batch import
            </Link>
          </div>
        }
      >
        <div className="row toolbar">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`btn btn-ghost${kind === k.id ? ' stat-active' : ''}`}
              onClick={() => {
                setKind(k.id)
                setPage(1)
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
        <ErrorBox error={error} />
        {loading && !data && <Loading />}
        {data && data.items.length === 0 && <Empty title="No jobs yet">Start an import here, or a tagging or migration job from their pages.</Empty>}
        {data && data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Summary</th>
                  <th>Recipe and AI</th>
                  <th>Times</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <Link href={hrefFor(batch.kind, batch.id)}>{batch.name}</Link>
                      <div className="small muted">
                        {KIND_LABEL[batch.kind] ?? batch.kind}
                        {batch.kind === 'import' && ` · ${batch.files} file(s)`}
                      </div>
                    </td>
                    <td>
                      {batch.phase ? (
                        <Badge tone="info">{batch.phase}…</Badge>
                      ) : batch.status === 'ready' && batch.summary.total > 0 && batch.summary.remaining === 0 && batch.summary.failed === 0 ? (
                        <Badge tone="good" title="Nothing left to do. Close the job to file it away.">finished</Badge>
                      ) : (
                        <Badge tone={statusTone(batch.status)}>{batch.status}</Badge>
                      )}
                      {batch.error && <div className="small error-text">{batch.error}</div>}
                    </td>
                    <td className="small">
                      {batch.summary.total} item(s): {batch.summary.succeeded} done
                      {batch.summary.failed > 0 && <span className="error-text"> · {batch.summary.failed} failed/unresolved</span>}
                      {batch.summary.skipped > 0 && <> · {batch.summary.skipped} skipped</>}
                      {batch.summary.needsReview > 0 && <> · {batch.summary.needsReview} to review</>}
                      {batch.summary.remaining > 0 && <> · {batch.summary.remaining} remaining</>}
                    </td>
                    <td className="small">
                      {batch.recipeName ? (
                        <>
                          {batch.recipeName} v{batch.recipeVersion}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      <div className="muted">{batch.models.length ? `AI: ${batch.models.join(', ')}` : 'No AI'}</div>
                    </td>
                    <td className="small">
                      Created {formatDate(batch.createdAt)}
                      {batch.finishedAt && <div className="muted">Finished {formatDate(batch.finishedAt)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="row">
            <Button onClick={() => setPage(page - 1)} disabled={page <= 1}>
              Previous
            </Button>
            <span className="small muted">
              Page {page} of {pages}
            </span>
            <Button onClick={() => setPage(page + 1)} disabled={page >= pages}>
              Next
            </Button>
          </div>
        )}
      </Card>
    </>
  )
}
