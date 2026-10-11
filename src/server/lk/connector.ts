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
 * - Deliberately narrow: read operations plus three writes — create one page, replace a
 *   resource's tag list, and replace one page's content (always with a version check).
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
}
