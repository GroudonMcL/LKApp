'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Badge, Button, Card, Empty, ErrorBox, Loading, Notice, formatDate, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { Recipe } from '@/core/recipe'
import type { PageTemplate, TemplateDefinitionInput } from '@/core/template'
import type { PageTypeDefinition } from '@/core/page-types'

export default function RecipesPage() {
  const { data, error, loading } = useApi<{ recipes: Recipe[] }>('/api/recipes')
  return (
    <>
      <div className="page-header">
        <h1>Recipes & templates</h1>
        <p>A recipe says how to turn a kind of source into a kind of page: the page type, template, fields, tag and link rules, and instructions for the AI. Recipes are versioned; each draft remembers the exact version it used.</p>
      </div>
      <Card title="Recipes" actions={<Link className="btn btn-primary" href="/recipes/new">New recipe</Link>}>
        <ErrorBox error={error} />
        {loading && <Loading />}
        {data && data.recipes.length === 0 && <Empty title="No recipes">Create one to start importing.</Empty>}
        {data && data.recipes.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recipe</th>
                  <th>Page type</th>
                  <th>Tags</th>
                  <th>Creation</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {data.recipes.map((recipe) => (
                  <tr key={recipe.id}>
                    <td>
                      <Link href={`/recipes/${recipe.id}`}>{recipe.definition.name}</Link>
                      <div className="small muted">{recipe.definition.description}</div>
                    </td>
                    <td>{recipe.definition.targetPageType}</td>
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
        )}
      </Card>
      <Templates />
    </>
  )
}

function Templates() {
  const { data, error, loading, reload } = useApi<{ templates: PageTemplate[] }>('/api/templates')
  const types = useApi<{ pageTypes: PageTypeDefinition[] }>('/api/page-types')
  const [editing, setEditing] = useState<{ id: string | null; definition: TemplateDefinitionInput } | null>(null)
  const action = useAction()

  return (
    <Card title="Templates" actions={<Button onClick={() => setEditing({ id: null, definition: { name: 'New template', pageType: 'npc', sections: ['Description'], infoboxFields: [] } })}>New template</Button>}>
      <Notice>
        LegendKeeper’s API cannot list or apply the templates you build inside LegendKeeper, so templates here are <strong>configured locally</strong>: an ordered list of section
        headings and the fields shown in the infobox. <Badge>example</Badge> templates ship with the app and are read-only; <Badge tone="info">local</Badge> templates are yours.
      </Notice>
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
                  <td>{template.origin === 'example' ? <Badge>example</Badge> : <Badge tone="info">local</Badge>}</td>
                  <td>{template.definition.pageType}</td>
                  <td className="small">{template.definition.sections.join(' · ')}</td>
                  <td className="nowrap">
                    {template.origin === 'local' ? (
                      <>
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
            <input type="checkbox" checked={definition.includeSourcesSection ?? true} onChange={(e) => setDefinition({ ...definition, includeSourcesSection: e.target.checked })} /> Add a “Sources” section
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
