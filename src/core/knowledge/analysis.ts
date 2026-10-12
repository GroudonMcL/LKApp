import type { Citation, KbPage } from '../chronology/entries'
import { splitSentences } from '../chronology/discovery'
import { levenshtein, normalizeName } from '../text'
import { kindFromNameShape, type EntityKind } from './entities'

/**
 * Cross-page knowledge analysis over the local index and the page content audits read.
 * Every result cites the page and the words (or field) it rests on, and says how directly
 * the content supports it:
 *
 * - `api`: from LegendKeeper's own data (a page's parent in the tree).
 * - `link`: the page links to the other page (a mention in its content).
 * - `field`: a labelled field names the other page ("Affiliations: Lanternwardens").
 * - `text`: inferred from the wording ("…is worshipped by the Horned Society").
 * - `ai`: suggested by the AI (never by these functions).
 *
 * LegendKeeper has no backlinks endpoint: incoming links are found by reading every page's
 * outgoing links, so they are only as complete as the pages audits have read.
 */

export type RelationType = 'part_of' | 'links_to' | 'member_of' | 'located_in' | 'worships' | 'led_by' | 'allied_with' | 'enemy_of' | 'related_to' | 'involves' | 'mentions'
export type RelationSupport = 'api' | 'link' | 'field' | 'text' | 'ai'

export const RELATION_LABELS: Record<RelationType, string> = {
  part_of: 'filed under',
  links_to: 'links to',
  member_of: 'member of',
  located_in: 'located in',
  worships: 'worships',
  led_by: 'led or ruled by',
  allied_with: 'allied or friendly with',
  enemy_of: 'enemy or rival of',
  related_to: 'family of',
  involves: 'involves',
  mentions: 'mentions (not linked)',
}

export const SUPPORT_LABELS: Record<RelationSupport, string> = {
  api: 'LegendKeeper data',
  link: 'link in the page',
  field: 'stated in a field',
  text: 'inferred from wording',
  ai: 'AI suggestion',
}

export interface Relation {
  from: string
  to: string
  type: RelationType
  support: RelationSupport
  evidence: Citation
}

const FIELD_TYPES: [RegExp, RelationType][] = [
  [/^(affiliations?|factions?|member of|allegiance|organi[sz]ations?|orders?|guilds?|group)$/i, 'member_of'],
  [/^(location|residence|home|region|located in|capital|lair|realm|country|kingdom|nation|province|territory|home ?town|settlement|place)$/i, 'located_in'],
  [/^(deity|deities|patron|patron deity|god|gods|worships|religion|faith|pantheon)$/i, 'worships'],
  [/^(rulers?|leaders?|head|founder|founded by|lord|sovereign|commander)$/i, 'led_by'],
  [/^(allies|ally|friends?)$/i, 'allied_with'],
  [/^(enemies|enemy|rivals?|foes?)$/i, 'enemy_of'],
  [/^(family|parents?|children|spouse|siblings?|mother|father|son|daughter)$/i, 'related_to'],
  [/^(participants?|combatants|belligerents|parties)$/i, 'involves'],
]

const TEXT_PATTERNS: { re: (a: string, b: string) => RegExp; type: RelationType; reverse?: boolean }[] = [
  { re: (a, b) => new RegExp(`${a}[^.]{0,40}\\b(?:is|was|are|were|became)\\s+(?:a\\s+|an\\s+)?(?:member|members|agent|agents|servant|servants|knight|knights|priest|priests|soldier|soldiers)\\s+of\\s+(?:the\\s+)?${b}`, 'u'), type: 'member_of' },
  { re: (a, b) => new RegExp(`${a}[^.]{0,40}\\b(?:worships?|worshipped|reveres?|revered|serves?|served)\\s+(?:the\\s+)?${b}`, 'u'), type: 'worships' },
  { re: (a, b) => new RegExp(`${b}[^.]{0,40}\\b(?:is|was|are|were)\\s+worshipped\\s+by\\s+(?:the\\s+)?${a}`, 'u'), type: 'worships' },
  { re: (a, b) => new RegExp(`${a}[^.]{0,30}\\b(?:lies|lay|stands|stood|is located|was located|sits)\\s+(?:in|within|on|beneath|under)\\s+(?:the\\s+)?${b}`, 'u'), type: 'located_in' },
  { re: (a, b) => new RegExp(`${a}[^.]{0,30}\\b(?:is|was)\\s+(?:a|an|the)\\s+(?:village|town|city|fortress|castle|keep|port|temple|abbey|realm)\\s+(?:in|of|within)\\s+(?:the\\s+)?${b}`, 'u'), type: 'located_in' },
  { re: (a, b) => new RegExp(`${a}[^.]{0,40}\\b(?:rules?|ruled|leads?|led|commands?|commanded)\\s+(?:the\\s+)?${b}`, 'u'), type: 'led_by', reverse: true },
]

const TARGET_KINDS: Record<RelationType, EntityKind[]> = {
  part_of: ['person', 'deity', 'faction', 'place', 'event', 'creature', 'item', 'rule', 'other'],
  links_to: ['person', 'deity', 'faction', 'place', 'event', 'creature', 'item', 'rule', 'other'],
  member_of: ['faction', 'place'],
  located_in: ['place'],
  worships: ['deity'],
  led_by: ['person', 'deity'],
  allied_with: ['person', 'deity', 'faction', 'place'],
  enemy_of: ['person', 'deity', 'faction', 'place'],
  related_to: ['person', 'deity'],
  involves: ['person', 'deity', 'faction', 'place', 'creature'],
  mentions: ['person', 'deity', 'faction', 'place', 'event', 'creature', 'item', 'rule', 'other'],
}

const compact = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '')

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function passageAround(text: string, needle: string): string {
  const at = text.indexOf(needle)
  if (at < 0) return needle
  return splitSentences(text.slice(Math.max(0, text.lastIndexOf('\n', at)), text.indexOf('\n', at) === -1 ? undefined : text.indexOf('\n', at))).find((s) => s.includes(needle)) ?? needle
}

/** Names that identify a page, longest first (aliases included; very short names left out of text matching). */
function namesOf(page: KbPage): string[] {
  return [page.name, ...page.aliases].filter((n) => n.trim().length >= 3).sort((a, b) => b.length - a.length)
}

export function buildRelations(pages: KbPage[]): Relation[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const exact = new Map<string, KbPage[]>()
  for (const p of pages) for (const n of [p.name, ...p.aliases]) exact.set(normalizeName(n), [...(exact.get(normalizeName(n)) ?? []), p])
  const out: Relation[] = []
  const cite = (p: KbPage, field: string | null, passage: string): Citation => ({ resourceId: p.id, resourceName: p.name, field, passage: passage.slice(0, 500), version: p.content?.version ?? null })
  for (const page of pages) {
    if (page.parentId && byId.has(page.parentId)) out.push({ from: page.id, to: page.parentId, type: 'part_of', support: 'api', evidence: cite(page, 'Parent page', `${page.name} is filed under ${byId.get(page.parentId)!.name}`) })
    const c = page.content
    if (!c) continue
    const fieldTargets = new Set<string>()
    for (const f of c.fields) {
      const type = FIELD_TYPES.find(([re]) => re.test(f.key.trim()))?.[1]
      if (!type) continue
      const targets = new Set(f.mentionIds.filter((id) => byId.has(id)))
      // A plain value that is exactly one page's name or alias counts too.
      for (const part of f.value.split(/[,;\n]| and /)) {
        const hits = exact.get(normalizeName(part.trim())) ?? []
        if (hits.length === 1) targets.add(hits[0]!.id)
      }
      for (const to of targets) {
        if (to === page.id) continue
        fieldTargets.add(to)
        out.push({ from: page.id, to, type, support: 'field', evidence: cite(page, f.key, `${f.key}: ${f.value}`) })
      }
    }
    const linked = new Set<string>()
    for (const id of c.mentionIds) {
      if (!byId.has(id) || id === page.id || linked.has(id)) continue
      linked.add(id)
      const shown = c.links.find((l) => l.resourceId === id)?.text ?? byId.get(id)!.name
      out.push({ from: page.id, to: id, type: 'links_to', support: 'link', evidence: cite(page, null, passageAround(c.text, shown)) })
    }
  }
  return out
}

/**
 * Relationships inferred from wording between pages the text names exactly. Only sentences
 * naming both pages are considered; the cited sentence is the evidence.
 */
export function textRelations(pages: KbPage[], scope: Set<string>): Relation[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const named = pages.filter((p) => namesOf(p).length > 0)
  const out: Relation[] = []
  for (const page of pages) {
    if (!scope.has(page.id) || !page.content) continue
    for (const sentence of splitSentences(page.content.text)) {
      const present = named.filter((p) => namesOf(p).some((n) => /^[\p{Lu}]/u.test(n) && new RegExp(`(?<![\\p{L}])${escapeRe(n)}(?![\\p{L}])`, 'u').test(sentence)))
      if (present.length < 1) continue
      // The page itself may be the subject ("It lies in the Kron Hills" is not matched; its name is).
      const candidates = present.includes(page) ? present : [page, ...present]
      for (const a of candidates)
        for (const b of present) {
          if (a.id === b.id) continue
          for (const pattern of TEXT_PATTERNS) {
            const hit = namesOf(a).some((na) => namesOf(b).some((nb) => pattern.re(`(?:${escapeRe(na)})`, `(?:${escapeRe(nb)})`).test(sentence)))
            if (!hit) continue
            const [from, to] = pattern.reverse ? [b.id, a.id] : [a.id, b.id]
            // The kind of the other end must fit: one worships a deity, lies in a place…
            const target = byId.get(to)!.kind
            if (!TARGET_KINDS[pattern.type].includes(target)) continue
            out.push({ from, to, type: pattern.type, support: 'text', evidence: { resourceId: page.id, resourceName: page.name, field: null, passage: sentence.slice(0, 500), version: page.content.version } })
          }
        }
    }
  }
  const seen = new Set<string>()
  return out.filter((r) => (seen.has(`${r.from}|${r.to}|${r.type}`) ? false : (seen.add(`${r.from}|${r.to}|${r.type}`), true))).filter((r) => byId.has(r.from) && byId.has(r.to))
}

/** Pages whose text names another page (exactly, with its name or an alias) without linking to it. */
export function unlinkedMentions(pages: KbPage[], scope: Set<string>, options: { minNameLength?: number } = {}) {
  const min = options.minNameLength ?? 5
  // Rules and glossary pages ("Attack", "Damage") are named everywhere in passing; leave them out.
  // Folder pages with no content of their own ("Dragon", "Fiend") are categories, not things named in passing.
  const targets = pages.filter((p) => p.kind !== 'rule' && p.content && (p.kind !== 'other' || p.aliases.length > 0))
  const out: { page: KbPage; target: KbPage; name: string; passage: string }[] = []
  // Names shared by several pages are ambiguous and skipped.
  const owners = new Map<string, number>()
  for (const p of targets) for (const n of namesOf(p)) owners.set(n, (owners.get(n) ?? 0) + 1)
  for (const page of pages) {
    if (!scope.has(page.id) || !page.content) continue
    const linked = new Set(page.content.mentionIds)
    for (const target of targets) {
      if (target.id === page.id || linked.has(target.id) || page.parentId === target.id) continue
      const name = namesOf(target).find((n) => n.length >= min && owners.get(n) === 1 && /^[\p{Lu}\p{N}]/u.test(n) && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'u').test(page.content!.text))
      if (!name) continue
      out.push({ page, target, name, passage: passageAround(page.content.text, name) })
    }
  }
  return out
}

// ── Missing pages ────────────────────────────────────────────────────────────────

const STOP = new Set(
  [
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'of', 'to', 'for', 'with', 'by', 'from', 'as', 'it', 'its', 'he', 'she', 'they', 'his', 'her', 'their', 'this', 'that', 'these', 'those',
    'i', 'we', 'you', 'when', 'while', 'after', 'before', 'during', 'since', 'until', 'if', 'then', 'there', 'here', 'some', 'many', 'most', 'all', 'each', 'every', 'one', 'two', 'three',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'dm', 'gm', 'pc', 'pcs', 'npc', 'npcs', 'hp', 'ac', 'cr', 'xp', 'dc', 'str', 'dex', 'con', 'int', 'wis', 'cha',
    'armor class', 'armour class', 'hit points', 'saving throws', 'damage resistances', 'damage immunities', 'condition immunities', 'challenge', 'senses', 'languages', 'skills', 'speed',
    'actions', 'reactions', 'legendary actions', 'bonus actions', 'traits', 'description', 'history', 'notes', 'background', 'personality', 'relationships', 'summary', 'overview', 'appearance',
    'melee weapon attack', 'ranged weapon attack', 'melee attack', 'ranged attack', 'hit', 'spellcasting', 'innate spellcasting', 'proficiency bonus', 'passive perception', 'common',
    'chapter', 'page', 'source', 'sources', 'see also', 'table', 'note', 'warning', 'example', 'yes', 'no', 'none', 'unknown',
  ].map((w) => w.toLowerCase()),
)

const RULE_WORDS = new Set(
  ['attack', 'attacks', 'rolls', 'roll', 'damage', 'charisma', 'wisdom', 'strength', 'dexterity', 'constitution', 'intelligence', 'saving', 'throw', 'throws', 'advantage', 'disadvantage', 'action', 'actions', 'bonus', 'reaction', 'check', 'checks', 'spell', 'spells', 'level', 'hit', 'points', 'turn', 'round', 'condition', 'conditions', 'proficiency', 'speed', 'your', 'you', 'weapons', 'weapon', 'armor', 'armour', 'domains', 'escape', 'pouch', 'component', 'components', 'trait', 'traits', 'feature', 'features'],
)

export interface MissingEntity {
  name: string
  kind: EntityKind | null
  mentions: { page: KbPage; passage: string }[]
}

/**
 * Capitalised names that recur across pages but have no page (or alias) of their own. Only
 * names of two or more words, or single words found mid-sentence on three or more pages, are
 * considered; names that are part of an existing page's name are left out as ambiguous.
 */
export function missingEntities(pages: KbPage[], scope: Set<string>, extraStop: string[] = [], options: { minPages?: number } = {}): MissingEntity[] {
  const minPages = options.minPages ?? 2
  const known = new Set<string>()
  const knownCompact = new Set<string>()
  const knownTokens = new Set<string>()
  for (const p of pages)
    for (const n of [p.name, ...p.aliases]) {
      const key = normalizeName(n)
      known.add(key)
      knownCompact.add(compact(n))
      knownTokens.add(key)
      for (const part of key.split(' ')) if (part.length > 3) knownTokens.add(part)
    }
  const stop = new Set([...STOP, ...extraStop.map((s) => s.toLowerCase())])
  // Words the wiki also writes in lower case are ordinary words, not names, when they open a sentence.
  const lowerCounts = new Map<string, number>()
  for (const p of pages) for (const w of p.content?.text.match(/(?<![\p{L}])[\p{Ll}][\p{L}'’-]*/gu) ?? []) lowerCounts.set(w, (lowerCounts.get(w) ?? 0) + 1)
  const common = (w: string) => (lowerCounts.get(w.toLowerCase()) ?? 0) >= 2
  const found = new Map<string, { name: string; mentions: { page: KbPage; passage: string }[]; mid: number }>()
  const WORD = "[\\p{Lu}][\\p{L}'’-]+"
  const phrase = new RegExp(`${WORD}(?:\\s+(?:(?:of|the|of the|de|von)\\s+)?${WORD}){0,4}`, 'gu')
  for (const page of pages) {
    if (!scope.has(page.id) || !page.content || page.kind === 'rule') continue
    const headings = new Set(page.content.fields.map((f) => normalizeName(f.key)))
    const seenHere = new Set<string>()
    for (const sentence of splitSentences(page.content.text)) {
      // A capitalised word opening a sentence is not evidence of a name on its own.
      for (const m of sentence.matchAll(phrase)) {
        let name = m[0].replace(/[’']s$/u, '').trim()
        const atStart = m.index === 0 || /^["“‘(]?$/.test(sentence.slice(0, m.index).trim())
        const words = name.split(/\s+/)
        if (atStart && words.length > 1 && (stop.has(words[0]!.toLowerCase()) || common(words[0]!))) {
          name = words.slice(1).join(' ').replace(/^(?:of|the|and|of the)\s+/i, '')
        }
        name = name.replace(/^(?:The|A|An)\s+/, '')
        const key = normalizeName(name)
        const parts = key.split(' ')
        // A spelling variant of a page's name is a naming issue, not a missing page.
        if (parts.some((w) => RULE_WORDS.has(w))) continue
        if (!key || key.length < 4 || stop.has(key) || headings.has(key) || known.has(key) || knownCompact.has(compact(name)) || parts.every((w) => stop.has(w))) continue
        if (parts.length === 1 && (atStart || knownTokens.has(key) || common(name))) continue
        // Part of a known page's name ("Emridy" of "Battle of Emridy Meadows") or containing one.
        if ([...known].some((k) => k.includes(key) || (key.includes(k) && k.length > 3 && key !== k && (parts.length <= 2 || k.includes(' '))))) continue
        if (seenHere.has(key)) continue
        seenHere.add(key)
        const entry = found.get(key) ?? { name, mentions: [], mid: 0 }
        entry.mentions.push({ page, passage: sentence.slice(0, 400) })
        if (!atStart) entry.mid++
        found.set(key, entry)
      }
    }
  }
  return [...found.values()]
    .filter((e) => {
      const single = e.name.split(/\s+/).length === 1
      return e.mentions.length >= (single ? Math.max(3, minPages) : minPages) && (!single || e.mid >= 3)
    })
    .map((e) => ({ name: e.name, kind: kindFromNameShape(e.name, e.mentions.map((m) => m.passage).join(' ')), mentions: e.mentions }))
    .sort((a, b) => b.mentions.length - a.mentions.length || a.name.localeCompare(b.name))
}

// ── Terminology ───────────────────────────────────────────────────────────────────

export interface NameVariant {
  target: KbPage
  /** The page name or alias the variant resembles. */
  canonical: string
  variant: string
  mentions: { page: KbPage; passage: string }[]
}

/**
 * Spellings in running text that differ from a page's name only in spaces, hyphens,
 * apostrophes, capitals or accents ("Sea-Princes", "Lantern Wardens"), and are not aliases.
 */
export function nameVariants(pages: KbPage[], scope: Set<string>): NameVariant[] {
  const byCompact = new Map<string, { page: KbPage; name: string }[]>()
  const accepted = new Set<string>()
  for (const p of pages)
    for (const n of [p.name, ...p.aliases]) {
      accepted.add(n)
      const k = compact(n)
      if (k.length < 6) continue
      byCompact.set(k, [...(byCompact.get(k) ?? []), { page: p, name: n }])
    }
  const found = new Map<string, NameVariant>()
  const token = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu
  for (const page of pages) {
    if (!scope.has(page.id) || !page.content) continue
    for (const sentence of splitSentences(page.content.text)) {
      const words = [...sentence.matchAll(token)]
      for (let i = 0; i < words.length; i++) {
        for (let n = 1; n <= 4 && i + n <= words.length; n++) {
          const start = words[i]!.index!
          const last = words[i + n - 1]!
          const surface = sentence.slice(start, last.index! + last[0].length).replace(/['’]$/u, '')
          // ALL CAPS is a style (headings, labels), not a spelling; possessives and fragments are not names.
          if (!/^[\p{Lu}]/u.test(surface) || accepted.has(surface) || (surface.length > 3 && surface === surface.toUpperCase()) || /['’]s$|\(/u.test(surface)) continue
          const hits = byCompact.get(compact(surface))
          if (!hits || hits.length !== 1) continue
          const { page: target, name } = hits[0]!
          if (surface === name) continue
          // Capitals alone differ: normal for rules terms ("Dim light"); only reported for named things.
          if (surface.toLowerCase() === name.toLowerCase() && !['person', 'deity', 'faction', 'place'].includes(target.kind)) continue
          const key = `${target.id}|${surface}`
          const entry = found.get(key) ?? { target, canonical: name, variant: surface, mentions: [] }
          if (!entry.mentions.some((m) => m.page.id === page.id)) entry.mentions.push({ page, passage: sentence.slice(0, 400) })
          found.set(key, entry)
        }
      }
    }
  }
  return [...found.values()]
}

/** Pages whose names are near-identical (possible duplicates or inconsistent naming). Never merged. */
export function similarNames(pages: KbPage[]) {
  const out: { a: KbPage; b: KbPage; reason: string }[] = []
  const list = pages.filter((p) => p.name.trim().length >= 4)
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!
      const b = list[j]!
      if (a.aliases.includes(b.name) || b.aliases.includes(a.name)) continue
      const ka = compact(a.name)
      const kb = compact(b.name)
      if (ka === kb) out.push({ a, b, reason: a.name === b.name ? 'Same name.' : 'The names differ only in spacing, punctuation, capitals or accents.' })
      // Names that differ only in numbers ("Room 12", "Room 13") are usually different things.
      else if (ka.replace(/\d/g, '') === kb.replace(/\d/g, '')) continue
      else if (ka.length >= 8 && Math.abs(ka.length - kb.length) <= 2 && levenshtein(ka, kb) <= (ka.length >= 14 ? 2 : 1)) out.push({ a, b, reason: 'The names differ by one or two letters.' })
    }
  return out
}

// ── Contradictions ──────────────────────────────────────────────────────────────

const TITLE_WORDS = /\b(prince|princess|king|queen|lord|lady|duke|duchess|baron|baroness|count|countess|knight|archmage|high priest(?:ess)?|priest(?:ess)?|bishop|captain|general|emperor|empress|overking|regent|master|mistress|grandmaster|warden|chancellor|marshal)\b/i
const TITLE_FIELDS = /^(titles?|rank|position|role|office|occupation|honorifics?|epithets?)$/i
const ALLEGIANCE_FIELDS = /^(affiliations?|allegiance|factions?|member of|orders?)$/i

export interface ContradictionDraft {
  key: string
  kind: 'role_title_allegiance' | 'mechanics' | 'field'
  title: string
  explanation: string
  certainty: 'likely' | 'possible'
  evidence: Citation[]
  resourceIds: string[]
}

/**
 * Disagreements the app can find without interpretation:
 * - the same field with different values on pages describing the same entity (same name);
 * - a title used for a person elsewhere ("Thrommel, Knight of the Hart") that their own page's
 *   title fields do not contain (possible: people often hold several titles).
 */
export function findContradictions(pages: KbPage[], scope: Set<string>): ContradictionDraft[] {
  const out: ContradictionDraft[] = []
  const cite = (p: KbPage, field: string | null, passage: string): Citation => ({ resourceId: p.id, resourceName: p.name, field, passage: passage.slice(0, 400), version: p.content?.version ?? null })
  // Same-named pages with differing values for the same field.
  const groups = new Map<string, KbPage[]>()
  for (const p of pages) if (p.content) groups.set(normalizeName(p.name), [...(groups.get(normalizeName(p.name)) ?? []), p])
  for (const [name, group] of groups) {
    if (group.length < 2 || !group.some((p) => scope.has(p.id))) continue
    const keys = new Set(group.flatMap((p) => p.content!.fields.map((f) => normalizeName(f.key))))
    for (const key of keys) {
      const values = group.flatMap((p) => p.content!.fields.filter((f) => normalizeName(f.key) === key).map((f) => ({ p, f })))
      const distinct = new Set(values.map((v) => normalizeName(v.f.value)))
      if (values.length < 2 || distinct.size < 2) continue
      const mechanics = /\b(armou?r class|hit points|speed|challenge|str|dex|con|int|wis|cha|saving throws|ac|hp|cr|damage)\b/i.test(key)
      out.push({
        key: `field:${name}:${key}`,
        kind: mechanics ? 'mechanics' : 'field',
        title: `“${values[0]!.f.key}” differs between pages called “${group[0]!.name}”`,
        explanation: values.map((v) => `${v.p.name} (${v.p.id}) says “${v.f.value}”`).join('; ') + '. The app does not decide which is right.',
        certainty: 'likely',
        evidence: values.map((v) => cite(v.p, v.f.key, `${v.f.key}: ${v.f.value}`)),
        resourceIds: [...new Set(values.map((v) => v.p.id))],
      })
    }
  }
  // Titles and allegiances used elsewhere for a person or deity.
  const people = pages.filter((p) => (p.kind === 'person' || p.kind === 'deity') && p.content)
  for (const person of people) {
    const titleFields = person.content!.fields.filter((f) => TITLE_FIELDS.test(f.key.trim()))
    const allegiance = person.content!.fields.filter((f) => ALLEGIANCE_FIELDS.test(f.key.trim()))
    if (!titleFields.length && !allegiance.length) continue
    const own = normalizeName([...titleFields, ...allegiance].map((f) => f.value).join(' ; '))
    const names = [person.name, ...person.aliases].filter((n) => n.length >= 3)
    for (const page of pages) {
      if (page.id === person.id || !scope.has(page.id) || !page.content) continue
      for (const sentence of splitSentences(page.content.text)) {
        for (const n of names) {
          const m = sentence.match(new RegExp(`(?<![\\p{L}])${escapeRe(n)},\\s+(?:the\\s+)?([\\p{Lu}][\\p{L}'’-]+(?:\\s+(?:of\\s+(?:the\\s+)?|the\\s+)?[\\p{Lu}][\\p{L}'’-]+){0,5})`, 'u'))
          if (!m || !TITLE_WORDS.test(m[1]!)) continue
          const title = m[1]!
          if (own.includes(normalizeName(title))) continue
          out.push({
            key: `title:${person.id}:${normalizeName(title)}:${page.id}`,
            kind: 'role_title_allegiance',
            title: `${person.name} is called “${title}” on ${page.name}`,
            explanation: `${person.name}'s page gives ${titleFields.length ? `“${titleFields.map((f) => f.value).join('; ')}”` : 'no title'}${allegiance.length ? ` (allegiance: “${allegiance.map((f) => f.value).join('; ')}”)` : ''}; ${page.name} calls them “${title}”. This may be another title, an error, or a change over time.`,
            certainty: 'possible',
            evidence: [...titleFields.map((f) => cite(person, f.key, `${f.key}: ${f.value}`)), cite(page, null, sentence)],
            resourceIds: [person.id, page.id],
          })
        }
      }
    }
  }
  return out
}
