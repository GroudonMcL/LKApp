'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { use, useEffect, useState } from 'react'
import { Badge, Button, Card, ErrorBox, Loading, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { Recipe, RecipeDefinitionInput } from '@/core/recipe'
import type { PageTemplate } from '@/core/template'
import type { FieldDefinition, PageTypeDefinition } from '@/core/page-types'

const BLANK: RecipeDefinitionInput = {
  name: 'New recipe',
  description: '',
  sourceFormat: 'any',
  targetPageType: 'npc',
  templateId: null,
  requiredFields: [],
  fieldMappings: [],
  tagPolicy: { mode: 'existing_only', alwaysAdd: [], includePageTypeTag: true, maxSuggestions: 6, guidance: '' },
  linkPolicy: { mode: 'suggest', autoSelectExactMatch: true, scanForKnownNames: true, scanExcludeTags: [] },
  aiInstructions: '',
  freeTextInstructions: '',
  missingInfoRules: '',
  allowCreate: false,
  defaultParentId: null,
}

export default function RecipeEditorPage({ params }: { params: Promise<{ recipeId: string }> }) {
  const { recipeId } = use(params)
  const isNew = recipeId === 'new'
  const router = useRouter()
  const existing = useApi<Recipe>(isNew ? null : `/api/recipes/${encodeURIComponent(recipeId)}`)
  const types = useApi<{ pageTypes: PageTypeDefinition[] }>('/api/page-types')
  const templates = useApi<{ templates: PageTemplate[] }>('/api/templates')
  const [definition, setDefinition] = useState<RecipeDefinitionInput | null>(isNew ? BLANK : null)
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const save = useAction()
  const archive = useAction()

  useEffect(() => {
    if (existing.data) setDefinition(existing.data.definition)
  }, [existing.data])

  if (existing.error) return <ErrorBox error={existing.error} />
  if (!definition) return <Loading />

  const set = (patch: Partial<RecipeDefinitionInput>) => setDefinition({ ...definition, ...patch })
  const custom = definition.customPageType ?? null
  const allTypes = [...(types.data?.pageTypes ?? []).filter((t) => t.id !== custom?.id), ...(custom ? [custom as PageTypeDefinition] : [])]
  const pageType = allTypes.find((t) => t.id === definition.targetPageType)
  const fields: FieldDefinition[] = [...(pageType?.fields ?? []), ...((definition.extraFields ?? []) as FieldDefinition[])]
  const matchingTemplates = (templates.data?.templates ?? []).filter((t) => t.definition.pageType === definition.targetPageType)

  const submit = () =>
    save.run(async () => {
      let body = definition
      if (jsonMode) {
        try {
          body = JSON.parse(jsonText) as RecipeDefinitionInput
        } catch (error) {
          setJsonError((error as Error).message)
          return
        }
      }
      if (isNew) {
        const created = await api.post<Recipe>('/api/recipes', body)
        router.push(`/recipes/${created.id}`)
      } else {
        const updated = await api.put<Recipe>(`/api/recipes/${recipeId}`, { definition: body, expectedVersion: existing.data!.version })
        existing.setData(updated)
        setDefinition(updated.definition)
        setJsonMode(false)
      }
    })

  return (
    <>
      <div className="page-header">
        <p>
          <Link href="/recipes">← Recipes</Link>
        </p>
        <h1>{isNew ? 'New recipe' : definition.name}</h1>
        {!isNew && existing.data && <p>Version {existing.data.version}. Saving creates version {existing.data.version + 1}; earlier versions are kept so past drafts stay explainable.</p>}
      </div>

      <div className="row" style={{ marginBottom: '1rem' }}>
        <Button variant="primary" busy={save.busy} onClick={submit}>
          Save recipe
        </Button>
        <Button
          onClick={() => {
            if (!jsonMode) setJsonText(JSON.stringify(definition, null, 2))
            else {
              try {
                setDefinition(JSON.parse(jsonText) as RecipeDefinitionInput)
              } catch (error) {
                setJsonError((error as Error).message)
                return
              }
            }
            setJsonError(null)
            setJsonMode(!jsonMode)
          }}
        >
          {jsonMode ? 'Back to form' : 'Edit as JSON'}
        </Button>
        <span className="spacer" />
        {!isNew && (
          <Button
            variant="danger"
            busy={archive.busy}
            onClick={() => {
              if (confirm('Archive this recipe? Existing drafts keep the version they used.')) void archive.run(async () => { await api.del(`/api/recipes/${recipeId}`); router.push('/recipes') })
            }}
          >
            Archive
          </Button>
        )}
      </div>
      <ErrorBox error={save.error} title="The recipe could not be saved" />
      <ErrorBox error={archive.error} />

      {jsonMode ? (
        <Card title="Recipe JSON">
          {jsonError && <Notice tone="error">Not valid JSON: {jsonError}</Notice>}
          <textarea className="mono" rows={30} value={jsonText} onChange={(e) => setJsonText(e.target.value)} aria-label="Recipe JSON" />
        </Card>
      ) : (
        <>
          <Card title="Basics">
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="r-name">Name</label>
                <input id="r-name" type="text" value={definition.name} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="r-format">Source format</label>
                <select id="r-format" value={definition.sourceFormat ?? 'any'} onChange={(e) => set({ sourceFormat: e.target.value as RecipeDefinitionInput['sourceFormat'] })}>
                  <option value="any">Any</option>
                  <option value="text">Plain text</option>
                  <option value="markdown">Markdown</option>
                  <option value="json">JSON</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="r-desc">Description</label>
                <textarea id="r-desc" rows={2} value={definition.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="r-type">Target page type</label>
                <select id="r-type" value={definition.targetPageType} onChange={(e) => set({ targetPageType: e.target.value, templateId: null, requiredFields: [], fieldMappings: [] })}>
                  {allTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                      {t.builtIn ? '' : ' (custom)'}
                    </option>
                  ))}
                </select>
                {pageType && <div className="small muted">{pageType.description}</div>}
              </div>
              <div className="field">
                <label htmlFor="r-template">Template</label>
                <select id="r-template" value={definition.templateId ?? ''} onChange={(e) => set({ templateId: e.target.value || null })}>
                  <option value="">Page type default</option>
                  {matchingTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.definition.name} ({t.origin === 'example' ? 'example' : 'local'})
                    </option>
                  ))}
                </select>
                <div className="small muted">Templates are configured locally — LegendKeeper templates cannot be read through the API.</div>
              </div>
              <div className="field">
                <label htmlFor="r-parent">
                  Default parent page ID <span className="hint">(optional)</span>
                </label>
                <input id="r-parent" type="text" value={definition.defaultParentId ?? ''} onChange={(e) => set({ defaultParentId: e.target.value.trim() || null })} />
              </div>
            </div>
          </Card>

          <Card title="Fields">
            <p className="small muted">Tick fields that must have a confirmed value before a page can be created. For JSON sources, a path such as <code>stats.ac</code> copies that value verbatim, without AI.</p>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Group</th>
                  <th>Required</th>
                  <th>JSON path</th>
                  <th>Hint for the AI</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => {
                  const mapping = (definition.fieldMappings ?? []).find((m) => m.fieldKey === field.key)
                  const setMapping = (patch: { sourcePath?: string | null; hint?: string | null }) => {
                    const others = (definition.fieldMappings ?? []).filter((m) => m.fieldKey !== field.key)
                    const next = { fieldKey: field.key, sourcePath: mapping?.sourcePath ?? null, hint: mapping?.hint ?? null, ...patch }
                    set({ fieldMappings: next.sourcePath || next.hint ? [...others, next] : others })
                  }
                  return (
                    <tr key={field.key}>
                      <td>
                        {field.label} <code className="small muted">{field.key}</code>
                      </td>
                      <td>
                        <Badge>{field.group}</Badge>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${field.label} required`}
                          checked={(definition.requiredFields ?? []).includes(field.key)}
                          onChange={(e) => set({ requiredFields: e.target.checked ? [...(definition.requiredFields ?? []), field.key] : (definition.requiredFields ?? []).filter((k) => k !== field.key) })}
                        />
                      </td>
                      <td>
                        <input type="text" aria-label={`${field.label} JSON path`} value={mapping?.sourcePath ?? ''} onChange={(e) => setMapping({ sourcePath: e.target.value || null })} />
                      </td>
                      <td>
                        <input type="text" aria-label={`${field.label} hint`} value={mapping?.hint ?? ''} onChange={(e) => setMapping({ hint: e.target.value || null })} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="small muted">Need different fields? Use “Edit as JSON” to add <code>extraFields</code>, or define a <code>customPageType</code> (see the README).</p>
          </Card>

          <Card title="Tags and links">
            <div className="grid grid-2">
              <fieldset>
                <legend>Tag policy</legend>
                <label className="check">
                  <input type="radio" name="tagmode" checked={(definition.tagPolicy?.mode ?? 'existing_only') === 'existing_only'} onChange={() => set({ tagPolicy: { ...definition.tagPolicy, mode: 'existing_only' } })} />
                  <span>Use existing tags only</span>
                </label>
                <label className="check">
                  <input type="radio" name="tagmode" checked={definition.tagPolicy?.mode === 'allow_new'} onChange={() => set({ tagPolicy: { ...definition.tagPolicy, mode: 'allow_new' } })} />
                  <span>May suggest new tags (clearly marked as new)</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={definition.tagPolicy?.includePageTypeTag ?? true} onChange={(e) => set({ tagPolicy: { ...definition.tagPolicy, includePageTypeTag: e.target.checked } })} />
                  <span>Suggest the page type’s usual tag {pageType?.suggestedTag && <>(“{pageType.suggestedTag}”)</>}</span>
                </label>
                <div className="field">
                  <label htmlFor="r-always">Always add (comma-separated)</label>
                  <input
                    id="r-always"
                    type="text"
                    value={(definition.tagPolicy?.alwaysAdd ?? []).join(', ')}
                    onChange={(e) => set({ tagPolicy: { ...definition.tagPolicy, alwaysAdd: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) } })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="r-max">Maximum AI tag suggestions</label>
                  <input id="r-max" type="number" min={0} max={20} value={definition.tagPolicy?.maxSuggestions ?? 6} onChange={(e) => set({ tagPolicy: { ...definition.tagPolicy, maxSuggestions: Number(e.target.value) } })} />
                </div>
                <div className="field">
                  <label htmlFor="r-tagguide">Tag guidance for the AI</label>
                  <textarea id="r-tagguide" rows={2} value={definition.tagPolicy?.guidance ?? ''} onChange={(e) => set({ tagPolicy: { ...definition.tagPolicy, guidance: e.target.value } })} />
                </div>
              </fieldset>
              <fieldset>
                <legend>Link policy</legend>
                <label className="check">
                  <input type="checkbox" checked={(definition.linkPolicy?.mode ?? 'suggest') === 'suggest'} onChange={(e) => set({ linkPolicy: { ...definition.linkPolicy, mode: e.target.checked ? 'suggest' : 'off' } })} />
                  <span>Suggest links to existing pages</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={definition.linkPolicy?.autoSelectExactMatch ?? true} onChange={(e) => set({ linkPolicy: { ...definition.linkPolicy, autoSelectExactMatch: e.target.checked } })} />
                  <span>Select automatically when exactly one page has that exact name or alias</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={definition.linkPolicy?.scanForKnownNames ?? true} onChange={(e) => set({ linkPolicy: { ...definition.linkPolicy, scanForKnownNames: e.target.checked } })} />
                  <span>Also scan the source for exact names of known pages</span>
                </label>
                <div className="field">
                  <label htmlFor="r-scanexclude">
                    Never link pages with these tags in the name scan <span className="hint">(comma-separated, exact spelling — e.g. Glossary)</span>
                  </label>
                  <input
                    id="r-scanexclude"
                    type="text"
                    value={(definition.linkPolicy?.scanExcludeTags ?? []).join(', ')}
                    onChange={(e) => set({ linkPolicy: { ...definition.linkPolicy, scanExcludeTags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) } })}
                  />
                </div>
              </fieldset>
            </div>
          </Card>

          <Card title="Instructions">
            <div className="field">
              <label htmlFor="r-ai">
                Instructions for the AI <span className="hint">(structured guidance)</span>
              </label>
              <textarea id="r-ai" value={definition.aiInstructions ?? ''} onChange={(e) => set({ aiInstructions: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="r-free">
                Describe the transformation in your own words <span className="hint">(optional)</span>
              </label>
              <textarea id="r-free" value={definition.freeTextInstructions ?? ''} onChange={(e) => set({ freeTextInstructions: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="r-missing">Rules for missing or uncertain information</label>
              <textarea id="r-missing" value={definition.missingInfoRules ?? ''} onChange={(e) => set({ missingInfoRules: e.target.value })} />
            </div>
            <p className="small muted">These add detail but can never relax the built-in rules: the AI must not invent facts, statistics, dates or names, and must mark missing values as missing.</p>
          </Card>

          <Card title="Writing">
            <label className="check">
              <input type="checkbox" checked={definition.allowCreate ?? false} onChange={(e) => set({ allowCreate: e.target.checked })} />
              <span>
                <strong>Allow creation after approval.</strong> When off, drafts made with this recipe can be reviewed but never written. Even when on, every page needs your explicit
                approval in the final preview.
              </span>
            </label>
          </Card>
        </>
      )}
    </>
  )
}
