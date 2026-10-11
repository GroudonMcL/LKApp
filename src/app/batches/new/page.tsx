'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { Button, Card, ErrorBox, Notice, useAction, useApi } from '@/components/ui'
import { api } from '@/lib/api'
import type { Recipe } from '@/core/recipe'
import type { BatchView, TemplateWithReport } from '@/lib/types'

const ACCEPT = '.txt,.md,.markdown,.json,.html,.htm,.docx,.pdf,.png,.jpg,.jpeg,.webp,.gif'

export default function NewBatchPage() {
  const router = useRouter()
  const recipes = useApi<{ recipes: Recipe[] }>('/api/recipes')
  const templates = useApi<{ templates: TemplateWithReport[] }>('/api/templates')
  const action = useAction()
  const [name, setName] = useState('')
  const [recipeId, setRecipeId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [attributionTitle, setAttributionTitle] = useState('')
  const [citation, setCitation] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [pastes, setPastes] = useState<{ name: string; text: string }[]>([])
  const [progress, setProgress] = useState<string[]>([])

  const recipe = recipes.data?.recipes.find((r) => r.id === recipeId) ?? null
  const templateOptions = useMemo(() => (recipe ? (templates.data?.templates ?? []).filter((t) => t.definition.pageType === recipe.definition.targetPageType) : []), [recipe, templates.data])

  const submit = () =>
    action.run(async () => {
      const created = await api.post<BatchView>('/api/batches', {
        name: name.trim() || files[0]?.name || 'Batch import',
        recipeId,
        templateId: templateId || null,
        attributionTitle: attributionTitle || null,
        citation: citation || null,
      })
      const id = created.batch.id
      const log: string[] = []
      for (const file of files) {
        const form = new FormData()
        form.set('file', file)
        try {
          await api.upload(`/api/batches/${id}/sources`, form)
          log.push(`✓ ${file.name}`)
        } catch (error) {
          log.push(`✗ ${file.name}: ${(error as Error).message}`)
        }
        setProgress([...log])
      }
      for (const paste of pastes.filter((p) => p.text.trim())) {
        const form = new FormData()
        form.set('text', paste.text)
        form.set('name', paste.name || 'Pasted text')
        try {
          await api.upload(`/api/batches/${id}/sources`, form)
          log.push(`✓ ${paste.name || 'Pasted text'}`)
        } catch (error) {
          log.push(`✗ ${paste.name || 'Pasted text'}: ${(error as Error).message}`)
        }
        setProgress([...log])
      }
      router.push(`/batches/${id}`)
    })

  return (
    <>
      <div className="page-header">
        <p>
          <Link href="/batches">← Batch jobs</Link>
        </p>
        <h1>New batch import</h1>
        <p>Choose a recipe and add files. Nothing is sent to LegendKeeper or to the AI at this step: the files are read on this computer.</p>
      </div>
      <Card title="1. Recipe">
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="b-name">Batch name</label>
            <input id="b-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monster Manual chapter 3" />
          </div>
          <div className="field">
            <label htmlFor="b-recipe">Recipe</label>
            <select id="b-recipe" value={recipeId} onChange={(e) => { setRecipeId(e.target.value); setTemplateId('') }}>
              <option value="">Choose a recipe…</option>
              {recipes.data?.recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.definition.name} (v{r.version}, {r.definition.targetPageType})
                </option>
              ))}
            </select>
            {recipe && (
              <div className="hint small muted">
                Splits records: {recipe.definition.extraction.mode === 'heading' ? `at level-${recipe.definition.extraction.headingLevel} headings` : recipe.definition.extraction.mode.replace('_', ' ')} (you can change this for the batch) · duplicates:{' '}
                {recipe.definition.duplicatePolicy.replace('_', ' ')} · <Link href={`/recipes/${recipe.id}`}>edit recipe</Link>
              </div>
            )}
          </div>
          {recipe && (
            <div className="field">
              <label htmlFor="b-template">Lay pages out with</label>
              <select id="b-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">The recipe’s template</option>
                {templateOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.definition.name}
                    {t.definition.lkLayout ? ' — from LegendKeeper' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="b-attr">Source title for attribution (optional)</label>
            <input id="b-attr" type="text" value={attributionTitle} onChange={(e) => setAttributionTitle(e.target.value)} placeholder="e.g. Monster Manual (2024)" />
            <label htmlFor="b-cite" style={{ marginTop: '0.5rem' }}>
              Citation prefix (optional)
            </label>
            <input id="b-cite" type="text" value={citation} onChange={(e) => setCitation(e.target.value)} placeholder="e.g. Chapter 3" />
            <div className="hint small muted">Each page also gets its file name, section and page number, as the recipe’s attribution rules say.</div>
          </div>
        </div>
      </Card>
      <Card title="2. Files and text">
        <div className="field">
          <label htmlFor="b-files">Files (.txt .md .json .html .docx .pdf, images)</label>
          <input id="b-files" type="file" multiple accept={ACCEPT} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          {files.length > 0 && (
            <ul className="small">
              {files.map((f) => (
                <li key={f.name}>
                  {f.name} — {(f.size / 1024).toFixed(1)} KB
                </li>
              ))}
            </ul>
          )}
        </div>
        <Notice>
          Text files, Word, HTML and PDFs with a text layer are read on this computer. <strong>Images and scanned PDFs</strong> can only be read by AI transcription: you can start it
          per file on the next screen, and only then is that file sent to the AI provider.
        </Notice>
        {pastes.map((paste, i) => (
          <div key={i} className="grid grid-2" style={{ marginTop: '0.5rem' }}>
            <div className="field">
              <label htmlFor={`p-name-${i}`}>Name</label>
              <input id={`p-name-${i}`} type="text" value={paste.name} onChange={(e) => setPastes(pastes.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))} />
              <Button variant="ghost" onClick={() => setPastes(pastes.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
            <div className="field">
              <label htmlFor={`p-text-${i}`}>Text</label>
              <textarea id={`p-text-${i}`} rows={6} value={paste.text} onChange={(e) => setPastes(pastes.map((p, j) => (j === i ? { ...p, text: e.target.value } : p)))} />
            </div>
          </div>
        ))}
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <Button onClick={() => setPastes([...pastes, { name: `Pasted text ${pastes.length + 1}`, text: '' }])}>Add pasted text</Button>
        </div>
      </Card>
      <ErrorBox error={action.error} />
      {progress.length > 0 && (
        <Notice>
          {progress.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </Notice>
      )}
      <div className="row">
        <Button variant="primary" busy={action.busy} disabled={!recipeId || (files.length === 0 && !pastes.some((p) => p.text.trim()))} onClick={() => void submit()}>
          Create batch and read the files
        </Button>
      </div>
    </>
  )
}
