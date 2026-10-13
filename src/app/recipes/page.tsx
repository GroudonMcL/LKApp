'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, KeyValue, Loading, More, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { Recipe } from '@/core/recipe'
import { LAYOUT_PRESETS, type LayoutRules, type TemplateDefinitionInput } from '@/core/template'
import type { PageTypeDefinition } from '@/core/page-types'
import { LkBlocksPreview } from '@/components/lk-preview'
import type { LayoutReport, LkTemplateListing, TemplateWithReport } from '@/lib/types'

export default function RecipesPage() {
  const { data, error, loading, reload } = useApi<{ recipes: Recipe[] }>('/api/recipes')
  const templateNames = useApi<{ templates: TemplateWithReport[] }>('/api/templates')
  return (
    <>
      <div className="page-header">
        <h1>Recipes & templates</h1>
        <p className="lead">Page kinds and how sources become pages.</p>
        <More>
          <p className="small">
            A <strong>template</strong> is how a page looks (copy one from LegendKeeper). A <strong>recipe</strong> is how a source becomes that page: the template, fields, tag and link
          rules, and instructions for the AI. Copying a template from LegendKeeper makes a matching recipe for you. Recipes are versioned; each draft remembers the exact version it used.
          </p>
        </More>
      </div>
      <Card title="Recipes" actions={<Link className="btn btn-primary" href="/recipes/new">New recipe</Link>}>
        <ErrorBox error={error} />
        {loading && <Loading />}
        {data && data.recipes.length === 0 && <Empty title="No recipes">Create one to start importing.</Empty>}
        {data && data.recipes.length > 0 && (
          <>
          <RecipeTable recipes={data.recipes.filter((r) => !r.definition.name.startsWith('Import: '))} templates={templateNames.data?.templates ?? []} />
          {data.recipes.some((r) => r.definition.name.startsWith('Import: ')) && (
            <More label={`Made by the import for its page kinds (${data.recipes.filter((r) => r.definition.name.startsWith('Import: ')).length})`}>
              <RecipeTable recipes={data.recipes.filter((r) => r.definition.name.startsWith('Import: '))} templates={templateNames.data?.templates ?? []} />
            </More>
          )}
          </>
        )}
      </Card>
      <Templates
        recipes={data?.recipes ?? []}
        onRecipesChanged={async () => {
          await reload()
          await templateNames.reload()
        }}
      />
    </>
  )
}

function RecipeTable({ recipes, templates }: { recipes: Recipe[]; templates: TemplateWithReport[] }) {
  if (!recipes.length) return <p className="muted small">No recipes of your own yet.</p>
  return (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recipe</th>
                  <th>Page type</th>
                  <th>Template</th>
                  <th>Tags</th>
                  <th>Creation</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {recipes.map((recipe) => (
                  <tr key={recipe.id}>
                    <td>
                      <Link href={`/recipes/${recipe.id}`}>{recipe.definition.name}</Link>
                      <div className="small muted">{recipe.definition.description}</div>
                    </td>
                    <td>{recipe.definition.targetPageType}</td>
                    <td className="small">
                      {templates.find((t) => t.id === recipe.definition.templateId)?.definition.name ?? (recipe.definition.templateId ? <code>{recipe.definition.templateId}</code> : 'default layout')}
                    </td>
                    <td>{recipe.definition.tagPolicy.mode === 'existing_only' ? 'existing only' : 'may suggest new'}</td>
                    <td>{recipe.definition.allowCreate ? <Badge tone="good">allowed after approval</Badge> : <Badge>review only</Badge>}</td>
                    <td className="small">
                      v{recipe.version} · {formatDate(recipe.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
  )
}

function Templates({ recipes, onRecipesChanged }: { recipes: Recipe[]; onRecipesChanged: () => Promise<void> }) {
  const { data, error, loading, reload } = useApi<{ templates: TemplateWithReport[] }>('/api/templates')
  const types = useApi<{ pageTypes: PageTypeDefinition[] }>('/api/page-types')
  const [editing, setEditing] = useState<{ id: string | null; definition: TemplateDefinitionInput } | null>(null)
  const [copying, setCopying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [prepared, setPrepared] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [made, setMade] = useState<Recipe | null>(null)
  const action = useAction()

  return (
    <Card
      title="Templates"
      actions={
        <>
          <Button onClick={() => setCopying(!copying)}>Copy from LegendKeeper</Button>
          <Button onClick={() => setSaving(!saving)}>Save a page as a LegendKeeper template</Button>
          <Button onClick={() => setEditing({ id: null, definition: { name: 'New template', pageType: 'npc', sections: ['Description'], infoboxFields: [] } })}>New template</Button>
        </>
      }
    >
      <Notice>
        A template decides how a new page is laid out. It can be <strong>copied from LegendKeeper</strong> (the layout of one of your LegendKeeper templates, or of any page you pick as
        an example), or <strong>configured here</strong> as a list of section headings and infobox fields. When it was copied from a LegendKeeper template, each new page is created
        in LegendKeeper as a copy of that template (with its sidebar, icon, banner, other tabs and built-in boxes) and the app fills its first page tab. <Badge>example</Badge> templates
        ship with the app and are read-only; <Badge tone="info">local</Badge> templates are yours.
      </Notice>
      {saving && <SaveAsLkTemplate onClose={() => setSaving(false)} />}
      {copying && (
        <CopyFromLegendKeeper
          pageTypes={types.data?.pageTypes ?? []}
          onDone={async (recipe) => {
            setCopying(false)
            setMade(recipe)
            await reload()
            await onRecipesChanged()
          }}
        />
      )}
      {made && (
        <Notice tone="success">
          Made the recipe <Link href={`/recipes/${made.id}`}>“{made.definition.name}”</Link>, which uses this template. Open it to choose where new pages go (the default parent page)
          and to adjust tag and link rules.
        </Notice>
      )}
      {prepared && <Notice tone="success">{prepared}</Notice>}
      <ErrorBox error={error ?? action.error} />
      {loading && <Loading />}
      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Origin</th>
                <th>Page type</th>
                <th>Sections</th>
                <th>Recipes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.templates.map((template) => (
                <tr key={template.id}>
                  <td>
                    {template.definition.name}
                    <div className="small muted">
                      <code>{template.id}</code>
                    </div>
                  </td>
                  <td>
                    {template.origin === 'example' ? <Badge>example</Badge> : <Badge tone="info">local</Badge>}
                    {template.definition.lkLayout && (
                      <div>
                        <Badge tone="good" title={`Copied ${formatDate(template.definition.lkLayout.fetchedAt)}`}>
                          from LegendKeeper
                        </Badge>
                      </div>
                    )}
                  </td>
                  <td>{template.definition.pageType}</td>
                  <td className="small">
                    {template.definition.lkLayout ? (
                      <>
                        Layout of the LegendKeeper {template.definition.lkLayout.sourceKind} “{template.definition.lkLayout.sourceName}” (<code>{template.definition.lkLayout.sourceResourceId}</code>), copied{' '}
                        {formatDate(template.definition.lkLayout.fetchedAt)}.{' '}
                        {template.definition.lkLayout.sourceKind === 'template' && 'New pages start as a copy of this template in LegendKeeper. '}
                        <strong>{describeRules(template.definition.layoutRules)}.</strong>{' '}
                        <button type="button" className="link-button" onClick={() => setOpen(open === template.id ? null : template.id)}>
                          {open === template.id ? 'Hide details' : 'What goes where'}
                        </button>
                      </>
                    ) : (
                      template.definition.sections.join(' · ')
                    )}
                    {open === template.id && template.layoutReport && template.definition.lkLayout && <LayoutDetails report={template.layoutReport} blocks={template.definition.lkLayout.blocks} />}
                  </td>
                  <td className="small">
                    {recipes
                      .filter((r) => r.definition.templateId === template.id)
                      .map((r) => (
                        <div key={r.id}>
                          <Link href={`/recipes/${r.id}`}>{r.definition.name}</Link>
                        </div>
                      ))}
                    <Button
                      variant="ghost"
                      busy={action.busy}
                      title="Make a recipe that lays pages out with this template"
                      onClick={() =>
                        void action.run(async () => {
                          setMade(await api.post<Recipe>(`/api/templates/${template.id}/recipe`, {}))
                          await onRecipesChanged()
                        })
                      }
                    >
                      Make recipe
                    </Button>
                  </td>
                  <td className="nowrap">
                    {template.origin === 'local' ? (
                      <>
                        {template.definition.lkLayout && (
                          <Button
                            variant="ghost"
                            busy={action.busy}
                            title="Read the layout from LegendKeeper again, to pick up changes you made to it there"
                            onClick={() =>
                              void action.run(async () => {
                                await api.post('/api/templates/copy', { resource: template.definition.lkLayout!.sourceResourceId, pageType: template.definition.pageType, templateId: template.id })
                                await reload()
                              })
                            }
                          >
                            Refresh
                          </Button>
                        )}
                        {template.definition.lkLayout?.sourceKind === 'template' && (
                          <Button
                            variant="ghost"
                            busy={action.busy}
                            title="Gives the template's blocks their ids in LegendKeeper (nothing visible changes), so each new page needs one write fewer"
                            onClick={() => {
                              if (
                                confirm(
                                  `Prepare “${template.definition.lkLayout!.sourceName}” in LegendKeeper?\n\nThis gives the blocks of the template's first tab the ids LegendKeeper uses to address them. Nothing you can see changes. Pages made from it then need one write fewer each.`,
                                )
                              )
                                void action.run(async () => {
                                  const result = await api.post<{ prepared: boolean; already: boolean; name: string }>(`/api/templates/${template.id}/prepare-lk`, { confirm: true })
                                  setMade(null)
                                  setPrepared(result.already ? `“${result.name}” was already prepared.` : `Prepared “${result.name}”: pages made from it now take one write fewer.`)
                                })
                            }}
                          >
                            Speed up
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => setEditing({ id: template.id, definition: template.definition })}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Delete the local template “${template.definition.name}”?`)) void action.run(async () => { await api.del(`/api/templates/${template.id}`); await reload() })
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" onClick={() => setEditing({ id: null, definition: { ...template.definition, name: template.definition.name.replace(' (example)', '') + ' (my copy)' } })}>
                        Duplicate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <TemplateEditor
          initial={editing.definition}
          pageTypes={types.data?.pageTypes ?? []}
          busy={action.busy}
          onCancel={() => setEditing(null)}
          onSave={(definition) =>
            action.run(async () => {
              if (editing.id) await api.put(`/api/templates/${editing.id}`, definition)
              else await api.post('/api/templates', definition)
              setEditing(null)
              await reload()
            })
          }
        />
      )}
    </Card>
  )
}

function TemplateEditor({ initial, pageTypes, busy, onSave, onCancel }: { initial: TemplateDefinitionInput; pageTypes: PageTypeDefinition[]; busy: boolean; onSave: (d: TemplateDefinitionInput) => void; onCancel: () => void }) {
  const [definition, setDefinition] = useState(initial)
  const lines = (value: string) => value.split('\n').map((l) => l.trim()).filter(Boolean)
  const pageType = pageTypes.find((t) => t.id === definition.pageType)
  return (
    <div className="confirm-box" style={{ marginTop: '1rem' }}>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="t-name">Name</label>
          <input id="t-name" type="text" value={definition.name} onChange={(e) => setDefinition({ ...definition, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="t-type">Page type</label>
          <select id="t-type" value={definition.pageType} onChange={(e) => setDefinition({ ...definition, pageType: e.target.value })}>
            {pageTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {definition.lkLayout && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Notice>
              The layout comes from the LegendKeeper {definition.lkLayout.sourceKind} “{definition.lkLayout.sourceName}”. To change it, edit it in LegendKeeper and press <strong>Refresh</strong>.
              The section headings and infobox fields below are not used for this template.
            </Notice>
            <LayoutRulesEditor rules={definition.layoutRules} onChange={(layoutRules) => setDefinition({ ...definition, layoutRules })} />
          </div>
        )}
        <div className="field">
          <label htmlFor="t-sections">
            Section headings <span className="hint">(one per line, in page order)</span>
          </label>
          <textarea id="t-sections" value={(definition.sections ?? []).join('\n')} onChange={(e) => setDefinition({ ...definition, sections: lines(e.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="t-infobox">
            Infobox fields <span className="hint">(field keys, one per line; empty = all lore fields)</span>
          </label>
          <textarea id="t-infobox" value={(definition.infoboxFields ?? []).join('\n')} onChange={(e) => setDefinition({ ...definition, infoboxFields: lines(e.target.value) })} />
          {pageType && <div className="small muted">Available: {pageType.fields.map((f) => f.key).join(', ')}</div>}
        </div>
        <div className="field">
          <label htmlFor="t-mech">Statistics heading</label>
          <input id="t-mech" type="text" value={definition.mechanicsHeading ?? 'Statistics'} onChange={(e) => setDefinition({ ...definition, mechanicsHeading: e.target.value })} />
        </div>
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={definition.includeSourcesSection ?? true} onChange={(e) => setDefinition({ ...definition, includeSourcesSection: e.target.checked })} /> Add a “Sources” section at the end
          </label>
          <label htmlFor="t-notes">Notes</label>
          <textarea id="t-notes" value={definition.notes ?? ''} onChange={(e) => setDefinition({ ...definition, notes: e.target.value })} placeholder="e.g. mirrors my 'NPC (2024)' template in LegendKeeper" />
        </div>
      </div>
      <div className="row">
        <Button variant="primary" busy={busy} onClick={() => onSave(definition)}>
          Save template
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function describeRules(rules: LayoutRules): string {
  const same = (a: LayoutRules, b: LayoutRules) => a.emptyFields === b.emptyFields && a.emptySections === b.emptySections && a.additions === b.additions
  if (same(rules, LAYOUT_PRESETS.exact)) return 'Pages follow it exactly'
  if (same(rules, LAYOUT_PRESETS.fit)) return 'Pages are fitted to their content'
  return [
    rules.emptyFields === 'keep' ? 'empty fields kept' : 'empty fields removed',
    rules.emptySections === 'keep' ? 'empty sections kept' : 'empty sections removed',
    rules.additions === 'add' ? 'extra fields added in line' : 'nothing added',
  ].join(', ').replace(/^./, (c) => c.toUpperCase())
}

/** How strictly pages follow a template copied from LegendKeeper: two presets and the three rules. */
function LayoutRulesEditor({ rules: given, onChange }: { rules: Partial<LayoutRules> | undefined; onChange: (rules: LayoutRules) => void }) {
  const rules: LayoutRules = { emptyFields: given?.emptyFields ?? 'keep', emptySections: given?.emptySections ?? 'remove', additions: given?.additions ?? 'add' }
  return (
    <div className="stack" style={{ marginTop: '0.5rem' }}>
      <strong>How new pages follow this template</strong>
      <div className="row">
        <Button variant="ghost" onClick={() => onChange(LAYOUT_PRESETS.exact)}>
          Exactly as the template
        </Button>
        <Button variant="ghost" onClick={() => onChange(LAYOUT_PRESETS.fit)}>
          Fitted to each page
        </Button>
      </div>
      <label className="check">
        <input type="checkbox" checked={rules.emptyFields === 'remove'} onChange={(e) => onChange({ ...rules, emptyFields: e.target.checked ? 'remove' : 'keep' })} />
        <span>Remove fields that have no value (e.g. Resistances on a creature without any). Unticked: they stay, blank. Image slots always stay.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={rules.emptySections === 'remove'} onChange={(e) => onChange({ ...rules, emptySections: e.target.checked ? 'remove' : 'keep' })} />
        <span>Remove sections the page has nothing for (e.g. Legendary Actions). Unticked: they stay, blank.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={rules.additions === 'add'} onChange={(e) => onChange({ ...rules, additions: e.target.checked ? 'add' : 'none' })} />
        <span>
          Add fields and sections the template does not have: fields in line, where they come in a statblock (e.g. Condition Immunities after Immunities), sections as new
          boxes. Unticked: nothing is added; extra sections go into the template’s Notes box or description area, and the final preview lists anything left out.
        </span>
      </label>
    </div>
  )
}

function guessPageType(name: string): string {
  const n = name.toLowerCase()
  if (/stat\s*block|creature|monster|beast/.test(n)) return 'creature'
  if (/npc|character|person/.test(n)) return 'npc'
  if (/location|place|city|town|region|settlement/.test(n)) return 'location'
  if (/item|weapon|armou?r|artifact|artefact/.test(n)) return 'magic_item'
  if (/rule/.test(n)) return 'rule'
  if (/event|history|battle|war/.test(n)) return 'historical_event'
  return 'npc'
}

function CopyFromLegendKeeper({ pageTypes, onDone }: { pageTypes: PageTypeDefinition[]; onDone: (recipe: Recipe | null) => Promise<void> }) {
  const [makeRecipe, setMakeRecipe] = useState(true)
  const listing = useApi<{ templates: LkTemplateListing[]; note: string }>('/api/lk-templates')
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [layoutChoice, setLayoutChoice] = useState<Record<string, 'exact' | 'fit'>>({})
  const [other, setOther] = useState('')
  const [otherType, setOtherType] = useState('npc')
  const action = useAction()
  const copy = (resource: string, pageType: string, layout: 'exact' | 'fit' = 'exact') =>
    action.run(async () => {
      const result = await api.post<{ recipe: Recipe | null }>('/api/templates/copy', { resource, pageType, createRecipe: makeRecipe, layoutRules: LAYOUT_PRESETS[layout] })
      await onDone(result.recipe)
    })
  const typeSelect = (value: string, onChange: (v: string) => void, id: string) => (
    <select id={id} aria-label="Page type" value={value} onChange={(e) => onChange(e.target.value)}>
      {pageTypes.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  )
  return (
    <div className="confirm-box" style={{ marginBottom: '1rem' }}>
      <p>
        Pick a LegendKeeper template and the kind of page it is for. The app reads its layout (this only reads from LegendKeeper) and saves it here as a local template.
        Pages made with it are created as copies of the template in LegendKeeper, so they keep its sidebar, icon, banner, other tabs and built-in boxes; the app fills
        the first page tab.
      </p>
      <p>
        Choose how new pages follow each template: <strong>exactly as the template</strong> (every field and section stays, blank when there is nothing for it,
        and nothing is added) or <strong>fitted to each page</strong> (empty fields and sections are removed, and fields the template lacks are added in line, in
        statblock order). You can change this later on the template, field by field.
      </p>
      <label className="check">
        <input type="checkbox" checked={makeRecipe} onChange={(e) => setMakeRecipe(e.target.checked)} />
        <span>Also make a recipe for it (named after the template, with creation after approval switched on)</span>
      </label>
      <ErrorBox error={listing.error ?? action.error} />
      {listing.loading && <Loading label="Looking for templates in LegendKeeper…" />}
      {listing.data && listing.data.templates.length === 0 && <Empty title="No templates found">You can still use any page as an example, below.</Empty>}
      {listing.data && listing.data.templates.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>LegendKeeper template</th>
                <th>For page type</th>
                <th>New pages</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {listing.data.templates.map((item) => {
                const pageType = choice[item.id] ?? guessPageType(item.name)
                // Statblocks usually fit the creature; other templates are usually kept exactly as they are.
                const layout = layoutChoice[item.id] ?? (pageType === 'creature' ? 'fit' : 'exact')
                return (
                  <tr key={item.id}>
                    <td>
                      {item.name}
                      <div className="small muted">
                        <code>{item.id}</code>
                        {item.parentTemplate && <> · inside “{item.parentTemplate.name}”</>} · {item.documents.length} tab{item.documents.length === 1 ? '' : 's'} ({[...new Set(item.documents.map((d) => d.type))].join(', ')})
                        {item.tags.length > 0 && <> · tags {item.tags.join(', ')}</>} · updated {formatDate(item.updatedAt)}
                      </div>
                    </td>
                    <td>{typeSelect(pageType, (v) => setChoice({ ...choice, [item.id]: v }), `pt-${item.id}`)}</td>
                    <td>
                      <select aria-label="How new pages follow the template" value={layout} onChange={(e) => setLayoutChoice({ ...layoutChoice, [item.id]: e.target.value as 'exact' | 'fit' })}>
                        <option value="exact">Exactly as the template</option>
                        <option value="fit">Fitted to each page</option>
                      </select>
                    </td>
                    <td>
                      <Button variant="primary" busy={action.busy} onClick={() => void copy(item.id, pageType, layout)}>
                        Copy layout
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {listing.data && <p className="small muted">{listing.data.note}</p>}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="copy-other">Or use a page as an example (page id or link)</label>
          <input id="copy-other" type="text" value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. m391dcf44f359b15421b7216" />
        </div>
        <div className="field">{typeSelect(otherType, setOtherType, 'copy-other-type')}</div>
        <div className="field">
          <Button busy={action.busy} disabled={!other.trim()} onClick={() => void copy(other.trim(), otherType)}>
            Copy layout
          </Button>
        </div>
      </div>
    </div>
  )
}

interface SavePreview {
  approvalToken: string
  expiresAt: string
  project: { id: string; name: string }
  page: { id: string; name: string; tabs: { name: string; type: string }[]; sidebarProperties: number; tags: string[] }
  name: string
  includeChildren: boolean
  descendants: number
  plannedTemplateId: string
  fingerprint: string
  warnings: string[]
}

/** Saves a LegendKeeper page as a new LegendKeeper template: preview, explicit approval, read-back. */
function SaveAsLkTemplate({ onClose }: { onClose: () => void }) {
  const [resource, setResource] = useState('')
  const [name, setName] = useState('')
  const [includeChildren, setIncludeChildren] = useState(false)
  const [preview, setPreview] = useState<SavePreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState<{ status: string; message?: string; template?: { id: string; name: string; tabs: number }; mismatches?: string[] } | null>(null)
  const prepare = useAction()
  const approve = useAction()
  return (
    <div className="confirm-box stack" style={{ marginBottom: '1rem' }}>
      <p>
        Copies a page of your wiki into a new LegendKeeper template, with its sidebar properties, tabs and content. The page itself does not change. LegendKeeper allows this only for
        project admins, so it needs an API key with the Admin role. You will see a final preview first.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="sat-res">Page (id or link)</label>
          <input id="sat-res" type="text" value={resource} onChange={(e) => setResource(e.target.value)} placeholder="e.g. l1ylm24t" />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="sat-name">
            Template name <span className="hint">(optional; default: the page name + “Template”)</span>
          </label>
          <input id="sat-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
        <span>Also copy the pages under it (at most 99), keeping their tree</span>
      </label>
      <div className="row">
        <Button
          variant="primary"
          busy={prepare.busy}
          disabled={!resource.trim()}
          onClick={() =>
            prepare.run(async () => {
              setResult(null)
              setConfirmed(false)
              setPreview(await api.post<SavePreview>('/api/lk-templates/save', { action: 'prepare', resource: resource.trim(), name: name.trim() || undefined, includeChildren }))
            })
          }
        >
          Open final preview
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <ErrorBox error={prepare.error} title="The preview could not be prepared" />
      {preview && (
        <div className="stack">
          <KeyValue
            rows={[
              ['Project', `${preview.project.name} (${preview.project.id})`],
              ['Page to copy', `${preview.page.name} (${preview.page.id}) — ${preview.page.tabs.length} tab${preview.page.tabs.length === 1 ? '' : 's'}, ${preview.page.sidebarProperties} sidebar propert${preview.page.sidebarProperties === 1 ? 'y' : 'ies'}`],
              ['New template', <strong key="n">{preview.name}</strong>],
              ['Pages under it', preview.includeChildren ? `${preview.descendants} copied with it` : 'not copied'],
              ['New template ID', <code key="i">{preview.plannedTemplateId}</code>],
              ['Approval expires', formatDate(preview.expiresAt)],
            ]}
          />
          {preview.warnings.length > 0 && (
            <Notice tone="warning">
              <ul>
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              Create the template “{preview.name}” in <strong>{preview.project.name}</strong>.
            </span>
          </label>
          <div className="row">
            <Button
              variant="primary"
              busy={approve.busy}
              disabled={!confirmed}
              onClick={() =>
                approve.run(async () => {
                  setResult(await api.post('/api/lk-templates/save', { action: 'approve', approvalToken: preview.approvalToken, confirm: true }))
                  setPreview(null)
                })
              }
            >
              Save as template
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
          <ErrorBox error={approve.error} title="The template was not saved" />
        </div>
      )}
      {result?.status === 'created' && result.template && (
        <Notice tone="success">
          Saved the template “{result.template.name}” (<code>{result.template.id}</code>) in LegendKeeper. Use <strong>Copy from LegendKeeper</strong> to make pages with it.
          {result.mismatches && result.mismatches.length > 0 && <> Reading it back showed: {result.mismatches.join('; ')}.</>}
        </Notice>
      )}
      {result && result.status !== 'created' && result.message && <Notice tone={result.status === 'uncertain' ? 'warning' : 'error'}>{result.message}</Notice>}
    </div>
  )
}

function LayoutDetails({ report, blocks }: { report: LayoutReport; blocks: unknown[] }) {
  const [showPreview, setShowPreview] = useState(false)
  return (
    <div className="confirm-box" style={{ marginTop: '0.5rem' }}>
      <strong>Infobox rows</strong>
      <ul>
        {report.rows.map((row, i) => (
          <li key={i}>
            {row.key || '(no label)'} → {row.fields.length ? row.fields.join(' + ') : <span className="muted">no matching field (left out)</span>}
          </li>
        ))}
      </ul>
      <strong>Text blocks</strong> (filled with the section of the same name; left out when the source has nothing for them):{' '}
      {report.sections.length ? report.sections.join(' · ') : 'none'}
      <p className="small">
        {report.hasDescriptionArea
          ? 'The description and other lore go where the template has its placeholder text.'
          : 'The template has no placeholder text, so the description and other lore go at the end.'}{' '}
        Rows the source has no value for are left out. Sections without a matching text block are added as new text blocks. Fields without a row ({report.fieldsWithoutRow.join(', ') || 'none'}) are added to the first or last group
        when the source has them. Template text itself is never copied.
      </p>
      {report.droppedParts.length > 0 && (
        <p className="small">
          Not in the copied layout: {report.droppedParts.join(', ')}. The API cannot write these built-in boxes. Pages created from the LegendKeeper template itself keep them; plain
          pages do not, but their tags and aliases are still saved.
        </p>
      )}
      <button type="button" className="link-button" onClick={() => setShowPreview(!showPreview)}>
        {showPreview ? 'Hide the copied layout' : 'Show the copied layout'}
      </button>
      {showPreview && <LkBlocksPreview blocks={blocks} />}
    </div>
  )
}
