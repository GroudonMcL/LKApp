'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { Badge, Button, Card, ErrorBox, JsonView, KeyValue, Notice, formatDate, statusTone, useAction } from './ui'
import { LkBlocksPreview } from './lk-preview'
import { api } from '@/lib/api'
import type { DraftView, WritePreview } from '@/lib/types'

/**
 * The approval step. Creating a page takes two deliberate actions:
 * 1. "Open final preview" — the server re-checks everything (connection, parent, every link)
 *    and returns exactly what will be sent, with a one-time approval token.
 * 2. "Create page" — only after ticking the confirmation (and acknowledging warnings).
 * Any edit to the draft after step 1 invalidates the approval.
 */
export function WritePanel({ view, dirty, onChange }: { view: DraftView; dirty: boolean; onChange: (v: DraftView) => void }) {
  const [preview, setPreview] = useState<WritePreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [result, setResult] = useState<{ status: string; message?: string; resourceId?: string; mismatches?: string[]; issues?: unknown[] } | null>(null)
  const prepare = useAction()
  const approve = useAction()
  const check = useAction()
  const newId = useAction()
  const finish = useAction()
  const status = view.draft.status
  const errors = view.findings.filter((f) => f.severity === 'error').length

  const refresh = async () => onChange(await api.get<DraftView>(`/api/drafts/${view.draft.id}`))

  if (status === 'created') {
    return (
      <Card title="Created in LegendKeeper">
        <Notice tone="success">
          This draft was created as <Link href={`/pages/${view.draft.createdResourceId}`}>{view.draft.page.name}</Link> (<code>{view.draft.createdResourceId}</code>)
          {view.draft.createdVersion && (
            <>
              , document version <code>{view.draft.createdVersion}</code>
            </>
          )}
          . The import is complete and its stored source text has been deleted.
        </Notice>
        {result?.mismatches && result.mismatches.length > 0 && <Notice tone="warning">Reading the page back showed differences: {result.mismatches.join('; ')}.</Notice>}
        <p className="small">
          <Link href={`/history?draftId=${view.draft.id}`}>See the audit trail for this draft</Link>
        </p>
      </Card>
    )
  }

  if (status === 'cancelled') return null

  return (
    <Card title="Create in LegendKeeper">
      {status === 'write_uncertain' && (
        <Notice tone="warning">
          <strong>The outcome of the last write is uncertain.</strong> {view.draft.writeError} The app will not retry on its own.
          <div className="row" style={{ marginTop: '0.5rem' }}>
            <Button variant="primary" busy={check.busy} onClick={() => check.run(async () => { setResult(await api.post(`/api/drafts/${view.draft.id}/write`, { action: 'check' })); await refresh() })}>
              Check outcome
            </Button>
            <NewIdButton draftId={view.draft.id} action={newId} onDone={refresh} />
          </div>
        </Notice>
      )}
      {status === 'write_incomplete' && (
        <Notice tone="warning">
          <strong>The page exists but is not finished.</strong> {view.draft.writeError}{' '}
          {view.draft.createdResourceId && <Link href={`/pages/${view.draft.createdResourceId}`}>Open the page</Link>}
          <div className="row" style={{ marginTop: '0.5rem' }}>
            <Button
              variant="primary"
              busy={finish.busy}
              onClick={() =>
                finish.run(async () => {
                  setResult(await api.post(`/api/drafts/${view.draft.id}/write`, { action: 'finish', confirm: true }))
                  await refresh()
                })
              }
            >
              Finish the page
            </Button>
            <span className="small muted">Fills its first page tab with the approved content and adds the tags and aliases. Nothing new is created.</span>
          </div>
        </Notice>
      )}
      {status === 'write_failed' && view.draft.writeError && (
        <Notice tone="error">
          <strong>The last write did not happen.</strong> {view.draft.writeError}
          {view.draft.writeError.includes('Assign a new page ID') && <NewIdButton draftId={view.draft.id} action={newId} onDone={refresh} />}
        </Notice>
      )}
      <ErrorBox error={check.error} />
      <ErrorBox error={newId.error} />
      <ErrorBox error={finish.error} title="The page could not be finished" />

      {status === 'write_incomplete' ? null : view.writeBlockers.length > 0 ? (
        <Notice tone="info">
          <strong>Creating pages is not available yet:</strong>
          <ul>
            {view.writeBlockers.map((b) => (
              <li key={b.code}>{b.message}</li>
            ))}
          </ul>
          <span className="small">
            See <Link href="/connection#writes">Connection → Write access</Link>.
          </span>
        </Notice>
      ) : (
        <>
          <p>
            Creates <strong>one</strong> new page from the saved draft. Nothing else is changed, moved or deleted. You will see exactly what will be sent before anything is written.
          </p>
          <Button
            variant="primary"
            busy={prepare.busy}
            disabled={dirty || errors > 0 || status === 'write_uncertain' || status === 'writing'}
            onClick={() =>
              prepare.run(async () => {
                setResult(null)
                setConfirmed(false)
                setAcknowledged(false)
                setPreview(await api.post<WritePreview>(`/api/drafts/${view.draft.id}/write`, { action: 'prepare' }))
              })
            }
          >
            Open final preview
          </Button>{' '}
          {dirty && <span className="muted small">Save the draft first.</span>}
          {errors > 0 && <span className="muted small">Fix the validation errors first.</span>}
        </>
      )}
      <ErrorBox error={prepare.error} title="The final preview could not be prepared" />

      {preview && (
        <div className="confirm-box stack" style={{ marginTop: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>Final preview — please check</h3>
          <KeyValue
            rows={[
              ['Project', `${preview.project.name} (${preview.project.id})`],
              ['Page name', <strong key="n">{preview.name}</strong>],
              ['Goes under', preview.parent ? `${preview.parent.name} (${preview.parent.id})` : 'Top level of the project tree'],
              ['New page ID', <code key="i">{preview.plannedResourceId}</code>],
              ...(preview.fromTemplate
                ? ([
                    [
                      'Created from',
                      <span key="tpl">
                        A copy of the LegendKeeper template <strong>{preview.fromTemplate.name}</strong> (<code>{preview.fromTemplate.id}</code>): its {preview.fromTemplate.tabs.length} tab
                        {preview.fromTemplate.tabs.length === 1 ? '' : 's'} ({preview.fromTemplate.tabs.map((t) => t.name).join(', ')}), {preview.fromTemplate.sidebarProperties} sidebar propert
                        {preview.fromTemplate.sidebarProperties === 1 ? 'y' : 'ies'}, icon and banner. The tab “{preview.fromTemplate.filledTab}” gets the content below
                        {preview.fromTemplate.keptBoxes.length > 0 && <>, keeping the template’s {preview.fromTemplate.keptBoxes.join(', ')}</>}. Its other tabs stay as in the template.
                      </span>,
                    ],
                  ] as [string, ReactNode][])
                : []),
              ['Position', preview.placement],
              ['Tags', preview.tags.length ? <span key="t" className="pill-list">{preview.tags.map((t) => <Badge key={t.value} tone={statusTone(t.status)}>{t.value}{t.status === 'new' ? ' (new)' : ''}</Badge>)}</span> : 'none'],
              ...(preview.fromTemplate && preview.fromTemplate.tags.length ? ([['Tags from the template', preview.fromTemplate.tags.join(', ')]] as [string, ReactNode][]) : []),
              ['Aliases', preview.aliases.join(', ') || '—'],
              ['Links (confirmed just now)', preview.links.length ? preview.links.map((l) => `${l.mention} → ${l.name}`).join('; ') : 'none'],
              ['Size', `${(preview.bytes / 1024).toFixed(1)} KB · content fingerprint ${preview.payloadHash}`],
              ['Approval expires', formatDate(preview.expiresAt)],
            ]}
          />
          {preview.warnings.length > 0 && (
            <Notice tone="warning">
              <strong>Warnings</strong>
              <ul>
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
              <label className="check">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                <span>I have read these warnings and want to continue.</span>
              </label>
            </Notice>
          )}
          <details>
            <summary>Show the page content that will be sent</summary>
            <LkBlocksPreview blocks={preview.blocks} names={Object.fromEntries(preview.links.map((l) => [l.resourceId, l.name]))} />
            <JsonView value={preview.blocks} label="Show blocks (JSON)" />
          </details>
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              Create the page “{preview.name}” in <strong>{preview.project.name}</strong>.
            </span>
          </label>
          <div className="row">
            <Button
              variant="primary"
              busy={approve.busy}
              disabled={!confirmed || (preview.warnings.length > 0 && !acknowledged)}
              onClick={() =>
                approve.run(async () => {
                  const outcome = await api.post<{ status: string; message?: string; resourceId?: string }>(`/api/drafts/${view.draft.id}/write`, {
                    action: 'approve',
                    approvalToken: preview.approvalToken,
                    acknowledgeWarnings: acknowledged,
                    confirm: true,
                  })
                  setResult(outcome)
                  setPreview(null)
                  await refresh()
                })
              }
            >
              Create page
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
          <ErrorBox error={approve.error} title="The page was not created" />
        </div>
      )}

      {result && result.status !== 'created' && result.status !== 'write_incomplete' && result.message && <Notice tone={result.status === 'write_uncertain' ? 'warning' : 'error'}>{result.message}</Notice>}
    </Card>
  )
}

function NewIdButton({ draftId, action, onDone }: { draftId: string; action: ReturnType<typeof useAction>; onDone: () => Promise<void> }) {
  return (
    <Button
      variant="ghost"
      busy={action.busy}
      onClick={() => {
        if (
          confirm(
            'Only do this if LegendKeeper said this page ID is already taken AND you have checked LegendKeeper (including the trash) and the page does not exist. A new ID removes the protection against creating the page twice. Continue?',
          )
        )
          void action.run(async () => {
            await api.post(`/api/drafts/${draftId}/write`, { action: 'newId', confirmCheckedLegendKeeper: true })
            await onDone()
          })
      }}
    >
      Assign a new page ID
    </Button>
  )
}
