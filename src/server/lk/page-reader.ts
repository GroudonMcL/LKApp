import { emptyFormatting, normalizeForCompare, type FormattingCounts, type PageReading, type PreservedPart, type ReadLine } from '@/core/migration-check'

/**
 * Reads a LegendKeeper page (its blocks as the API returns them) for template migration.
 *
 * Text the import pipeline understands — headings, paragraphs, lists, key-value rows and
 * titled text boxes, also inside the infobox — becomes Markdown, so the page can be
 * re-drafted with a recipe and template exactly like an imported document.
 *
 * Everything else is *kept as it is*: images, embeds, maps, tables, quotes, callouts,
 * collapsible sections, secrets (GM-only text must never become ordinary text), checklists,
 * link lists, collections and blocks the API cannot express. Those are sent back by id when
 * the page is written, so LegendKeeper keeps them unchanged.
 *
 * Pure: no network, no database.
 */

type Json = Record<string, unknown>

/** Heading given to loose text that follows a titled box, so it is not merged into that box. */
export const LOOSE_TEXT_HEADING = 'Description'

/** Kinds that become text. Everything not listed here (apart from dividers) is kept as is. */
const TEXT_KINDS = new Set(['heading', 'paragraph', 'bulletList', 'orderedList', 'keyValue', 'textField', 'infobox'])

export function readPage(blocks: unknown[], pageName: string): PageReading {
  const reader = new Reader(pageName)
  for (const block of blocks) reader.block(block as Json, 'page')
  return reader.result()
}

class Reader {
  private md: string[] = []
  private lines: ReadLine[] = []
  private mentions: { text: string; resourceId: string }[] = []
  private linkIds = new Set<string>()
  private preserved: PreservedPart[] = []
  private dropped: Record<string, number> = {}
  private formatting: FormattingCounts = emptyFormatting()
  private section: string | null = null
  private title: string | null = null
  /** A titled box just ended: loose text after it needs a heading of its own. */
  private sectionClosed = false
  private seenText = false

  constructor(private readonly pageName: string) {}

  result(): PageReading {
    return {
      markdown: this.md.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
      lines: this.lines,
      mentions: this.mentions,
      linkIds: [...this.linkIds],
      preserved: this.preserved,
      dropped: this.dropped,
      formatting: this.formatting,
      title: this.title,
    }
  }

  block(b: Json, container: 'page' | 'infobox', nested = false) {
    const kind = String(b.kind ?? 'unknown')
    if (!nested && container === 'page' && this.sectionClosed && ['paragraph', 'bulletList', 'orderedList', 'keyValue'].includes(kind)) {
      // Loose text after a titled box (e.g. lore under the statblock) is not part of that box.
      this.enterSection(LOOSE_TEXT_HEADING, 2)
      this.sectionClosed = false
    }
    if (kind === 'heading' || kind === 'textField') this.sectionClosed = false
    if (kind === 'rule') {
      this.dropped.rule = (this.dropped.rule ?? 0) + 1
      return
    }
    if (!TEXT_KINDS.has(kind) || (container === 'infobox' && !['keyValue', 'textField'].includes(kind))) {
      this.keep(b, container)
      return
    }
    switch (kind) {
      case 'heading': {
        const { plain, markdown } = this.runs(b.content)
        if (!plain.trim()) return
        if (Number(b.level) === 1 && this.title === null && normalizeForCompare(plain) === normalizeForCompare(this.pageName)) {
          this.title = plain
          return
        }
        const level = Math.min(Math.max(Number(b.level) || 2, 1), 6)
        this.md.push(`${'#'.repeat(level)} ${markdown.trim()}`)
        this.lines.push({ kind: 'heading', text: plain.trim(), markdown: markdown.trim(), section: this.section })
        this.section = plain.trim()
        return
      }
      case 'paragraph': {
        const { plain, markdown } = this.runs(b.content)
        if (!plain.trim()) return
        this.md.push(markdown.trim())
        this.lines.push({ kind: 'paragraph', text: plain.trim(), markdown: markdown.trim(), section: this.section })
        return
      }
      case 'bulletList':
      case 'orderedList': {
        const out: string[] = []
        this.list(b, kind === 'orderedList', 0, out)
        if (out.length) this.md.push(out.join('\n'))
        return
      }
      case 'keyValue': {
        const title = typeof b.title === 'string' && b.isTitleHidden !== true && b.title.trim() ? b.title.trim() : null
        if (title) this.enterSection(title, 3)
        const rows: string[] = []
        for (const row of (b.rows as Json[] | undefined) ?? []) {
          const key = String(row.key ?? '').trim()
          const { plain, markdown } = Array.isArray(row.content) ? this.runs(row.content) : { plain: String(row.text ?? ''), markdown: String(row.text ?? '') }
          if (!key && !plain.trim()) continue
          rows.push(`${key}: ${markdown.trim()}`)
          this.lines.push({ kind: 'row', text: `${key}: ${plain.trim()}`, markdown: `${key}: ${markdown.trim()}`, section: this.section, key, value: plain.trim() })
        }
        if (rows.length) this.md.push(rows.join('\n'))
        return
      }
      case 'textField': {
        const title = typeof b.title === 'string' && b.isTitleHidden !== true && b.title.trim() ? b.title.trim() : null
        if (title) this.enterSection(title, 2)
        for (const child of (b.children as Json[] | undefined) ?? []) this.block(child, 'page', true)
        if (title && !nested && container === 'page') {
          this.section = null
          this.sectionClosed = true
        }
        return
      }
      case 'infobox': {
        for (const row of (b.rows as Json[] | undefined) ?? []) this.block(row, 'infobox', true)
        return
      }
    }
  }

  private enterSection(title: string, level: number) {
    this.md.push(`${'#'.repeat(level)} ${title}`)
    this.lines.push({ kind: 'heading', text: title, markdown: title, section: this.section })
    this.section = title
  }

  private list(b: Json, ordered: boolean, depth: number, out: string[]) {
    let n = Number(b.start) || 1
    for (const item of (b.children as Json[] | undefined) ?? []) {
      for (const child of (item.children as Json[] | undefined) ?? []) {
        const kind = String(child.kind)
        if (kind === 'paragraph') {
          const { plain, markdown } = this.runs(child.content)
          if (!plain.trim()) continue
          out.push(`${'  '.repeat(depth)}${ordered ? `${n}.` : '-'} ${markdown.trim()}`)
          this.lines.push({ kind: 'list', text: plain.trim(), markdown: markdown.trim(), section: this.section })
        } else if (kind === 'bulletList' || kind === 'orderedList') {
          this.list(child, kind === 'orderedList', depth + 1, out)
        } else {
          this.keep(child, 'page')
        }
      }
      n++
    }
  }

  private keep(b: Json, container: 'page' | 'infobox') {
    const kind = String(b.kind ?? 'unknown')
    this.collectLinks(b)
    this.preserved.push({ id: typeof b.id === 'string' ? b.id : null, kind, label: describe(b), container, section: this.section, atTop: !this.seenText, block: b })
  }

  /** Links inside kept blocks still count as links of the page. */
  private collectLinks(value: unknown) {
    if (Array.isArray(value)) {
      for (const v of value) this.collectLinks(v)
      return
    }
    if (!value || typeof value !== 'object') return
    const o = value as Json
    const mention = o.mention as { resourceId?: string } | undefined
    if (mention?.resourceId) this.linkIds.add(mention.resourceId)
    if ((o.kind === 'resourceLink' || o.kind === 'resourceCollection') && Array.isArray(o.items)) {
      for (const item of o.items) {
        const id = typeof item === 'string' ? item : (item as { resourceId?: string })?.resourceId
        if (id) this.linkIds.add(id)
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'mention' && typeof v === 'object') this.collectLinks(v)
  }

  /** Inline runs → plain text and Markdown (bold, italic and web links kept). */
  private runs(content: unknown): { plain: string; markdown: string } {
    let plain = ''
    let markdown = ''
    this.seenText = true
    for (const run of merge((content as Json[] | undefined) ?? [])) {
      const mention = run.mention as { resourceId?: string; text?: string; name?: string } | undefined
      if (mention) {
        const text = mention.text || mention.name || ''
        if (mention.resourceId) {
          this.linkIds.add(mention.resourceId)
          if (text) this.mentions.push({ text, resourceId: mention.resourceId })
        }
        plain += text
        markdown += text
        continue
      }
      const text = String(run.text ?? '')
      plain += text
      for (const mark of ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup'] as const) if (run[mark] === true && text.trim()) this.formatting[mark]++
      if (typeof run.link === 'string' && text.trim()) this.formatting.link++
      markdown += markdownRun(text, run)
    }
    return { plain, markdown }
  }
}

/** Joins neighbouring runs with the same marks, so "**A.**" is not split into pieces. */
function merge(runs: Json[]): Json[] {
  const out: Json[] = []
  const marks = (r: Json) => JSON.stringify([r.bold, r.italic, r.underline, r.strike, r.code, r.link, r.sub, r.sup])
  for (const run of runs) {
    const last = out[out.length - 1]
    if (last && !last.mention && !run.mention && typeof last.text === 'string' && typeof run.text === 'string' && marks(last) === marks(run)) {
      out[out.length - 1] = { ...last, text: last.text + run.text }
    } else out.push(run)
  }
  return out
}

function markdownRun(text: string, run: Json): string {
  if (!text.trim()) return text
  const lead = text.match(/^\s*/)![0]
  const trail = text.match(/\s*$/)![0]
  let core = text.trim()
  if (run.bold === true && run.italic === true) core = `***${core}***`
  else if (run.bold === true) core = `**${core}**`
  else if (run.italic === true) core = `*${core}*`
  if (typeof run.link === 'string' && /^https?:\/\//i.test(run.link)) core = `[${core}](${run.link})`
  return lead + core + trail
}

function describe(b: Json): string {
  const kind = String(b.kind ?? 'block')
  const title = typeof b.title === 'string' && b.title.trim() ? ` “${b.title.trim()}”` : ''
  const names: Record<string, string> = {
    image: 'Image',
    embed: 'Embedded media',
    map: 'Map',
    meter: 'Meter',
    table: 'Table',
    quote: 'Quote',
    callout: 'Callout box',
    expand: 'Collapsible section',
    secret: 'Secret (GM-only) content',
    taskList: 'Checklist',
    code: 'Code block',
    layout: 'Column layout',
    resourceLink: 'Link list',
    resourceCollection: 'Page collection',
    unsupported: 'Content the API cannot read',
  }
  return `${names[kind] ?? kind}${title}`
}
