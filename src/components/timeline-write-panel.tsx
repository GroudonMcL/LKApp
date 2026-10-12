'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Button, ErrorBox, KeyValue, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'

interface TimelineOption {
  resourceId: string
  documentId: string
  resourceName: string
  name: string
  lanes: { id: string; name: string; external: boolean }[]
}

interface Prepared {
  writeId: string | null
  approvalToken: string | null
  blockers: { code: string; message: string }[]
  warnings: string[]
  preview: {
    timeline: { resourceId: string; resourceName: string; name: string; calendar: string | null }
    lane: string
    eventId: string
    name: string
    dateAsWritten: string
    dateReadAs: string
    formattedStart: string | null
    formattedEnd: string | null
    link: { resourceId: string; name: string } | null
  }
}

interface WriteResult {
  id: string
  status: string
  error: string | null
  readback: Record<string, unknown> | null
}

/**
 * Adds one chronology entry to an existing LegendKeeper timeline: choose the timeline and
 * lane, see exactly what will be sent, approve. Nothing is sent before the approval.
 */
export function TimelineWritePanel({ entryId, defaultName }: { entryId: string; defaultName: string }) {
  const timelines = useApi<{ sources: { timelines: TimelineOption[] } }>('/api/chronology?limit=1')
  const [documentId, setDocumentId] = useState('')
  const [laneId, setLaneId] = useState('')
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [ack, setAck] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<WriteResult | null>(null)
  const action = useAction()
  const options = timelines.data?.sources.timelines ?? []
  const timeline = options.find((t) => t.documentId === documentId)

  if (timelines.data && options.length === 0)
    return (
      <Notice tone="info">
        No LegendKeeper timelines have been read. Create a timeline (and a lane) in LegendKeeper if you want one, then use “Read LegendKeeper timelines” on the{' '}
        <Link href="/chronology">Chronology</Link> page.
      </Notice>
    )

  return (
    <div className="comparison">
      <strong>Add “{defaultName}” to a LegendKeeper timeline</strong>
      <div className="filter-grid">
        <label>
          Timeline
          <select value={documentId} onChange={(e) => (setDocumentId(e.target.value), setLaneId(''), setPrepared(null))}>
            <option value="">Choose…</option>
            {options.map((t) => (
              <option key={t.documentId} value={t.documentId}>
                {t.resourceName} / {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Lane
          <select value={laneId} onChange={(e) => (setLaneId(e.target.value), setPrepared(null))} disabled={!timeline}>
            <option value="">Choose…</option>
            {timeline?.lanes
              .filter((l) => !l.external)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="row">
        <Button
          disabled={!documentId || !laneId}
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              setResult(null)
              setAck(false)
              setConfirm(false)
              setPrepared(await api.post<Prepared>('/api/timeline-writes', { entryId, documentId, laneId }))
            })
          }
        >
          Show final preview
        </Button>
      </div>
      {prepared && (
        <>
          <KeyValue
            rows={[
              ['Timeline', `${prepared.preview.timeline.resourceName} / ${prepared.preview.timeline.name} (calendar: ${prepared.preview.timeline.calendar ?? '—'})`],
              ['Lane', prepared.preview.lane],
              ['Event name', prepared.preview.name],
              ['Date as written', prepared.preview.dateAsWritten || '—'],
              ['Sent to LegendKeeper', prepared.preview.formattedStart ? <code key="d">{[prepared.preview.formattedStart, prepared.preview.formattedEnd].filter(Boolean).join(' → ')}</code> : '—'],
              ['Links to', prepared.preview.link ? <Link key="l" href={`/pages/${encodeURIComponent(prepared.preview.link.resourceId)}`}>{prepared.preview.link.name}</Link> : 'no page'],
              ['Event id (chosen now)', <code key="i">{prepared.preview.eventId}</code>],
            ]}
          />
          {prepared.blockers.map((b) => (
            <Notice key={b.code} tone="error">
              {b.message}
            </Notice>
          ))}
          {prepared.warnings.map((w, i) => (
            <Notice key={i} tone="warning">
              {w}
            </Notice>
          ))}
          {prepared.writeId && !result && (
            <div className="confirm-box">
              {prepared.warnings.length > 0 && (
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the warnings.
                </label>
              )}
              <label className="check">
                <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Add this event to the LegendKeeper timeline. It is sent once; to change or
                remove it later, use LegendKeeper.
              </label>
              <Button
                variant="primary"
                disabled={!confirm || (prepared.warnings.length > 0 && !ack)}
                busy={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const r = await api.post<{ write: WriteResult }>(`/api/timeline-writes/${prepared.writeId}`, { action: 'approve', approvalToken: prepared.approvalToken, acknowledgeWarnings: ack, confirm: true })
                    setResult(r.write)
                  })
                }
              >
                Approve and add
              </Button>
            </div>
          )}
        </>
      )}
      {result && (
        <Notice tone={result.status === 'verified' ? 'success' : result.status === 'uncertain' || result.status === 'mismatch' ? 'warning' : 'error'}>
          <Badge>{result.status}</Badge>{' '}
          {result.status === 'verified' ? 'Added and read back exactly as approved.' : result.error}
          {result.status === 'uncertain' && (
            <div className="row">
              <Button busy={action.busy} onClick={() => void action.run(async () => setResult((await api.post<{ write: WriteResult }>(`/api/timeline-writes/${result.id}`, { action: 'check' })).write))}>
                Check outcome
              </Button>
            </div>
          )}
        </Notice>
      )}
      <ErrorBox error={action.error} />
    </div>
  )
}
