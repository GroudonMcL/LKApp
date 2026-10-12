import 'server-only'
import { z } from 'zod'
import { formatDate, parseDate } from '@/core/chronology/dates'
import { resolvePageType } from '@/core/resolve'
import type { AppContext } from '../context'
import type { KnowledgeItem } from '../db/knowledge-repositories'
import { recordAudit } from './audit'
import { calendarSettings } from './chronology'
import { ServiceError } from './errors'
import { createImport } from './imports'
import { runTransform } from './transform'

/**
 * Turns an accepted event candidate, or a missing-page candidate, into an ordinary import
 * draft with one of your recipes. From there it follows the usual path: review, final
 * preview, explicit approval, write with a pre-chosen page id, read-back. Nothing is written
 * to LegendKeeper here.
 *
 * The draft's source is a short summary the app writes from the item and its cited passages,
 * so you can see exactly what it was made from.
 */

const DraftInput = z.object({ recipeId: z.string().min(1).max(100) })

function sourceFor(ctx: AppContext, item: KnowledgeItem): { name: string; text: string } {
  const proposal = { ...item.data, ...(item.edits ?? {}) } as { title?: string; date?: string; summary?: string | null; participantIds?: string[]; name?: string; kindGuess?: string }
  const lines: string[] = []
  const projectId = item.projectId
  const nameOf = (id: string) => ctx.repos.index.get(projectId, id)?.name ?? id
  if (item.kind === 'event_candidate') {
    const title = proposal.title ?? item.title
    lines.push(`# ${title}`, '')
    if (proposal.date) {
      const reading = parseDate(proposal.date, calendarSettings(ctx), { allowBareYear: false })
      lines.push(`Date: ${proposal.date}`)
      if (reading.kind === 'approximate' || reading.kind === 'relative') lines.push(`(The date is ${reading.kind}: ${formatDate(reading)}.)`)
    }
    const participants = (proposal.participantIds ?? []).map(nameOf)
    if (participants.length) lines.push(`Participants: ${participants.join(', ')}`)
    lines.push('', proposal.summary ?? item.summary)
  } else {
    const name = proposal.title ?? proposal.name ?? item.title
    lines.push(`# ${name}`, '', proposal.summary ?? item.summary)
  }
  lines.push('', '## Sources', '')
  for (const c of item.evidence) lines.push(`- ${c.resourceName}${c.field ? ` (${c.field})` : ''}: “${c.passage}”`)
  return { name: (proposal.title ?? item.title).slice(0, 200), text: lines.join('\n') }
}

export async function draftFromItem(ctx: AppContext, itemId: string, input: unknown) {
  const { recipeId } = DraftInput.parse(input ?? {})
  const item = ctx.repos.knowledge.get(itemId)
  if (!item) throw new ServiceError(404, 'Finding not found.')
  if (item.kind !== 'event_candidate' && item.kind !== 'missing_page') throw new ServiceError(400, 'Only proposed events and missing pages can become drafts.')
  if (item.status === 'drafted' && item.draftJobId) throw new ServiceError(409, 'A draft was already made from this.', [], 'ALREADY_DRAFTED')
  if (item.status === 'rejected') throw new ServiceError(409, 'This was rejected. Reopen it first.')
  const recipe = ctx.repos.recipes.get(recipeId)
  if (!recipe) throw new ServiceError(400, 'The chosen recipe does not exist.')
  const type = resolvePageType(recipe.definition)
  if (item.kind === 'event_candidate' && type?.id !== 'historical_event' && !/event|history/i.test(`${type?.label ?? ''} ${recipe.definition.name}`))
    throw new ServiceError(400, `“${recipe.definition.name}” is not an event recipe. Choose a recipe for historical events.`)
  const source = sourceFor(ctx, item)
  const job = createImport(ctx, {
    bytes: new TextEncoder().encode(source.text),
    fileName: null,
    mimeType: 'text/markdown',
    declaredFormat: 'markdown',
    sourceKind: 'paste',
    name: source.name,
    attributionTitle: 'LK Companion: drafted from existing pages',
    citation: item.evidence.map((c) => c.resourceName).join('; ').slice(0, 500),
    recipeId,
  })
  await runTransform(ctx, job.id, { mode: 'structural', recipeId })
  ctx.repos.knowledge.setDraftJob(item.id, job.id)
  recordAudit(ctx, { operation: 'knowledge.draft', outcome: 'success', projectId: item.projectId, jobId: job.id, recipeId, message: `Draft made from “${item.title}”`, details: { itemId: item.id, kind: item.kind } })
  return { jobId: job.id, item: ctx.repos.knowledge.get(item.id)! }
}
