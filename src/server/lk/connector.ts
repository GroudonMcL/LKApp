import type {
  CreatePageInput,
  CreatedPage,
  DocumentContent,
  CreateTimelineEventInput,
  LkCalendarInfo,
  ProjectInfo,
  ResourceDetail,
  ResourcePage,
  SearchHit,
  TagCount,
  TimelineDocumentInfo,
  TimelineEventInfo,
  TimelineLaneInfo,
} from './types'

/**
 * Everything the app may do in LegendKeeper, in one interface.
 *
 * - All authenticated LegendKeeper calls go through an implementation of this interface,
 *   on the server only. UI code never sees the SDK or the API key.
 * - Deliberately narrow: read operations plus four writes — create one page, replace a
 *   resource's tag list, replace one page's content (always with a version check), and add
 *   one event to an existing timeline (with an event id chosen before the write).
 *   There is no move, delete or merge here, so the rest of the app cannot perform one even
 *   by mistake. Writes are never retried automatically.
 * - Tests use an in-memory implementation; production uses `SdkConnector`.
 */
export interface LegendKeeperConnector {
  getProject(): Promise<ProjectInfo>
  /** A live project read, bypassing any client-side caching. Used to confirm the connection. */
  pingProject(projectId: string): Promise<ProjectInfo>
  listResources(options: { cursor?: string | null; limit?: number; parentId?: string | null }): Promise<ResourcePage>
  getResource(resourceId: string): Promise<ResourceDetail>
  getDocumentContent(resourceId: string, documentId: string): Promise<DocumentContent>
  /** Every tag with its usage count. Requires an ADMIN key. */
  listTags(): Promise<TagCount[]>
  search(query: string, limit: number): Promise<SearchHit[]>
  /** Creates one resource with one page document. Never retried automatically. */
  createPage(input: CreatePageInput): Promise<CreatedPage>
  /**
   * Replaces a resource's tag list (`resources.update` sends only `tags`). LegendKeeper has no
   * version check for resource updates, so callers read the tags right before and merge.
   */
  updateResourceTags(resourceId: string, tags: string[]): Promise<{ tags: string[]; updatedAt: string | null }>
  /**
   * Replaces one page document's blocks, only if it is still at `ifMatch` (otherwise
   * `version_conflict`, nothing written). Returns the new version.
   */
  replaceDocumentBlocks(resourceId: string, documentId: string, blocks: unknown[], ifMatch: string): Promise<{ version: string }>

  /** The project's custom calendars, then LegendKeeper's built-in ones. */
  listCalendars(): Promise<LkCalendarInfo[]>
  /** A document's summary; for a timeline, its calendar. */
  getTimelineDocument(resourceId: string, documentId: string): Promise<TimelineDocumentInfo>
  listTimelineLanes(resourceId: string, documentId: string): Promise<TimelineLaneInfo[]>
  /** Every event of a timeline (all pages, up to `max`), ordered by start. */
  listTimelineEvents(resourceId: string, documentId: string, max: number): Promise<TimelineEventInfo[]>
  getTimelineEvent(resourceId: string, documentId: string, eventId: string): Promise<TimelineEventInfo>
  /** Adds one event to an existing lane. Never retried automatically. */
  createTimelineEvent(input: CreateTimelineEventInput): Promise<TimelineEventInfo>
}
