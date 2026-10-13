'use client'

import Link from 'next/link'
import { use, useEffect, useState } from 'react'
import { Badge, Button, Card, ErrorBox, KeyValue, Loading, Notice, formatDate, statusTone, useAction, useApi } from '@/components/ui'
import { DraftReview } from '@/components/draft-review'
import { api } from '@/lib/api'
import type { DraftView, JobDetail, TemplateWithReport } from '@/lib/types'
import type { Recipe } from '@/core/recipe'

export default function ImportJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params)
  const jobState = useApi<{ job: JobDetail; draftId: string | null }>(`/api/imports/${encodeURIComponent(jobId)}`)
  const recipes = useApi<{ recipes: Recipe[] }>('/api/recipes')
  const templates = useApi<{ templates: TemplateWithReport[] }>('/api/templates')
  const [templateId, setTemplateId] = useState<string>('')
  const [draft, setDraft] = useState<DraftView | null>(null)
  const draftLoad = useAction()
  const transform = useAction()
  const cancel = useAction()
  const [recipeId, setRecipeId] = useState<string>('')
  const job = jobState.data?.job
  const draftId = jobState.data?.draftId ?? null

  useEffect(() => {
    if (job && !recipeId) setRecipeId(job.recipeId ?? '')
  }, [job, recipeId])

  useEffect(() => {
    if (draftId) void draftLoad.run(async () => setDraft(await api.get<DraftView>(`/api/drafts/${draftId}`)))
  }, [draftId])

  const runTransform = (mode: 'ai' | 'structural') =>
    transform.run(async () => {
      if (draft && !confirm('Re-running replaces the current draft content (the previous version is kept in the draft history). Continue?')) return
      const view = await api.post<DraftView>(`/api/imports/${jobId}/transform`, { mode, recipeId: recipeId || null, templateId: templateId || null })
      const withBlockers = await api.get<DraftView>(`/api/drafts/${view.draft.id}`)
      setDraft(withBlockers)
      await jobState.reload()
    })

  if (jobState.error) return <ErrorBox error={jobState.error} />
  if (!job) return <Loading />

  const recipe = recipes.data?.recipes.find((r) => r.id === recipeId) ?? null
  const recipeTemplate = recipe?.definition.templateId ? templates.data?.templates.find((t) => t.id === recipe.definition.templateId) : null
  const templateOptions = recipe ? (templates.data?.templates ?? []).filter((t) => t.definition.pageType === recipe.definition.targetPageType && t.id !== recipe.definition.templateId) : []

  const closed = job.status === 'cancelled' || job.status === 'completed'
  const locked = draft ? ['writing', 'write_uncertain', 'write_incomplete', 'created'].includes(draft.draft.status) : false

  return (
    <>
      <div className="page-header">
        <p>
          {job.batchId ? <Link href={`/batches/${job.batchId}`}>← Back to the batch</Link> : <Link href="/import">← Import</Link>}
          {job.recordMeta && (
            <span className="small muted">
              {' '}
              · record {job.recordMeta.index + 1} of {job.recordMeta.fileName ?? job.recordMeta.documentTitle ?? 'the source'}
              {job.recordMeta.section ? ` · ${job.recordMeta.section}` : ''}
              {job.recordMeta.page ? ` · p. ${job.recordMeta.page}` : ''}
            </span>
          )}
        </p>
        <h1>{job.name}</h1>
        <p>
          <Badge tone={statusTone(job.status)}>{job.status}</Badge> {draft && <Badge tone={statusTone(draft.draft.status)}>draft: {draft.draft.status}</Badge>}
        </p>
      </div>

      <Card title="Source">
        <KeyValue
          rows={[
            ['Source', `${job.sourceName ?? 'Pasted text'} (${job.sourceKind}, ${job.sourceFormat}, ${(job.sourceSize / 1024).toFixed(1)} KB)`],
            ['Attribution', `${job.attribution.title}${job.attribution.citation ? ` — ${job.attribution.citation}` : ''}`],
            ['SHA-256', <code key="h" className="small">{job.sourceSha256.slice(0, 16)}…</code>],
            ['Created', formatDate(job.createdAt)],
            ['Likely page type (hint)', job.pageTypeGuesses.length ? job.pageTypeGuesses.map((g) => `${g.pageType} (${g.matched.slice(0, 4).join(', ')})`).join(' · ') : 'no strong hint'],
          ]}
        />
        {job.warnings.map((warning, i) => (
          <Notice key={i} tone="warning">
            {warning}
          </Notice>
        ))}
        {job.error && <Notice tone="error">{job.error}</Notice>}
        {job.sourcePurgedAt && <p className="muted small">The source text was deleted on {formatDate(job.sourcePurgedAt)} (the import is {job.status}).</p>}
      </Card>

      {!closed && !locked && (
        <Card title={draft ? 'Re-run transformation' : 'Transform into a draft'}>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="recipe">Recipe</label>
              <select
                id="recipe"
                value={recipeId}
                onChange={(e) => {
                  setRecipeId(e.target.value)
                  setTemplateId('')
                }}
              >
                <option value="">Choose a recipe…</option>
                {recipes.data?.recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.definition.name} (v{r.version}, {r.definition.targetPageType})
                  </option>
                ))}
              </select>
              <div className="hint small muted">
                <Link href="/recipes">Manage recipes</Link>
              </div>
              {recipe && (
                <>
                  <label htmlFor="template" style={{ marginTop: '0.75rem' }}>
                    Lay the page out with
                  </label>
                  <select id="template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">{recipeTemplate ? `${recipeTemplate.definition.name} (the recipe’s template)` : 'The recipe’s default layout'}</option>
                    {templateOptions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.definition.name}
                        {t.definition.lkLayout ? ' — from LegendKeeper' : t.origin === 'example' ? ' — example' : ''}
                      </option>
                    ))}
                  </select>
                  <div className="hint small muted">You can also change the layout later, while reviewing the draft.</div>
                </>
              )}
            </div>
            <div>
              <p className="small">
                <strong>AI transformation</strong> sends the source text, the recipe’s instructions and field list, and your existing tag names to the configured AI provider. It
                returns a draft only — nothing is written.
              </p>
              <p className="small">
                <strong>Structural</strong> uses no AI: Markdown headings become sections, “Label: value” lines and JSON mappings fill fields verbatim.
              </p>
            </div>
          </div>
          <div className="row">
            <Button variant="primary" busy={transform.busy} disabled={!recipeId || job.sourceText === null} onClick={() => runTransform('ai')}>
              Run AI transformation
            </Button>
            <Button busy={transform.busy} disabled={!recipeId || job.sourceText === null} onClick={() => runTransform('structural')}>
              Run structural (no AI)
            </Button>
            <span className="spacer" />
            <Button
              variant="danger"
              busy={cancel.busy}
              onClick={() => {
                if (confirm('Cancel this import? The stored source text is deleted. Nothing in LegendKeeper is affected.'))
                  void cancel.run(async () => {
                    await api.post(`/api/imports/${jobId}/cancel`)
                    await jobState.reload()
                    if (draftId) setDraft(await api.get<DraftView>(`/api/drafts/${draftId}`))
                  })
              }}
            >
              Cancel import
            </Button>
          </div>
          {transform.busy && <Loading label="Transforming… AI transformations of long sources can take a minute or two." />}
          <ErrorBox error={transform.error} title="Transformation failed" />
          <ErrorBox error={cancel.error} />
        </Card>
      )}

      <ErrorBox error={draftLoad.error} />
      {draftId && !draft && draftLoad.busy && <Loading label="Loading draft…" />}
      {draft && <DraftReview view={draft} sourceText={job.sourceText} onChange={setDraft} />}
    </>
  )
}
