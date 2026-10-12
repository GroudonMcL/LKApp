import { z } from 'zod'
import { normalizeName } from '../text'

/**
 * The Task Assistant's plan: a short list of steps, each one of a fixed set of operations
 * that map onto existing app services. Nothing outside this list can be planned or run, and
 * no step writes to LegendKeeper: requests that need a write are handed to the tool that
 * performs it with its own preview and approval.
 *
 * Page references are kept as the words you used; the app resolves them against the page
 * index when the plan runs (and asks you when a name matches several pages or none).
 */

export const ENTITY_KINDS = ['person', 'deity', 'faction', 'place', 'event', 'creature', 'item', 'rule', 'other'] as const
const Ref = z.string().trim().min(1).max(200)
const Kind = z.enum(ENTITY_KINDS)

export const Step = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('find_pages'),
    kind: Kind.optional(),
    tag: z.string().max(100).optional(),
    untagged: z.boolean().optional(),
    within: Ref.optional(),
    nameContains: z.string().max(200).optional(),
    textContains: z.string().max(200).optional(),
    linksTo: Ref.optional(),
  }),
  z.object({
    op: z.literal('events'),
    involving: Ref.optional(),
    involvingKind: Kind.optional(),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    dates: z.enum(['any', 'dated', 'uncertain', 'undated', 'unconfirmed', 'conflicts']).default('any'),
    text: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal('references_to'), target: Ref }),
  z.object({ op: z.literal('unlinked_mentions'), target: Ref }),
  z.object({ op: z.literal('relationships'), target: Ref }),
  z.object({ op: z.literal('old_layout'), kind: Kind.optional(), tag: z.string().max(100).optional() }),
  z.object({ op: z.literal('discover_events'), pages: z.array(Ref).min(1).max(25), useAi: z.boolean().default(false) }),
  z.object({ op: z.literal('compare_pages'), pages: z.array(Ref).min(2).max(5) }),
  z.object({ op: z.literal('knowledge_analysis'), checks: z.array(z.enum(['relationships', 'links', 'missing', 'contradictions', 'terminology'])).min(1), within: Ref.optional() }),
  z.object({ op: z.literal('handoff'), tool: z.enum(['tagging', 'migration', 'import', 'timeline', 'health']), reason: z.string().max(500) }),
])
export type Step = z.infer<typeof Step>
export type StepOp = Step['op']

export const TaskPlan = z.object({
  /** The request restated in plain words. */
  understanding: z.string().max(1000),
  steps: z.array(Step).max(4),
  /** Information the request lacks (shown to you; the plan does not guess it). */
  missing: z.array(z.string().max(300)).max(10).default([]),
  /** A question to ask instead of guessing, with suggested answers. */
  clarification: z.object({ question: z.string().max(500), options: z.array(z.string().max(200)).max(8) }).nullable().default(null),
})
export type TaskPlan = z.infer<typeof TaskPlan>

/** What each operation does, whether it uses AI, and what it may change (only the app's own records). */
export const OPERATIONS: Record<StepOp, { label: string; effect: 'read' | 'analysis' | 'handoff'; ai: 'never' | 'optional' | 'always'; describes: string }> = {
  find_pages: { label: 'Find pages', effect: 'read', ai: 'never', describes: 'Lists pages from the local index by kind, tag, folder, name, text or links.' },
  events: { label: 'Find events in the chronology', effect: 'read', ai: 'never', describes: 'Lists chronology entries by who or what they involve, period and date certainty.' },
  references_to: { label: 'Report references to a page', effect: 'read', ai: 'never', describes: 'Every page that links to it or names it, with the passage.' },
  unlinked_mentions: { label: 'Find unlinked mentions', effect: 'read', ai: 'never', describes: 'Pages that name it without linking to it.' },
  relationships: { label: 'Show relationships', effect: 'read', ai: 'never', describes: 'Its links, fields and the page tree, in and out.' },
  old_layout: { label: 'Find pages not matching their template', effect: 'read', ai: 'never', describes: 'Uses the layout findings of the last Wiki Health audit.' },
  discover_events: { label: 'Suggest a chronology from pages', effect: 'analysis', ai: 'optional', describes: 'Runs event discovery on the pages; candidates are recorded for your review.' },
  compare_pages: { label: 'Compare pages for inconsistencies', effect: 'analysis', ai: 'always', describes: 'One AI request comparing the pages; findings must quote both sides.' },
  knowledge_analysis: { label: 'Run knowledge analysis', effect: 'analysis', ai: 'never', describes: 'Relationships, unlinked mentions, missing pages, contradictions, naming.' },
  handoff: { label: 'Open the tool that makes this change', effect: 'handoff', ai: 'never', describes: 'Changes to LegendKeeper are made in their own tool, with preview and approval.' },
}

export function stepUsesAi(step: Step): boolean {
  return step.op === 'compare_pages' || (step.op === 'discover_events' && step.useAi)
}

// ── Rule-based interpretation (no AI) ──────────────────────────────────────────────

const KIND_WORDS: [RegExp, (typeof ENTITY_KINDS)[number]][] = [
  [/\b(npcs?|characters?|people|persons?)\b/i, 'person'],
  [/\b(gods?|deit(?:y|ies)|goddess(?:es)?|powers)\b/i, 'deity'],
  [/\b(factions?|organi[sz]ations?|guilds?|orders|groups)\b/i, 'faction'],
  [/\b(locations?|places?|towns?|cities|city|villages?|regions?|settlements?)\b/i, 'place'],
  [/\b(creatures?|monsters?|statblocks?)\b/i, 'creature'],
  [/\b(magic items?|items?|artifacts?)\b/i, 'item'],
  [/\b(spells?|rules?)\b/i, 'rule'],
]

export interface NamedPage {
  id: string
  name: string
  aliases: string[]
  hasChildren: boolean
}

/**
 * Page names (or aliases) the request mentions, longest first, matched without regard to
 * case. Returns the words as typed, so they can be resolved and shown.
 */
export function namesInRequest(text: string, pages: NamedPage[]): string[] {
  const t = ` ${normalizeName(text)} `
  const hits: { name: string; at: number; len: number }[] = []
  for (const p of pages)
    for (const n of [p.name, ...p.aliases]) {
      const key = normalizeName(n)
      if (key.length < 3) continue
      const at = t.indexOf(` ${key} `)
      if (at >= 0) hits.push({ name: n, at, len: key.length })
    }
  hits.sort((a, b) => b.len - a.len)
  const taken: { at: number; len: number }[] = []
  const out: string[] = []
  for (const h of hits) {
    if (taken.some((t2) => h.at < t2.at + t2.len + 1 && t2.at < h.at + h.len + 1)) continue
    taken.push(h)
    if (!out.includes(h.name)) out.push(h.name)
  }
  return out.sort((a, b) => t.indexOf(` ${normalizeName(a)} `) - t.indexOf(` ${normalizeName(b)} `))
}

/** Quoted names ("…" or "…"), or a list after a colon: page names you spelled out. */
function quotedNames(text: string): string[] {
  const quoted = [...text.matchAll(/["“']([^"”']{2,120})["”']/g)].map((m) => m[1]!.trim())
  if (quoted.length) return quoted
  const afterColon = text.split(':')[1]
  if (afterColon) return afterColon.split(/,|;|\band\b|\n/).map((s) => s.trim().replace(/\.$/, '')).filter((s) => s.length > 1)
  return []
}

/**
 * Turns common maintenance requests into a plan without AI. Returns null when the request is
 * not one it recognises (then you can ask the AI to plan it, or rephrase).
 */
export function interpretRequest(request: string, pages: NamedPage[]): TaskPlan | null {
  const text = request.trim()
  const lower = text.toLowerCase()
  const names = namesInRequest(text, pages)
  const spelled = quotedNames(text)
  const kind = KIND_WORDS.find(([re]) => re.test(lower))?.[1]
  const byName = (n: string) => pages.find((p) => normalizeName(p.name) === normalizeName(n) || p.aliases.some((a) => normalizeName(a) === normalizeName(n)))

  // Writes are never planned: point to the tool that does them with its own approval.
  if (/\b(add|apply|set|change|fix|remove|delete|rename|merge|create|make|write|link up|retag)\b[^.]*\b(tags?|pages?|links?|layout|template|timeline|events?)\b/i.test(lower) && !/\b(find|list|show|which|report|identify|suggest|prepare)\b/i.test(lower)) {
    const tool = /\btags?\b/.test(lower) ? 'tagging' : /\blayout|template\b/.test(lower) ? 'migration' : /\btimeline\b/.test(lower) ? 'timeline' : 'import'
    return {
      understanding: `You want to change something in LegendKeeper (${tool === 'tagging' ? 'tags' : tool === 'migration' ? 'page layouts' : tool === 'timeline' ? 'a timeline' : 'pages'}).`,
      steps: [{ op: 'handoff', tool, reason: 'The assistant only finds and analyses. Changes are made in their own tool, which shows a final preview and asks for your approval.' }],
      missing: [],
      clarification: null,
    }
  }

  // "Find inconsistencies between these two NPC biographies"
  if (/\b(inconsisten|contradict|disagree|conflict)/i.test(lower)) {
    const list = spelled.length >= 2 ? spelled : names
    if (list.length >= 2 && list.length <= 5)
      return { understanding: `Compare ${list.map((n) => `“${n}”`).join(' and ')} for statements that contradict each other.`, steps: [{ op: 'compare_pages', pages: list }], missing: [], clarification: null }
    return {
      understanding: 'Find inconsistencies between pages.',
      steps: [],
      missing: ['Which pages to compare (2 to 5).'],
      clarification: { question: 'Which pages should be compared? Name 2 to 5 pages, in quotes or after a colon.', options: [] },
    }
  }

  // "Suggest a chronology of events mentioned in these five pages"
  if (/\b(chronolog|timeline of|events mentioned|order of events)/i.test(lower) && !/\binvolving\b/.test(lower)) {
    const list = spelled.length ? spelled : names
    if (list.length)
      return { understanding: `Find the historical events described in ${list.map((n) => `“${n}”`).join(', ')} and put them in date order.`, steps: [{ op: 'discover_events', pages: list.slice(0, 25), useAi: false }], missing: [], clarification: null }
    return { understanding: 'Suggest a chronology from some pages.', steps: [], missing: ['Which pages.'], clarification: { question: 'Which pages should the chronology come from? List them in quotes or after a colon.', options: [] } }
  }

  // "Identify pages mentioning this faction that are not linked to its resource"
  if (/\bnot linked|without (a )?link|unlinked\b/i.test(lower)) {
    if (names.length === 1) return { understanding: `Find pages that name “${names[0]}” without linking to it.`, steps: [{ op: 'unlinked_mentions', target: names[0]! }], missing: [], clarification: null }
    return { understanding: 'Find pages that name a page without linking to it.', steps: [], missing: ['Which page.'], clarification: { question: names.length > 1 ? 'Which of these did you mean?' : 'Which page should the mentions be of?', options: names } }
  }

  // "Prepare a report of all references to a particular deity"
  if (/\b(references? to|mentions? of|report)\b/i.test(lower) && !/\bevents?\b/.test(lower)) {
    if (names.length === 1) return { understanding: `Report every page that links to or names “${names[0]}”.`, steps: [{ op: 'references_to', target: names[0]! }], missing: [], clarification: null }
    return { understanding: 'Report references to a page.', steps: [], missing: ['Which page.'], clarification: { question: names.length > 1 ? 'Which of these did you mean?' : 'Which page should the report be about?', options: names } }
  }

  // "Find creatures that appear to use the old statblock layout"
  if (/\b(old|outdated|previous|wrong)\b[^.]*\b(layout|template|statblock|format)\b/i.test(lower)) {
    return { understanding: `Find ${kind ? `${kind} ` : ''}pages whose layout does not match their template, from the last Wiki Health audit.`, steps: [{ op: 'old_layout', ...(kind ? { kind } : {}) }], missing: [], clarification: null }
  }

  // "Find historical events involving the Sea Princes that have no confirmed date"
  if (/\bevents?\b/.test(lower)) {
    const dates = /\b(no|without|unconfirmed|uncertain|unknown|missing)\b[^.]*\bdates?\b|\bundated\b/.test(lower) ? (/\bconfirmed|uncertain\b/.test(lower) ? 'unconfirmed' : 'undated') : /\bconflict|disagree/.test(lower) ? 'conflicts' : 'any'
    const years = [...lower.matchAll(/\b(\d{1,4})\s*(?:cy)?\b/g)].map((m) => Number(m[1]))
    const step: Step = { op: 'events', dates, ...(names[0] ? { involving: names[0] } : {}), ...(!names[0] && kind && kind !== 'event' ? { involvingKind: kind } : {}), ...(years.length >= 2 ? { from: Math.min(...years), to: Math.max(...years) } : {}) }
    return {
      understanding: `List chronology events${names[0] ? ` involving “${names[0]}”` : ''}${dates === 'unconfirmed' ? ' that have no confirmed date' : dates === 'undated' ? ' that have no date' : dates === 'conflicts' ? ' whose sources disagree on the date' : ''}.`,
      steps: [step],
      missing: names.length > 1 ? [`Only “${names[0]}” is used; the request also names ${names.slice(1).map((n) => `“${n}”`).join(', ')}.`] : [],
      clarification: null,
    }
  }

  // "Show the relationships of Iuz"
  if (/\b(relationships?|connections?|connected|neighbours?|neighbors?)\b/.test(lower) && names.length === 1) {
    return { understanding: `Show what “${names[0]}” is connected to, and what connects to it.`, steps: [{ op: 'relationships', target: names[0]! }], missing: [], clarification: null }
  }

  // "Find all untagged NPC pages in Saltmarsh"
  if (/\b(find|list|show|which)\b/.test(lower) && (kind || /\buntagged|tag(ged)? /.test(lower) || names.length)) {
    const within = names.find((n) => /\b(in|under|within|inside)\s+(the\s+)?$/i.test(lower.slice(0, lower.indexOf(n.toLowerCase())).trimEnd() + ' '))
    const place = within ? byName(within) : undefined
    const tagMatch = text.match(/\btagged\s+["“]?([\p{L}\p{N} '’-]{2,40}?)["”]?(?:\s|$|\.)/u)
    const step: Step = {
      op: 'find_pages',
      ...(kind ? { kind } : {}),
      ...(/\buntagged|no tags|without tags\b/.test(lower) ? { untagged: true } : {}),
      ...(tagMatch && !/\buntagged\b/.test(lower) ? { tag: tagMatch[1]!.trim() } : {}),
      ...(within && place?.hasChildren ? { within } : within ? { linksTo: within } : {}),
    }
    return {
      understanding: `List ${/\buntagged/.test(lower) ? 'untagged ' : ''}${kind ? `${kind} ` : ''}pages${within ? (place?.hasChildren ? ` filed under “${within}”` : ` that link to “${within}”`) : ''}.`,
      steps: [step],
      missing: within && !place?.hasChildren ? [`“${within}” has no pages filed under it, so pages that link to it are listed instead.`] : [],
      clarification: null,
    }
  }
  return null
}

/**
 * Removes placeholder values models sometimes put in fields they do not use ("", "[]",
 * "null", "none", empty lists) so they are not mistaken for page names. Applied before the
 * plan is validated; it never adds anything.
 */
export function withoutPlaceholders(raw: unknown): unknown {
  const empty = (v: unknown) => v === '' || v === null || (typeof v === 'string' && /^\s*(\[\s*\]|null|none|n\/a|undefined)\s*$/i.test(v)) || (Array.isArray(v) && v.length === 0)
  if (!raw || typeof raw !== 'object') return raw
  const plan = raw as { steps?: unknown }
  if (!Array.isArray(plan.steps)) return raw
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step && typeof step === 'object' ? Object.fromEntries(Object.entries(step as Record<string, unknown>).filter(([k, v]) => k === 'op' || k === 'pages' || k === 'checks' || !empty(v))) : step,
    ),
  }
}
