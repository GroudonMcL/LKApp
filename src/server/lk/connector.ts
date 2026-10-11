import type {
  CreatePageInput,
  CreatedPage,
  DocumentContent,
  ProjectInfo,
  ResourceDetail,
  ResourcePage,
  SearchHit,
  TagCount,
} from './types'

/**
 * Everything the app may do in LegendKeeper, in one interface.
 *
 * - All authenticated LegendKeeper calls go through an implementation of this interface,
 *   on the server only. UI code never sees the SDK or the API key.
 * - Phase 1 is deliberately narrow: read operations, plus exactly one write
 *   (`createPage`). There is no update, move, delete or bulk operation here, so the rest
 *   of the app cannot perform one even by mistake.
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
}
