'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, More, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { Recipe } from '@/core/recipe'
import type { BatchListing, MigrationView, TemplateWithReport } from '@/lib/types'

const PAGE_TYPES = ['npc', 'creature', 'location', 'magic_item', 'rule', 'historical_event']

export default function MigrationsPage() {
  return (
    <>
      <div className="page-header">
        <h1>Template migration</h1>
        <p className="lead">Moves older pages into a newer template’s layout without losing anything.</p>
        <More>
          <p className="small">
            Brings older pages into the layout of a newer template without losing anything. Start with one representative page, check the before-and-after comparison, then
          run the same recipe on more pages. Nothing is changed in LegendKeeper until you approve a page and apply it.
          </p>
        </More>
      </div>
      <HowItWorks />
      <NewMigration />
      <Jobs />
    </>
  )
}

function HowItWorks() {
  return (
    <Card title="What happens to a page">
      <ol className="steps-list">
        <li>
          <strong>Read.</strong> The app reads the page. Its text (headings, paragraphs, lists, infobox rows and titled boxes) is re-drafted with your recipe, exactly like
          an import. Everything else — images, secrets, tables, embeds, maps, quotes, callouts and content the API cannot read — is kept exactly as it is.
        </li>
        <li>
          <strong>Compare.</strong> The proposed page is checked word for word against the old one. Old text with no place in the new layout is kept in a notes section;
          links that would be lost are added back; every number that changes must be ticked off by you.
        </li>
        <li>
          <strong>Apply.</strong> The original is saved in this app first. The page content is then replaced with a version check, so a page edited in the meantime is never
          overwritten. The page keeps its id, name, place in the tree, aliases, sidebar properties and incoming links; its tags change only if the recipe says so.
        </li>
        <li>
          <strong>Restore.</strong> A migrated page can be put back to the saved original, as long as nobody has edited it since (or you accept overwriting those edits).
        </li>
      </ol>
      <p className="small muted">
        Target layouts: a <strong>LegendKeeper template</strong> copied on the Recipes &amp; templates page, a layout copied from an <strong>example page</strong>, or a layout{' '}
        <strong>defined in this app</strong>. LegendKeeper does not record which template a page was made from, so the app never claims that it knows.
      </p>
    </Card>
  )
}

function NewMigration() {
  const router = useRouter()
  const action = useAction()
  const recipes = useApi<{ recipes: Recipe[] }>('/api/recipes')
  const templates = useApi<{ templates: TemplateWithReport[] }>('/api/templates')
  const [name, setName] = useState('Migration test')
  const [recipeId, setRecipeId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [mode, setMode] = useState<'structural' | 'ai'>('structural')
  const [scope, setScope] = useState('resources')
  const [pageRefs, setPageRefs] = useState('')
  const [pageTypes, setPageTypes] = useState<string[]>([])
  const [folderId, setFolderId] = useState('')
  const [tag, setTag] = useState('')
  const [nameContains, setNameContains] = useState('')
  const [maxPages, setMaxPages] = useState(25)

  const recipe = recipes.data?.recipes.find((r) => r.id === recipeId) ?? null
  const choices = (templates.data?.templates ?? []).filter((t) => !recipe || t.definition.pageType === recipe.definition.targetPageType)
  const kindOf = (t: TemplateWithReport) => (t.definition.lkLayout?.sourceKind === 'template' ? 'LegendKeeper template' : t.definition.lkLayout ? 'example page' : 'defined in this app')
  const refs = pageRefs.split('\n').map((s) => s.trim()).filter(Boolean)

  return (
    <Card title="New migration">
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="m-name">Name</label>
          <input id="m-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="m-recipe">Recipe (how to read the old page)</label>
          <select
            id="m-recipe"
            value={recipeId}
            onChange={(e) => {
              setRecipeId(e.target.value)
              setTemplateId('')
            }}
          >
            <option value="">Choose a recipe…</option>
            {recipes.data?.recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.definition.name} ({r.definition.targetPageType})
              </option>
            ))}
          </select>
          <label htmlFor="m-template">Target layout</label>
          <select id="m-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!recipe}>
            <option value="">{recipe?.definition.templateId ? 'The recipe’s own template' : 'The built-in layout for this page type'}</option>
            {choices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.definition.name} — {kindOf(t)}
              </option>
            ))}
          </select>
          <label>Drafting</label>
          <label className="check">
            <input type="radio" name="m-mode" checked={mode === 'structural'} onChange={() => setMode('structural')} />
            <span>
              <strong>Structural</strong> — reads labels and headings on this computer. No AI, nothing sent anywhere. Best for statblocks and pages with labelled values.
            </span>
          </label>
          <label className="check">
            <input type="radio" name="m-mode" checked={mode === 'ai'} onChange={() => setMode('ai')} />
            <span>
              <strong>AI</strong> — for moving prose into fields. Each page’s readable text is sent to the AI provider with the recipe’s instructions and a rule to reorganise,
              not rewrite. Its result is still checked word for word.
            </span>
          </label>
          {recipe && (
            <p className="small muted">
              Recipe settings: text that does not fit goes under “{recipe.definition.migration.notesHeading}” ({recipe.definition.unmappedHandling === 'keep' ? 'kept' : 'must be resolved first'}); tags{' '}
              {recipe.definition.migration.tagHandling === 'keep' ? 'are not changed' : 'you accept in the draft are added'}; lost links{' '}
              {recipe.definition.migration.linkHandling === 'keep_all' ? 'are added back as a link list' : 'are reported'}. Change these in the <Link href={`/recipes/${recipe.id}`}>recipe</Link>.
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="m-scope">Pages</label>
          <select id="m-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="resources">Pages I name (start with one to test)</option>
            <option value="page_types">Pages of some types</option>
            <option value="folder">Pages in a folder (region, chapter…)</option>
            <option value="criteria">Pages with a tag or name</option>
          </select>
          {scope === 'resources' && (
            <>
              <textarea aria-label="Pages" rows={4} placeholder={'One per line: a page name, page id or LegendKeeper link\nAboleth'} value={pageRefs} onChange={(e) => setPageRefs(e.target.value)} />
              <p className="small muted">Names must match exactly one page in the last project scan.</p>
            </>
          )}
          {scope === 'page_types' && (
            <div className="row">
              {PAGE_TYPES.map((t) => (
                <label key={t} className="check">
                  <input type="checkbox" checked={pageTypes.includes(t)} onChange={(e) => setPageTypes(e.target.checked ? [...pageTypes, t] : pageTypes.filter((x) => x !== t))} /> {t}
                </label>
              ))}
            </div>
          )}
          {scope === 'folder' && <input aria-label="Folder page ID" type="text" placeholder="folder page ID (Page browser)" value={folderId} onChange={(e) => setFolderId(e.target.value)} />}
          {scope === 'criteria' && (
            <>
              <input aria-label="Has tag" type="text" placeholder="has tag" value={tag} onChange={(e) => setTag(e.target.value)} />
              <input aria-label="Name contains" type="text" placeholder="name contains" value={nameContains} onChange={(e) => setNameContains(e.target.value)} />
            </>
          )}
          {scope !== 'resources' && (
            <>
              <label htmlFor="m-max">At most this many pages</label>
              <input id="m-max" type="number" min={1} max={2000} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
            </>
          )}
          <Notice>Creating the job reads each page once and builds its comparison. Nothing is written until you approve pages and apply them.</Notice>
        </div>
      </div>
      <ErrorBox error={action.error ?? recipes.error ?? templates.error} />
      <Button
        variant="primary"
        busy={action.busy}
        disabled={!recipeId || (scope === 'resources' && refs.length === 0)}
        onClick={() =>
          void action.run(async () => {
            const view = await api.post<MigrationView>('/api/migrations', {
              name,
              recipeId,
              templateId: templateId || null,
              mode,
              scope: { mode: scope, pageTypes, folderId: folderId || null, tag: tag || null, nameContains: nameContains || null, maxPages },
              pageRefs: scope === 'resources' ? refs : [],
            })
            await api.post(`/api/migrations/${view.batch.id}/actions`, { action: 'analyse' })
            router.push(`/migrations/${view.batch.id}`)
          })
        }
      >
        Create and compare
      </Button>
    </Card>
  )
}

function Jobs() {
  const { data, error, loading } = useApi<BatchListing>('/api/migrations')
  return (
    <Card title="Migration jobs">
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data && data.items.length === 0 && <Empty title="No migrations yet" />}
      {data && data.items.length > 0 && (
        <table>
          <tbody>
            {data.items.map((b) => (
              <tr key={b.id}>
                <td>
                  <Link href={`/migrations/${b.id}`}>{b.name}</Link>
                </td>
                <td>
                  <Badge tone={statusTone(b.status)}>{b.phase ?? b.status}</Badge>
                </td>
                <td className="small">
                  {Object.values(b.counts).reduce((x, y) => x + y, 0)} pages · {b.counts.succeeded} migrated · {b.counts.awaiting_review} to review
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
