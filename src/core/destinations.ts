import { matchLayoutKey, summarizeLayout } from './lk-layout'
import { BUILT_IN_PAGE_TYPES, type FieldDefinition, type PageTypeDefinition } from './page-types'

/**
 * Import destinations: the kinds of page an import can produce, one per LegendKeeper template.
 *
 * A template is matched to the built-in page type it most resembles (its name, and how many of
 * its infobox rows are fields of that type). Rows the type has no field for become extra fields,
 * so the AI fills them too ("Gender", "Age", "Friends"). A template that resembles no built-in
 * type gets a page type of its own, made from its rows and boxes.
 *
 * Pure: no network, no database.
 */

type AnyBlock = Record<string, unknown>

const NAME_HINTS: Record<string, RegExp> = {
  creature: /\b(stat ?blocks?|monsters?|creatures?|beasts?|bestiary)\b/i,
  npc: /\b(characters?|npcs?|persons?|people|villains?)\b/i,
  location: /\b(locations?|places?|settlements?|cities|city|towns?|regions?|dungeons?|buildings?|landmarks?|realms?|countries|country|kingdoms?)\b/i,
  magic_item: /\b(magic items?|items?|artifacts?|artefacts?|relics?|weapons?|equipment)\b/i,
  rule: /\b(spells?|rules?|conditions?|feats?)\b/i,
  historical_event: /\b(events?|battles?|wars?|timeline)\b/i,
}

/** "Statblock Template" → "Statblock". */
export function destinationLabel(templateName: string): string {
  return templateName.replace(/\s*\btemplate\b\s*$/i, '').trim() || templateName.trim()
}

/** A field key from a row label: "Hit Die" → "hitDie". */
export function fieldKeyFrom(label: string, taken: Set<string>): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
  let key = words.map((word, i) => (i === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase())).join('') || 'field'
  if (!/^[a-zA-Z]/.test(key)) key = `f${key}`
  key = key.slice(0, 60)
  let unique = key
  for (let n = 2; taken.has(unique); n++) unique = `${key}${n}`
  taken.add(unique)
  return unique
}

/** The row labels of a layout, in order, without blanks or repeats. */
function rowLabels(blocks: AnyBlock[]): string[] {
  const empty: PageTypeDefinition = { id: 'x', label: 'x', description: '', suggestedTag: null, alternativeTags: [], fields: [], sections: [], detectionHints: [], builtIn: false }
  const seen = new Set<string>()
  return summarizeLayout(blocks, empty)
    .rows.map((row) => row.key.trim())
    .filter((key) => {
      const norm = key.toLowerCase()
      if (!key || seen.has(norm) || /^(tags?|aliases?|sources?):?$/i.test(key)) return false
      seen.add(norm)
      return true
    })
}

export interface DestinationType {
  /** The built-in page type it is based on, or the page type made for it. */
  pageType: PageTypeDefinition
  /** Built-in: fields for the template's rows the type has no field for. */
  extraFields: FieldDefinition[]
  /** True when the page type was made from the template itself. */
  custom: boolean
  /** How the choice was made, for the screen. */
  reason: string
}

/** Which page type a LegendKeeper template is for. */
export function destinationType(templateName: string, blocks: AnyBlock[], usedTypeIds: Set<string> = new Set()): DestinationType {
  const labels = rowLabels(blocks)
  let best: { type: PageTypeDefinition; score: number; matched: number; byName: boolean } | null = null
  for (const type of BUILT_IN_PAGE_TYPES) {
    const byName = NAME_HINTS[type.id]?.test(templateName) ?? false
    const matched = new Set(labels.flatMap((label) => matchLayoutKey(label, type).fieldKeys)).size
    const ratio = labels.length ? matched / labels.length : 0
    const score = ratio + (byName ? 0.6 : 0)
    if (!best || score > best.score) best = { type, score, matched, byName }
  }
  if (best && (best.byName || (best.matched >= 2 && best.score >= 0.5))) {
    return {
      ...withExtraFields(best.type, blocks),
      reason: best.byName ? `Its name suggests ${best.type.label} pages.` : `${best.matched} of its ${labels.length} fields are ${best.type.label} fields.`,
    }
  }

  // Nothing similar: a page type made from the template's own fields and boxes.
  const label = destinationLabel(templateName)
  const base = `tpl_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`.slice(0, 60) || 'tpl_page'
  let id = /^[a-z]/.test(base) ? base : `tpl_${base}`
  for (let n = 2; usedTypeIds.has(id); n++) id = `${base.slice(0, 58)}_${n}`
  const taken = new Set<string>()
  const summary = summarizeLayout(blocks, { id, label, description: '', suggestedTag: null, alternativeTags: [], fields: [], sections: [], detectionHints: [], builtIn: false })
  const pageType: PageTypeDefinition = {
    id,
    label: label.slice(0, 100),
    description: `Pages like the LegendKeeper template “${templateName}”.`.slice(0, 1000),
    suggestedTag: null,
    alternativeTags: [],
    fields: labels.slice(0, 80).map((row) => ({ key: fieldKeyFrom(row, taken), label: row.slice(0, 100), group: 'lore' as const, kind: 'text' as const, description: '', aliases: [] })),
    sections: [...new Set(summary.sections.map((s) => s.trim()).filter(Boolean))].slice(0, 40),
    detectionHints: [],
    builtIn: false,
  }
  if (pageType.sections.length === 0) pageType.sections = ['Description']
  return { pageType, extraFields: [], custom: true, reason: 'It resembles none of the built-in page types, so its own fields and boxes are used.' }
}

/** A built-in type for a template: rows no field of the type takes become extra fields. */
export function withExtraFields(type: PageTypeDefinition, blocks: AnyBlock[]): DestinationType {
  // Each field goes to its best row; the other rows have no field yet.
  const ranked = rowLabels(blocks).map((label) => ({ label, ...matchLayoutKey(label, type) }))
  const bestRow = new Map<string, { label: string; rank: number }>()
  for (const row of ranked) {
    if (row.fieldKeys.length !== 1) continue
    const current = bestRow.get(row.fieldKeys[0]!)
    if (!current || row.rank < current.rank) bestRow.set(row.fieldKeys[0]!, row)
  }
  const taken = new Set(type.fields.map((field) => field.key))
  const extraFields: FieldDefinition[] = ranked
    .filter((row) => row.fieldKeys.length === 0 || (row.fieldKeys.length === 1 && bestRow.get(row.fieldKeys[0]!)?.label !== row.label))
    .map((row) => ({ key: fieldKeyFrom(row.label, taken), label: row.label.slice(0, 100), group: 'lore' as const, kind: 'text' as const, description: `The template's “${row.label}” field.`, aliases: [] }))
    .slice(0, 40)
  return { pageType: type, extraFields, custom: false, reason: '' }
}
