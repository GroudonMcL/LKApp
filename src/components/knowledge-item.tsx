'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { Badge, Button, ErrorBox, formatDate, useAction } from '@/components/ui'
import { api } from '@/lib/api'

export interface CitationView {
  resourceId: string
  resourceName: string
  field: string | null
  passage: string
  version: string | null
}

export interface KnowledgeItemView {
  id: string
  kind: string
  kindLabel?: string
  title: string
  summary: string
  resourceIds: string[]
  data: Record<string, unknown>
  evidence: CitationView[]
  edits: Record<string, unknown> | null
  origin: 'deterministic' | 'ai'
  certainty: 'stated' | 'likely' | 'possible'
  status: string
  statusNote: string | null
  draftJobId: string | null
  allowed?: string[]
  firstSeenAt: string
  lastSeenAt: string
}

const DECISION_LABELS: Record<string, string> = {
  accept: 'Accept',
  reject: 'Reject',
  defer: 'Needs research',
  intentional: 'Intentional',
  resolve: 'Resolved',
  reopen: 'Reopen',
}

export const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  open: 'warn',
  accepted: 'good',
  drafted: 'good',
  deferred: 'info',
  rejected: 'neutral',
  intentional: 'neutral',
  resolved: 'good',
}

/** One cited passage: the page (a verified id from the index), the field, the words. */
export function Citation({ citation }: { citation: CitationView }) {
  return (
    <div className="citation">
      <div className="small">
        <Link href={`/pages/${encodeURIComponent(citation.resourceId)}`}>{citation.resourceName}</Link>
        {citation.field && <span className="muted"> · {citation.field}</span>}
      </div>
      {citation.passage ? <blockquote className="passage">{citation.passage}</blockquote> : <div className="muted small">(no passage)</div>}
    </div>
  )
}

/** A finding or candidate with its evidence and the decisions that apply to it. */
export function KnowledgeItemCard({ item, onChanged, children }: { item: KnowledgeItemView; onChanged?: (item: KnowledgeItemView) => void; children?: ReactNode }) {
  const action = useAction()
  const [note, setNote] = useState('')
  const decide = (decision: string) =>
    action.run(async () => {
      const result = await api.post<{ item: KnowledgeItemView }>(`/api/knowledge/${encodeURIComponent(item.id)}`, { action: 'decide', decision, note: note.trim() || null })
      setNote('')
      onChanged?.({ ...item, ...result.item })
    })
  return (
    <div className="knowledge-item">
      <div className="row">
        <strong>{item.title}</strong>
        {item.kindLabel && <Badge>{item.kindLabel}</Badge>}
        <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>
        <Badge tone={item.certainty === 'stated' ? 'good' : item.certainty === 'likely' ? 'info' : 'neutral'} title="How directly the evidence supports it">
          {item.certainty}
        </Badge>
        {item.origin === 'ai' && (
          <Badge tone="info" title="Proposed by the AI; the cited passage was checked to be on the page, but the claim itself is not verified">
            AI suggestion
          </Badge>
        )}
      </div>
      <p className="small">{item.summary}</p>
      {item.statusNote && <p className="small muted">{item.statusNote}</p>}
      {children}
      {item.evidence.length > 0 && (
        <details open={item.evidence.length <= 2}>
          <summary className="small">Evidence ({item.evidence.length})</summary>
          {item.evidence.map((c, i) => (
            <Citation key={`${c.resourceId}-${i}`} citation={c} />
          ))}
        </details>
      )}
      {item.allowed && item.allowed.length > 0 && (
        <div className="row toolbar">
          <input className="inline-input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" maxLength={1000} />
          {item.allowed
            .filter((d) => (d === 'reopen' ? item.status !== 'open' : true))
            .map((d) => (
              <Button key={d} variant={d === 'accept' ? 'primary' : 'secondary'} busy={action.busy} onClick={() => void decide(d)}>
                {DECISION_LABELS[d] ?? d}
              </Button>
            ))}
          <span className="small muted">First seen {formatDate(item.firstSeenAt)}</span>
        </div>
      )}
      <ErrorBox error={action.error} />
    </div>
  )
}
