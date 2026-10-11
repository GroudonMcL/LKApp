import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser'

/**
 * Converts HTML (a saved web page, or a Word document converted by mammoth) into Markdown
 * text that keeps the structure the rest of the app relies on:
 * - headings become `#` lines (so records can be split at a heading level);
 * - lists become `-` / `1.` items;
 * - tables become Markdown pipe tables (statblock tables and item tables stay readable, and
 *   no cell is lost);
 * - bold/italic become `**` / `*`;
 * - links keep their text (the address is dropped);
 * - scripts, styles, forms, navigation chrome and images are left out.
 *
 * Deterministic: no AI. Text is copied as written; only whitespace is tidied.
 */
export function htmlToMarkdown(html: string): { markdown: string; title: string | null } {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } })
  const title = textOf(root.querySelector('title'))?.trim() || textOf(root.querySelector('h1'))?.trim() || null
  const body = root.querySelector('body') ?? root
  const out: string[] = []
  renderBlock(body, out)
  const markdown = out
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { markdown, title }
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'nav', 'form', 'button', 'select', 'input', 'svg', 'canvas', 'iframe', 'img', 'picture', 'video', 'audio'])
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'blockquote', 'figure', 'figcaption', 'dl', 'dd', 'dt', 'address', 'center'])

function textOf(node: HTMLElement | null): string | null {
  return node ? collapse(node.text) : null
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function tag(node: Node): string {
  return node.nodeType === NodeType.ELEMENT_NODE ? (node as HTMLElement).rawTagName?.toLowerCase() ?? '' : ''
}

function renderBlock(node: HTMLElement, out: string[]) {
  let inline = ''
  const flush = () => {
    const text = inline.trim()
    if (text) out.push(text, '')
    inline = ''
  }
  for (const child of node.childNodes) {
    const name = tag(child)
    if (child.nodeType === NodeType.TEXT_NODE) {
      inline += decodeText(child.rawText)
      continue
    }
    if (child.nodeType !== NodeType.ELEMENT_NODE || SKIP.has(name)) continue
    const element = child as HTMLElement
    if (/^h[1-6]$/.test(name)) {
      flush()
      const text = inlineText(element).trim()
      if (text) out.push(`${'#'.repeat(Number(name[1]))} ${text}`, '')
    } else if (name === 'ul' || name === 'ol') {
      flush()
      renderList(element, out, 0)
      out.push('')
    } else if (name === 'table') {
      flush()
      renderTable(element, out)
      out.push('')
    } else if (name === 'pre') {
      flush()
      out.push('```', element.text.replace(/\n$/, ''), '```', '')
    } else if (name === 'hr') {
      flush()
      out.push('---', '')
    } else if (name === 'br') {
      inline += '\n'
    } else if (BLOCKS.has(name) || name === 'li' || name === 'body' || name === 'html') {
      flush()
      if (name === 'blockquote') {
        const inner: string[] = []
        renderBlock(element, inner)
        out.push(...inner.map((line) => (line ? `> ${line}` : '')))
      } else {
        renderBlock(element, out)
      }
    } else {
      inline += inlineNode(element)
    }
  }
  flush()
}

/** The inline text of one node, with its own formatting (bold, italic, line break). */
function inlineNode(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return decodeText(node.rawText)
  const name = tag(node)
  if (node.nodeType !== NodeType.ELEMENT_NODE || SKIP.has(name)) return ''
  if (name === 'br') return '\n'
  const inner = inlineText(node as HTMLElement)
  if ((name === 'strong' || name === 'b') && inner.trim()) return wrap(inner, '**')
  if ((name === 'em' || name === 'i') && inner.trim()) return wrap(inner, '*')
  return inner
}

function inlineText(element: HTMLElement): string {
  return element.childNodes.map(inlineNode).join('').replace(/[ \t\r\f\v]+/g, ' ')
}

/** Wraps text in a marker, keeping surrounding spaces outside it ("**Bold.** text"). */
function wrap(text: string, marker: string): string {
  const lead = /^\s*/.exec(text)![0]
  const trail = /\s*$/.exec(text)![0]
  return `${lead ? ' ' : ''}${marker}${text.trim()}${marker}${trail ? ' ' : ''}`
}

function decodeText(raw: string): string {
  return parse(`<x>${raw}</x>`).text.replace(/[ \t\r\n\f\v]+/g, ' ')
}

function renderList(list: HTMLElement, out: string[], depth: number) {
  const ordered = tag(list) === 'ol'
  let n = 1
  for (const item of list.childNodes) {
    if (tag(item) !== 'li') continue
    const element = item as HTMLElement
    const own = element.childNodes.filter((c) => !['ul', 'ol'].includes(tag(c)))
    const text = own.map(inlineNode).join('').trim()
    out.push(`${'  '.repeat(depth)}${ordered ? `${n++}.` : '-'} ${text}`)
    for (const nested of element.childNodes) if (['ul', 'ol'].includes(tag(nested))) renderList(nested as HTMLElement, out, depth + 1)
  }
}

function renderTable(table: HTMLElement, out: string[]) {
  const rows = table.querySelectorAll('tr').map((row) =>
    row.childNodes.filter((cell) => ['td', 'th'].includes(tag(cell))).map((cell) => inlineText(cell as HTMLElement).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()),
  )
  const nonEmpty = rows.filter((row) => row.length > 0)
  if (nonEmpty.length === 0) return
  const width = Math.max(...nonEmpty.map((row) => row.length))
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill('')]
  out.push(`| ${pad(nonEmpty[0]!).join(' | ')} |`)
  out.push(`| ${Array(width).fill('---').join(' | ')} |`)
  for (const row of nonEmpty.slice(1)) out.push(`| ${pad(row).join(' | ')} |`)
}
