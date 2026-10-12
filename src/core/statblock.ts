import type { FieldDefinition } from './page-types'
import type { RecipeDefinition } from './recipe'

/**
 * Reading "label → value" lines and D&D-style statblocks without AI.
 *
 * Everything here copies text verbatim; it only decides *which field* a piece of text belongs
 * to. Supported forms:
 * - `Label: value`, `**Label** value`, `**Label.** value`, and — for game-mechanics fields —
 *   `Label value` without a colon (statblock style: `AC 17`, `HP 21 (6d6)`, `CR 1 (XP 200)`).
 * - Several values on one line separated by tabs or wide spacing (`AC 17   Initiative +2 (12)`).
 * - Field aliases (built-in, e.g. AC/Armour Class, plus your own from the recipe).
 * - Ability scores: 2014 style (`STR 19 (+4) DEX 8 (−1) …`, or a header row then a value row)
 *   and 2024 style (`Str 10 +0 +0` — score, modifier, saving throw).
 * - The creature type line (`Small Humanoid (Goblinoid), Neutral Evil`).
 */

export interface LabelEntry {
  label: string
  fieldKey: string
  /** Mechanics fields may be written without a colon ("AC 17"); lore fields need one. */
  allowBare: boolean
}

export function buildLabelIndex(fields: FieldDefinition[], recipe: RecipeDefinition | null): LabelEntry[] {
  const entries: LabelEntry[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    const extra = recipe?.fieldMappings.find((m) => m.fieldKey === field.key)?.labels ?? []
    for (const label of [field.label, field.key, ...field.aliases, ...extra]) {
      const key = label.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      // Your own recipe labels may always be used without a colon.
      entries.push({ label: label.trim(), fieldKey: field.key, allowBare: field.group === 'mechanics' || extra.includes(label) })
    }
  }
  // Longest first, so "Armor Class" wins over "AC"-like prefixes and "Damage Immunities" over "Immunities".
  return entries.sort((a, b) => b.label.length - a.label.length)
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Strips list markers and Markdown emphasis around a label: "- **AC.** 17" → "AC. 17". */
function clean(segment: string): string {
  return segment
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\*([^*]+)\*$/, '$1')
    .trim()
}

/** Matches one segment (a line, or part of a line) against the labels. */
export function matchLabel(segment: string, labels: LabelEntry[]): { fieldKey: string; value: string; label: string } | null {
  const text = clean(segment)
  if (text.length === 0 || text.length > 400) return null
  for (const entry of labels) {
    const withColon = new RegExp(`^${escape(entry.label)}\\s*[:.]\\s*(.+)$`, 'i').exec(text)
    if (withColon && withColon[1]!.trim()) return { fieldKey: entry.fieldKey, value: withColon[1]!.trim(), label: entry.label }
    if (entry.allowBare) {
      const bare = new RegExp(`^${escape(entry.label)}\\s+(.+)$`, 'i').exec(text)
      // A bare label must be followed by a value, not prose: "Speed 30 ft." but not "Speed is…".
      // Statblocks write "Languages the languages it knew in life", so an article is fine there.
      const prose = /^languages?$/i.test(entry.label) ? /^(?:is|are|was|were)\b/i : /^(?:is|are|was|were|of|and|or|the|a|an|to|in|on|that|which|it|as|by|for|with)\b/i
      if (bare && text.length <= 200 && !prose.test(bare[1]!.trim())) {
        return { fieldKey: entry.fieldKey, value: bare[1]!.trim(), label: entry.label }
      }
    }
  }
  return null
}

/** Splits a line into segments at tabs or runs of 3+ spaces. */
export function splitSegments(line: string): string[] {
  return line
    .split(/\t+| {3,}/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const
type Ability = (typeof ABILITIES)[number]
const MINUS = '[+\\-−–]'

export interface AbilityRead {
  scores: Partial<Record<Ability, string>>
  saves: Partial<Record<Ability, string>>
  /** The line, with the recognised parts removed (so leftovers are not lost). */
  rest: string
}

const abilityName = (name: string): Ability | null => {
  const key = name.slice(0, 3).toLowerCase()
  return (ABILITIES as readonly string[]).includes(key) ? (key as Ability) : null
}

/**
 * Reads ability scores written inline:
 * - 2014: `STR 19 (+4) DEX 8 (−1) …`
 * - 2024: `Str 10 +0 +0` (score, modifier, saving throw), one or several per line.
 */
export function readAbilityLine(line: string): AbilityRead | null {
  const scores: AbilityRead['scores'] = {}
  const saves: AbilityRead['saves'] = {}
  let rest = line.replace(/\|/g, ' ')
  const modern = new RegExp(`\\b(Str|Dex|Con|Int|Wis|Cha)(?:ength|terity|stitution|elligence|dom|risma)?\\b\\.?\\s+(\\d{1,2})\\s+(${MINUS}\\s?\\d+)\\s+(${MINUS}\\s?\\d+)`, 'gi')
  const classic = new RegExp(`\\b(Str|Dex|Con|Int|Wis|Cha)(?:ength|terity|stitution|elligence|dom|risma)?\\b\\.?\\s+(\\d{1,2})\\s*\\(\\s*(${MINUS}\\s?\\d+)\\s*\\)`, 'gi')
  for (const match of rest.matchAll(modern)) {
    const ability = abilityName(match[1]!)
    if (!ability) continue
    scores[ability] = `${match[2]} (${match[3]!.replace(/\s/g, '')})`
    saves[ability] = match[4]!.replace(/\s/g, '')
  }
  rest = rest.replace(modern, ' ')
  for (const match of rest.matchAll(classic)) {
    const ability = abilityName(match[1]!)
    if (!ability || scores[ability]) continue
    scores[ability] = `${match[2]} (${match[3]!.replace(/\s/g, '')})`
  }
  rest = rest.replace(classic, ' ')
  if (Object.keys(scores).length === 0) return null
  return { scores, saves, rest: rest.replace(/\s+/g, ' ').trim() }
}

/** A header row naming the six abilities in order (2014 table layout), e.g. `| STR | DEX | … |`. */
export function abilityHeader(line: string): Ability[] | null {
  const tokens = line
    .replace(/[|]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (tokens.length !== 6) return null
  const abilities = tokens.map(abilityName)
  if (abilities.some((a) => a === null) || new Set(abilities).size !== 6) return null
  return abilities as Ability[]
}

/** Values for a header row: `19 (+4) 8 (−1) …` (or `| 19 (+4) | … |`). */
export function abilityValues(line: string): string[] | null {
  const values = [...line.matchAll(new RegExp(`(\\d{1,2})\\s*\\(\\s*(${MINUS}\\s?\\d+)\\s*\\)`, 'g'))].map((m) => `${m[1]} (${m[2]!.replace(/\s/g, '')})`)
  return values.length === 6 ? values : null
}

/** 2024 table header (`MOD SAVE`) and Markdown table separators carry no data. */
export function isTableNoise(line: string): boolean {
  const t = line.replace(/[|]/g, ' ').trim()
  return /^(?:mod(?:ifier)?\s+save|score\s+mod(?:ifier)?\s+save)$/i.test(t) || /^[\s|:-]+$/.test(line) && line.includes('-')
}

const SIZES = 'Tiny|Small|Medium|Large|Huge|Gargantuan'

/** `Small Humanoid (Goblinoid), Neutral Evil` → size, type, alignment (verbatim pieces). */
export function readTypeLine(line: string): { size: string; creatureType: string; alignment: string } | null {
  const text = clean(line).replace(/^_|_$/g, '')
  const match = new RegExp(`^((?:${SIZES})(?:\\s+or\\s+(?:${SIZES}))?)\\s+([^,]+?),\\s*(.+?)\\.?$`, 'i').exec(text)
  if (!match) return null
  return { size: match[1]!, creatureType: match[2]!.trim(), alignment: match[3]!.trim() }
}

/** Plain-text section headings in statblocks and notes, e.g. "Actions" or "Legendary Actions:". */
export function plainHeading(line: string, headings: string[]): string | null {
  const text = clean(line).replace(/[:.]$/, '').trim()
  if (text.length === 0 || text.length > 40) return null
  return headings.find((heading) => heading.toLowerCase() === text.toLowerCase()) ?? null
}
