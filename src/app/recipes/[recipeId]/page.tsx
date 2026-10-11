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
  allowCreate: true,
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
        {!isNew && (
          <Button
            busy={save.busy}
            onClick={() =>
              void save.run(async () => {
                const copy = await api.post<Recipe>('/api/recipes', { ...definition, name: `${definition.name} (copy)` })
                router.push(`/recipes/${copy.id}`)
              })
            }
          >
            Duplicate
          </Button>
        )}
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
            <p className="small muted">Tick fields that must have a confirmed value before a page can be created. <strong>Also written as</strong> lists the labels already recognised (grey) and lets you add your own — e.g. if your notes say “Vitality” for Hit Points. For JSON sources, a path such as <code>stats.ac</code> copies that value verbatim, without AI.</p>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Group</th>
                  <th>Required</th>
                  <th>Also written as</th>
                  <th>JSON path</th>
                  <th>Hint for the AI</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => {
                  const mapping = (definition.fieldMappings ?? []).find((m) => m.fieldKey === field.key)
                  const setMapping = (patch: { sourcePath?: string | null; hint?: string | null; labels?: string[] }) => {
                    const others = (definition.fieldMappings ?? []).filter((m) => m.fieldKey !== field.key)
                    const next = { fieldKey: field.key, sourcePath: mapping?.sourcePath ?? null, hint: mapping?.hint ?? null, labels: mapping?.labels ?? [], ...patch }
                    set({ fieldMappings: next.sourcePath || next.hint || next.labels.length ? [...others, next] : others })
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
                        {(field.aliases ?? []).length > 0 && <div className="small muted">{(field.aliases ?? []).join(', ')}</div>}
                        <input
                          type="text"
                          aria-label={`${field.label} extra labels`}
                          placeholder="your labels, comma-separated"
                          value={(mapping?.labels ?? []).join(', ')}
                          onChange={(e) => setMapping({ labels: e.target.value.split(',').map((l) => l.trim()).filter(Boolean) })}
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

          <BatchSettings definition={definition} set={set} fields={fields} />
          <MigrationSettingsCard definition={definition} set={set} />

          <Card title="Writing">
            <label className="check">
              <input type="checkbox" checked={definition.allowCreate ?? true} onChange={(e) => set({ allowCreate: e.target.checked })} />
              <span>
                <strong>Allow creation after approval.</strong> When off, drafts made with this recipe can be reviewed but never written. Even when on, every page needs your explicit
                approval in the final preview.
              </span>
            </label>
          </Card>

          <TryRecipe definition={definition} />
        </>
      )}
    </>
  )
}

const FORMAT_OPTIONS = ['text', 'markdown', 'json', 'html', 'docx', 'pdf', 'image'] as const

function MigrationSettingsCard({ definition, set }: { definition: RecipeDefinitionInput; set: (patch: Partial<RecipeDefinitionInput>) => void }) {
  const m = { notesHeading: 'Notes from the previous layout', keptHeading: 'Kept from the previous layout', tagHandling: 'keep', linkHandling: 'keep_all', ...(definition.migration ?? {}) } as NonNullable<RecipeDefinitionInput['migration']> & { notesHeading: string; keptHeading: string; tagHandling: 'keep' | 'add_accepted'; linkHandling: 'keep_all' | 'warn' }
  const setM = (patch: Partial<typeof m>) => set({ migration: { ...m, ...patch } })
  return (
    <Card title="Template migration (existing pages)">
      <p className="small muted">
        Used when this recipe moves existing pages into its template. Text with no place in the new layout is never dropped: it goes under the heading below (or, if “Unmapped
        content” above is set to “must be moved”, the page cannot be approved until you resolve it).
      </p>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="mg-notes">Heading for text that did not fit</label>
          <input id="mg-notes" type="text" value={m.notesHeading} onChange={(e) => setM({ notesHeading: e.target.value })} />
          <label htmlFor="mg-kept">Heading for kept blocks with no matching section</label>
          <input id="mg-kept" type="text" value={m.keptHeading} onChange={(e) => setM({ keptHeading: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="mg-tags">Tags</label>
          <select id="mg-tags" value={m.tagHandling} onChange={(e) => setM({ tagHandling: e.target.value as 'keep' | 'add_accepted' })}>
            <option value="keep">Leave the page’s tags as they are</option>
            <option value="add_accepted">Add tags I accept in the draft (never removes any)</option>
          </select>
          <label htmlFor="mg-links">Links the new layout would lose</label>
          <select id="mg-links" value={m.linkHandling} onChange={(e) => setM({ linkHandling: e.target.value as 'keep_all' | 'warn' })}>
            <option value="keep_all">Add them back as a link list (recommended)</option>
            <option value="warn">Only report them</option>
          </select>
        </div>
      </div>
    </Card>
  )
}

function BatchSettings({ definition, set, fields }: { definition: RecipeDefinitionInput; set: (patch: Partial<RecipeDefinitionInput>) => void; fields: FieldDefinition[] }) {
  const extraction = { mode: 'whole', headingLevel: 2, separator: '---', jsonPath: '', jsonNamePath: 'name', jsonIdPath: 'id', minChars: 40, expectLabels: [], ...(definition.extraction ?? {}) } as NonNullable<RecipeDefinitionInput['extraction']> & { mode: string; headingLevel: number; separator: string; jsonPath: string; jsonNamePath: string; jsonIdPath: string; minChars: number; expectLabels: string[] }
  const setExtraction = (patch: Record<string, unknown>) => set({ extraction: { ...extraction, ...patch } as RecipeDefinitionInput['extraction'] })
  const attribution = { includeFile: true, includeSection: true, includePage: true, required: false, ...(definition.attribution ?? {}) }
  const accepted = (definition.acceptedFormats ?? []) as string[]
  const defaults = (definition.defaultValues ?? []) as { fieldKey: string; value: string }[]
  return (
    <Card title="Batch settings">
      <p className="small muted">Used when this recipe runs over many files or a document with many entries (Batch import). Single imports ignore the splitting rules.</p>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="b-mode">Split each file into records</label>
          <select id="b-mode" value={extraction.mode} onChange={(e) => setExtraction({ mode: e.target.value })}>
            <option value="whole">Each file is one record</option>
            <option value="heading">At headings of one level</option>
            <option value="statblock">At each statblock (name + “Size Type, Alignment” line)</option>
            <option value="separator">At separator lines</option>
            <option value="paragraph">Each blank-line paragraph</option>
            <option value="json_array">Each item of a JSON list</option>
          </select>
          {extraction.mode === 'heading' && (
            <>
              <label htmlFor="b-level">Heading level</label>
              <select id="b-level" value={extraction.headingLevel} onChange={(e) => setExtraction({ headingLevel: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {'#'.repeat(n)} (level {n})
                  </option>
                ))}
              </select>
            </>
          )}
          {extraction.mode === 'separator' && (
            <>
              <label htmlFor="b-sep">Separator line</label>
              <input id="b-sep" type="text" value={extraction.separator} onChange={(e) => setExtraction({ separator: e.target.value })} />
            </>
          )}
          {extraction.mode === 'json_array' && (
            <>
              <label htmlFor="b-jpath">Path to the list</label>
              <input id="b-jpath" type="text" value={extraction.jsonPath} onChange={(e) => setExtraction({ jsonPath: e.target.value })} placeholder="empty = the file itself" />
              <label htmlFor="b-jname">Name field</label>
              <input id="b-jname" type="text" value={extraction.jsonNamePath} onChange={(e) => setExtraction({ jsonNamePath: e.target.value })} />
              <label htmlFor="b-jid">Identifier field</label>
              <input id="b-jid" type="text" value={extraction.jsonIdPath} onChange={(e) => setExtraction({ jsonIdPath: e.target.value })} />
            </>
          )}
          <label htmlFor="b-labels">A valid record contains one of these labels (comma-separated)</label>
          <input id="b-labels" type="text" value={extraction.expectLabels.join(', ')} onChange={(e) => setExtraction({ expectLabels: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="e.g. Armor Class, AC" />
          <label htmlFor="b-min">Flag records shorter than (characters)</label>
          <input id="b-min" type="number" min={0} value={extraction.minChars} onChange={(e) => setExtraction({ minChars: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="b-dup">When a record matches an existing page</label>
          <select id="b-dup" value={definition.duplicatePolicy ?? 'require_review'} onChange={(e) => set({ duplicatePolicy: e.target.value as RecipeDefinitionInput['duplicatePolicy'] })}>
            <option value="require_review">Ask me every time (safest)</option>
            <option value="skip_exact">Skip exact, verified duplicates; ask about the rest</option>
            <option value="create_anyway">Create a new page anyway (matches are still shown)</option>
          </select>
          <div className="hint small muted">Imports never merge or overwrite existing pages.</div>
          <label>Accepted file types (none ticked = all)</label>
          <div className="row">
            {FORMAT_OPTIONS.map((format) => (
              <label key={format} className="check">
                <input
                  type="checkbox"
                  checked={accepted.includes(format)}
                  onChange={(e) => set({ acceptedFormats: (e.target.checked ? [...accepted, format] : accepted.filter((f) => f !== format)) as RecipeDefinitionInput['acceptedFormats'] })}
                />{' '}
                {format}
              </label>
            ))}
          </div>
          <label htmlFor="b-unc">Uncertain values</label>
          <select id="b-unc" value={definition.uncertainHandling ?? 'warn'} onChange={(e) => set({ uncertainHandling: e.target.value as 'warn' | 'block' })}>
            <option value="warn">Warn; leave them out of the page</option>
            <option value="block">Must be resolved before approval</option>
          </select>
          <label htmlFor="b-unm">Source text that fits nowhere</label>
          <select id="b-unm" value={definition.unmappedHandling ?? 'keep'} onChange={(e) => set({ unmappedHandling: e.target.value as 'keep' | 'block' })}>
            <option value="keep">Keep it in an “Unmapped content” section</option>
            <option value="block">Must be moved or removed before approval</option>
          </select>
        </div>
        <div className="field">
          <label>Source attribution on each page</label>
          {(
            [
              ['includeFile', 'File name'],
              ['includeSection', 'Section heading'],
              ['includePage', 'Page number (PDF)'],
              ['required', 'Require attribution (a page without a source is an error)'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="check">
              <input type="checkbox" checked={attribution[key]} onChange={(e) => set({ attribution: { ...attribution, [key]: e.target.checked } })} /> {label}
            </label>
          ))}
        </div>
        <div className="field">
          <label>Default values for empty fields</label>
          <div className="hint small muted">Written with the status “recipe default”, never as source facts. Leave empty unless every page should have the value.</div>
          {defaults.map((d, i) => (
            <div key={i} className="row">
              <select aria-label="Field" value={d.fieldKey} onChange={(e) => set({ defaultValues: defaults.map((x, j) => (j === i ? { ...x, fieldKey: e.target.value } : x)) })}>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <input aria-label="Value" type="text" value={d.value} onChange={(e) => set({ defaultValues: defaults.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              <Button variant="ghost" onClick={() => set({ defaultValues: defaults.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="ghost" disabled={fields.length === 0} onClick={() => set({ defaultValues: [...defaults, { fieldKey: fields[0]!.key, value: '' }] })}>
            Add a default value
          </Button>
        </div>
      </div>
    </Card>
  )
}

interface TryResult {
  format: string
  recordCount: number
  preamble: string[]
  records: { title: string; chars: number; flags: string[] }[]
  drafts: { title: string; section: string | null; name: string; flags: { flag: string; explanation: string }[]; fields: { label: string; value: string | null; status: string; note: string | null }[]; missing: string[]; sections: { heading: string; kind: string; paragraphs: number }[]; findings: { severity: string; message: string }[] }[]
  shown: number
}

function TryRecipe({ definition }: { definition: RecipeDefinitionInput }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<TryResult | null>(null)
  const action = useAction()
  return (
    <Card title="Try it on sample text">
      <p className="small muted">Paste a sample (for example a few statblocks). The app splits it with these settings and drafts the first records without AI. Nothing is saved or sent anywhere. Uses the settings on this screen, saved or not.</p>
      <textarea aria-label="Sample text" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <Button busy={action.busy} disabled={!text.trim()} onClick={() => void action.run(async () => setResult(await api.post<TryResult>('/api/recipes/test', { definition, text })))}>
          Try it
        </Button>
      </div>
      <ErrorBox error={action.error} />
      {result && (
        <div style={{ marginTop: '0.75rem' }}>
          <p>
            Read as {result.format}; found <strong>{result.recordCount}</strong> record(s){result.preamble.length ? ` and ${result.preamble.length} piece(s) of text outside any record (skipped)` : ''}. Showing the first {result.shown}.
          </p>
          {result.drafts.map((draft, i) => (
            <details key={i} open={i === 0} className="confirm-box" style={{ marginBottom: '0.5rem' }}>
              <summary>
                <strong>{draft.name}</strong> {draft.section && <span className="muted small">({draft.section})</span>}{' '}
                {draft.findings.filter((f) => f.severity === 'error').length > 0 && <Badge tone="bad">{draft.findings.filter((f) => f.severity === 'error').length} error(s)</Badge>}
                {draft.flags.map((f) => (
                  <Badge key={f.flag} tone="warn" title={f.explanation}>
                    {f.flag.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </summary>
              <table className="small">
                <tbody>
                  {draft.fields.map((f) => (
                    <tr key={f.label}>
                      <td>{f.label}</td>
                      <td>{f.value}</td>
                      <td>
                        <Badge tone={f.status === 'source' ? 'good' : f.status === 'default' ? 'info' : 'warn'}>{f.status}</Badge> {f.note && <span className="muted">{f.note}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {draft.missing.length > 0 && <p className="small muted">Not found: {draft.missing.join(', ')}</p>}
              <p className="small">Sections: {draft.sections.map((s) => `${s.heading} (${s.paragraphs})`).join(' · ') || 'none'}</p>
              {draft.findings.length > 0 && (
                <ul className="small">
                  {draft.findings.map((f, j) => (
                    <li key={j} className={f.severity === 'error' ? 'error-text' : undefined}>
                      {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          ))}
        </div>
      )}
    </Card>
  )
}
