'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, ErrorBox, JsonView, KeyValue, Notice, formatDate, statusTone, useAction } from './ui'
import { LkBlocksPreview } from './lk-preview'
import { WritePanel } from './write-panel'
import { api } from '@/lib/api'
import type { DraftView, SearchHit } from '@/lib/types'
import type { CanonicalPage, FieldStatus, PageReference, PageSection, TagProposal } from '@/core/page-model'

type Tab = 'page' | 'fields' | 'sections' | 'tags' | 'links' | 'notes'

const FIELD_STATUSES: { value: FieldStatus; label: string }[] = [
  { value: 'source', label: 'From source' },
  { value: 'user', label: 'Confirmed by me' },
  { value: 'default', label: 'Recipe default' },
  { value: 'uncertain', label: 'Uncertain' },
  { value: 'suggested', label: 'Suggestion' },
  { value: 'missing', label: 'Missing' },
]

export function DraftReview({ view, sourceText, onChange }: { view: DraftView; sourceText: string | null; onChange: (view: DraftView) => void }) {
  const [page, setPage] = useState<CanonicalPage>(view.draft.page)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<Tab>('page')
  const save = useAction()
  const validate = useAction()
  const editable = ['draft', 'awaiting_approval', 'write_failed'].includes(view.draft.status)

  useEffect(() => {
    setPage(view.draft.page)
    setDirty(false)
  }, [view.draft.page, view.draft.revision])

  const update = (next: CanonicalPage) => {
    setPage(next)
    setDirty(true)
  }

  const saveDraft = () => save.run(async () => onChange(await api.put<DraftView>(`/api/drafts/${view.draft.id}`, { page, expectedRevision: view.draft.revision })))

  const counts = {
    error: view.findings.filter((f) => f.severity === 'error').length,
    warning: view.findings.filter((f) => f.severity === 'warning').length,
  }

  return (
    <>
      <Card
        title={`Draft: ${page.name || 'Untitled'}`}
        actions={
          editable && (
            <>
              <Button variant="primary" onClick={saveDraft} busy={save.busy} disabled={!dirty}>
                Save draft
              </Button>
              <Button onClick={() => validate.run(async () => onChange(await api.post<DraftView>(`/api/drafts/${view.draft.id}/validate`)))} busy={validate.busy} disabled={dirty}>
                Validate
              </Button>
              <Button variant="ghost" disabled={!dirty} onClick={() => { setPage(view.draft.page); setDirty(false) }}>
                Discard changes
              </Button>
            </>
          )
        }
      >
        <p className="small muted">
          Revision {view.draft.revision} · {view.pageType?.label ?? page.pageType} · recipe {view.recipe ? `“${view.recipe.name}” v${view.recipe.version}` : 'unknown'} · template{' '}
          {editable && view.templateChoices.length > 1 ? (
            <select
              aria-label="Template"
              className="inline-select"
              value={view.template?.id ?? ''}
              disabled={save.busy}
              onChange={(e) => {
                // Switching the layout saves the draft (with any unsaved edits) and refreshes the preview.
                const next = { ...page, templateId: e.target.value || null }
                void save.run(async () => onChange(await api.put<DraftView>(`/api/drafts/${view.draft.id}`, { page: next, expectedRevision: view.draft.revision })))
              }}
            >
              {!view.template?.id && <option value="">{view.template?.name ?? 'default layout'}</option>}
              {view.templateChoices.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.fromLegendKeeper ? ' — from LegendKeeper' : t.origin === 'example' ? ' — example' : ''}
                </option>
              ))}
            </select>
          ) : view.template ? (
            <>
              “{view.template.name}” <Badge tone={view.template.origin === 'local' ? 'info' : 'neutral'}>{view.template.origin === 'example' ? 'example template' : view.template.origin === 'local' ? 'local template' : 'page type default'}</Badge>
            </>
          ) : (
            '—'
          )}
          {page.processing && (
            <>
              {' '}
              · made by {page.processing.mode === 'ai' ? `AI (${page.processing.servedByModel ?? page.processing.model}, prompt ${page.processing.promptVersion})` : 'structural transformer (no AI)'} on {formatDate(page.processing.generatedAt)}
            </>
          )}
        </p>
        {dirty && <Notice tone="warning">You have unsaved changes. Save the draft to re-validate it.</Notice>}
        {!editable && <Notice>This draft is {view.draft.status} and can no longer be edited.</Notice>}
        <ErrorBox error={save.error} title="Could not save" />
        <ErrorBox error={validate.error} />

        <div className="tabs" role="tablist" aria-label="Draft sections">
          {(
            [
              ['page', 'Page'],
              ['fields', `Fields (${page.fields.filter((f) => f.value).length}/${page.fields.length})`],
              ['sections', `Sections (${page.sections.length})`],
              ['tags', `Tags (${page.tags.filter((t) => t.accepted && t.status !== 'rejected').length})`],
              ['links', `Links (${page.references.filter((r) => r.status === 'resolved').length}/${page.references.length})`],
              ['notes', 'Notes & source'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0 }}>
          {tab === 'page' && <PageTab page={page} view={view} update={update} />}
          {tab === 'fields' && <FieldsTab page={page} update={update} requiredFields={view.recipe?.requiredFields ?? []} />}
          {tab === 'sections' && <SectionsTab page={page} update={update} />}
          {tab === 'tags' && <TagsTab page={page} update={update} policy={view.recipe?.tagPolicy.mode ?? 'existing_only'} />}
        </fieldset>
        {tab === 'links' && <LinksTab view={view} dirty={dirty} editable={editable} onChange={onChange} />}
        {tab === 'notes' && <NotesTab page={page} sourceText={sourceText} />}
      </Card>

      <Card title={`Validation — ${counts.error} error(s), ${counts.warning} warning(s)`}>
        <Findings view={view} />
      </Card>

      <Card title="Preview">
        <p className="small muted">
          Approximately how the page will look in LegendKeeper, built from the last saved draft. Only confirmed values are included; suggestions, uncertain and missing values are
          not. {view.preview ? `About ${(view.preview.bytes / 1024).toFixed(1)} KB of content.` : ''}
        </p>
        {view.preview ? (
          <>
            <LkBlocksPreview blocks={view.preview.blocks} names={referenceNames(view.draft.page)} />
            <JsonView value={view.preview.blocks} label="Show LegendKeeper blocks (JSON)" />
          </>
        ) : (
          <Notice tone="warning">The preview could not be built. See the validation errors.</Notice>
        )}
      </Card>

      <WritePanel view={view} dirty={dirty} onChange={onChange} />
    </>
  )
}

function Findings({ view }: { view: DraftView }) {
  if (view.findings.length === 0) return <p>No issues found.</p>
  const order = { error: 0, warning: 1, info: 2 } as const
  return (
    <ul className="findings" style={{ paddingLeft: '1rem' }}>
      {[...view.findings]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((finding, i) => (
          <li key={i}>
            <Badge tone={finding.severity === 'error' ? 'bad' : finding.severity === 'warning' ? 'warn' : 'neutral'}>{finding.severity}</Badge> {finding.message}{' '}
            {finding.path && <code className="small muted">{finding.path}</code>}
          </li>
        ))}
    </ul>
  )
}

function PageTab({ page, view, update }: { page: CanonicalPage; view: DraftView; update: (p: CanonicalPage) => void }) {
  return (
    <div className="grid grid-2">
      <div className="field">
        <label htmlFor="name">Page name</label>
        <input id="name" type="text" value={page.name} onChange={(e) => update({ ...page, name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="aliases">
          Aliases <span className="hint">(comma-separated; search matches them)</span>
        </label>
        <input
          id="aliases"
          type="text"
          value={page.aliases.join(', ')}
          onChange={(e) =>
            update({
              ...page,
              aliases: e.target.value
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="parent">
          Parent page ID <span className="hint">(where the page goes in the tree; empty = top level, needs an ADMIN key)</span>
        </label>
        <input id="parent" type="text" value={page.parentId ?? ''} onChange={(e) => update({ ...page, parentId: e.target.value.trim() || null })} />
        <div className="small muted">
          {view.parent ? (
            <>
              Currently: <Link href={`/pages/${view.parent.id}`}>{view.parent.name}</Link>
            </>
          ) : page.parentId ? (
            'Not in the local index; it will be checked against LegendKeeper before writing.'
          ) : (
            'Top level.'
          )}{' '}
          Find IDs in the <Link href="/pages">page browser</Link>.
        </div>
      </div>
      <div>
        <KeyValue
          rows={[
            ['Page type', view.pageType?.label ?? page.pageType],
            ['Planned page ID', view.draft.plannedResourceId ? <code key="p">{view.draft.plannedResourceId}</code> : 'chosen when you open the final preview'],
            ['Created page', view.draft.createdResourceId ? <Link key="c" href={`/pages/${view.draft.createdResourceId}`}>{view.draft.createdResourceId}</Link> : '—'],
          ]}
        />
      </div>
    </div>
  )
}

function FieldsTab({ page, update, requiredFields }: { page: CanonicalPage; update: (p: CanonicalPage) => void; requiredFields: string[] }) {
  const set = (index: number, patch: Partial<CanonicalPage['fields'][number]>) => {
    const fields = page.fields.map((field, i) => (i === index ? { ...field, ...patch } : field))
    update({ ...page, fields })
  }
  return (
    <div>
      <p className="small muted">
        Only values marked <Badge tone="good">From source</Badge> or <Badge tone="good">Confirmed by me</Badge> are written. Editing a value marks it as confirmed by you. Missing
        values are never guessed.
      </p>
      {(['lore', 'mechanics'] as const).map((group) => (
        <div key={group}>
          <h3>{group === 'lore' ? 'Lore (infobox)' : 'Game mechanics (statistics)'}</h3>
          {page.fields.map((field, index) =>
            field.group !== group ? null : (
              <div className="field-row" key={field.key}>
                <label htmlFor={`f-${field.key}`} style={{ marginTop: '0.4rem' }}>
                  {field.label}
                  {requiredFields.includes(field.key) && <span className="muted"> *</span>}
                </label>
                <div>
                  <input
                    id={`f-${field.key}`}
                    type="text"
                    value={field.value ?? ''}
                    onChange={(e) => set(index, { value: e.target.value || null, status: e.target.value ? 'user' : 'missing' })}
                  />
                  {field.sourceQuote && <div className="small muted break">Source: “{field.sourceQuote}”</div>}
                </div>
                <select aria-label={`${field.label} status`} value={field.status} onChange={(e) => set(index, { status: e.target.value as FieldStatus })}>
                  {FIELD_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <div className="small">
                  <Badge tone={statusTone(field.status)}>{field.status}</Badge> {field.note && <span className="muted">{field.note}</span>}
                </div>
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  )
}

function SectionsTab({ page, update }: { page: CanonicalPage; update: (p: CanonicalPage) => void }) {
  const set = (index: number, patch: Partial<PageSection>) => update({ ...page, sections: page.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  const move = (index: number, delta: number) => {
    const sections = [...page.sections]
    const [moved] = sections.splice(index, 1)
    sections.splice(index + delta, 0, moved!)
    update({ ...page, sections })
  }
  return (
    <div className="stack">
      <p className="small muted">Paragraphs are separated by a blank line. Lines starting with “- ” become a bullet list; **text** becomes bold.</p>
      {page.sections.map((section, index) => (
        <fieldset key={section.id}>
          <legend>
            <Badge tone={section.kind === 'unmapped' ? 'warn' : section.kind === 'mechanics' ? 'info' : 'neutral'}>{section.kind}</Badge>
          </legend>
          <div className="row">
            <input aria-label="Section heading" type="text" value={section.heading} onChange={(e) => set(index, { heading: e.target.value })} style={{ flex: 1 }} />
            <select aria-label="Section kind" value={section.kind} onChange={(e) => set(index, { kind: e.target.value as PageSection['kind'] })} style={{ width: 'auto' }}>
              <option value="lore">Lore</option>
              <option value="mechanics">Mechanics</option>
              <option value="notes">Notes</option>
              <option value="unmapped">Unsorted source material</option>
            </select>
            <Button variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} title="Move up">
              ↑
            </Button>
            <Button variant="ghost" disabled={index === page.sections.length - 1} onClick={() => move(index, 1)} title="Move down">
              ↓
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (confirm(`Remove the section “${section.heading}”? Its text will not be written.`)) update({ ...page, sections: page.sections.filter((_, i) => i !== index) })
              }}
            >
              Remove
            </Button>
          </div>
          <textarea
            aria-label={`${section.heading} text`}
            rows={Math.min(14, 3 + section.paragraphs.join('\n\n').split('\n').length)}
            value={section.paragraphs.join('\n\n')}
            onChange={(e) => set(index, { paragraphs: e.target.value.split(/\n\s*\n/).map((p) => p.replace(/\s+$/, '')).filter((p) => p.trim() !== '') })}
            style={{ marginTop: '0.4rem' }}
          />
        </fieldset>
      ))}
      <Button onClick={() => update({ ...page, sections: [...page.sections, { id: `sec_${Date.now().toString(36)}`, heading: 'New section', kind: 'lore', paragraphs: [] }] })}>Add section</Button>
    </div>
  )
}

function TagsTab({ page, update, policy }: { page: CanonicalPage; update: (p: CanonicalPage) => void; policy: string }) {
  const [newTag, setNewTag] = useState('')
  const set = (index: number, patch: Partial<TagProposal>) => update({ ...page, tags: page.tags.map((t, i) => (i === index ? { ...t, ...patch } : t)) })
  return (
    <div>
      <p className="small muted">
        Tag policy: <strong>{policy === 'existing_only' ? 'existing tags only' : 'may suggest new tags'}</strong>. Tags match exactly in LegendKeeper (“NPC” and “npc” differ), so close
        variants are rewritten to the existing spelling. Statuses are re-checked when you save.
      </p>
      {page.tags.length === 0 && <p className="muted">No tags proposed.</p>}
      <table>
        <thead>
          <tr>
            <th>Use</th>
            <th>Tag</th>
            <th>Status</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {page.tags.map((tag, index) => (
            <tr key={`${tag.value}-${index}`}>
              <td>
                <input type="checkbox" aria-label={`Use tag ${tag.value}`} checked={tag.accepted && tag.status !== 'rejected'} disabled={tag.status === 'rejected'} onChange={(e) => set(index, { accepted: e.target.checked })} />
              </td>
              <td>
                {tag.existingMatch && tag.existingMatch !== tag.value ? (
                  <>
                    {tag.value} → <strong>{tag.existingMatch}</strong>
                  </>
                ) : (
                  <strong>{tag.value}</strong>
                )}
              </td>
              <td>
                <Badge tone={statusTone(tag.status)}>{tag.status === 'case_variant' ? 'existing (respelled)' : tag.status}</Badge> <span className="small muted">{tag.origin}</span>
              </td>
              <td className="small">
                {tag.reason}
                {tag.similarTo && <> Did you mean “{tag.similarTo}”?</>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="row"
        style={{ marginTop: '0.6rem' }}
        onSubmit={(e) => {
          e.preventDefault()
          if (!newTag.trim()) return
          update({ ...page, tags: [...page.tags, { value: newTag.trim(), status: 'new', existingMatch: null, similarTo: null, origin: 'user', accepted: true, reason: 'Added by you.' }] })
          setNewTag('')
        }}
      >
        <input type="text" aria-label="New tag" placeholder="Add a tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} style={{ maxWidth: '20rem' }} />
        <Button type="submit">Add tag</Button>
      </form>
    </div>
  )
}

function LinksTab({ view, dirty, editable, onChange }: { view: DraftView; dirty: boolean; editable: boolean; onChange: (v: DraftView) => void }) {
  const action = useAction()
  const [mention, setMention] = useState('')
  const refs = view.draft.page.references
  const post = (body: unknown) => action.run(async () => onChange(await api.post<DraftView>(`/api/drafts/${view.draft.id}/references`, body)))
  return (
    <div>
      <p className="small muted">
        Mentions of other pages. Only a page ID that came from LegendKeeper can be linked: an exact single match is selected automatically, several matches must be chosen by you,
        and anything else stays plain text. Every link is checked again just before writing.
      </p>
      {dirty && <Notice tone="warning">Save your other changes before changing links.</Notice>}
      <ErrorBox error={action.error} />
      {refs.length === 0 && <p className="muted">No mentions found.</p>}
      {refs.map((ref) => (
        <ReferenceRow key={ref.id} reference={ref} disabled={!editable || dirty || action.busy} onChoose={(resourceId) => post({ action: 'choose', refId: ref.id, resourceId })} onLink={(resourceId) => post({ action: 'link', refId: ref.id, resourceId })} />
      ))}
      {editable && (
        <form
          className="row"
          style={{ marginTop: '0.75rem' }}
          onSubmit={(e) => {
            e.preventDefault()
            if (mention.trim()) void post({ action: 'add', mention: mention.trim(), relation: null }).then(() => setMention(''))
          }}
        >
          <input type="text" aria-label="Add a mention" placeholder="Add a mention, exactly as written in the text" value={mention} onChange={(e) => setMention(e.target.value)} style={{ maxWidth: '24rem' }} />
          <Button type="submit" disabled={dirty || action.busy}>
            Add mention
          </Button>
        </form>
      )}
    </div>
  )
}

function ReferenceRow({ reference, disabled, onChoose, onLink }: { reference: PageReference; disabled: boolean; onChoose: (id: string | null) => void; onLink: (id: string) => void }) {
  const [query, setQuery] = useState(reference.mention)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const search = useAction()
  return (
    <fieldset>
      <legend>
        <strong>{reference.mention}</strong> {reference.relation && <span className="muted">({reference.relation})</span>} <Badge tone={statusTone(reference.status)}>{reference.status.replace('_', ' ')}</Badge>{' '}
        <span className="small muted">found by {reference.origin === 'index_scan' ? 'name scan' : reference.origin}</span>
      </legend>
      {reference.status === 'resolved' && reference.resourceId && (
        <p className="small">
          Links to <Link href={`/pages/${reference.resourceId}`}>{reference.candidates.find((c) => c.resourceId === reference.resourceId)?.name ?? reference.resourceId}</Link> <code>{reference.resourceId}</code>
          {reference.resolvedBy === 'auto_exact' && <span className="muted"> · selected automatically (exact match)</span>}
        </p>
      )}
      {reference.candidates.length > 0 && (
        <div role="radiogroup" aria-label={`Candidates for ${reference.mention}`}>
          {reference.candidates.map((candidate) => (
            <label key={candidate.resourceId} className="check">
              <input type="radio" name={`ref-${reference.id}`} checked={reference.resourceId === candidate.resourceId} disabled={disabled} onChange={() => onChoose(candidate.resourceId)} />
              <span>
                {candidate.name} <code className="small">{candidate.resourceId}</code> <Badge>{candidate.matchType.replace('_', ' ')}</Badge>
                {candidate.path && <span className="small muted"> · {candidate.path}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: '0.4rem' }}>
        <Button variant="ghost" disabled={disabled || reference.status === 'left_unresolved'} onClick={() => onChoose(null)}>
          Leave unresolved (plain text)
        </Button>
        <input type="search" aria-label={`Search LegendKeeper for ${reference.mention}`} value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: '16rem' }} />
        <Button disabled={disabled} busy={search.busy} onClick={() => search.run(async () => setHits((await api.get<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=8`)).hits))}>
          Search LegendKeeper
        </Button>
      </div>
      <ErrorBox error={search.error} />
      {hits && hits.length === 0 && <p className="small muted">No results.</p>}
      {hits && hits.length > 0 && (
        <ul className="small">
          {hits.map((hit, i) => (
            <li key={`${hit.resourceId}-${i}`}>
              {hit.name} <span className="muted">{hit.path.join(' / ')}</span>{' '}
              <Button variant="ghost" disabled={disabled} onClick={() => onLink(hit.resourceId)}>
                Link to this page
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

function NotesTab({ page, sourceText }: { page: CanonicalPage; sourceText: string | null }) {
  return (
    <div className="two-col">
      <div>
        <h3>Notes for the reviewer</h3>
        {page.reviewerNotes.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul>
            {page.reviewerNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}
        <h3>Sources</h3>
        <ul>
          {page.sources.map((source, i) => (
            <li key={i}>
              {source.title}
              {source.citation && ` — ${source.citation}`} <span className="muted small">({source.kind}, {formatDate(source.importedAt)})</span>
            </li>
          ))}
        </ul>
        <JsonView value={page} label="Show canonical draft (JSON)" />
      </div>
      <div>
        <h3>Original source</h3>
        {sourceText === null ? <p className="muted">The source text has been deleted.</p> : <pre className="source">{sourceText}</pre>}
      </div>
    </div>
  )
}

/** Resource ID → page name for the links in a draft (for previews). */
function referenceNames(page: CanonicalPage): Record<string, string> {
  return Object.fromEntries(page.references.flatMap((ref) => ref.candidates.map((c) => [c.resourceId, c.name] as const)))
}
