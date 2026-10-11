import { br, h, links, property, walk, type Block, type Run } from '@legendkeeper/sdk/blocks'
import { fieldsForLayoutKey, isEmptyImage, isPlaceholderBlock, type LkLayout } from '@/core/lk-layout'
import { resolvedReferences, writableFields, type CanonicalPage, type PageSection } from '@/core/page-model'
import type { PageTypeDefinition } from '@/core/page-types'
import { boldEntryName, inlineRuns, mentionTargets, paragraphBlocks, sourcesBlocks } from './render-text'

/**
 * Fills a layout copied from LegendKeeper (see `src/core/lk-layout.ts`) with a draft.
 *
 * The same rules as the app's own renderer apply: only confirmed values (`source` or `user`)
 * are written, only resolved references become links, and mechanics stay apart from lore.
 * Template text is never copied into the page: rows without a value are left out, text blocks
 * without a matching section are left out, and placeholder paragraphs are replaced.
 *
 * Pure: no network, no database.
 */

type AnyBlock = Record<string, unknown>
type Row = { key: string; fieldKeys: string[] }

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

export function renderFromLayout(page: CanonicalPage, pageType: PageTypeDefinition, layout: LkLayout, includeSources: boolean): Block[] {
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
        (block.rows as AnyBlock[]).map((row) => ({ key: String(row.key ?? ''), fieldKeys: fieldsForLayoutKey(String(row.key ?? ''), pageType) })),
      )
      return
    }
    for (const key of ['children', 'rows']) {
      const inner = block[key]
      if (Array.isArray(inner)) for (const child of inner as AnyBlock[]) if (child && typeof child === 'object') collect(child, inInfobox || block.kind === 'infobox')
    }
  }
  template.forEach((block) => collect(block, false))
  const allRows = [...rowsOf.values()].flat()
  const dedicated = new Set(allRows.filter((row) => row.fieldKeys.length === 1).map((row) => row.fieldKeys[0]!))
  for (const row of allRows) if (row.fieldKeys.length > 1) row.fieldKeys = row.fieldKeys.filter((key) => !dedicated.has(key))
  const covered = new Set(allRows.flatMap((row) => row.fieldKeys))

  // Fields with no row of their own: those that come before the first covered field (e.g. size,
  // type and alignment) open the first group; the rest close the last group.
  const order = pageType.fields.map((field) => field.key)
  const firstCovered = Math.min(...order.map((key, i) => (covered.has(key) ? i : Infinity)))
  const extra = order.filter((key) => values.has(key) && !covered.has(key))
  const extraBefore = extra.filter((key) => order.indexOf(key) < firstCovered)
  const extraAfter = extra.filter((key) => order.indexOf(key) >= firstCovered)
  const groups = keyValues.some((kv) => kv.inInfobox) ? keyValues.filter((kv) => kv.inInfobox) : keyValues
  const firstGroup = groups[0]?.block
  const lastGroup = groups[groups.length - 1]?.block

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

  const sections = page.sections.filter((section) => section.paragraphs.some((paragraph) => paragraph.trim() !== ''))
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
  const fill = (block: AnyBlock, depth: number): AnyBlock | null => {
    switch (block.kind) {
      case 'keyValue': {
        const rows = (rowsOf.get(block) ?? []).map((row) => {
          const text = row.fieldKeys.filter((key) => values.has(key)).map((key) => values.get(key)!).join('; ')
          return { key: row.key, content: text ? valueRuns(text) : [] }
        })
        if (block === firstGroup) rows.unshift(...extraRows(extraBefore))
        if (block === lastGroup) rows.push(...extraRows(extraAfter))
        // Rows with nothing to show are left out, and a group with no rows at all goes too.
        const filled = rows.filter((row) => row.content.length > 0)
        return filled.length ? { ...block, rows: filled } : null
      }
      case 'heading':
        if (!nameWritten && block.level === 1) {
          nameWritten = true
          return { ...block, content: [{ text: page.name.trim() }] }
        }
        return depth === 0 ? block : null
      case 'textField': {
        if (depth === 0 && typeof block.title === 'string' && block.isTitleHidden !== true) {
          const section = sectionFor(block.title)
          return section ? { ...block, children: sectionChildren(section) } : null
        }
        // A text block inside the infobox, or one without a title: keep its structure (the
        // name heading, images, nested key-values) and drop its example text.
        const children = fillChildren(block.children, depth)
        return children.length ? { ...block, children } : null
      }
      case 'infobox': {
        const rows = fillChildren(block.rows, depth)
        return rows.length ? { ...block, rows } : null
      }
      case 'image':
        // Layouts copied before empty image slots were dropped may still hold one.
        return isEmptyImage(block) ? null : block
      default: {
        if (depth > 0 && isPlaceholderBlock(block)) return null
        if (Array.isArray(block.children)) return { ...block, children: fillChildren(block.children, depth) }
        return block
      }
    }
  }
  const fillChildren = (items: unknown, depth: number): AnyBlock[] =>
    Array.isArray(items) ? (items as AnyBlock[]).map((child) => fill(child, depth + 1)).filter((child): child is AnyBlock => child !== null) : []

  // Walk the top level. The first run of free paragraphs marks where the description goes;
  // the last text block marks where extra mechanics sections go.
  const out: AnyBlock[] = []
  let descriptionAt = -1
  let mechanicsAt = -1
  for (const block of template) {
    const isName = block.kind === 'heading' && block.level === 1 && !nameWritten
    if (!isName && isPlaceholderBlock(block)) {
      if (descriptionAt === -1) descriptionAt = out.length
      continue
    }
    const filled = fill(block, 0)
    if (filled) out.push(filled)
    if (block.kind === 'textField' || block.kind === 'infobox') mechanicsAt = out.length
  }
  if (!firstGroup && extra.length) {
    // The layout has no key-value block at all: put the fields in one after the infobox (or at the top).
    const at = out.findIndex((block) => block.kind === 'infobox') + 1
    out.splice(at, 0, { kind: 'keyValue', rows: extraRows(extra) })
    if (descriptionAt >= at) descriptionAt++
    if (mechanicsAt >= at) mechanicsAt++
  }

  const rest = sections.filter((section) => !placed.has(section))
  const mechanics = rest.filter((section) => section.kind === 'mechanics')
  const lore = rest.filter((section) => section.kind !== 'mechanics')
  const mechanicsBlocks: AnyBlock[] = []
  for (const section of mechanics) {
    const merged = sectionFor(section.heading)
    if (merged) mechanicsBlocks.push({ kind: 'textField', title: section.heading, isTitleHidden: false, children: sectionChildren(merged) })
  }
  const loreBlocks: AnyBlock[] = lore.flatMap((section, i) => [
    // The first lore section fills the template's description slot; a "Description" heading would repeat it.
    ...(i === 0 && descriptionAt !== -1 && norm(section.heading) === 'description' ? [] : [h(2, section.heading)]),
    ...sectionChildren(section),
  ])

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
    if (box) box.rows = [...(box.rows as AnyBlock[]), property(links(unlinked), { title: 'Related' }) as unknown as AnyBlock]
    else out.push(h(2, 'Related') as unknown as AnyBlock, links(unlinked) as unknown as AnyBlock)
  }

  if (includeSources) out.push(...(sourcesBlocks(page) as unknown as AnyBlock[]))
  return out as unknown as Block[]
}

function contentRuns(block: unknown): { mention?: { resourceId?: string } }[] {
  const b = block as { content?: unknown; rows?: unknown }
  const runs: { mention?: { resourceId?: string } }[] = []
  if (Array.isArray(b.content)) runs.push(...(b.content as { mention?: { resourceId?: string } }[]))
  if (Array.isArray(b.rows)) for (const row of b.rows as { content?: unknown }[]) if (Array.isArray(row?.content)) runs.push(...(row.content as { mention?: { resourceId?: string } }[]))
  return runs
}
