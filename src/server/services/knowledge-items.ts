import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { collapseWhitespace } from '@/core/text'
import type { AppContext } from '../context'
import { KNOWLEDGE_KINDS, type KnowledgeItem, type KnowledgeKind, type KnowledgeStatus } from '../db/knowledge-repositories'
import { recordAudit } from './audit'
import { knownProjectId } from './connection'
import { ServiceError } from './errors'

/**
 * Findings of chronology and knowledge analysis, and event candidates, with your decisions.
 * Deciding changes only the app's own records; nothing here writes to LegendKeeper.
 */

/** A fingerprint of the cited wording: when it changes, earlier decisions are reconsidered. */
export function fingerprintOf(passages: string[]): string {
  return createHash('sha256')
    .update(passages.map((p) => collapseWhitespace(p).toLowerCase()).sort().join('\u0000'))
    .digest('hex')
    .slice(0, 24)
}

export type Decision = 'accept' | 'reject' | 'defer' | 'intentional' | 'resolve' | 'reopen'

const ALLOWED: Record<KnowledgeKind, Decision[]> = {
  event_candidate: ['accept', 'reject', 'defer', 'reopen'],
  chronology_conflict: ['intentional', 'resolve', 'defer', 'reject', 'reopen'],
  contradiction: ['intentional', 'resolve', 'defer', 'reject', 'reopen'],
  unresolved_date: ['resolve', 'defer', 'reject', 'intentional', 'reopen'],
  missing_page: ['accept', 'reject', 'defer', 'reopen'],
  relationship: ['accept', 'reject', 'defer', 'reopen'],
  terminology: ['intentional', 'resolve', 'reject', 'defer', 'reopen'],
  link_suggestion: ['accept', 'reject', 'defer', 'reopen'],
}

const STATUS_FOR: Record<Decision, KnowledgeStatus> = {
  accept: 'accepted',
  reject: 'rejected',
  defer: 'deferred',
  intentional: 'intentional',
  resolve: 'resolved',
  reopen: 'open',
}

export const DECISION_LABELS: Record<Decision, string> = {
  accept: 'Accept',
  reject: 'Reject',
  defer: 'Needs research',
  intentional: 'Intentional',
  resolve: 'Resolved',
  reopen: 'Reopen',
}

/** What you may change on an event candidate before accepting it. */
export const EventEdits = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  date: z.string().trim().max(200).optional(),
  summary: z.string().trim().max(4000).nullable().optional(),
  participantIds: z.array(z.string().min(1).max(100)).max(50).optional(),
})

const DecideInput = z.object({
  decision: z.enum(['accept', 'reject', 'defer', 'intentional', 'resolve', 'reopen']),
  note: z.string().trim().max(1000).nullable().default(null),
})

export function decide(ctx: AppContext, itemId: string, input: unknown): KnowledgeItem {
  const body = DecideInput.parse(input ?? {})
  const item = ctx.repos.knowledge.get(itemId)
  if (!item) throw new ServiceError(404, 'Finding not found.')
  if (!ALLOWED[item.kind].includes(body.decision)) throw new ServiceError(400, `“${DECISION_LABELS[body.decision]}” does not apply to a ${KNOWLEDGE_KINDS[item.kind].toLowerCase()}.`)
  if (item.status === 'drafted' && body.decision !== 'reopen') throw new ServiceError(409, 'A draft was already made from this. Open the draft instead.')
  ctx.repos.knowledge.setStatus(item.id, STATUS_FOR[body.decision], body.note)
  recordAudit(ctx, { operation: 'knowledge.decide', outcome: 'info', projectId: item.projectId, message: `${KNOWLEDGE_KINDS[item.kind]} “${item.title}”: ${DECISION_LABELS[body.decision]}`, details: { itemId: item.id, kind: item.kind, decision: body.decision } })
  return ctx.repos.knowledge.get(item.id)!
}

export function editItem(ctx: AppContext, itemId: string, input: unknown): KnowledgeItem {
  const item = ctx.repos.knowledge.get(itemId)
  if (!item) throw new ServiceError(404, 'Finding not found.')
  if (item.kind !== 'event_candidate' && item.kind !== 'missing_page') throw new ServiceError(400, 'Only proposed events and missing pages can be edited.')
  if (item.status === 'drafted') throw new ServiceError(409, 'A draft was already made from this; edit the draft instead.')
  const edits = EventEdits.parse(input ?? {})
  const merged = { ...(item.edits ?? {}), ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined)) }
  ctx.repos.knowledge.setEdits(item.id, Object.keys(merged).length ? merged : null)
  return ctx.repos.knowledge.get(item.id)!
}

export const ItemFilter = z.object({
  kinds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter((k): k is KnowledgeKind => k in KNOWLEDGE_KINDS))),
  statuses: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : ((Array.isArray(v) ? v : v.split(',')) as KnowledgeStatus[]))),
  resourceId: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
})

export function listItems(ctx: AppContext, input: unknown) {
  const projectId = knownProjectId(ctx)
  if (!projectId) throw new ServiceError(409, 'Connect to LegendKeeper first.')
  const filter = ItemFilter.parse(input ?? {})
  const { items, total } = ctx.repos.knowledge.list(projectId, { kinds: filter.kinds, statuses: filter.statuses, resourceId: filter.resourceId, search: filter.q, limit: filter.limit, offset: filter.offset })
  const counts = ctx.repos.knowledge.counts(projectId)
  return {
    items: items.map((item) => ({ ...item, allowed: ALLOWED[item.kind], kindLabel: KNOWLEDGE_KINDS[item.kind] })),
    total,
    counts,
    kinds: KNOWLEDGE_KINDS,
  }
}
