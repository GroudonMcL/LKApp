import { applyJsonMappings, baseTagCandidates, emptyFields, MECHANICS_HEADINGS, newPage, sectionId, type DraftBuildResult, type DraftContext } from './draft-common'
import { getByPath, jsonValueToText, markdownOutline } from './extraction'
import type { PageField, PageSection } from './page-model'
import { abilityHeader, abilityValues, buildLabelIndex, isTableNoise, matchLabel, plainHeading, readAbilityLine, readTypeLine, splitSegments } from './statblock'

/**
 * The structural transformer builds a draft without AI, using only the source's own
 * structure. It never interprets or rewrites text:
 * - Markdown headings become sections; text before the first heading goes into the
 *   template's first section.
 * - Lines like `Armor Class: 15`, `**Armor Class** 15`, `AC 17` or `HP 21 (6d6)` fill the
 *   matching field, using the field's label, its aliases and the recipe's extra labels
 *   (see statblock.ts). Ability-score tables, the creature type line and plain headings such
 *   as "Actions" are understood too. Matched text is not repeated in the body.
 * - JSON sources use the recipe's field mappings; other JSON keys are kept as unsorted
 *   source material.
 *
 * It is used when AI is switched off, and as a baseline that needs no API key.
 */
export function buildStructuralDraft(ctx: DraftContext, format: 'text' | 'markdown' | 'json'): DraftBuildResult {
  let fields = emptyFields(ctx.pageType)
  let sections: PageSection[] = []
  let name = ctx.sourceTitle ?? 'Untitled'
  let notes: string[] = []

  if (format === 'json') {
    const mapped = applyJsonMappings(fields, ctx.recipe, ctx.sourceJson)
    fields = mapped.fields
    sections = jsonLeftovers(ctx.sourceJson, mapped.usedPaths)
  } else {
    const result = fromText(ctx, fields, format)
    fields = result.fields
    sections = result.sections
    name = result.title ?? name
    notes = result.notes
  }

  const page = newPage(ctx, name, fields, sections, {
    mode: 'structural',
    model: null,
    servedByModel: null,
    promptVersion: null,
    recipeId: ctx.recipeId,
    recipeVersion: ctx.recipeVersion,
    generatedAt: ctx.now,
    inputTokens: null,
    outputTokens: null,
    detectedPageType: null,
    pageTypeConfidence: null,
  })
  page.reviewerNotes = ['Built without AI from the source’s own structure. Section text is copied verbatim; check that fields were matched correctly.', ...notes]
  return { page, mentions: [], tagCandidates: baseTagCandidates(ctx) }
}

/** Plain-text headings that start a game-mechanics section in statblocks. */
const STATBLOCK_HEADINGS = ['Traits', 'Actions', 'Bonus Actions', 'Reactions', 'Legendary Actions', 'Lair Actions', 'Mythic Actions', 'Regional Effects', 'Spellcasting']
const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const

function fromText(ctx: DraftContext, initial: PageField[], format: 'text' | 'markdown') {
  const nameNotes: string[] = []
  const fields = initial.map((field) => ({ ...field }))
  const fieldIndex = new Map(fields.map((field, i) => [field.key, i]))
  const labels = buildLabelIndex(ctx.pageType.fields, ctx.recipe)
  const setField = (key: string, value: string, quote: string | null, note: string): boolean => {
    const i = fieldIndex.get(key)
    if (i === undefined) return false
    const current = fields[i]!
    if (current.value !== null) {
      // The same field appears twice. Identical values are fine; different values are a
      // conflict for the reviewer, never resolved by picking one.
      const same = current.value.replace(/\s+/g, ' ').trim().toLowerCase() === value.replace(/\s+/g, ' ').trim().toLowerCase()
      if (!same) {
        fields[i] = { ...current, status: 'uncertain', note: `Conflicting values in the source: “${current.value}” and “${value}”. Check which is correct.` }
      }
      return false
    }
    fields[i] = { ...current, value, status: 'source', sourceQuote: quote, note }
    return true
  }
  const headings = [...new Set([...ctx.template.sections, ...STATBLOCK_HEADINGS])]

  const lines = ctx.sourceText.split('\n')
  const outline = format === 'markdown' ? markdownOutline(ctx.sourceText) : []
  const h1 = outline.length > 0 && outline[0]!.level === 1 ? outline[0]! : null
  const sectionLevel = outline.filter((e) => e !== h1).reduce((min, e) => Math.min(min, e.level), 7)

  const sections: PageSection[] = []
  // Text before the first heading is description, not mechanics (a template may list "Traits" first).
  const introHeading = ctx.template.sections.find((heading) => !MECHANICS_HEADINGS.has(heading.toLowerCase())) ?? 'Description'
  let current: { heading: string; lines: string[] } = { heading: introHeading, lines: [] }
  const flush = () => {
    const kind = MECHANICS_HEADINGS.has(current.heading.toLowerCase()) ? 'mechanics' : 'lore'
    // In statblock sections every entry ("Multiattack. …") is its own paragraph.
    const paragraphs = kind === 'mechanics' ? current.lines.map((l) => l.trim()).filter((l) => l !== '') : toParagraphs(current.lines)
    if (paragraphs.length > 0) sections.push({ id: sectionId(), heading: current.heading, kind, paragraphs })
  }
  const startSection = (heading: string) => {
    flush()
    current = { heading, lines: [] }
  }

  // For plain text the first line is used as the page name, so it is not repeated in the body.
  const titleLine = format === 'text' ? lines.findIndex((line) => line.trim() !== '') : -1
  const firstLine = titleLine === -1 ? '' : lines[titleLine]!.trim()
  const matchesName = titleLine !== -1 && ctx.sourceTitle !== null && firstLine === ctx.sourceTitle.trim()
  // A statblock's first line is the creature's name, even if you named the import differently.
  const nextLine = titleLine === -1 ? undefined : lines.slice(titleLine + 1).find((line) => line.trim() !== '')
  const statblockName =
    titleLine !== -1 &&
    !matchesName &&
    fieldIndex.has('size') &&
    firstLine.length <= 80 &&
    !/[.:;]$/.test(firstLine) &&
    matchLabel(firstLine, labels) === null &&
    nextLine !== undefined &&
    readTypeLine(nextLine) !== null
  const usePlainTitle = matchesName || statblockName
  if (statblockName && ctx.sourceTitle !== null) {
    nameNotes.push(`The first line “${firstLine}” was read as the creature’s name; the page keeps the name you gave the import (“${ctx.sourceTitle}”).`)
  }

  let inFence = false
  let contentLines = 0
  let pendingHeader: ReturnType<typeof abilityHeader> = null
  const saves: Partial<Record<(typeof ABILITY_KEYS)[number], string>> = {}

  for (const [index, line] of lines.entries()) {
    if (usePlainTitle && index === titleLine) continue
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) {
      current.lines.push(line)
      continue
    }
    const heading = format === 'markdown' ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (heading) {
      if (h1 && heading[1]!.length === 1 && heading[2] === h1.heading) continue
      if (heading[1]!.length <= sectionLevel || plainHeading(heading[2]!, STATBLOCK_HEADINGS)) {
        startSection(heading[2]!)
        continue
      }
      current.lines.push(`${heading[2]}`)
      continue
    }
    if (line.trim() === '') {
      current.lines.push(line)
      continue
    }

    const plain = plainHeading(line, headings)
    if (plain) {
      startSection(plain)
      continue
    }

    // The creature type line, near the top: "Small Humanoid (Goblinoid), Neutral Evil".
    if (contentLines < 3 && fieldIndex.has('size')) {
      const type = readTypeLine(line)
      if (type) {
        setField('size', type.size, line.trim(), 'Read from the type line.')
        setField('creatureType', type.creatureType, line.trim(), 'Read from the type line.')
        setField('alignment', type.alignment, line.trim(), 'Read from the type line.')
        contentLines++
        continue
      }
    }
    contentLines++

    // Ability scores: a header row followed by a value row (2014 table layout).
    const header = abilityHeader(line)
    if (header && fieldIndex.has('str')) {
      pendingHeader = header
      continue
    }
    if (pendingHeader) {
      if (isTableNoise(line)) continue
      const values = abilityValues(line)
      if (values) {
        pendingHeader.forEach((ability, i) => setField(ability, values[i]!, line.trim(), 'Read from the ability score table.'))
        pendingHeader = null
        continue
      }
      pendingHeader = null
    }
    if (/^\s*\|?\s*(?:mod(?:ifier)?)\s*\|?\s*save\s*\|?\s*$/i.test(line) && fieldIndex.has('str')) continue

    // Ability scores written inline (2014: "STR 19 (+4) …"; 2024: "Str 10 +0 +0").
    let text = line
    if (fieldIndex.has('str')) {
      const abilities = readAbilityLine(line)
      if (abilities) {
        for (const key of ABILITY_KEYS) {
          if (abilities.scores[key]) setField(key, abilities.scores[key]!, line.trim(), 'Read from the ability scores.')
          if (abilities.saves[key]) saves[key] = abilities.saves[key]
        }
        if (abilities.rest === '') continue
        text = abilities.rest
      }
    }

    // "Label value" segments: "AC 17", "HP 21 (6d6)", "Armor Class: 15", "**Speed** 30 ft." …
    const segments = splitSegments(text)
    const unmatched = segments.filter((segment) => {
      const match = matchLabel(segment, labels)
      return !(match && setField(match.fieldKey, match.value, segment.trim(), `Matched by the label “${match.label}”.`))
    })
    if (unmatched.length === 0) continue
    current.lines.push(unmatched.length === segments.length && text === line ? line : unmatched.join('   '))
  }
  flush()

  // 2024 statblocks give every saving throw in the SAVE column; keep them verbatim.
  const saveList = ABILITY_KEYS.filter((key) => saves[key]).map((key) => `${key[0]!.toUpperCase()}${key.slice(1)} ${saves[key]}`)
  if (saveList.length > 0) setField('savingThrows', saveList.join(', '), null, 'Copied from the SAVE column of the ability table.')

  return { fields, sections, title: h1?.heading ?? (matchesName ? ctx.sourceTitle : statblockName ? (ctx.sourceTitle ?? firstLine) : null), notes: nameNotes }
}

/** Recognises `Key: Value`, `**Key:** Value`, `**Key.** Value` and `**Key** Value`. */
export function keyValueLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim().replace(/^[-*]\s+/, '')
  const bold = /^\*\*([^*]{1,60}?)[:.]?\*\*[:.]?\s+(.+)$/.exec(trimmed)
  if (bold) return { key: bold[1]!.trim(), value: bold[2]!.trim() }
  const plain = /^([A-Za-z][A-Za-z ]{0,40}):\s+(.+)$/.exec(trimmed)
  if (plain) return { key: plain[1]!.trim(), value: plain[2]!.trim() }
  return null
}

function toParagraphs(lines: string[]): string[] {
  const out: string[] = []
  let buffer: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (buffer.length) out.push(buffer.join('\n').trim())
      buffer = []
    } else {
      buffer.push(line)
    }
  }
  if (buffer.length) out.push(buffer.join('\n').trim())
  return out.filter((p) => p !== '')
}

function jsonLeftovers(json: unknown, usedPaths: string[]): PageSection[] {
  const object = Array.isArray(json) ? json[0] : json
  if (!object || typeof object !== 'object') {
    const text = jsonValueToText(json)
    return text ? [{ id: sectionId(), heading: 'Unsorted source material', kind: 'unmapped', paragraphs: [text] }] : []
  }
  const usedTop = new Set(usedPaths.map((p) => p.split(/[.[]/)[0]))
  const paragraphs = Object.keys(object as Record<string, unknown>)
    .filter((key) => !usedTop.has(key) && !['name', 'title', 'Name', 'Title'].includes(key))
    .map((key) => `${key}: ${jsonValueToText(getByPath(object, key)) ?? ''}`)
  return paragraphs.length ? [{ id: sectionId(), heading: 'Unsorted source material', kind: 'unmapped', paragraphs }] : []
}
