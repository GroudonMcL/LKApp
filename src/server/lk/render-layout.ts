import { br, h, links, property, walk, type Block, type Run } from '@legendkeeper/sdk/blocks'
import { isEmptyImage, isPlaceholderBlock, matchLayoutKey, type LkLayout } from '@/core/lk-layout'
import { resolvedReferences, writableFields, type CanonicalPage, type PageSection } from '@/core/page-model'
import type { PageTypeDefinition } from '@/core/page-types'
import type { LayoutRules } from '@/core/template'
import { boldEntryName, inlineRuns, mentionTargets, paragraphBlocks, sourcesBlocks } from './render-text'

/**
 * Fills a layout copied from LegendKeeper (see `src/core/lk-layout.ts`) with a draft.
 *
 * The same rules as the app's own renderer apply: only confirmed values (`source` or `user`)
 * are written, only resolved references become links, and mechanics stay apart from lore.
 *
 * Infobox fields keep the template's order exactly. The template's layout rules decide the rest:
 * fields and sections the source has nothing for stay, blank, or are removed; fields the
 * template has no row for are added in line (where they come in the page type's field order,
 * which is the order of a statblock), or not at all. Template example text is never copied into
 * the page, and empty spacer paragraphs stay as they are. Block and row ids in the layout are
 * kept, so the result can be written back into a copy of the template block by block (see
 * core/template-fill.ts).
 *
 * Pure: no network, no database.
 */

export interface LayoutRenderOptions {
  /**
   * Keep empty image slots. LegendKeeper refuses to *create* one, so only a page that already
   * has the slot (a copy of the template, filled block by block) can keep it.
   */
  keepEmptyImages?: boolean
  /** How strictly the page follows the template (the template's own setting). */
  rules?: LayoutRules
  /** Filled in with what the page has but the template leaves no place for (rules.additions = none). */
  report?: { leftOut: string[] }
}

const DEFAULT_RULES: LayoutRules = { emptyFields: 'keep', emptySections: 'remove', additions: 'add' }
/** A text box that takes whatever has no place of its own, when the template adds nothing. */
const NOTES_TITLE = /^(notes?|other|misc(ellaneous)?|additional( notes| information)?)$/i

type AnyBlock = Record<string, unknown>
type Row = { key: string; fieldKeys: string[]; rank: number }

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

export function renderFromLayout(page: CanonicalPage, pageType: PageTypeDefinition, layout: LkLayout, includeSources: boolean, options: LayoutRenderOptions = {}): Block[] {
  const rules = options.rules ?? DEFAULT_RULES
  const leftOut = (what: string) => options.report?.leftOut.push(what)
  const targets = mentionTargets(page)
  const values = new Map(writableFields(page).map((field) => [field.key, field.value!.trim()]))
  const template = structuredClone(layout.blocks) as AnyBlock[]

  // Which fields each key-value row holds. A field with its own row is not repeated in a
  // combined row ("Immunities" keeps only what "Condition Immunities" does not take).
  const rowsOf = new Map<AnyBlock, Row[]>()
  const keyValues: { block: AnyBlock; inInfobox: boolean }[] = []
  const collect = (block: AnyBlock, inInfobox: boolean) => {
    if (block.kind === 'keyValue' && Array.isArray(block.rows)) {
      keyValues.push({ block, inInfobox })
      rowsOf.set(
        block,
        (block.rows as AnyBlock[]).map((row) => ({ key: String(row.key ?? ''), ...matchLayoutKey(String(row.key ?? ''), pageType) })),
      )
      return
    }
    for (const key of ['children', 'rows']) {
      const inner = block[key]
      if (Array.isArray(inner)) for (const child of inner as AnyBlock[]) if (child && typeof child === 'object') collect(child, inInfobox || block.kind === 'infobox')
    }
  }
  template.forEach((block) => collect(block, false))

  // Hidden text boxes whose example text names what goes there: "Description text" takes the
  // description; "Holy symbol description" takes the Holy symbol field.
  const slots = new Map<AnyBlock, { kind: 'description' } | { kind: 'field'; key: string }>()
  const findSlots = (block: AnyBlock, depth: number) => {
    if (block.kind === 'textField' && (block.isTitleHidden === true || depth > 0) && Array.isArray(block.children)) {
      const children = block.children as AnyBlock[]
      if (children.length && children.every((child) => child.kind === 'paragraph')) {
        const text = children.map((child) => headingText(child)).join(' ').trim()
        if (/^(?:\[[^\]]+\]\s*)?description(?:\s+text)?$/i.test(text)) slots.set(block, { kind: 'description' })
        else {
          const field = [...pageType.fields].sort((a, b) => b.label.length - a.label.length).find((f) => norm(text).startsWith(norm(f.label)) && norm(f.label).length >= 4)
          if (field) slots.set(block, { kind: 'field', key: field.key })
        }
      }
    }
    for (const key of ['children', 'rows']) {
      const inner = block[key]
      if (Array.isArray(inner)) for (const child of inner as AnyBlock[]) if (child && typeof child === 'object') findSlots(child, depth + 1)
    }
  }
  template.forEach((block) => findSlots(block, 0))
  const slotFields = new Set([...slots.values()].flatMap((slot) => (slot.kind === 'field' ? [slot.key] : [])))

  const allRows = [...rowsOf.values()].flat()
  // A field goes to the one row that matches it best ("Professions" over "Class" for Occupation),
  // never to several; the other rows stay as the template has them (blank, or removed).
  const best = new Map<string, Row>()
  for (const row of allRows) {
    if (row.fieldKeys.length !== 1) continue
    const field = row.fieldKeys[0]!
    const current = best.get(field)
    if (!current || row.rank < current.rank) best.set(field, row)
  }
  for (const row of allRows) if (row.fieldKeys.length === 1 && best.get(row.fieldKeys[0]!) !== row) row.fieldKeys = []
  const dedicated = new Set(allRows.filter((row) => row.fieldKeys.length === 1).map((row) => row.fieldKeys[0]!))
  for (const row of allRows) if (row.fieldKeys.length > 1) row.fieldKeys = row.fieldKeys.filter((key) => !dedicated.has(key))
  const covered = new Set([...allRows.flatMap((row) => row.fieldKeys), ...slotFields])

  // Fields with a value but no row of their own. With additions, each goes in line: after the
  // template row that comes just before it in the page type's field order (a statblock's order),
  // so "Condition Immunities" lands after "Immunities", not at the end. The template's own rows
  // never move.
  const order = pageType.fields.map((field) => field.key)
  const extra = order.filter((key) => values.has(key) && !covered.has(key))
  const groups = keyValues.some((kv) => kv.inInfobox) ? keyValues.filter((kv) => kv.inInfobox) : keyValues
  const firstGroup = groups[0]?.block
  const lastGroup = groups[groups.length - 1]?.block
  /** Per group: extra field keys to add after its row i (-1: before its first row). */
  const extrasAt = new Map<AnyBlock, Map<number, string[]>>()
  if (rules.additions === 'add' && firstGroup) {
    const anchors = groups.flatMap(({ block }) =>
      (rowsOf.get(block) ?? []).map((row, i) => ({ block, i, at: Math.min(...row.fieldKeys.map((key) => order.indexOf(key)).filter((n) => n >= 0), Infinity) })),
    ).filter((anchor) => anchor.at !== Infinity)
    for (const key of extra) {
      const at = order.indexOf(key)
      const before = anchors.filter((anchor) => anchor.at < at).sort((a, b) => b.at - a.at)[0]
      const after = anchors.filter((anchor) => anchor.at > at).sort((a, b) => a.at - b.at)[0]
      const place = before ? { block: before.block, i: before.i } : after ? { block: after.block, i: after.i - 1 } : { block: lastGroup!, i: (rowsOf.get(lastGroup!) ?? []).length - 1 }
      const forGroup = extrasAt.get(place.block) ?? new Map<number, string[]>()
      forGroup.set(place.i, [...(forGroup.get(place.i) ?? []), key])
      extrasAt.set(place.block, forGroup)
    }
  } else if (rules.additions === 'none') {
    for (const key of extra) leftOut(`the field “${pageType.fields.find((field) => field.key === key)?.label ?? key}”`)
  }

  const sourceLine = page.sources.map((source) => `${source.title}${source.citation ? ` (${source.citation})` : ''}`).join('; ')
  const labelOf = (key: string) => pageType.fields.find((field) => field.key === key)?.label ?? key
  const valueRuns = (text: string): Run[] => {
    const runs: Run[] = []
    text.split('\n').forEach((line, i) => {
      if (i > 0) runs.push(br)
      runs.push(...inlineRuns(line, targets, new Set()))
    })
    return runs
  }
  const extraRows = (keys: string[]) => keys.map((key) => ({ key: labelOf(key), content: valueRuns(values.get(key)!) }))

  let sections = page.sections.filter((section) => section.paragraphs.some((paragraph) => paragraph.trim() !== ''))
  // A template with a quote slot at the top level gets the source's first quotation there.
  const isQuote = (paragraph: string) => paragraph.trim() !== '' && paragraph.split('\n').every((line) => /^\s*>/.test(line))
  let pulledQuote: string | null = null
  if (template.some((block) => block.kind === 'quote')) {
    sections = sections.map((section) => {
      if (pulledQuote !== null || section.kind === 'mechanics') return section
      const at = section.paragraphs.findIndex(isQuote)
      if (at === -1) return section
      pulledQuote = section.paragraphs[at]!
      return { ...section, paragraphs: section.paragraphs.filter((_, i) => i !== at) }
    }).filter((section) => section.paragraphs.some((paragraph) => paragraph.trim() !== ''))
  }
  const placed = new Set<PageSection>()
  // All sections with the block's title, merged (a source can repeat a heading).
  const sectionFor = (title: string): PageSection | undefined => {
    const found = sections.filter((section) => !placed.has(section) && norm(section.heading) === norm(title))
    found.forEach((section) => placed.add(section))
    return found.length ? { ...found[0]!, paragraphs: found.flatMap((section) => section.paragraphs) } : undefined
  }
  const sectionChildren = (section: PageSection): Block[] => {
    const linked = new Set<string>()
    return section.paragraphs.flatMap((paragraph) =>
      paragraphBlocks(section.kind === 'mechanics' ? boldEntryName(paragraph) : paragraph, section.kind === 'unmapped' ? new Map() : targets, linked),
    )
  }

  let nameWritten = false
  let topIndex = 0
  // Extra tags named in a template instruction such as "tag the [Class] name and the Subclass tag".
  const instruction = /tag the \[[^\]]+\] name and the ([\p{L}\p{N} '\-]+?) tag/iu.exec(JSON.stringify(template))
  const tagIndexExtras = instruction ? [instruction[1]!.trim()] : []
  const fill = (block: AnyBlock, depth: number): AnyBlock | null => {
    switch (block.kind) {
      case 'keyValue': {
        // Every template row, in the template's order: its value, or blank (or left out, when the
        // template's rules remove empty fields). The row keeps its id and position; its example
        // value (and the read-only `text`) is not copied. Extra fields go in line.
        const originals = block.rows as AnyBlock[]
        const inline = extrasAt.get(block)
        const rows: AnyBlock[] = [...extraRows(inline?.get(-1) ?? [])]
        ;(rowsOf.get(block) ?? []).forEach((row, i) => {
          const { text: _exampleText, content: _exampleContent, ...kept } = originals[i] ?? {}
          let text = row.fieldKeys.filter((key) => values.has(key)).map((key) => values.get(key)!).join('; ')
          // A "Source" row that matches no field gets where the page's content came from.
          if (!text && row.fieldKeys.length === 0 && /^sources?$/.test(norm(row.key))) text = sourceLine
          if (text || rules.emptyFields === 'keep') rows.push({ ...kept, key: row.key, content: text ? valueRuns(text) : [] })
          rows.push(...extraRows(inline?.get(i) ?? []))
        })
        return rows.length || rules.emptyFields === 'keep' ? { ...block, rows } : null
      }
      case 'heading': {
        const text = headingText(block)
        // "[Spell] Name", "[Magic Item] Name": the template's slot for the page name.
        if (/^\s*\[[^\]]+\]\s*name\s*$/i.test(text)) {
          nameWritten = true
          return { ...block, content: [{ text: page.name.trim() }] }
        }
        // A big heading that opens the page (or sits in the infobox) is the name, unless it is a placeholder.
        if (!nameWritten && block.level === 1 && (depth > 0 || topIndex === 0) && !/[[@]/.test(text)) {
          nameWritten = true
          return { ...block, content: [{ text: page.name.trim() }] }
        }
        // "From @Source Link": the template's slot for the source.
        if (text.includes('@')) {
          const source = page.sources[0]
          return source ? { ...block, content: [{ text: `From ${source.title}${source.citation ? ` (${source.citation})` : ''}` }] } : null
        }
        // "Becoming a [Class]" → "Becoming a Tidecaller".
        if (/\[[^\]]+\]/.test(text)) return { ...block, content: [{ text: text.replace(/\[[^\]]+\]/g, page.name.trim()).replace(/\s+/g, ' ').trim() }] }
        return block
      }
      case 'resourceCollection': {
        // An empty tag index: fill it as the template's own instructions say (e.g. "tag the
        // [Class] name and the Subclass tag"), or with the page's name.
        const filter = block.filter as { filterType?: string; tags?: string[] } | undefined
        if (filter?.filterType === 'tag' && Array.isArray(filter.tags) && filter.tags.length === 0) {
          return { ...block, filter: { ...filter, tags: [page.name.trim(), ...tagIndexExtras] } }
        }
        return block
      }
      case 'textField': {
        if (depth === 0 && typeof block.title === 'string' && block.isTitleHidden !== true) {
          const section = sectionFor(block.title)
          if (section) return { ...block, children: sectionChildren(section) }
          // Nothing for this section: kept, blank, or removed, as the template's rules say.
          return rules.emptySections === 'keep' ? { ...block, children: [{ kind: 'paragraph', content: [] }] } : null
        }
        // A field slot without a value stays, blank (its example text removed), unless the
        // template's rules remove empty fields.
        const blank = rules.emptyFields === 'keep' ? { ...block, children: [{ kind: 'paragraph', content: [] }] } : null
        const slot = slots.get(block)
        if (slot?.kind === 'field') {
          const value = values.get(slot.key)
          return value ? { ...block, children: paragraphBlocks(value, targets, new Set()) } : blank
        }
        if (slot?.kind === 'description') {
          const lore = sections.filter((section) => section.kind !== 'mechanics' && !placed.has(section))
          const chosen = lore.find((section) => norm(section.heading) === 'description') ?? lore[0]
          if (!chosen) return blank
          placed.add(chosen)
          return { ...block, children: sectionChildren(chosen) }
        }
        // A text block inside the infobox, or one without a title: keep its structure (the
        // name heading, images, nested key-values) and drop its example text. Inside the
        // infobox it stays even when nothing is left, so the template's fields are all there.
        const children = fillChildren(block.children, depth)
        return children.length ? { ...block, children } : depth > 0 ? blank : null
      }
      case 'infobox': {
        // The infobox is always kept, with every one of its fields (blank where there is no value).
        return { ...block, rows: fillChildren(block.rows, depth) }
      }
      case 'image':
        // An empty image slot can only stay on a page that already has it (a template copy).
        return isEmptyImage(block) && !options.keepEmptyImages ? null : block
      default: {
        if (depth > 0 && isPlaceholderBlock(block)) return null
        if (Array.isArray(block.children)) {
          // A table whose cells were all example text is left out, not kept as an empty grid.
          if (block.kind === 'table' && !hasText(fillChildren(block.children, depth))) return null
          const children = fillChildren(block.children, depth)
          // A layout column the template keeps as an empty spacer stays one (with an empty paragraph).
          if (block.kind === 'layoutColumn' && children.length === 0) return { ...block, children: [{ kind: 'paragraph', content: [] }] }
          return { ...block, children }
        }
        return block
      }
    }
  }
  const fillChildren = (items: unknown, depth: number): AnyBlock[] =>
    Array.isArray(items) ? (items as AnyBlock[]).map((child) => fill(child, depth + 1)).filter((child): child is AnyBlock => child !== null) : []

  const loreBlocksExtra: AnyBlock[] = []
  // Walk the top level. The first run of free paragraphs marks where the description goes;
  // the last text block marks where extra mechanics sections go.
  const out: AnyBlock[] = []
  let descriptionAt = -1
  let mechanicsAt = -1
  for (const block of template) {
    const isName = block.kind === 'heading' && !nameWritten && ((block.level === 1 && topIndex === 0 && !/[[@]/.test(headingText(block))) || /^\s*\[[^\]]+\]\s*name\s*$/i.test(headingText(block)))
    if (block.kind === 'quote' && pulledQuote !== null) {
      out.push(...(paragraphBlocks(pulledQuote, targets, new Set()) as unknown as AnyBlock[]))
      pulledQuote = null
      topIndex++
      continue
    }
    // A quote box with nothing to quote: kept, blank, when empty sections stay.
    if (block.kind === 'quote' && rules.emptySections === 'keep') {
      out.push({ ...block, children: [{ kind: 'paragraph', content: [] }] })
      topIndex++
      continue
    }
    if (!isName && isPlaceholderBlock(block)) {
      if (descriptionAt === -1) descriptionAt = out.length
      // An empty paragraph is a spacer in the template's layout, not example text: it stays.
      if (block.kind === 'paragraph' && !hasText([block])) out.push(block)
      topIndex++
      continue
    }
    const filled = fill(block, 0)
    topIndex++
    if (filled) out.push(filled)
    if (block.kind === 'textField' || block.kind === 'infobox') mechanicsAt = out.length
  }
  if (!firstGroup && extra.length && rules.additions === 'add') {
    // The layout has no key-value block at all: put the fields in one after the infobox (or at the top).
    const at = out.findIndex((block) => block.kind === 'infobox') + 1
    out.splice(at, 0, { kind: 'keyValue', rows: extraRows(extra) })
    if (descriptionAt >= at) descriptionAt++
    if (mechanicsAt >= at) mechanicsAt++
  }

  let rest = sections.filter((section) => !placed.has(section))
  // Adding nothing to the template: sections without a box of their own go into its Notes box
  // (under a bold heading), or else into its description area; with neither, they are reported.
  const boldHeading = (text: string): AnyBlock => ({ kind: 'paragraph', content: [{ text, bold: true }] })
  if (rules.additions === 'none') {
    const notes = out.find((block) => block.kind === 'textField' && typeof block.title === 'string' && NOTES_TITLE.test(block.title.trim()))
    const hasArea = descriptionAt !== -1
    const firstLore = rest.find((section) => section.kind !== 'mechanics')
    // Only the description itself goes into the description area when there is a Notes box.
    const toArea = hasArea && firstLore && (!notes || /^(description|overview|summary|appearance)$/.test(norm(firstLore.heading))) ? [firstLore] : []
    const leftovers = rest.filter((section) => !toArea.includes(section))
    if (notes) {
      const existing = ((notes.children as AnyBlock[]) ?? []).filter((child) => hasText([child]))
      notes.children = [...existing, ...leftovers.flatMap((section) => [boldHeading(section.heading), ...(sectionChildren(section) as unknown as AnyBlock[])])]
      rest = toArea
    } else if (!hasArea) {
      for (const section of leftovers) leftOut(`the section “${section.heading}”`)
      rest = []
    }
    // Otherwise everything goes into the description area, as text under bold headings.
  }
  const mechanics = rest.filter((section) => section.kind === 'mechanics')
  const lore = rest.filter((section) => section.kind !== 'mechanics')
  const mechanicsBlocks: AnyBlock[] = []
  for (const section of mechanics) {
    const merged = sectionFor(section.heading)
    if (!merged) continue
    // Adding nothing: in the description area as text under a bold heading, not as a new box.
    if (rules.additions === 'none') loreBlocksExtra.push(boldHeading(section.heading), ...(sectionChildren(merged) as unknown as AnyBlock[]))
    else mechanicsBlocks.push({ kind: 'textField', title: section.heading, isTitleHidden: false, children: sectionChildren(merged) })
  }
  const loreBlocks: AnyBlock[] = [
    ...lore.flatMap((section, i) => [
      // The first lore section fills the template's description slot; a "Description" heading would repeat it.
      ...(i === 0 && descriptionAt !== -1 && norm(section.heading) === 'description' ? [] : [rules.additions === 'none' ? boldHeading(section.heading) : h(2, section.heading)]),
      ...sectionChildren(section),
    ]),
    ...loreBlocksExtra,
  ]

  if (mechanicsAt === -1) mechanicsAt = descriptionAt === -1 ? out.length : descriptionAt
  if (descriptionAt === -1) descriptionAt = out.length
  // Insert at the later position first so the earlier index stays valid.
  const inserts = [
    { at: mechanicsAt, blocks: mechanicsBlocks, order: 0 },
    { at: descriptionAt, blocks: loreBlocks, order: 1 },
  ].sort((a, b) => b.at - a.at || b.order - a.order)
  for (const insert of inserts) out.splice(insert.at, 0, ...insert.blocks)

  // References that did not become a link anywhere in the text are listed in the infobox.
  const linkedIds = new Set<string>()
  walk(out as Block[], (block) => {
    for (const run of contentRuns(block)) if (run.mention?.resourceId) linkedIds.add(run.mention.resourceId)
  })
  const unlinked = [...new Set(resolvedReferences(page).map((ref) => ref.resourceId!))].filter((id) => !linkedIds.has(id))
  if (unlinked.length) {
    const box = out.find((block) => block.kind === 'infobox')
    const notes = out.find((block) => block.kind === 'textField' && typeof block.title === 'string' && NOTES_TITLE.test(block.title.trim()))
    if (rules.additions === 'none') {
      // Adding nothing: listed in the Notes box if there is one.
      if (notes) notes.children = [...((notes.children as AnyBlock[]) ?? []).filter((child) => hasText([child])), boldHeading('Related'), links(unlinked) as unknown as AnyBlock]
      else leftOut('the list of related pages')
    } else if (box) box.rows = [...(box.rows as AnyBlock[]), property(links(unlinked), { title: 'Related' }) as unknown as AnyBlock]
    else out.push(h(2, 'Related') as unknown as AnyBlock, links(unlinked) as unknown as AnyBlock)
  }

  // A divider that ended up last separated nothing (e.g. before an empty source section).
  while (out.length && out[out.length - 1]!.kind === 'rule') out.pop()
  if (includeSources) out.push(...(sourcesBlocks(page) as unknown as AnyBlock[]))
  return out as unknown as Block[]
}

function hasText(blocks: AnyBlock[]): boolean {
  let found = false
  walk(blocks as unknown as Block[], (block) => {
    const content = (block as unknown as AnyBlock).content
    if (Array.isArray(content) && content.some((run) => typeof (run as { text?: string }).text === 'string' && (run as { text: string }).text.trim() !== '')) found = true
  })
  return found
}

function headingText(block: AnyBlock): string {
  return ((block.content as { text?: string }[] | undefined) ?? []).map((run) => run.text ?? '').join('')
}

function contentRuns(block: unknown): { mention?: { resourceId?: string } }[] {
  const b = block as { content?: unknown; rows?: unknown }
  const runs: { mention?: { resourceId?: string } }[] = []
  if (Array.isArray(b.content)) runs.push(...(b.content as { mention?: { resourceId?: string } }[]))
  if (Array.isArray(b.rows)) for (const row of b.rows as { content?: unknown }[]) if (Array.isArray(row?.content)) runs.push(...(row.content as { mention?: { resourceId?: string } }[]))
  return runs
}
