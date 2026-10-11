import 'server-only'
import { mapAiOutputToDraft } from '@/core/ai-output'
import type { DraftBuildResult, DraftContext } from '@/core/draft-common'
import { newAppId } from '@/core/ids'
import { resolveReferences } from '@/core/references'
import { resolvePageType, resolveTemplate } from '@/core/resolve'
import { buildStructuralDraft } from '@/core/structural'
import { suggestTags } from '@/core/tagging'
import type { AppContext } from '../context'
import { AiError } from '../ai/provider'
import { recordAudit } from './audit'
import { draftView, referenceIndex, validateWithRender } from './drafts'
import { ServiceError } from './errors'
import { existingTags } from './tags'

export type TransformMode = 'ai' | 'structural'

/**
 * Turns an import job's source into a draft.
 *
 * Stage A — interpret: the AI (or the structural transformer) produces structured data.
 * Stage B — check and propose: the app validates that data, matches tags against existing
 * tags, resolves links against known pages, renders a preview, and stores a draft.
 *
 * Nothing is written to LegendKeeper here. A finished transformation only produces a draft.
 */
export async function runTransform(ctx: AppContext, jobId: string, options: { mode: TransformMode; recipeId?: string | null; templateId?: string | null }) {
  const job = ctx.repos.jobs.get(jobId)
  if (!job) throw new ServiceError(404, 'Import job not found.')
  if (job.status === 'cancelled' || job.status === 'completed') throw new ServiceError(409, `This import is ${job.status}.`)
  if (job.status === 'transforming') throw new ServiceError(409, 'A transformation is already running for this import.')
  if (job.sourceText === null) throw new ServiceError(409, 'The source text for this import has been deleted. Start a new import.')
  const existingDraft = ctx.repos.drafts.getByJob(jobId)
  if (existingDraft && ['writing', 'write_uncertain', 'created'].includes(existingDraft.status)) {
    throw new ServiceError(409, 'This draft has already been written (or a write is in progress), so it cannot be regenerated.')
  }

  const recipeId = options.recipeId ?? job.recipeId
  if (!recipeId) throw new ServiceError(400, 'Choose a recipe first.')
  const recipe = ctx.repos.recipes.get(recipeId)
  if (!recipe) throw new ServiceError(400, 'The chosen recipe does not exist.')
  const pageType = resolvePageType(recipe.definition)
  if (!pageType) throw new ServiceError(400, `The recipe's page type “${recipe.definition.targetPageType}” is not defined.`)
  // A template chosen for this import replaces the recipe's (it must be for the same page type).
  let templateRecord = recipe.definition.templateId ? ctx.repos.templates.get(recipe.definition.templateId) : null
  if (options.templateId) {
    const chosen = ctx.repos.templates.get(options.templateId)
    if (!chosen) throw new ServiceError(400, 'The chosen template does not exist.')
    if (chosen.definition.pageType !== pageType.id) throw new ServiceError(400, `The template “${chosen.definition.name}” is for “${chosen.definition.pageType}” pages, but this recipe makes “${pageType.id}” pages.`)
    templateRecord = chosen
  }
  const template = resolveTemplate(pageType, templateRecord)

  const draftContext: DraftContext = {
    pageType,
    template,
    recipe: recipe.definition,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    templateId: templateRecord?.id ?? null,
    jobId,
    sourceText: job.sourceText,
    sourceJson: job.sourceJson,
    sourceTitle: job.name,
    attribution: job.attribution,
    now: ctx.now().toISOString(),
  }

  ctx.repos.jobs.update(jobId, { status: 'transforming', recipeId: recipe.id, error: null })
  const tagInfo = await existingTags(ctx)
  draftContext.existingTags = tagInfo.tags.map((t) => t.tag)
  let result: DraftBuildResult
  let model: string | null = null
  try {
    if (options.mode === 'ai') {
      const provider = ctx.ai()
      model = provider.model
      const response = await provider.transform({
        sourceText: job.sourceText,
        sourceFormat: job.sourceFormat,
        sourceName: job.sourceName ?? job.name,
        pageType,
        template,
        recipe: recipe.definition,
        existingTags: tagInfo.tags.slice(0, 300).map((t) => t.tag),
      })
      result = mapAiOutputToDraft(response.output, draftContext, {
        model: response.model,
        servedByModel: response.servedByModel,
        promptVersion: response.promptVersion,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      })
    } else {
      result = buildStructuralDraft(draftContext, job.sourceFormat)
    }
  } catch (error) {
    const message = error instanceof AiError || error instanceof ServiceError ? error.message : `Transformation failed: ${(error as Error).message}`
    ctx.repos.jobs.update(jobId, { status: existingDraft ? 'drafted' : 'failed', error: message })
    recordAudit(ctx, {
      operation: 'transform',
      outcome: 'failure',
      jobId,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      model,
      errorCode: error instanceof AiError ? error.kind : 'error',
      requestId: error instanceof AiError ? (error.details.requestId ?? null) : null,
      message,
      details: { mode: options.mode, issues: error instanceof AiError ? error.details.issues : undefined },
    })
    if (error instanceof AiError) {
      throw new ServiceError(error.kind === 'disabled' || error.kind === 'not_configured' ? 400 : 502, error.message, error.details.issues ?? [], error.kind)
    }
    throw error
  }

  // Stage B: tags, links, validation.
  const page = result.page
  page.tags = suggestTags(result.tagCandidates, tagInfo.tags, recipe.definition.tagPolicy)
  if (tagInfo.source === 'none') {
    page.reviewerNotes.push('No existing tags were available (no ADMIN key and no project scan yet), so every suggested tag is treated as new.')
  }
  const index = referenceIndex(ctx)
  const scanned =
    recipe.definition.linkPolicy.mode === 'suggest' && recipe.definition.linkPolicy.scanForKnownNames && index
      ? index.scanText(job.sourceText, [page.name], { excludeTags: recipe.definition.linkPolicy.scanExcludeTags }).map((mention) => ({ mention, relation: null, origin: 'index_scan' as const }))
      : []
  page.references = resolveReferences([...result.mentions, ...scanned], index, recipe.definition.linkPolicy, page.name)

  const { findings } = validateWithRender(ctx, page, recipe.definition, job)
  const draft = ctx.repos.drafts.upsertContent({
    id: newAppId('drf'),
    jobId,
    page,
    findings,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    reason: options.mode === 'ai' ? `AI transformation (${page.processing?.model ?? 'unknown model'})` : 'Structural transformation',
  })
  ctx.repos.jobs.update(jobId, { status: 'drafted', error: null })
  recordAudit(ctx, {
    operation: 'transform',
    outcome: 'success',
    jobId,
    draftId: draft.id,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    model: page.processing?.servedByModel ?? page.processing?.model ?? null,
    message: `Draft “${page.name}” (${options.mode})`,
    details: {
      mode: options.mode,
      promptVersion: page.processing?.promptVersion ?? null,
      inputTokens: page.processing?.inputTokens ?? null,
      outputTokens: page.processing?.outputTokens ?? null,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      references: page.references.length,
      tags: page.tags.length,
    },
  })
  return draftView(ctx, draft.id)
}
