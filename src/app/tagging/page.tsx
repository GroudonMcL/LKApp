'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { TaxonomyConfig, TaxonomyEntry, TagRule } from '@/core/tag-assistant'
import type { BatchListing, TagOverview, TaggingView } from '@/lib/types'

const PAGE_TYPES = ['npc', 'creature', 'location', 'magic_item', 'rule', 'historical_event']
const list = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean)

export default function TaggingPage() {
  return (
    <>
      <div className="page-header">
        <h1>Tagging assistant</h1>
        <p className="lead">Suggests tags for existing pages; you choose and approve every one.</p>
        <More>
          <p className="small">
            Suggests tags for existing pages, using your existing tags, the page’s place in the tree, its neighbours, its links and (if you switch it on) the AI. You choose every
          tag. Nothing is changed until you approve and run a job, and existing tags are never removed unless you tick a removal yourself.
          </p>
        </More>
      </div>
      <Taxonomy />
      <NewJob />
      <Jobs />
    </>
  )
}

function Taxonomy() {
  const { data, error, loading, setData } = useApi<{ config: TaxonomyConfig; revision: number }>('/api/tagging/taxonomy')
  const tags = useApi<TagOverview>('/api/tags')
  const [config, setConfig] = useState<TaxonomyConfig | null>(null)
  const save = useAction()
  useEffect(() => {
    if (data) setConfig(data.config)
  }, [data])
  if (error) return <ErrorBox error={error} />
  if (loading || !config) return <Loading />
  const set = (patch: Partial<TaxonomyConfig>) => setConfig({ ...config, ...patch })
  const setEntry = (i: number, patch: Partial<TaxonomyEntry>) => set({ approved: config.approved.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
  const setRule = (i: number, patch: Partial<TagRule>) => set({ rules: config.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const existing = (tags.data as { tags?: { tag: string; count: number | null }[] } | null)?.tags ?? []
  return (
    <Card title={`Tagging settings (revision ${data?.revision ?? 0})`}>
      <div className="grid grid-2">
        <div className="field">
          <label>Which tags may be suggested</label>
          {(
            [
              ['existing_only', 'A — Existing tags only', 'Only tags that already exist in your project.'],
              ['allow_new', 'B — Suggest new tags', 'New tags may be suggested, marked NEW; each needs your explicit approval.'],
              ['approved_taxonomy', 'C — Approved taxonomy', 'Only the tags in your approved list below, optionally limited to page types.'],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="check">
              <input type="radio" name="policy" checked={config.policy === value} onChange={() => set({ policy: value })} />
              <span>
                <strong>{label}</strong> — {hint}
              </span>
            </label>
          ))}
          <label className="check" style={{ marginTop: '0.5rem' }}>
            <input type="checkbox" checked={config.useAi} onChange={(e) => set({ useAi: e.target.checked })} />
            <span>
              Also ask the AI. Each page’s name, place in the tree, current tags and up to 6,000 characters of its text are sent to the AI provider, with your allowed tags.
            </span>
          </label>
          <label htmlFor="t-max">Suggestions per page (at most)</label>
          <input id="t-max" type="number" min={1} max={20} value={config.maxSuggestionsPerPage} onChange={(e) => set({ maxSuggestionsPerPage: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>Your existing tags {tags.loading && !tags.data ? '(loading…)' : `(${existing.length})`}</label>
          <div className="tag-cloud small">
            {existing.slice(0, 200).map((t) => (
              <Badge key={t.tag}>
                {t.tag}
                {t.count !== null ? ` · ${t.count}` : ''}
              </Badge>
            ))}
          </div>
          <p className="small muted">
            Similar tags (capitals, plurals, typos) are listed in <Link href="/health">Wiki Health</Link>. They are never merged automatically.
          </p>
        </div>
      </div>

      <h3>Approved taxonomy {config.policy !== 'approved_taxonomy' && <span className="small muted">(used for policy C, and for aliases and text matches in all policies)</span>}</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tag</th>
              <th>Also written as</th>
              <th>Only for page types</th>
              <th>Group</th>
              <th>Meaning</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {config.approved.map((entry, i) => (
              <tr key={i}>
                <td>
                  <input aria-label="Tag" type="text" value={entry.tag} onChange={(e) => setEntry(i, { tag: e.target.value })} />
                </td>
                <td>
                  <input aria-label="Aliases" type="text" value={entry.aliases.join(', ')} onChange={(e) => setEntry(i, { aliases: list(e.target.value) })} placeholder="Monsters, monster" />
                </td>
                <td>
                  <input aria-label="Page types" type="text" value={entry.pageTypes.join(', ')} onChange={(e) => setEntry(i, { pageTypes: list(e.target.value) })} placeholder={PAGE_TYPES.join(', ')} />
                </td>
                <td>
                  <input aria-label="Group" type="text" value={entry.category} onChange={(e) => setEntry(i, { category: e.target.value })} placeholder="Type, Region…" />
                </td>
                <td>
                  <input aria-label="Meaning" type="text" value={entry.description} onChange={(e) => setEntry(i, { description: e.target.value })} />
                </td>
                <td>
                  <Button variant="ghost" onClick={() => set({ approved: config.approved.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <Button variant="ghost" onClick={() => set({ approved: [...config.approved, { tag: '', aliases: [], pageTypes: [], category: '', description: '' }] })}>
          Add a tag
        </Button>
        <Button
          variant="ghost"
          disabled={existing.length === 0}
          onClick={() => {
            const have = new Set(config.approved.map((e) => e.tag.toLowerCase()))
            set({ approved: [...config.approved, ...existing.filter((t) => !have.has(t.tag.toLowerCase())).map((t) => ({ tag: t.tag, aliases: [], pageTypes: [], category: '', description: '' }))] })
          }}
        >
          Start from my existing tags
        </Button>
      </div>

      <h3>Rules</h3>
      <p className="small muted">Deterministic rules, e.g. “pages under the Saltmarsh page get the tag Saltmarsh”. Rule suggestions are marked definite and pre-selected (if the policy allows the tag).</p>
      {config.rules.map((rule, i) => (
        <div key={i} className="confirm-box rule-box">
          <div className="rule-grid">
            <label>
              <span className="small muted">Page type</span>
              <select value={rule.when.pageType ?? ''} onChange={(e) => setRule(i, { when: { ...rule.when, pageType: e.target.value || null } })}>
                <option value="">any page type</option>
                {PAGE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="small muted">Inside the page with ID</span>
              <input type="text" placeholder="any" value={rule.when.underResourceId ?? ''} onChange={(e) => setRule(i, { when: { ...rule.when, underResourceId: e.target.value || null } })} />
            </label>
            <label>
              <span className="small muted">Name contains</span>
              <input type="text" placeholder="anything" value={rule.when.nameContains ?? ''} onChange={(e) => setRule(i, { when: { ...rule.when, nameContains: e.target.value || null } })} />
            </label>
            <label>
              <span className="small muted">Already has the tag</span>
              <input type="text" placeholder="any" value={rule.when.hasTag ?? ''} onChange={(e) => setRule(i, { when: { ...rule.when, hasTag: e.target.value || null } })} />
            </label>
            <label>
              <span className="small muted">Then suggest (comma-separated)</span>
              <input type="text" placeholder="Tag, Tag" value={rule.add.join(', ')} onChange={(e) => setRule(i, { add: list(e.target.value) })} />
            </label>
            <label>
              <span className="small muted">Note (shown as the reason)</span>
              <input type="text" value={rule.note} onChange={(e) => setRule(i, { note: e.target.value })} />
            </label>
          </div>
          <Button variant="ghost" onClick={() => set({ rules: config.rules.filter((_, j) => j !== i) })}>
            Remove rule
          </Button>
        </div>
      ))}
      <Button variant="ghost" onClick={() => set({ rules: [...config.rules, { when: { pageType: null, underResourceId: null, nameContains: null, hasTag: null }, add: [], note: '' }] })}>
        Add a rule
      </Button>
      <ErrorBox error={save.error} />
      <div className="row" style={{ marginTop: '0.75rem' }}>
        <Button variant="primary" busy={save.busy} onClick={() => void save.run(async () => setData(await api.put('/api/tagging/taxonomy', { ...config, approved: config.approved.filter((e) => e.tag.trim()), rules: config.rules.filter((r) => r.add.length) })))}>
          Save settings
        </Button>
        <span className="small muted">Jobs keep the settings they started with.</span>
      </div>
    </Card>
  )
}

function NewJob() {
  const router = useRouter()
  const action = useAction()
  const [name, setName] = useState('Tag untagged pages')
  const [mode, setMode] = useState('untagged')
  const [pageTypes, setPageTypes] = useState<string[]>([])
  const [folderId, setFolderId] = useState('')
  const [tag, setTag] = useState('')
  const [nameContains, setNameContains] = useState('')
  const [maxPages, setMaxPages] = useState(200)
  return (
    <Card title="New tagging job">
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="j-name">Name</label>
          <input id="j-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="j-mode">Pages</label>
          <select id="j-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="untagged">All untagged pages</option>
            <option value="page_types">Pages of some types</option>
            <option value="folder">Pages in a folder (region, chapter…)</option>
            <option value="criteria">Pages with a tag or name</option>
            <option value="all">All pages</option>
          </select>
          {mode === 'page_types' && (
            <div className="row">
              {PAGE_TYPES.map((t) => (
                <label key={t} className="check">
                  <input type="checkbox" checked={pageTypes.includes(t)} onChange={(e) => setPageTypes(e.target.checked ? [...pageTypes, t] : pageTypes.filter((x) => x !== t))} /> {t}
                </label>
              ))}
            </div>
          )}
          {mode === 'folder' && <input aria-label="Folder page ID" type="text" placeholder="folder page ID (Page browser)" value={folderId} onChange={(e) => setFolderId(e.target.value)} />}
          {mode === 'criteria' && (
            <>
              <input aria-label="Has tag" type="text" placeholder="has tag" value={tag} onChange={(e) => setTag(e.target.value)} />
              <input aria-label="Name contains" type="text" placeholder="name contains" value={nameContains} onChange={(e) => setNameContains(e.target.value)} />
            </>
          )}
          <label htmlFor="j-max">At most this many pages</label>
          <input id="j-max" type="number" min={1} max={2000} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
        </div>
        <div>
          <Notice>
            The job reads each selected page once (about 4 a second) to suggest tags. It changes nothing until you approve pages and run it. Uses the saved settings above.
          </Notice>
        </div>
      </div>
      <ErrorBox error={action.error} />
      <Button
        variant="primary"
        busy={action.busy}
        onClick={() =>
          void action.run(async () => {
            const view = await api.post<TaggingView>('/api/tagging', { name, scope: { mode, pageTypes, folderId: folderId || null, tag: tag || null, nameContains: nameContains || null, maxPages } })
            await api.post(`/api/tagging/${view.batch.id}/actions`, { action: 'suggest' })
            router.push(`/tagging/${view.batch.id}`)
          })
        }
      >
        Create job and suggest tags
      </Button>
    </Card>
  )
}

function Jobs() {
  const { data, error, loading } = useApi<BatchListing>('/api/tagging')
  return (
    <Card title="Tagging jobs">
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && data.items.length === 0 && <Empty title="No tagging jobs yet" />}
      {data && data.items.length > 0 && (
        <table>
          <tbody>
            {data.items.map((b) => (
              <tr key={b.id}>
                <td>
                  <Link href={`/tagging/${b.id}`}>{b.name}</Link>
                </td>
                <td>
                  <Badge tone={statusTone(b.status)}>{b.phase ?? b.status}</Badge>
                </td>
                <td className="small">
                  {Object.values(b.counts).reduce((x, y) => x + y, 0)} pages · {b.counts.succeeded} updated · {b.counts.awaiting_review} to review
                </td>
                <td className="small">{formatDate(b.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
