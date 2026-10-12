import { normalizeName } from '../text'
import type { EntityKind } from '../knowledge/entities'
import { calendarForLk, type CalendarSettings } from './calendar'
import { datesConflict, findDates, orderKey, parseDate, type ChronoDate } from './dates'

/**
 * The local chronology: historical events gathered from what the project already holds.
 *
 * Sources, each kept distinct:
 * - `event_page`: a page about an event (an Event tag or page type), dated by its Date field,
 *   or failing that by the first date in its opening text.
 * - `page_field`: a dated field on another page ("Born", "Died", "Founded", "Destroyed").
 * - `native_timeline`: an event on a LegendKeeper timeline, as last read.
 * - `accepted_candidate`: an event you accepted from event discovery (it may have no page).
 *
 * Nothing is merged away: when two sources describe the same event they stay separate
 * entries, grouped, and any disagreement between their dates is reported, not resolved.
 */

export interface Citation {
  resourceId: string
  resourceName: string
  field: string | null
  passage: string
  version: string | null
}

export interface KbPage {
  id: string
  name: string
  aliases: string[]
  tags: string[]
  parentId: string | null
  ancestors: string[]
  kind: EntityKind
  content: {
    version: string
    text: string
    fields: { key: string; value: string; mentionIds: string[] }[]
    mentionIds: string[]
    links: { resourceId: string; text: string }[]
  } | null
}

export interface NativeTimelineInput {
  resourceId: string
  documentId: string
  resourceName: string
  name: string
  calendarId: string | null
  events: {
    eventId: string
    laneName: string | null
    type: string
    name: string
    formattedStart: string | null
    formattedEnd: string | null
    startDate: { year: number; month: number; monthName: string; day: number; era: { abbr?: string } | null } | null
    endDate: { year: number; month: number; monthName: string; day: number; era: { abbr?: string } | null } | null
    detail: number | null
    uri: string | null
    isHidden: boolean
  }[]
}

export interface AcceptedEventInput {
  itemId: string
  title: string
  dateText: string
  summary: string | null
  participantIds: string[]
  evidence: Citation[]
  /** The page made from it, when a draft was written. */
  resourceId: string | null
}

export type EntryOrigin = 'event_page' | 'page_field' | 'native_timeline' | 'accepted_candidate'
export type EntryStatus = 'dated' | 'approximate' | 'relative' | 'undated' | 'unplaced'

export interface ChronologyEntry {
  id: string
  origin: EntryOrigin
  title: string
  date: ChronoDate
  status: EntryStatus
  /** The page this entry is about or links to (a verified id from the index), if any. */
  resourceId: string | null
  summary: string | null
  sources: Citation[]
  participants: { resourceId: string; name: string; kind: EntityKind }[]
  categories: string[]
  timeline: { resourceId: string; documentId: string; name: string; lane: string | null; eventId: string } | null
  /** Entries that describe the same event (same page, or the same name). */
  group: string
  /** Ids of entries whose dates cannot both be right with this one. */
  conflictsWith: string[]
}

export interface ChronologyConflict {
  key: string
  kind: 'date' | 'sequence' | 'after_death'
  title: string
  explanation: string
  entryIds: string[]
  certainty: 'likely' | 'possible'
}

const DATE_FIELD = /^(date|dates|when|year|start|start date|began|begun|occurred|took place|date of event)$/i
const END_FIELD = /^(end|end date|ended|until|to|finished)$/i
const LIFE_FIELDS: { re: RegExp; title: (name: string) => string; role: 'birth' | 'death' | 'founding' | 'destruction' }[] = [
  { re: /^(born|birth|date of birth|birth date|birthdate)$/i, title: (n) => `Birth of ${n}`, role: 'birth' },
  { re: /^(died|death|date of death|death date|deceased)$/i, title: (n) => `Death of ${n}`, role: 'death' },
  { re: /^(founded|founding|established|date founded)$/i, title: (n) => `Founding of ${n}`, role: 'founding' },
  { re: /^(destroyed|fell|date destroyed|ruined)$/i, title: (n) => `Destruction of ${n}`, role: 'destruction' },
]

function statusOf(date: ChronoDate): EntryStatus {
  if (date.kind === 'unknown') return 'undated'
  if (date.kind === 'relative') return 'relative'
  if (!date.sort) return 'unplaced'
  return date.kind === 'approximate' || date.approximate ? 'approximate' : 'dated'
}

/** Reads a native event's date in the calendar configured for its timeline. */
export function nativeDate(timeline: Pick<NativeTimelineInput, 'calendarId'>, event: NativeTimelineInput['events'][number], settings: CalendarSettings): ChronoDate {
  const original = [event.formattedStart, event.formattedEnd].filter(Boolean).join(' – ') || ''
  const calendar = calendarForLk(settings, timeline.calendarId)
  if (!calendar || !event.startDate) {
    const date = parseDate('', settings)
    date.original = original
    date.notes = [calendar ? 'The event has no start date.' : `This timeline uses the LegendKeeper calendar “${timeline.calendarId ?? 'none'}”, which no configured calendar is linked to. Link it on the Calendars tab to place these events.`]
    return date
  }
  const point = (d: NonNullable<typeof event.startDate>) => {
    const era = d.era?.abbr ?? calendar.primaryEra
    const detail = event.detail ?? 3
    if (detail >= 3 && d.monthName) return `${d.monthName} ${d.day}, ${d.year} ${era}`
    if (detail === 2 && d.monthName) return `${d.monthName} ${d.year} ${era}`
    return `${d.year} ${era}`
  }
  const expression = event.endDate ? `${point(event.startDate)} to ${point(event.endDate)}` : point(event.startDate)
  const date = parseDate(expression, settings, { allowBareYear: false })
  date.original = original || expression
  if (date.kind === 'unknown') date.notes = [`The era “${event.startDate.era?.abbr ?? ''}” of this timeline is not in the “${calendar.name}” calendar settings.`]
  return date
}

function firstDateIn(text: string, settings: CalendarSettings, limit = 600) {
  const found = findDates(text.slice(0, limit), settings)[0]
  if (!found) return null
  const start = Math.max(0, text.lastIndexOf('\n', found.index) + 1)
  const endNl = text.indexOf('\n', found.index)
  const passage = text.slice(start, endNl === -1 ? Math.min(text.length, found.index + 200) : endNl).trim()
  return { date: found.date, passage: passage.slice(0, 400) }
}

function participantsOf(ids: string[], pages: Map<string, KbPage>, self: string | null) {
  const out: ChronologyEntry['participants'] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (id === self || seen.has(id)) continue
    const page = pages.get(id)
    if (!page || !['person', 'deity', 'faction', 'place', 'creature', 'event'].includes(page.kind)) continue
    seen.add(id)
    out.push({ resourceId: id, name: page.name, kind: page.kind })
  }
  return out
}

export function buildChronology(input: { pages: KbPage[]; timelines: NativeTimelineInput[]; accepted: AcceptedEventInput[]; settings: CalendarSettings }) {
  const { settings } = input
  const pages = new Map(input.pages.map((p) => [p.id, p]))
  const entries: ChronologyEntry[] = []
  const add = (e: Omit<ChronologyEntry, 'status' | 'group' | 'conflictsWith'>) => entries.push({ ...e, status: statusOf(e.date), group: '', conflictsWith: [] })

  for (const page of input.pages) {
    const content = page.content
    const fields = content?.fields ?? []
    const cite = (field: string | null, passage: string): Citation => ({ resourceId: page.id, resourceName: page.name, field, passage, version: content?.version ?? null })
    if (page.kind === 'event') {
      const dateField = fields.find((f) => DATE_FIELD.test(f.key.trim()))
      const endField = fields.find((f) => END_FIELD.test(f.key.trim()))
      let date: ChronoDate
      const sources: Citation[] = []
      if (dateField) {
        date = parseDate(endField ? `${dateField.value} to ${endField.value}` : dateField.value, settings)
        if (endField && date.kind !== 'range') date = parseDate(dateField.value, settings)
        date.original = endField ? `${dateField.value} – ${endField.value}` : dateField.value
        sources.push(cite(dateField.key, `${dateField.key}: ${dateField.value}`))
        if (endField) sources.push(cite(endField.key, `${endField.key}: ${endField.value}`))
      } else {
        const found = content ? firstDateIn(content.text, settings) : null
        date = found?.date ?? parseDate('', settings)
        if (found) sources.push(cite(null, found.passage))
        else {
          date.notes = [content ? 'The page has no Date field and no date in its opening text.' : 'The page has not been read yet (run a Wiki Health audit).']
          sources.push(cite(null, ''))
        }
      }
      const summary = content?.text.split('\n').map((l) => l.trim()).find((l) => l.length > 40) ?? null
      add({
        id: `page:${page.id}`,
        origin: 'event_page',
        title: page.name,
        date,
        resourceId: page.id,
        summary: summary ? summary.slice(0, 300) : null,
        sources,
        participants: participantsOf([...(content?.mentionIds ?? []), ...fields.flatMap((f) => f.mentionIds)], pages, page.id),
        categories: page.tags,
        timeline: null,
      })
    }
    for (const field of fields) {
      const life = LIFE_FIELDS.find((l) => l.re.test(field.key.trim()))
      if (!life) continue
      const date = parseDate(field.value, settings)
      if (date.kind === 'unknown' && !/unknown|\?/i.test(field.value)) continue
      add({
        id: `field:${page.id}:${normalizeName(field.key)}`,
        origin: 'page_field',
        title: life.title(page.name),
        date,
        resourceId: page.id,
        summary: null,
        sources: [cite(field.key, `${field.key}: ${field.value}`)],
        participants: page.kind === 'person' || page.kind === 'deity' || page.kind === 'faction' || page.kind === 'place' ? [{ resourceId: page.id, name: page.name, kind: page.kind }] : [],
        categories: [life.role, ...page.tags],
        timeline: null,
      })
    }
  }

  for (const timeline of input.timelines) {
    for (const event of timeline.events) {
      if (event.type !== 'event') continue
      const linked = event.uri?.match(/^lk:\/\/resources\/([^/]+)/)?.[1] ?? null
      const linkedPage = linked ? pages.get(linked) ?? null : null
      add({
        id: `native:${timeline.documentId}:${event.eventId}`,
        origin: 'native_timeline',
        title: event.name || '(unnamed event)',
        date: nativeDate(timeline, event, settings),
        resourceId: linkedPage ? linkedPage.id : null,
        summary: null,
        sources: [{ resourceId: timeline.resourceId, resourceName: timeline.resourceName, field: `Timeline “${timeline.name}”${event.laneName ? `, lane “${event.laneName}”` : ''}`, passage: `${event.name}: ${[event.formattedStart, event.formattedEnd].filter(Boolean).join(' – ')}`, version: null }],
        participants: linkedPage && linkedPage.kind !== 'event' ? [{ resourceId: linkedPage.id, name: linkedPage.name, kind: linkedPage.kind }] : participantsOf(linkedPage?.content?.mentionIds ?? [], pages, linkedPage?.id ?? null),
        categories: [timeline.name, ...(event.laneName ? [event.laneName] : [])],
        timeline: { resourceId: timeline.resourceId, documentId: timeline.documentId, name: timeline.name, lane: event.laneName, eventId: event.eventId },
      })
    }
  }

  for (const item of input.accepted) {
    add({
      id: `item:${item.itemId}`,
      origin: 'accepted_candidate',
      title: item.title,
      date: parseDate(item.dateText, settings, { allowBareYear: false }),
      resourceId: item.resourceId && pages.has(item.resourceId) ? item.resourceId : null,
      summary: item.summary,
      sources: item.evidence,
      participants: participantsOf(item.participantIds, pages, null),
      categories: [],
      timeline: null,
    })
  }

  // Group entries about the same event: the same page, or the same name.
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    while (parent.get(k) && parent.get(k) !== k) k = parent.get(k)!
    return k
  }
  const union = (a: string, b: string) => {
    parent.set(a, parent.get(a) ?? a)
    parent.set(b, parent.get(b) ?? b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  for (const e of entries) {
    const keys = [`title:${normalizeName(e.title)}`]
    // A life field and the person's own page are not "the same event".
    if (e.resourceId && (e.origin === 'event_page' || e.origin === 'native_timeline' || e.origin === 'accepted_candidate') && pages.get(e.resourceId)?.kind === 'event') keys.push(`res:${e.resourceId}`)
    for (const k of keys) union(keys[0]!, k)
    e.group = keys[0]!
  }
  for (const e of entries) e.group = find(e.group)

  const conflicts: ChronologyConflict[] = []
  const byGroup = new Map<string, ChronologyEntry[]>()
  for (const e of entries) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e])
  for (const [group, members] of byGroup) {
    if (members.length < 2) continue
    const clashing = new Set<string>()
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        if (datesConflict(members[i]!.date, members[j]!.date, settings.approximateToleranceYears)) {
          members[i]!.conflictsWith.push(members[j]!.id)
          members[j]!.conflictsWith.push(members[i]!.id)
          clashing.add(members[i]!.id).add(members[j]!.id)
        }
    if (clashing.size) {
      const involved = members.filter((m) => clashing.has(m.id))
      conflicts.push({
        key: `date:${group}`,
        kind: 'date',
        title: `Different dates for “${members[0]!.title}”`,
        explanation: involved.map((m) => `${m.sources[0]?.resourceName ?? 'a source'} gives “${m.date.original}”`).join('; ') + '.',
        entryIds: involved.map((m) => m.id),
        certainty: 'likely',
      })
    }
  }

  // Sequence: a recorded death before the birth, and events after a death.
  const tolerance = settings.approximateToleranceYears
  const lifeOf = (personId: string, role: 'birth' | 'death') => entries.filter((e) => e.origin === 'page_field' && e.resourceId === personId && e.categories[0] === role && e.date.sort)
  const people = new Set(entries.filter((e) => e.origin === 'page_field').map((e) => e.resourceId!))
  for (const personId of people) {
    const births = lifeOf(personId, 'birth')
    const deaths = lifeOf(personId, 'death')
    for (const b of births)
      for (const d of deaths)
        if (b.date.sort!.lo > d.date.sort!.hi + (b.date.approximate || d.date.approximate ? tolerance : 0)) {
          b.conflictsWith.push(d.id)
          d.conflictsWith.push(b.id)
          conflicts.push({ key: `sequence:${b.id}|${d.id}`, kind: 'sequence', title: `${pages.get(personId)?.name ?? 'Someone'} dies before being born`, explanation: `Born “${b.date.original}”, died “${d.date.original}”.`, entryIds: [b.id, d.id], certainty: 'likely' })
        }
    for (const d of deaths) {
      for (const e of entries) {
        if (e === d || !e.date.sort || !e.participants.some((p) => p.resourceId === personId) || e.categories[0] === 'death' || e.categories[0] === 'birth') continue
        if (e.date.sort.lo > d.date.sort!.hi + tolerance)
          conflicts.push({
            key: `after_death:${e.id}|${d.id}`,
            kind: 'after_death',
            title: `${pages.get(personId)?.name ?? 'Someone'} appears in an event after their recorded death`,
            explanation: `“${e.title}” (${e.date.original}) involves them; their death is recorded as “${d.date.original}”. This may be intended (undead, legacy, a namesake).`,
            entryIds: [e.id, d.id],
            certainty: 'possible',
          })
      }
    }
  }

  entries.sort((a, b) => {
    const ka = orderKey(a.date)
    const kb = orderKey(b.date)
    if (ka === null && kb === null) return a.title.localeCompare(b.title)
    if (ka === null) return 1
    if (kb === null) return -1
    return ka - kb || a.title.localeCompare(b.title)
  })
  return { entries, conflicts }
}
