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

// ── Timelines and calendars ─────────────────────────────────────────────────────

export interface LkCalendarInfo {
  id: string
  name: string
  /** Eras from year 1 onwards, by abbreviation. */
  positiveEras: { abbr: string; name: string }[]
  /** The era before year 1 (e.g. "BCY"), when the calendar has one. */
  negativeEra: { abbr: string; name: string } | null
  months: string[]
  builtIn: boolean
}

export interface TimelineDocumentInfo {
  resourceId: string
  documentId: string
  name: string
  type: string
  calendarId: string | null
}

export interface TimelineLaneInfo {
  id: string
  name: string
  /** From a chained timeline rather than this document. */
  external: boolean
}

export interface TimelineEventDate {
  year: number
  month: number
  monthName: string
  day: number
  era: { id?: string; name?: string; abbr?: string } | null
}

export interface TimelineEventInfo {
  id: string
  laneId: string | null
  type: string
  name: string
  formattedStart: string | null
  formattedEnd: string | null
  startDate: TimelineEventDate | null
  endDate: TimelineEventDate | null
  /** Precision: 1 year, 2 month, 3 day, 4 time. */
  detail: number | null
  uri: string | null
  isHidden: boolean
  /** True for events of chained timelines (listed here, stored elsewhere). */
  external: boolean
}

export interface CreateTimelineEventInput {
  resourceId: string
  documentId: string
  /** Client-chosen event id (cuid2 format), chosen before the write: a second create with it is refused. */
  eventId: string
  laneId: string
  name: string
  /** A plain date LegendKeeper parses in the timeline's calendar (see core/chronology/dates.ts lkFormatted). */
  formattedStart: string
  formattedEnd: string | null
  /** `lk://resources/<id>`: links the event to a page. */
  uri: string | null
}
