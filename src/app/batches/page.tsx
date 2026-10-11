'use client'

import Link from 'next/link'
import { Badge, Card, Empty, ErrorBox, Loading, formatDate, statusTone, useApi } from '@/components/ui'
import type { BatchListing } from '@/lib/types'

export default function BatchesPage() {
  const { data, error, loading } = useApi<BatchListing>('/api/batches')
  return (
    <>
      <div className="page-header">
        <h1>Batch jobs</h1>
        <p>Every batch: imports of many records, tag applications and template migrations. Open one to continue where you left off; nothing is lost between visits.</p>
      </div>
      <Card title="Batches" actions={<Link className="btn btn-primary" href="/batches/new">New batch import</Link>}>
        <ErrorBox error={error} />
        {loading && <Loading />}
        {data && data.items.length === 0 && <Empty title="No batches yet">Start one with “New batch import”.</Empty>}
        {data && data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Items</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((batch) => {
                  const total = Object.values(batch.counts).reduce((a, b) => a + b, 0)
                  return (
                    <tr key={batch.id}>
                      <td>
                        <Link href={batch.kind === 'import' ? `/batches/${batch.id}` : batch.kind === 'tagging' ? `/tagging/${batch.id}` : `/migrations/${batch.id}`}>{batch.name}</Link>
                        {batch.kind === 'import' && <div className="small muted">{batch.files} file(s)</div>}
                      </td>
                      <td>{batch.kind}</td>
                      <td>
                        <Badge tone={statusTone(batch.status)}>{batch.phase ?? batch.status}</Badge>
                      </td>
                      <td className="small">
                        {total} · {batch.counts.succeeded} done · {batch.counts.awaiting_review} to review · {batch.counts.failed + batch.counts.needs_reconciliation} failed/unresolved
                      </td>
                      <td className="small">{formatDate(batch.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
