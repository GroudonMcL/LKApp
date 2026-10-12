'use client'

import Link from 'next/link'
import { use, useState } from 'react'
import { Badge, Button, Card, ErrorBox, JsonView, KeyValue, Loading, Notice, formatDate, useAction } from '@/components/ui'
import { useApi } from '@/components/ui'
import { api } from '@/lib/api'
import { LkBlocksPreview } from '@/components/lk-preview'
import type { DocumentContent, ResourceDetail } from '@/lib/types'

export default function ResourcePage({ params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = use(params)
  const { data, error, loading } = useApi<{ resource: ResourceDetail; parentName: string | null }>(`/api/resources/${encodeURIComponent(resourceId)}`)
  const load = useAction()
  const [content, setContent] = useState<DocumentContent | null>(null)

  return (
    <>
      <div className="page-header">
        <p>
          <Link href="/pages">← Page browser</Link>
        </p>
        <h1>{data?.resource.name ?? 'Resource'}</h1>
        <p>Read-only view. Nothing here changes your LegendKeeper project.</p>
      </div>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && (
        <>
          <Card title="Resource">
            <KeyValue
              rows={[
                ['ID', <code key="id">{data.resource.id}</code>],
                ['Parent', data.resource.parentId ? <Link key="p" href={`/pages/${data.resource.parentId}`}>{data.parentName ?? data.resource.parentId}</Link> : 'Top level'],
                ['Tags', data.resource.tags.length ? <span key="t" className="pill-list">{data.resource.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span> : <Badge key="t" tone="warn">no tags</Badge>],
                ['Aliases', data.resource.aliases.join(', ') || '—'],
                ['Hidden / locked', `${data.resource.isHidden ? 'hidden' : 'visible'} · ${data.resource.isLocked ? 'locked' : 'not locked'}`],
                ['Updated', formatDate(data.resource.updatedAt)],
              ]}
            />
          </Card>

          <Card title="Connections">
            <p className="small">
              <Link href={`/relationships?id=${encodeURIComponent(data.resource.id)}`}>Relationship browser</Link> (links in and out, fields, page tree) ·{' '}
              <Link href={`/chronology?participant=${encodeURIComponent(data.resource.id)}`}>Chronology</Link> ·{' '}
              <Link href={`/knowledge?tab=link_suggestion`}>Analysis findings</Link>
            </p>
          </Card>

          <Card title="Documents">
            <p className="muted small">A resource has one or more documents (tabs). Page documents hold blocks; timelines are read on the Chronology page; maps and boards are shown by type only.</p>
            <ul>
              {data.resource.documents.map((doc) => (
                <li key={doc.id}>
                  <strong>{doc.name}</strong> <Badge>{doc.type}</Badge> <code className="small">{doc.id}</code>{' '}
                  {doc.type === 'page' && (
                    <Button variant="ghost" busy={load.busy} onClick={() => load.run(async () => setContent(await api.get(`/api/resources/${encodeURIComponent(data.resource.id)}/documents/${encodeURIComponent(doc.id)}`)))}>
                      Read blocks
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <ErrorBox error={load.error} />
          </Card>

          {content && (
            <Card title="Page content">
              <p className="small muted">
                Version <code>{content.version}</code> · {content.blocks.length} top-level blocks
              </p>
              {content.unsupportedCount > 0 && (
                <Notice tone="warning">
                  {content.unsupportedCount} block(s) use content the public API cannot express (shown as “unsupported”). Phase 1 never rewrites existing pages, so they are safe.
                </Notice>
              )}
              <div className="two-col">
                <div>
                  <h3>Plain text</h3>
                  <pre className="source">{content.text || '(empty)'}</pre>
                </div>
                <div>
                  <h3>Rendered (approximate)</h3>
                  <LkBlocksPreview blocks={content.blocks} />
                </div>
              </div>
              <JsonView value={content.blocks} label="Show block structure (JSON)" />
            </Card>
          )}

          <Card title="Sidebar properties">
            {data.resource.properties.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul>
                {data.resource.properties.map((prop, i) => (
                  <li key={prop.id ?? i}>
                    <strong>{prop.title ?? '(untitled)'}</strong> <Badge>{prop.kind}</Badge> {prop.isHidden && <Badge>hidden</Badge>}
                    {prop.text && <pre className="source small">{prop.text}</pre>}
                  </li>
                ))}
              </ul>
            )}
            <JsonView value={data.resource.properties} label="Show properties (JSON)" />
          </Card>
        </>
      )}
    </>
  )
}
