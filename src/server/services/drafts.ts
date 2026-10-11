import 'server-only'
import { CanonicalPage, type PageReference } from '@/core/page-model'
import { ReferenceIndex, chooseReference, resolveOne } from '@/core/references'
import { recheckTags } from '@/core/tagging'
import { resolvePageType, resolveTemplate } from '@/core/resolve'
import { validateDraft, type ValidationContext } from '@/core/validation'
import type { RecipeDefinition } from '@/core/recipe'
import type { PageTypeDefinition } from '@/core/page-types'
import type { AppContext } from '../context'
import type { Draft, ImportJob } from '../db/repositories'
import { buildCreatePayload, payloadBytes, renderPageBlocks, MAX_PAYLOAD_BYTES } from '../lk/render'
import { toConnectorError } from '../lk/errors'
import { recordAudit } from './audit'
import { knownProjectId } from './connection'
import { ServiceError } from './errors'
import { existingTags } from './tags'

/** The recipe definition a draft was made with (the exact version, if still available). */
export function recipeForDraft(ctx: AppContext, draft: Pick<Draft, 'recipeId' | 'recipeVersion'>): RecipeDefinition | null {
  if (!draft.recipeId) return null
  if (draft.recipeVersion !== null) {
    const exact = ctx.repos.recipes.getVersion(draft.recipeId, draft.recipeVersion)
    if (exact) return exact
  }
  return ctx.repos.recipes.get(draft.recipeId)?.definition ?? null
}

/**
 * The template a draft is laid out with: the one chosen for the draft (at import or in
 * review), else the recipe's. A template for another page type is ignored.
 */
export function templateForDraft(ctx: AppContext, pageType: PageTypeDefinition, page: Pick<CanonicalPage, 'templateId'>, recipe: RecipeDefinition | null) {
  const chosen = page.templateId ? ctx.repos.templates.get(page.templateId) : null
  const record = chosen && chosen.definition.pageType === pageType.id ? chosen : recipe?.templateId ? ctx.repos.templates.get(recipe.templateId) : null
  return { record, template: resolveTemplate(pageType, record) }
}

/** Templates that can lay out pages of this type, for the template pickers. */
export function templateChoices(ctx: AppContext, pageTypeId: string) {
  return ctx.repos.templates
    .list()
    .filter((t) => t.definition.pageType === pageTypeId)
    .map((t) => ({ id: t.id, name: t.definition.name, origin: t.origin, fromLegendKeeper: t.definition.lkLayout !== null }))
}

export function referenceIndex(ctx: AppContext): ReferenceIndex | null {
  const projectId = knownProjectId(ctx)
  if (!projectId) return null
  const resources = ctx.repos.index.forReferences(projectId)
  return resources.length > 0 ? new ReferenceIndex(resources) : null
}

export function validationContext(ctx: AppContext, page: CanonicalPage, recipe: RecipeDefinition | null, job: ImportJob | null): ValidationContext {
  const projectId = knownProjectId(ctx)
  const indexAvailable = projectId ? ctx.repos.index.stats(projectId).total > 0 : false
  return {
    pageType: recipe ? resolvePageType(recipe) : null,
    recipe,
    sourceText: job?.sourceText ?? null,
    // A migration draft is the page itself, so that page is not a "duplicate" of it.
    sameNamePages: projectId && page.name.trim() ? ctx.repos.index.byExactName(projectId, page.name.trim()).filter((p) => p.id !== page.migration?.sourceResourceId) : [],
    parentInIndex: projectId && indexAvailable && page.parentId ? ctx.repos.index.get(projectId, page.parentId) !== null : null,
    indexAvailable,
  }
}

/** Full validation, including the checks that need the rendered content (size, block shape). */
export function validateWithRender(ctx: AppContext, page: CanonicalPage, recipe: RecipeDefinition | null, job: ImportJob | null) {
  const vctx = validationContext(ctx, page, recipe, job)
  const result = validateDraft(page, vctx)
  if (result.page && vctx.pageType) {
    try {
      const { template } = templateForDraft(ctx, vctx.pageType, result.page, recipe)
      const bytes = payloadBytes(buildCreatePayload(result.page, { pageType: vctx.pageType, template }, 'a0000000000000000000000a', 'size-check'))
      if (bytes > MAX_PAYLOAD_BYTES) {
        result.findings.push({ severity: 'error', code: 'PAYLOAD_TOO_LARGE', path: null, message: `The page is about ${Math.round(bytes / 1024)} KB, over the ~${Math.round(MAX_PAYLOAD_BYTES / 1024)} KB request limit. Split it into several pages.` })
      }
    } catch (error) {
      result.findings.push({ severity: 'error', code: 'RENDER_FAILED', path: null, message: `The draft could not be converted to LegendKeeper content: ${(error as Error).message}` })
    }
  }
  return result
}

export function getDraft(ctx: AppContext, id: string): Draft {
  const draft = ctx.repos.drafts.get(id)
  if (!draft) throw new ServiceError(404, 'Draft not found.')
  return draft
}

/** Everything the review screen needs, with fresh validation and a rendered preview. */
export function draftView(ctx: AppContext, id: string) {
  const draft = getDraft(ctx, id)
  const job = ctx.repos.jobs.get(draft.jobId)
  const recipe = recipeForDraft(ctx, draft)
  const pageType = recipe ? resolvePageType(recipe) : null
  const resolved = pageType ? templateForDraft(ctx, pageType, draft.page, recipe) : null
  const templateRecord = resolved?.record ?? null
  const template = resolved?.template ?? null
  const { findings } = validateWithRender(ctx, draft.page, recipe, job)

  let preview: { blocks: unknown[]; bytes: number } | null = null
  if (pageType && template) {
    try {
      const blocks = renderPageBlocks(draft.page, { pageType, template })
      preview = { blocks, bytes: new TextEncoder().encode(JSON.stringify(blocks)).byteLength }
    } catch {
      preview = null
    }
  }
  const projectId = knownProjectId(ctx)
  const parent = projectId && draft.page.parentId ? ctx.repos.index.get(projectId, draft.page.parentId) : null

  return {
    draft: { ...draft, approvalToken: undefined },
    job,
    recipe: recipe ? { id: draft.recipeId, version: draft.recipeVersion, name: recipe.name, tagPolicy: recipe.tagPolicy, linkPolicy: recipe.linkPolicy, allowCreate: recipe.allowCreate, requiredFields: recipe.requiredFields } : null,
    pageType,
    template: template ? { ...template, id: templateRecord?.id ?? null, origin: templateRecord?.origin ?? 'default' } : null,
    templateChoices: pageType ? templateChoices(ctx, pageType.id) : [],
    parent: parent ? { id: parent.id, name: parent.name } : null,
    findings,
    preview,
    revisions: ctx.repos.drafts.revisions(draft.id),
  }
}

const EDITABLE = new Set(['draft', 'awaiting_approval', 'write_failed'])

/** Saves an edited draft. Tags are re-checked against existing tags and everything is re-validated. */
export async function saveDraft(ctx: AppContext, id: string, input: unknown, expectedRevision: number) {
  const draft = getDraft(ctx, id)
  if (!EDITABLE.has(draft.status)) throw new ServiceError(409, `A draft in status “${draft.status}” cannot be edited.`)
  const parsed = CanonicalPage.safeParse(input)
  if (!parsed.success) {
    throw new ServiceError(400, 'The draft is not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  }
  const recipe = recipeForDraft(ctx, draft)
  const page = { ...parsed.data, processing: draft.page.processing, sources: parsed.data.sources.length ? parsed.data.sources : draft.page.sources }
  if (recipe) {
    const { tags } = await existingTags(ctx)
    page.tags = recheckTags(page.tags, tags, recipe.tagPolicy)
  }
  // A resolved reference must keep pointing at one of its LegendKeeper-sourced candidates.
  // Candidates only ever come from the server (index or a confirmed lookup), never from the
  // browser, so an edited draft cannot smuggle in an unverified resource ID.
  page.references = page.references.map((ref) => {
    const before = draft.page.references.find((r) => r.id === ref.id)
    if (!before) return { ...ref, candidates: [], status: ref.status === 'resolved' ? 'unresolved' : ref.status, resourceId: ref.status === 'resolved' ? null : ref.resourceId, verifiedAt: null }
    return { ...ref, candidates: before.candidates, verifiedAt: ref.resourceId === before.resourceId ? before.verifiedAt : null }
  })
  const job = ctx.repos.jobs.get(draft.jobId)
  const { findings } = validateWithRender(ctx, page, recipe, job)
  const saved = ctx.repos.drafts.saveEdit(id, page, findings, expectedRevision)
  if (saved === 'conflict') throw new ServiceError(409, 'The draft was saved elsewhere since you loaded it. Reload to see the latest version.')
  if (!saved) throw new ServiceError(404, 'Draft not found.')
  recordAudit(ctx, { operation: 'draft.save', outcome: 'success', draftId: id, jobId: draft.jobId, details: { revision: saved.revision } })
  return draftView(ctx, id)
}

export function revalidate(ctx: AppContext, id: string) {
  const draft = getDraft(ctx, id)
  const recipe = recipeForDraft(ctx, draft)
  const { findings } = validateWithRender(ctx, draft.page, recipe, ctx.repos.jobs.get(draft.jobId))
  ctx.repos.drafts.setFindings(id, findings)
  return draftView(ctx, id)
}

function updateReference(ctx: AppContext, draft: Draft, refId: string, update: (ref: PageReference) => PageReference) {
  if (!EDITABLE.has(draft.status)) throw new ServiceError(409, `A draft in status “${draft.status}” cannot be edited.`)
  const index = draft.page.references.findIndex((ref) => ref.id === refId)
  if (index === -1) throw new ServiceError(404, 'Reference not found.')
  const page = structuredClone(draft.page)
  page.references[index] = update(page.references[index]!)
  const recipe = recipeForDraft(ctx, draft)
  const { findings } = validateWithRender(ctx, page, recipe, ctx.repos.jobs.get(draft.jobId))
  const saved = ctx.repos.drafts.saveEdit(draft.id, page, findings, draft.revision)
  if (saved === 'conflict') throw new ServiceError(409, 'The draft changed; reload and try again.')
  return draftView(ctx, draft.id)
}

/** Picks one of a reference's candidates, or leaves it unresolved (`resourceId: null`). */
export function chooseReferenceTarget(ctx: AppContext, draftId: string, refId: string, resourceId: string | null) {
  const draft = getDraft(ctx, draftId)
  return updateReference(ctx, draft, refId, (ref) => {
    try {
      return chooseReference(ref, resourceId)
    } catch (error) {
      throw new ServiceError(400, (error as Error).message)
    }
  })
}

/**
 * Adds a page found by live search as a candidate and selects it. The ID is confirmed with
 * LegendKeeper (`resources.get`) first, so an invented or mistyped ID can never be linked.
 */
export async function linkReferenceToResource(ctx: AppContext, draftId: string, refId: string, resourceId: string) {
  const draft = getDraft(ctx, draftId)
  let resource
  try {
    resource = await ctx.connector().getResource(resourceId)
  } catch (error) {
    const failure = toConnectorError(error)
    throw new ServiceError(failure.kind === 'not_found' ? 404 : 502, `Could not confirm that page in LegendKeeper: ${failure.message}`)
  }
  return updateReference(ctx, draft, refId, (ref) => {
    const candidates = ref.candidates.some((c) => c.resourceId === resource.id)
      ? ref.candidates
      : [...ref.candidates, { resourceId: resource.id, name: resource.name, matchType: 'search' as const, path: null }]
    return { ...ref, candidates, status: 'resolved', resourceId: resource.id, resolvedBy: 'user', verifiedAt: ctx.now().toISOString() }
  })
}

/** Adds a reference the AI or scan did not find. It is matched against the index like any other. */
export function addReference(ctx: AppContext, draftId: string, mention: string, relation: string | null) {
  const draft = getDraft(ctx, draftId)
  if (!EDITABLE.has(draft.status)) throw new ServiceError(409, `A draft in status “${draft.status}” cannot be edited.`)
  const text = mention.trim()
  if (!text) throw new ServiceError(400, 'Enter the name as it appears in the text.')
  if (draft.page.references.some((ref) => ref.mention === text)) throw new ServiceError(409, 'That reference already exists.')
  const recipe = recipeForDraft(ctx, draft)
  const policy = recipe?.linkPolicy ?? { mode: 'suggest' as const, autoSelectExactMatch: true, scanForKnownNames: true, scanExcludeTags: [] }
  const page = structuredClone(draft.page)
  const nextId = `ref_${Date.now().toString(36)}`
  page.references.push(resolveOne(nextId, { mention: text, relation, origin: 'user' }, referenceIndex(ctx), policy))
  const { findings } = validateWithRender(ctx, page, recipe, ctx.repos.jobs.get(draft.jobId))
  const saved = ctx.repos.drafts.saveEdit(draft.id, page, findings, draft.revision)
  if (saved === 'conflict') throw new ServiceError(409, 'The draft changed; reload and try again.')
  return draftView(ctx, draft.id)
}
