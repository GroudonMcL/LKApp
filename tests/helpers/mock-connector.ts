import type { LegendKeeperConnector } from '@/server/lk/connector'
import { ConnectorError } from '@/server/lk/errors'
import type {
  CreatePageInput,
  CreatedPage,
  DocumentContent,
  ProjectInfo,
  ResourceDetail,
  ResourcePage,
  SearchHit,
  TagCount,
} from '@/server/lk/types'

/**
 * An in-memory stand-in for LegendKeeper used by routine tests. It never touches the
 * network. Failures can be injected to exercise error handling and duplicate prevention.
 */

export interface MockResource {
  id: string
  name: string
  parentId: string | null
  tags: string[]
  aliases: string[]
  documents: { id: string; name: string; type: string; blocks: unknown[]; version: string; text: string }[]
}

export type CreateBehavior =
  | 'ok'
  /** The page is created, but the reply is lost (timeout / dropped connection). */
  | 'apply_then_connection_error'
  /** The connection fails before LegendKeeper receives anything. */
  | 'connection_error_before_apply'
  | 'server_error_before_apply'
  | 'permission_error'
  | 'validation_error'

export class MockConnector implements LegendKeeperConnector {
  project: ProjectInfo = { id: 'proj_test', name: 'Greyhawk Test Project', isPublic: false, createdAt: '2026-01-01T00:00:00Z' }
  resources = new Map<string, MockResource>()
  isAdmin = true
  createBehavior: CreateBehavior = 'ok'
  /** Per page name, overrides `createBehavior` (to fail one record of a batch). */
  createBehaviorByName = new Map<string, CreateBehavior>()
  /** Pages whose content cannot be read. */
  failDocuments = new Set<string>()
  failReads: ConnectorError | null = null
  pageSize: number | null = null
  calls: { method: string; args: unknown }[] = []
  createRequests: CreatePageInput[] = []

  constructor(resources: Partial<MockResource>[] = []) {
    for (const resource of resources) this.add(resource)
  }

  add(resource: Partial<MockResource>): MockResource {
    const id = resource.id ?? `res${String(this.resources.size).padStart(5, '0')}`
    const full: MockResource = {
      id,
      name: resource.name ?? id,
      parentId: resource.parentId ?? null,
      tags: resource.tags ?? [],
      aliases: resource.aliases ?? [],
      documents: resource.documents ?? [{ id: `doc_${id}`, name: 'Main', type: 'page', blocks: [], version: 'v1', text: '' }],
    }
    this.resources.set(id, full)
    return full
  }

  private record(method: string, args: unknown) {
    this.calls.push({ method, args })
    if (this.failReads && method !== 'createPage') throw this.failReads
  }

  callCount(method: string) {
    return this.calls.filter((call) => call.method === method).length
  }

  async getProject() {
    this.record('getProject', null)
    return this.project
  }

  async pingProject(projectId: string) {
    this.record('pingProject', projectId)
    if (projectId !== this.project.id) throw new ConnectorError('permission', 'wrong project', { status: 403, code: 'WRONG_PROJECT', outcome: 'not_applied' })
    return this.project
  }

  async listResources(options: { cursor?: string | null; limit?: number; parentId?: string | null }): Promise<ResourcePage> {
    this.record('listResources', options)
    const all = [...this.resources.values()]
      .filter((r) => (options.parentId ? r.parentId === options.parentId : true))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const size = this.pageSize ?? options.limit ?? 50
    const start = options.cursor ? Number(options.cursor) : 0
    const slice = all.slice(start, start + size)
    const next = start + size < all.length ? String(start + size) : null
    return {
      items: slice.map((r) => ({ id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: r.aliases, iconGlyph: null, isHidden: false, rank: null, updatedAt: null, documents: r.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })) })),
      nextCursor: next,
      hasMore: next !== null,
    }
  }

  async getResource(resourceId: string): Promise<ResourceDetail> {
    this.record('getResource', resourceId)
    const r = this.resources.get(resourceId)
    if (!r) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', requestId: 'req_mock_404', outcome: 'not_applied' })
    return {
      id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: r.aliases, iconGlyph: null, isHidden: false, isLocked: false,
      rank: null, updatedAt: null, createdAt: null,
      documents: r.documents.map((d) => ({ id: d.id, name: d.name, type: d.type, rank: 'a0', isHidden: false })),
      properties: [],
    }
  }

  async getDocumentContent(resourceId: string, documentId: string): Promise<DocumentContent> {
    this.record('getDocumentContent', { resourceId, documentId })
    if (this.failDocuments.has(resourceId)) throw new ConnectorError('validation', 'the document could not be converted', { status: 422, code: 'UNPROCESSABLE', outcome: 'not_applied' })
    const doc = this.resources.get(resourceId)?.documents.find((d) => d.id === documentId)
    if (!doc) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    return { resourceId, documentId, version: doc.version, text: doc.text, blocks: doc.blocks, unsupportedCount: 0 }
  }

  async listTags(): Promise<TagCount[]> {
    this.record('listTags', null)
    if (!this.isAdmin) throw new ConnectorError('permission', 'needs admin', { status: 403, code: 'FORBIDDEN', requestId: 'req_mock_403', outcome: 'not_applied' })
    const counts = new Map<string, number>()
    for (const r of this.resources.values()) for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    this.record('search', { query, limit })
    const q = query.toLowerCase()
    return [...this.resources.values()]
      .filter((r) => r.name.toLowerCase().includes(q) || r.aliases.some((a) => a.toLowerCase().includes(q)))
      .slice(0, limit)
      .map((r) => ({ resourceId: r.id, name: r.name, parentId: r.parentId, tags: r.tags, path: [], documentName: null, highlight: null }))
  }

  async createPage(input: CreatePageInput): Promise<CreatedPage> {
    this.record('createPage', input)
    this.createRequests.push(input)
    const apply = () => {
      if (this.resources.has(input.resourceId)) {
        throw new ConnectorError('duplicate_id', 'duplicate', { status: 409, code: 'DUPLICATE_ID', requestId: 'req_mock_409', outcome: 'not_applied' })
      }
      if (input.parentId && !this.resources.has(input.parentId)) {
        throw new ConnectorError('not_found', 'parent not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      }
      const text = JSON.stringify(input.blocks)
      this.add({
        id: input.resourceId,
        name: input.name,
        parentId: input.parentId,
        tags: input.tags,
        aliases: input.aliases,
        documents: [{ id: `doc_${input.resourceId}`, name: input.documentName, type: 'page', blocks: input.blocks, version: 'v1', text }],
      })
    }
    switch (this.createBehaviorByName.get(input.name) ?? this.createBehavior) {
      case 'permission_error':
        throw new ConnectorError('permission', 'forbidden', { status: 403, code: 'FORBIDDEN', requestId: 'req_mock_403', outcome: 'not_applied' })
      case 'validation_error':
        throw new ConnectorError('validation', 'invalid', { status: 400, code: 'INVALID_CONTENT', requestId: 'req_mock_400', issues: [{ path: 'documents[0].blocks[0]', message: 'bad block' }], outcome: 'not_applied' })
      case 'connection_error_before_apply':
        throw new ConnectorError('connection', 'network down', { outcome: 'unknown' })
      case 'server_error_before_apply':
        throw new ConnectorError('server', 'server error', { status: 500, code: 'INTERNAL', requestId: 'req_mock_500', outcome: 'unknown' })
      case 'apply_then_connection_error':
        apply()
        throw new ConnectorError('connection', 'reply lost', { outcome: 'unknown' })
      default:
        apply()
    }
    return { resourceId: input.resourceId, name: input.name, parentId: input.parentId, tags: input.tags, documentId: `doc_${input.resourceId}`, documentType: 'page' }
  }
}
