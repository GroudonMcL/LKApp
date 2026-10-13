'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Card, Empty, ErrorBox, Loading, More, formatDate, useApi } from '@/components/ui'
import type { ReviewQueue } from '@/lib/types'

const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: 'neutral' } as const

export default function ReviewPage() {
  const [type, setType] = useState('')
  const [severity, setSeverity] = useState('')
  const [q, setQ] = useState('')
  const params = new URLSearchParams({ ...(type ? { type } : {}), ...(severity ? { severity } : {}), ...(q.trim() ? { q: q.trim() } : {}) })
  const { data, error, loading } = useApi<ReviewQueue>(`/api/review?${params.toString()}`)

  return (
    <>
      <div className="page-header">
        <h1>Review queue</h1>
        <p className="lead">Everything waiting for a decision from you.</p>
        <More>
          <p className="small">
            Everything waiting for a decision from you, across imports, tagging, migrations, Wiki Health and writes. Each entry says why it needs you and links to where you deal
          with it. Entries disappear once their cause is resolved.
          </p>
        </More>
      </div>
      <Card>
        <div className="row toolbar">
          <select className="inline-select" aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types{data ? ` (${data.total})` : ''}</option>
            {data &&
              Object.entries(data.types).map(([id, label]) => (
                <option key={id} value={id}>
                  {label} ({data.byType[id as keyof typeof data.byType]})
                </option>
              ))}
          </select>
          <select className="inline-select" aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">Any severity</option>
            <option value="high">High{data ? ` (${data.bySeverity.high})` : ''}</option>
            <option value="medium">Medium{data ? ` (${data.bySeverity.medium})` : ''}</option>
            <option value="low">Low{data ? ` (${data.bySeverity.low})` : ''}</option>
          </select>
          <input className="inline-select" placeholder="Page name, page id or job" aria-label="Page or job" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ErrorBox error={error} />
        {loading && !data && <Loading />}
        {data && data.items.length === 0 && <Empty title={data.total === 0 ? 'Nothing needs you right now.' : 'Nothing matches these filters.'} />}
        {data && data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>What</th>
                  <th>Why it needs you</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.key}>
                    <td>
                      <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge>
                    </td>
                    <td>
                      <strong>{e.title}</strong>
                      <div className="small muted">{data.types[e.type]}</div>
                      {e.resourceId && (
                        <div className="small">
                          <Link href={`/pages/${encodeURIComponent(e.resourceId)}`}>Page details</Link>
                        </div>
                      )}
                    </td>
                    <td className="small">{e.explanation}</td>
                    <td className="small">
                      <Link href={e.href}>Open</Link>
                      {e.job && <div className="muted">{e.job}</div>}
                      <div className="muted">{formatDate(e.at)}</div>
                    </td>
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
