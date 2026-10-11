/**
 * The app's own view of LegendKeeper data.
 *
 * Services and the UI depend on these types, not on the SDK's generated types, so the
 * connector can be changed or extended when the SDK changes without touching the rest
 * of the app. Raw block trees are passed through as opaque JSON for display.
 */

export interface ProjectInfo {
  id: string
  name: string
  isPublic: boolean | null
  createdAt: string | null
}

export interface DocumentRef {
  id: string
  name: string
  type: string
}

export interface ResourceSummary {
  id: string
  name: string
  parentId: string | null
  tags: string[]
  aliases: string[]
  iconGlyph: string | null
  isHidden: boolean
  rank: string | null
  updatedAt: string | null
  documents: DocumentRef[]
}

export interface PropertySummary {
  id: string | null
  kind: string
  title: string | null
  isHidden: boolean
  /** Plain text of the property, where it has text (key-value rows, text fields). */
  text: string | null
  raw: unknown
}

export interface ResourceDetail extends ResourceSummary {
  isLocked: boolean
  createdAt: string | null
  documents: (DocumentRef & { rank: string | null; isHidden: boolean })[]
  properties: PropertySummary[]
}

export interface DocumentContent {
  resourceId: string
  documentId: string
  /** Opaque version string, used for conditional (If-Match) writes. */
  version: string
  text: string
  blocks: unknown[]
  /** Count of blocks the public block model cannot express (read-only `unsupported`). */
  unsupportedCount: number
}

export interface TagCount {
  tag: string
  count: number
}

export interface SearchHit {
  resourceId: string
  name: string
  parentId: string | null
  tags: string[]
  path: string[]
  documentName: string | null
  highlight: string | null
}

export interface ResourcePage {
  items: ResourceSummary[]
  nextCursor: string | null
  hasMore: boolean
}

export interface CreatePageInput {
  /** Client-chosen resource id (cuid2 format), chosen before the write. */
  resourceId: string
  name: string
  parentId: string | null
  tags: string[]
  aliases: string[]
  documentName: string
  /** LegendKeeper blocks, produced by the renderer. */
  blocks: unknown[]
  idempotencyKey: string
}

export interface CreatedPage {
  resourceId: string
  name: string
  parentId: string | null
  tags: string[]
  documentId: string | null
  documentType: string | null
}
