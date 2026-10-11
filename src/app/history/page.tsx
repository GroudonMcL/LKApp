'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, JsonView, Loading, formatDate, statusTone, useAction } from '@/components/ui'
import { api } from '@/lib/api'
import type { AuditEvent } from '@/lib/types'

export default function HistoryPage() {
  return (
    <>
      <div className="page-header">
        <h1>History & audit</h1>
        <p>Every connection test, scan, import, transformation, approval and write is recorded here with its outcome. API keys and source documents are never stored in this log.</p>
      </div>
      <Suspense fallback={<Loading />}>
        <AuditLog />
      </Suspense>
    </>
  )
}

const OPERATIONS = ['', 'connection.test', 'index.scan', 'import.create', 'import.cancel', 'transform', 'draft.save', 'write.verify', 'write.prepare', 'write.approve', 'write.create', 'write.check_outcome', 'recipe.create', 'recipe.update']

function AuditLog() {
  const search = useSearchParams()
  const draftId = search.get('draftId')
  const [operation, setOperation] = useState('')
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [done, setDone] = useState(false)
  const load = useAction()

  const fetchPage = (beforeId?: number) =>
    load.run(async () => {
      const params = new URLSearchParams({ limit: '50' })
      if (operation) params.set('operation', operation)
      if (draftId) params.set('draftId', draftId)
      if (beforeId) params.set('beforeId', String(beforeId))
      const result = await api.get<{ events: AuditEvent[] }>(`/api/audit?${params}`)
      setEvents((current) => (beforeId ? [...current, ...result.events] : result.events))
      setDone(result.events.length < 50)
    })

  useEffect(() => {
    void fetchPage()
    // Reload when the filter changes.
  }, [operation, draftId])

  return (
    <Card
      title="Audit log"
      actions={
        <select aria-label="Filter by operation" value={operation} onChange={(e) => setOperation(e.target.value)} style={{ width: 'auto' }}>
          {OPERATIONS.map((op) => (
            <option key={op} value={op}>
              {op || 'All operations'}
            </option>
          ))}
        </select>
      }
    >
      {draftId && (
        <p className="small">
          Showing events for draft <code>{draftId}</code>. <Link href="/history">Show all</Link>
        </p>
      )}
      <ErrorBox error={load.error} />
      {events.length === 0 && !load.busy && <Empty title="No events yet" />}
      {events.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Operation</th>
                <th>Outcome</th>
                <th>Approval</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="small nowrap">{formatDate(event.at)}</td>
                  <td>
                    <code className="small">{event.operation}</code>
                  </td>
                  <td>
                    <Badge tone={statusTone(event.outcome)}>{event.outcome}</Badge>
                  </td>
                  <td className="small">{event.approval === 'not_required' ? '—' : event.approval.replace('_', ' ')}</td>
                  <td className="small break">
                    {event.message}
                    <div className="muted">
                      {event.resourceId && (
                        <>
                          page <Link href={`/pages/${event.resourceId}`}>{event.resourceId}</Link> ·{' '}
                        </>
                      )}
                      {event.jobId && (
                        <>
                          import <Link href={`/import/${event.jobId}`}>{event.jobId}</Link> ·{' '}
                        </>
                      )}
                      {event.recipeId && <>recipe {event.recipeId} v{event.recipeVersion} · </>}
                      {event.model && <>model {event.model} · </>}
                      {event.errorCode && <>error {event.errorCode} · </>}
                      {event.requestId && <>request {event.requestId}</>}
                    </div>
                    {event.details && <JsonView value={event.details} label="Details" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: '0.75rem' }}>
        <Button busy={load.busy} disabled={done || events.length === 0} onClick={() => fetchPage(events[events.length - 1]?.id)}>
          Load older events
        </Button>
      </div>
    </Card>
  )
}
