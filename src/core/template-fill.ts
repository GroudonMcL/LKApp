/**
 * Filling a copy of a LegendKeeper template, block by block.
 *
 * A page created from a template (`resources.createFromTemplate`) already has the template's
 * blocks, with ids. Writing the whole tab back is not possible when the template has an empty
 * image slot (LegendKeeper refuses an image without a picture, even one it already holds), and
 * would risk the built-in boxes the API cannot write. So the filled tab is written as a list of
 * small edits against the copy:
 *
 * - the infobox stays where it is; each of its fields that changes is updated on its own
 *   (`updateBlockProperty`), in place, so their order never changes and image slots and built-in
 *   rows (Tags, Aliases) are never touched; example text it holds outside a field is removed;
 * - other blocks of the template are replaced in place (same id), or deleted when the page has
 *   nothing for them (unused sections, example paragraphs);
 * - new blocks (extra sections, the description, sources) take the place of a template block
 *   that is removed at the same spot (one replace instead of a delete and an insert), or are
 *   inserted next to their neighbour, each with an id chosen in advance, so repeating an insert
 *   can never add it twice.
 *
 * When the tab has nothing LegendKeeper cannot take back, one whole-tab replace does the same
 * in a single write.
 *
 * Pure: no network, no database.
 */

type AnyBlock = Record<string, unknown>

export type FillOp =
  | { op: 'replaceAll'; blocks: AnyBlock[] }
  | { op: 'delete'; blockId: string; label: string }
  | { op: 'replace'; blockId: string; block: AnyBlock; label: string }
  | { op: 'update'; blockId: string; patch: AnyBlock; label: string }
  | { op: 'insert'; block: AnyBlock; after?: string; before?: string; parent?: string; label: string }
  | { op: 'updateProperty'; blockId: string; propertyId: string; patch: AnyBlock; label: string }
  | { op: 'createProperty'; blockId: string; property: AnyBlock; label: string }
  | { op: 'deleteProperty'; blockId: string; propertyId: string; label: string }

const isObject = (value: unknown): value is AnyBlock => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Read-only parts of what LegendKeeper returns: a key-value row's plain `text`. */
export function writable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(writable) as T
  if (!isObject(value)) return value
  const out: AnyBlock = {}
  const isRow = 'key' in value && 'content' in value
  for (const [key, inner] of Object.entries(value)) {
    if (isRow && key === 'text') continue
    out[key] = writable(inner)
  }
  return out as T
}

const same = (a: unknown, b: unknown) => stable(writable(a)) === stable(writable(b))

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** Whether a tree holds something LegendKeeper refuses to take back (an image without a picture). */
export function hasUnwritable(blocks: unknown): boolean {
  if (Array.isArray(blocks)) return blocks.some(hasUnwritable)
  if (!isObject(blocks)) return false
  if (blocks.kind === 'image' && (typeof blocks.url !== 'string' || blocks.url.trim() === '')) return true
  return Object.values(blocks).some(hasUnwritable)
}

/** Every block, at any depth, and every infobox field has an id (edits address them by id). */
export function hasAllIds(blocks: unknown[]): boolean {
  return blocks.every(
    (block) =>
      isObject(block) &&
      typeof block.id === 'string' &&
      (block.kind !== 'infobox' || ((block.rows as unknown[]) ?? []).every((row) => isObject(row) && typeof row.id === 'string')) &&
      hasAllIds(((block.children as unknown[]) ?? []).filter((child) => isObject(child) && typeof child.kind === 'string')),
  )
}

const labelOf = (block: AnyBlock) => {
  const title = typeof block.title === 'string' && block.title ? ` “${block.title}”` : ''
  return `${String(block.kind ?? 'block')}${title}`
}

const PROPERTY_FIELDS = ['title', 'isTitleHidden', 'children', 'rank', 'isHidden', 'display', 'rows'] as const

/**
 * The edits that turn `current` (the copy's tab, every block with an id) into `desired` (the same
 * blocks filled: kept blocks keep their ids, new blocks have none). `newId` makes block ids.
 */
export function planFill(current: unknown[], desired: unknown[], newId: () => string): FillOp[] {
  const currentBlocks = current.filter(isObject)
  const desiredBlocks = desired.filter(isObject)
  if (!hasUnwritable(desiredBlocks)) return same(currentBlocks, desiredBlocks) ? [] : [{ op: 'replaceAll', blocks: writable(desiredBlocks) }]
  const ops: FillOp[] = []
  diffList(currentBlocks, desiredBlocks, null, newId, ops)
  return ops
}

/** Edits for one list of sibling blocks (the tab, or a container's children). */
function diffList(current: AnyBlock[], desired: AnyBlock[], parentId: string | null, newId: () => string, ops: FillOp[]) {
  const byId = new Map(current.filter((block) => typeof block.id === 'string').map((block) => [block.id as string, block]))
  const keptIds = new Set(desired.map((block) => block.id).filter((id): id is string => typeof id === 'string' && byId.has(id)))

  // A new block that comes where a template block is removed takes that block's place: one
  // replace instead of a delete and an insert.
  const reuse = new Map<AnyBlock, string>()
  let cursor = 0
  for (const block of desired) {
    if (typeof block.id === 'string' && keptIds.has(block.id)) {
      cursor = current.findIndex((item) => item.id === block.id) + 1
      continue
    }
    const spot = current[cursor]
    if (spot && typeof spot.id === 'string' && !keptIds.has(spot.id) && !hasUnwritable(spot)) {
      reuse.set(block, spot.id)
      cursor++
    }
  }
  const reused = new Set(reuse.values())

  // 1. Blocks of the template the page has no use for.
  for (const block of current) if (typeof block.id === 'string' && !keptIds.has(block.id) && !reused.has(block.id)) ops.push({ op: 'delete', blockId: block.id, label: labelOf(block) })

  // 2. Kept blocks: changed ones are replaced in place, unless they hold something that cannot be
  //    written back (an image slot): then the infobox is edited field by field, and any other
  //    container child by child.
  for (const block of desired) {
    const id = block.id as string | undefined
    const before = id ? byId.get(id) : undefined
    if (!before || !keptIds.has(id!) || same(block, before)) continue
    if (!hasUnwritable(block)) {
      ops.push({ op: 'replace', blockId: id!, block: writable(block), label: labelOf(block) })
    } else if (block.kind === 'infobox' && before.kind === 'infobox') {
      diffInfobox(before, block, newId, ops)
    } else {
      const patch: AnyBlock = {}
      for (const [key, value] of Object.entries(block)) if (key !== 'id' && key !== 'children' && key !== 'kind' && !same(value, before[key])) patch[key] = writable(value)
      if (Object.keys(patch).length) ops.push({ op: 'update', blockId: id!, patch, label: labelOf(block) })
      diffList(((before.children as unknown[]) ?? []).filter(isObject), ((block.children as unknown[]) ?? []).filter(isObject), id!, newId, ops)
    }
  }

  // 3. New blocks: in a removed block's place, or next to the block before them (or before the
  //    first kept block, or as the container's first child).
  let previous: string | null = null
  const firstKept = desired.find((block) => typeof block.id === 'string' && keptIds.has(block.id))?.id as string | undefined
  for (const block of desired) {
    if (typeof block.id === 'string' && keptIds.has(block.id)) {
      previous = block.id
      continue
    }
    const place = reuse.get(block)
    if (place) {
      ops.push({ op: 'replace', blockId: place, block: writable({ ...block, id: place }), label: labelOf(block) })
      previous = place
      continue
    }
    const id = newId()
    const placed = writable({ ...block, id })
    const where = previous ? { after: previous } : firstKept ? { before: firstKept } : parentId ? { parent: parentId } : {}
    ops.push({ op: 'insert', block: placed, ...where, label: labelOf(block) })
    previous = id
  }
}

/** An infobox, field by field: its fields keep their place; image slots and built-in rows are never sent. */
function diffInfobox(before: AnyBlock, block: AnyBlock, newId: () => string, ops: FillOp[]) {
  const id = block.id as string
  const oldRows = new Map(((before.rows as AnyBlock[]) ?? []).filter(isObject).map((row) => [row.id as string, row]))
  const keptRows = new Set(((block.rows as AnyBlock[]) ?? []).map((row) => row.id))
  // Example text the infobox holds on its own (not a field) is removed.
  for (const [rowId, row] of oldRows) if (!keptRows.has(rowId)) ops.push({ op: 'deleteProperty', blockId: id, propertyId: rowId, label: labelOf(row) })
  for (const row of ((block.rows as AnyBlock[]) ?? []).filter(isObject)) {
    const old = typeof row.id === 'string' ? oldRows.get(row.id) : undefined
    if (!old) {
      ops.push({ op: 'createProperty', blockId: id, property: writable({ ...row, id: newId() }), label: labelOf(row) })
      continue
    }
    const patch: AnyBlock = {}
    for (const field of PROPERTY_FIELDS) if (field in row && !same(row[field], old[field])) patch[field] = writable(row[field])
    if (Object.keys(patch).length) ops.push({ op: 'updateProperty', blockId: id, propertyId: row.id as string, patch, label: labelOf(row) })
  }
}

/**
 * The content of a tab with everything that is not content taken out (ids, ranks, built-in
 * boxes, empty image slots, read-only text), for checking that what is written into the copy is
 * what was approved.
 */
export function comparableContent(blocks: unknown[]): string {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value
        .filter((item) => !(isObject(item) && (item.kind === 'unsupported' || (item.kind === 'image' && (typeof item.url !== 'string' || item.url.trim() === '')))))
        .map(clean)
    }
    if (!isObject(value)) return value
    const out: AnyBlock = {}
    for (const [key, inner] of Object.entries(value)) {
      if ((key === 'id' && value.type !== 'filter') || key === 'rank') continue
      out[key] = clean(inner)
    }
    return out
  }
  return stable(writable(clean(blocks)))
}
