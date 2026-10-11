import { applyJsonMappings, baseTagCandidates, emptyFields, MECHANICS_HEADINGS, newPage, sectionId, type DraftBuildResult, type DraftContext } from './draft-common'
import { getByPath, jsonValueToText, markdownOutline } from './extraction'
import type { PageField, PageSection } from './page-model'

/**
 * The structural transformer builds a draft without AI, using only the source's own
 * structure. It never interprets or rewrites text:
 * - Markdown headings become sections; text before the first heading goes into the
 *   template's first section.
 * - Lines like `Armor Class: 15`, `**Armor Class** 15` or `**Armor Class.** 15` fill the
 *   field with that exact label (case-insensitive). The line is then not repeated in the body.
 * - JSON sources use the recipe's field mappings; other JSON keys are kept as unsorted
 *   source material.
 *
 * It is used when AI is switched off, and as a baseline that needs no API key.
 */
export function buildStructuralDraft(ctx: DraftContext, format: 'text' | 'markdown' | 'json'): DraftBuildResult {
  let fields = emptyFields(ctx.pageType)
  let sections: PageSection[] = []
  let name = ctx.sourceTitle ?? 'Untitled'

  if (format === 'json') {
    const mapped = applyJsonMappings(fields, ctx.recipe, ctx.sourceJson)
    fields = mapped.fields
    sections = jsonLeftovers(ctx.sourceJson, mapped.usedPaths)
  } else {
    const result = fromText(ctx, fields, format)
    fields = result.fields
    sections = result.sections
    name = result.title ?? name
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
  page.reviewerNotes = ['Built without AI from the source’s own structure. Section text is copied verbatim; check that fields were matched correctly.']
  return { page, mentions: [], tagCandidates: baseTagCandidates(ctx) }
}

function fromText(ctx: DraftContext, initial: PageField[], format: 'text' | 'markdown') {
  const fields = initial.map((field) => ({ ...field }))
  const labelIndex = new Map<string, number>()
  fields.forEach((field, i) => {
    labelIndex.set(field.label.toLowerCase(), i)
    labelIndex.set(field.key.toLowerCase(), i)
  })

  const lines = ctx.sourceText.split('\n')
  const outline = format === 'markdown' ? markdownOutline(ctx.sourceText) : []
  const h1 = outline.length > 0 && outline[0]!.level === 1 ? outline[0]! : null
  const sectionLevel = outline.filter((e) => e !== h1).reduce((min, e) => Math.min(min, e.level), 7)

  const sections: PageSection[] = []
  let current: { heading: string; lines: string[] } = { heading: ctx.template.sections[0] ?? 'Description', lines: [] }
  const flush = () => {
    const paragraphs = toParagraphs(current.lines)
    if (paragraphs.length > 0) {
      const kind = MECHANICS_HEADINGS.has(current.heading.toLowerCase()) ? 'mechanics' : 'lore'
      sections.push({ id: sectionId(), heading: current.heading, kind, paragraphs })
    }
  }

  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const heading = !inFence && format === 'markdown' ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (heading) {
      if (h1 && heading[1]!.length === 1 && heading[2] === h1.heading) continue
      if (heading[1]!.length <= sectionLevel) {
        flush()
        current = { heading: heading[2]!, lines: [] }
        continue
      }
      current.lines.push(`${heading[2]}`)
      continue
    }
    const pair = inFence ? null : keyValueLine(line)
    if (pair) {
      const index = labelIndex.get(pair.key.toLowerCase())
      if (index !== undefined && fields[index]!.value === null) {
        fields[index] = { ...fields[index]!, value: pair.value, status: 'source', sourceQuote: line.trim(), note: 'Matched by label.' }
        continue
      }
    }
    current.lines.push(line)
  }
  flush()
  return { fields, sections, title: h1?.heading ?? null }
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
