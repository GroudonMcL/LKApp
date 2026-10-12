import { ReferenceIndex } from '../references'
import { levenshtein, normalizeName } from '../text'
import type { EntityKind } from '../knowledge/entities'
import type { CalendarSettings } from './calendar'
import { datesConflict, findDates, formatDate, parseDate, type ChronoDate } from './dates'
import type { ChronologyEntry, Citation, KbPage } from './entries'

/**
 * Event discovery: historical events described in ordinary pages.
 *
 * The rule-based reader takes a sentence when it names an event ("the Greyhawk Wars", "the
 * Battle of Emridy Meadows"), or when it holds a date together with an event word (founded,
 * sacked, crowned, died, raided…). Every candidate cites its sentence word for word. Nothing
 * here decides whether a claim is true: a candidate says what one or more pages state.
 */

export type EventKindId = 'battle_war' | 'political' | 'founding_destruction' | 'journey_discovery' | 'religious_supernatural' | 'life' | 'treaty_raid_disaster' | 'other'

export const EVENT_KIND_LABELS: Record<EventKindId, string> = {
  battle_war: 'Battle or war',
  political: 'Political change or succession',
  founding_destruction: 'Founding or destruction',
  journey_discovery: 'Journey or discovery',
  religious_supernatural: 'Religious or supernatural',
  life: 'Birth, death or life event',
  treaty_raid_disaster: 'Treaty, raid or disaster',
  other: 'Other',
}

export interface EventCandidate {
  title: string
  kind: EventKindId
  dateText: string | null
  date: ChronoDate | null
  summary: string
  participantIds: string[]
  /** Names in the passage that match no page, or more than one. */
  unmatchedNames: string[]
  evidence: Citation[]
  origin: 'deterministic' | 'ai'
  notes: string[]
}

type Verb = { re: RegExp; kind: EventKindId; noun: string; prep: 'of' | 'on' | 'to' | 'in'; wants: EntityKind[] }

// Order matters: the first verb found in a sentence names the event.
const VERBS: Verb[] = [
  { re: /\b(?:was |were )?(?:born)\b/i, kind: 'life', noun: 'Birth', prep: 'of', wants: ['person', 'deity'] },
  { re: /\b(?:died|perished|was slain|were slain|was killed|was murdered|was assassinated)\b/i, kind: 'life', noun: 'Death', prep: 'of', wants: ['person', 'deity'] },
  { re: /\b(?:vanished|disappeared)\b/i, kind: 'life', noun: 'Disappearance', prep: 'of', wants: ['person', 'deity'] },
  { re: /\b(?:crowned)\b/i, kind: 'political', noun: 'Coronation', prep: 'of', wants: ['person'] },
  { re: /\b(?:abdicated|was deposed|usurped|succeeded|took the throne|seized power|became (?:king|queen|ruler|prince|princess|lord|archmage|regent))\b/i, kind: 'political', noun: 'Succession', prep: 'in', wants: ['place', 'faction'] },
  { re: /\b(?:founded|established)\b/i, kind: 'founding_destruction', noun: 'Founding', prep: 'of', wants: ['place', 'faction'] },
  { re: /\b(?:sacked)\b/i, kind: 'founding_destruction', noun: 'Sack', prep: 'of', wants: ['place'] },
  { re: /\b(?:destroyed|razed|ruined|burned|burnt|overrun)\b/i, kind: 'founding_destruction', noun: 'Destruction', prep: 'of', wants: ['place', 'faction'] },
  { re: /\b(?:fell|collapsed)\b/i, kind: 'founding_destruction', noun: 'Fall', prep: 'of', wants: ['place', 'faction'] },
  { re: /\b(?:conquered|annexed)\b/i, kind: 'political', noun: 'Conquest', prep: 'of', wants: ['place'] },
  { re: /\b(?:raided)\b/i, kind: 'treaty_raid_disaster', noun: 'Raid', prep: 'on', wants: ['place'] },
  { re: /\b(?:invaded)\b/i, kind: 'battle_war', noun: 'Invasion', prep: 'of', wants: ['place'] },
  { re: /\b(?:besieged)\b/i, kind: 'battle_war', noun: 'Siege', prep: 'of', wants: ['place'] },
  { re: /\b(?:fought|defeated|routed|battle|war|wars)\b/i, kind: 'battle_war', noun: 'Battle', prep: 'of', wants: ['place'] },
  { re: /\b(?:signed|treaty|pact|truce|alliance was)\b/i, kind: 'treaty_raid_disaster', noun: 'Treaty', prep: 'of', wants: ['place', 'faction'] },
  { re: /\b(?:plague|famine|flood|flooded|earthquake|eruption|storm|great fire)\b/i, kind: 'treaty_raid_disaster', noun: 'Disaster', prep: 'in', wants: ['place'] },
  { re: /\b(?:discovered|explored|charted|journeyed|sailed|expedition|voyage)\b/i, kind: 'journey_discovery', noun: 'Expedition', prep: 'to', wants: ['place'] },
  { re: /\b(?:summoned|ascended|consecrated|manifested|banished|miracle|apotheosis|prophesied)\b/i, kind: 'religious_supernatural', noun: 'Event', prep: 'in', wants: ['deity', 'place'] },
]

const NAMED_HEAD = 'Battle|Siege|Sack|Fall|Treaty|Massacre|Rebellion|Invasion|Uprising|Crusade|Founding|Destruction|Coronation|Burning|Plague|Pact|Council|Conquest|Liberation'
const WORD = "[\\p{Lu}][\\p{L}'’-]+"
const NAMED_EVENT = new RegExp(
  `\\b(?:(?:${NAMED_HEAD})(?:\\s+(?:of|at|on|for))\\s+(?:the\\s+)?${WORD}(?:\\s+(?:of\\s+(?:the\\s+)?)?${WORD})*|(?:${WORD}\\s+){1,3}(?:Wars?|Rebellion|Crusade|Uprising|Massacre|Plague|Invasion|Revolt|Schism))(?![\\p{L}'’-])`,
  'gu',
)
const NAMED_KIND: [RegExp, EventKindId][] = [
  [/^(battle|siege|invasion|war|wars|crusade|conquest|liberation)\b|\b(wars?|crusade|invasion)$/i, 'battle_war'],
  [/^(treaty|pact)\b|\bplague$/i, 'treaty_raid_disaster'],
  [/^(founding|destruction|sack|fall|burning)\b/i, 'founding_destruction'],
  [/^(coronation|council)\b|\b(rebellion|uprising|revolt|massacre)$/i, 'political'],
  [/\bschism$/i, 'religious_supernatural'],
]

export function splitSentences(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=["“‘(]?[\p{Lu}\p{N}])/u))
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
}

function objectAfter(sentence: string, re: RegExp): string | null {
  const m = sentence.match(re)
  if (!m || m.index === undefined) return null
  const rest = sentence.slice(m.index + m[0].length)
  const obj = rest.match(new RegExp(`^\\s+(?:(?:the|a|an|to|on|in|at)\\s+)*(${WORD}(?:\\s+(?:of\\s+(?:the\\s+)?)?${WORD})*)`, 'u'))
  return obj?.[1] ?? null
}

export interface DiscoveryContext {
  settings: CalendarSettings
  pages: Map<string, KbPage>
  refs: ReferenceIndex
}

export function referenceIndexFor(pages: KbPage[]): ReferenceIndex {
  return new ReferenceIndex(pages.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, parentId: p.parentId, tags: p.tags })))
}

/** The pages a passage refers to: its links first, then exact names; ambiguous names are reported, not guessed. */
export function participantsIn(passage: string, page: KbPage, ctx: DiscoveryContext): { ids: string[]; unmatched: string[] } {
  const ids = new Set<string>()
  const unmatched: string[] = []
  for (const link of page.content?.links ?? []) if (link.text && passage.includes(link.text) && ctx.pages.has(link.resourceId)) ids.add(link.resourceId)
  for (const name of ctx.refs.scanText(passage, [], { limit: 20 })) {
    const found = ctx.refs.find(name).exact
    if (found.length === 1) ids.add(found[0]!.resourceId)
    else if (found.length > 1 && !found.some((f) => ids.has(f.resourceId))) unmatched.push(`${name} (matches ${found.length} pages)`)
  }
  return { ids: [...ids], unmatched }
}

/** Rule-based candidates from one page's text. */
export function extractEventsFromPage(page: KbPage, ctx: DiscoveryContext): EventCandidate[] {
  if (!page.content) return []
  const out: EventCandidate[] = []
  for (const sentence of splitSentences(page.content.text)) {
    const dates = findDates(sentence, ctx.settings)
    const named = [...sentence.matchAll(NAMED_EVENT)].map((m) => m[0].trim()).filter((n) => n.split(/\s+/).length >= 2)
    const verb = VERBS.find((v) => v.re.test(sentence))
    if (!named.length && !(dates.length && verb)) continue
    const { ids, unmatched } = participantsIn(sentence, page, ctx)
    const notes: string[] = []
    let title: string
    let kind: EventKindId
    if (named.length) {
      title = named[0]!.replace(/^the\s+/i, '')
      kind = NAMED_KIND.find(([re]) => re.test(title))?.[1] ?? verb?.kind ?? 'other'
    } else {
      const v = verb!
      kind = v.kind
      const object = objectAfter(sentence, v.re)
      const known = ids.map((id) => ctx.pages.get(id)!).find((p) => v.wants.includes(p.kind))
      const self = v.wants.includes(page.kind) ? page.name : null
      // Who was born, died or was crowned: the named page just before the verb; a pronoun ("He
      // vanished…") means the page itself.
      const verbAt = sentence.search(v.re)
      const before = ids
        .map((id) => ctx.pages.get(id)!)
        .filter((p) => v.wants.includes(p.kind))
        .map((p) => ({ p, at: [p.name, ...p.aliases].map((n) => sentence.lastIndexOf(n, verbAt)).reduce((a, b) => Math.max(a, b), -1) }))
        .filter((x) => x.at >= 0)
        .sort((a, b) => b.at - a.at)[0]?.p
      const pronoun = /^(he|she|they|it|his|her|their)\b/i.test(sentence.trim())
      const personal = v.noun === 'Birth' || v.noun === 'Death' || v.noun === 'Disappearance' || v.noun === 'Coronation'
      const subject = (personal ? (pronoun ? self ?? before?.name : before?.name ?? self ?? known?.name) : object ?? self ?? known?.name) ?? page.name
      title = `${v.noun} ${v.prep} ${subject.replace(/^the\s+/i, '')}`
      if (!object && !known && !self) notes.push(`The page does not say who or where; the title uses the page name “${page.name}”.`)
    }
    const date = dates[0]?.date ?? null
    const distinct = [...new Set(dates.map((d) => d.text))]
    if (distinct.length > 1) notes.push(`The passage holds more than one date (${distinct.map((d) => `“${d}”`).join(', ')}); the first is used. Check which belongs to the event.`)
    if (!date) notes.push('The passage gives no date.')
    const participantIds = ids.filter((id) => normalizeName(ctx.pages.get(id)?.name ?? '') !== normalizeName(title))
    if (['person', 'deity', 'faction', 'place'].includes(page.kind) && !participantIds.includes(page.id) && page.kind !== 'event') participantIds.push(page.id)
    out.push({
      title: title.slice(0, 200),
      kind,
      dateText: dates[0]?.text ?? null,
      date,
      summary: sentence.slice(0, 600),
      participantIds,
      unmatchedNames: unmatched,
      evidence: [{ resourceId: page.id, resourceName: page.name, field: null, passage: sentence.slice(0, 1000), version: page.content.version }],
      origin: 'deterministic',
      notes,
    })
  }
  return out
}

/** Event records that may already describe this candidate (same or very similar name). */
export function existingMatches(title: string, date: ChronoDate | null, entries: Pick<ChronologyEntry, 'id' | 'title' | 'origin' | 'resourceId' | 'date'>[], tolerance: number) {
  const key = normalizeName(title)
  const tokens = key.split(' ').filter((t) => t.length > 2 && !['battle', 'war', 'wars', 'the', 'and', 'founding', 'destruction', 'birth', 'death'].includes(t))
  return entries
    .filter((e) => {
      const other = normalizeName(e.title)
      if (other === key) return true
      if (key.length > 8 && levenshtein(other, key) <= 2) return true
      const otherTokens = new Set(other.split(' '))
      return tokens.length >= 2 && tokens.every((t) => otherTokens.has(t))
    })
    .map((e) => ({
      entryId: e.id,
      title: e.title,
      origin: e.origin,
      resourceId: e.resourceId,
      date: e.date.original,
      display: formatDate(e.date),
      agrees: date && e.date.sort && date.sort ? !datesConflict(date, e.date, tolerance) : null,
    }))
}

/**
 * Groups candidates that describe the same event (same name) across passages and pages.
 * Candidates whose dates disagree stay separate, so the disagreement is kept; undated
 * mentions join the first dated group as corroboration.
 */
export function groupCandidates(candidates: EventCandidate[], tolerance: number): EventCandidate[] {
  // The same name, or the same cited passage (the rule-based reader and the AI may name one
  // event differently), means the same event.
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    while (parent.has(k) && parent.get(k) !== k) k = parent.get(k)!
    return k
  }
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const keysOf = (c: EventCandidate) => [`t:${normalizeName(c.title)}`, ...c.evidence.map((e) => `p:${e.resourceId}|${normalizeName(e.passage)}`)]
  for (const c of candidates) for (const k of keysOf(c)) union(keysOf(c)[0]!, k)
  const byTitle = new Map<string, EventCandidate[]>()
  for (const c of candidates) {
    const root = find(keysOf(c)[0]!)
    byTitle.set(root, [...(byTitle.get(root) ?? []), c])
  }
  const out: EventCandidate[] = []
  for (const group of byTitle.values()) {
    const clusters: EventCandidate[][] = []
    for (const c of group.filter((c) => c.date?.sort)) {
      const home = clusters.find((cl) => cl.every((o) => !datesConflict(o.date!, c.date!, tolerance)))
      if (home) home.push(c)
      else clusters.push([c])
    }
    const undatedOrUnplaced = group.filter((c) => !c.date?.sort)
    if (clusters.length === 0) clusters.push(undatedOrUnplaced.splice(0))
    else clusters[0]!.push(...undatedOrUnplaced)
    for (const cluster of clusters) {
      if (!cluster.length) continue
      // The most precise date stands for the group; the others are noted.
      const rank = (c: EventCandidate) => (c.date?.sort ? ({ day: 5, month: 4, year: 3, decade: 2, century: 1, none: 0 } as const)[c.date.precision] - (c.date.approximate ? 0.5 : 0) : -1)
      // Rule-based names come first on a tie: they use the page's own words.
      const lead = [...cluster].sort((a, b) => rank(b) - rank(a) || (a.origin === b.origin ? 0 : a.origin === 'deterministic' ? -1 : 1))[0]!
      const otherNames = [...new Set(cluster.map((c) => c.title).filter((t) => normalizeName(t) !== normalizeName(lead.title)))]
      const evidence = cluster.flatMap((c) => c.evidence).filter((e, i, all) => all.findIndex((o) => o.resourceId === e.resourceId && o.passage === e.passage) === i)
      const otherDates = [...new Set(cluster.filter((c) => c !== lead && c.dateText && c.dateText !== lead.dateText).map((c) => `“${c.dateText}” (${c.evidence[0]!.resourceName})`))]
      out.push({
        ...lead,
        participantIds: [...new Set(cluster.flatMap((c) => c.participantIds))],
        unmatchedNames: [...new Set(cluster.flatMap((c) => c.unmatchedNames))],
        evidence,
        origin: cluster.every((c) => c.origin === 'ai') ? 'ai' : 'deterministic',
        notes: [...new Set([...cluster.flatMap((c) => c.notes), ...(otherDates.length ? [`Also dated ${otherDates.join(', ')}; these agree within the tolerance.`] : []), ...(otherNames.length ? [`Also called ${otherNames.map((n) => `“${n}”`).join(', ')}.`] : [])])],
      })
    }
    if (clusters.length > 1) {
      const names = clusters.map((cl) => cl[0]!.dateText ?? 'no date')
      for (const c of out.slice(-clusters.length)) c.notes.push(`Sources disagree on the date (${names.map((n) => `“${n}”`).join(' vs ')}); each version is kept as its own candidate.`)
    }
  }
  return out
}

/** Re-reads a date the AI quoted, so the app (not the model) decides what it means. */
export function dateFromQuote(dateText: string | null, settings: CalendarSettings): ChronoDate | null {
  if (!dateText) return null
  const date = parseDate(dateText, settings, { allowBareYear: false })
  return date.kind === 'unknown' ? null : date
}
