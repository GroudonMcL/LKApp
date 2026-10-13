'use client'

import { useState } from 'react'
import { Badge, useApi } from '@/components/ui'

/** Finds a LegendKeeper page by name in the local index. */
export function ParentPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (value: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState('')
  const results = useApi<{ rows: { id: string; name: string; folder: string }[] }>(q.trim().length >= 2 ? `/api/advanced-search?q=${encodeURIComponent(q.trim())}&limit=8` : null)
  if (value) {
    return (
      <div className="row">
        <Badge tone="info">{value.name}</Badge>
        <button type="button" className="link-button" onClick={() => onChange(null)}>
          change
        </button>
      </div>
    )
  }
  return (
    <div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a page name, e.g. Bestiary" aria-label="Parent page" />
      {q.trim().length >= 2 && results.data && (
        <ul className="queue-list">
          {results.data.rows.length === 0 && <li className="muted">No page found. Scan the project on the Page browser if it is new.</li>}
          {results.data.rows.map((row) => (
            <li key={row.id}>
              <button type="button" className="link-button" onClick={() => onChange({ id: row.id, name: row.name })}>
                {row.name}
              </button>{' '}
              {row.folder && <span className="muted small">in {row.folder}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
