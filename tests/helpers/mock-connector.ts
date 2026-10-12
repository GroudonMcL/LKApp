import type { LegendKeeperConnector } from '@/server/lk/connector'
import { ConnectorError } from '@/server/lk/errors'
import { hasUnwritable } from '@/core/template-fill'
import type {
  CreateFromTemplateInput,
  SaveAsTemplateInput,
  CreateTimelineEventInput,
  LkCalendarInfo,
  TimelineDocumentInfo,
  TimelineEventInfo,
  TimelineLaneInfo,
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
  updatedAt?: string | null
  parentId: string | null
  tags: string[]
  aliases: string[]
  rank?: string | null
  /** Sidebar properties (opaque), copied with templates. */
  properties?: unknown[]
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
      rank: resource.rank ?? null,
      properties: resource.properties ?? [],
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
      items: slice.map((r) => ({ id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: r.aliases, iconGlyph: null, isHidden: false, rank: r.rank ?? null, updatedAt: r.updatedAt ?? null, documents: r.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })) })),
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
      rank: r.rank ?? null, updatedAt: r.updatedAt ?? null, createdAt: null,
      documents: r.documents.map((d) => ({ id: d.id, name: d.name, type: d.type, rank: 'a0', isHidden: false })),
      properties: (r.properties ?? []).map((raw, i) => ({ id: `prop${i}`, kind: 'keyValue', title: null, isHidden: false, text: null, raw })),
    }
  }

  /** Under the virtual "templates" root, at any depth. */
  isTemplate(resourceId: string): boolean {
    let current = this.resources.get(resourceId)
    for (let guard = 0; current && guard < 50; guard++) {
      if (current.parentId === 'templates') return true
      current = current.parentId ? this.resources.get(current.parentId) : undefined
    }
    return false
  }

  async listTemplates(options: { cursor?: string | null; limit?: number }): Promise<ResourcePage> {
    this.record('listTemplates', options)
    const all = [...this.resources.values()].filter((r) => this.isTemplate(r.id)).sort((a, b) => (a.id < b.id ? -1 : 1))
    const size = options.limit ?? 50
    const start = options.cursor ? Number(options.cursor) : 0
    const next = start + size < all.length ? String(start + size) : null
    return {
      items: all.slice(start, start + size).map((r) => ({ id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: r.aliases, iconGlyph: null, isHidden: false, rank: r.rank ?? null, updatedAt: null, documents: r.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })) })),
      nextCursor: next,
      hasMore: next !== null,
    }
  }

  /** Copies a resource (fields, properties, documents) under a new id. */
  private copyResource(source: MockResource, id: string, name: string, parentId: string | null): MockResource {
    return this.add({
      id,
      name,
      parentId,
      tags: [...source.tags],
      aliases: [...source.aliases],
      properties: structuredClone(source.properties ?? []),
      documents: source.documents.map((d, i) => ({ ...structuredClone(d), id: `doc_${id}_${i}`, version: 'v1' })),
    })
  }

  templateBehavior: CreateBehavior = 'ok'
  fromTemplateRequests: CreateFromTemplateInput[] = []

  async createFromTemplate(input: CreateFromTemplateInput): Promise<ResourceDetail> {
    this.record('createFromTemplate', input)
    this.fromTemplateRequests.push(input)
    const apply = () => {
      const template = this.resources.get(input.templateId)
      if (!template) throw new ConnectorError('not_found', 'template not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      if (!this.isTemplate(template.id)) throw new ConnectorError('validation', 'not a template', { status: 400, code: 'VALIDATION_ERROR', outcome: 'not_applied' })
      if (this.resources.has(input.resourceId)) throw new ConnectorError('duplicate_id', 'duplicate', { status: 409, code: 'DUPLICATE_ID', outcome: 'not_applied' })
      if (input.parentId && !this.resources.has(input.parentId)) throw new ConnectorError('not_found', 'parent not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      this.copyResource(template, input.resourceId, input.name || template.name.replace(/\s*Template\b/i, '').trim(), input.parentId)
    }
    switch (this.templateBehavior) {
      case 'permission_error':
        throw new ConnectorError('permission', 'forbidden', { status: 403, code: 'FORBIDDEN', outcome: 'not_applied' })
      case 'connection_error_before_apply':
        throw new ConnectorError('connection', 'network down', { outcome: 'unknown' })
      case 'apply_then_connection_error':
        apply()
        throw new ConnectorError('connection', 'reply lost', { outcome: 'unknown' })
      default:
        apply()
    }
    return this.getResource(input.resourceId)
  }

  async saveAsTemplate(input: SaveAsTemplateInput): Promise<ResourceDetail> {
    this.record('saveAsTemplate', input)
    if (!this.isAdmin) throw new ConnectorError('permission', 'admins only', { status: 403, code: 'FORBIDDEN', outcome: 'not_applied' })
    const source = this.resources.get(input.resourceId)
    if (!source) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    if (this.resources.has(input.templateId)) throw new ConnectorError('duplicate_id', 'duplicate', { status: 409, code: 'DUPLICATE_ID', outcome: 'not_applied' })
    this.copyResource(source, input.templateId, input.name, 'templates')
    if (input.includeChildren) {
      const copyChildren = (fromId: string, toId: string) => {
        for (const child of [...this.resources.values()].filter((r) => r.parentId === fromId)) {
          const copy = this.copyResource(child, `${child.id}t${this.resources.size}`.slice(0, 24), child.name, toId)
          copyChildren(child.id, copy.id)
        }
      }
      copyChildren(source.id, input.templateId)
    }
    return this.getResource(input.templateId)
  }

  async updateResourceLabels(resourceId: string, labels: { tags: string[]; aliases: string[] }): Promise<{ tags: string[]; aliases: string[] }> {
    this.record('updateResourceLabels', { resourceId, ...labels })
    const r = this.resources.get(resourceId)
    if (!r) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    r.tags = [...labels.tags]
    r.aliases = [...labels.aliases]
    return { tags: r.tags, aliases: r.aliases }
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

  /** Fails tag updates for these resources; `apply_then_connection_error` applies first. */
  tagUpdateBehavior = new Map<string, CreateBehavior>()

  async updateResourceTags(resourceId: string, tags: string[]): Promise<{ tags: string[]; updatedAt: string | null }> {
    this.record('updateResourceTags', { resourceId, tags })
    const r = this.resources.get(resourceId)
    if (!r) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    const behavior = this.tagUpdateBehavior.get(resourceId)
    if (behavior === 'validation_error') throw new ConnectorError('validation', 'invalid', { status: 400, code: 'VALIDATION_ERROR', outcome: 'not_applied' })
    if (behavior === 'server_error_before_apply') throw new ConnectorError('server', 'server error', { status: 500, outcome: 'unknown' })
    r.tags = [...tags]
    r.updatedAt = new Date(Date.now() + this.calls.length).toISOString()
    if (behavior === 'apply_then_connection_error') throw new ConnectorError('connection', 'reply lost', { outcome: 'unknown' })
    return { tags: r.tags, updatedAt: r.updatedAt }
  }

  /** Documents whose replacement should fail as if the reply was lost after applying. */
  replaceBehavior = new Map<string, CreateBehavior>()

  async replaceDocumentBlocks(resourceId: string, documentId: string, blocks: unknown[], ifMatch: string): Promise<{ version: string }> {
    this.record('replaceDocumentBlocks', { resourceId, documentId, ifMatch })
    const doc = this.resources.get(resourceId)?.documents.find((d) => d.id === documentId)
    if (!doc) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    if (doc.version !== ifMatch) throw new ConnectorError('version_conflict', 'version mismatch', { status: 412, code: 'VERSION_MISMATCH', outcome: 'not_applied' })
    if (hasUnwritable(blocks)) throw unsupportedHref()
    const behavior = this.replaceBehavior.get(resourceId)
    if (behavior === 'validation_error') throw new ConnectorError('validation', 'invalid', { status: 400, code: 'INVALID_CONTENT', outcome: 'not_applied', issues: [{ path: 'blocks[0]', message: 'bad block' }] })
    if (behavior === 'server_error_before_apply') throw new ConnectorError('server', 'server error', { status: 500, outcome: 'unknown' })
    doc.blocks = blocks
    doc.version = `v${Number(doc.version.replace(/\D/g, '') || '1') + 1}`
    doc.text = JSON.stringify(blocks)
    if (behavior === 'apply_then_connection_error') throw new ConnectorError('connection', 'reply lost', { outcome: 'unknown' })
    return { version: doc.version }
  }

  // ── Block-level edits (filling a template copy) ─────────────────────────────
  /** Block-level edits so far, by operation. */
  blockOps: { method: string; blockId?: string }[] = []
  /** Fails the n-th block-level edit (1-based), as `behavior`. */
  failBlockOp: { at: number; behavior: CreateBehavior } | null = null

  private doc(resourceId: string, documentId: string) {
    const doc = this.resources.get(resourceId)?.documents.find((d) => d.id === documentId)
    if (!doc) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    return doc
  }

  private blockWrite<T>(method: string, resourceId: string, documentId: string, ifMatch: string | null, blockId: string | undefined, apply: (blocks: Record<string, unknown>[]) => T): T {
    this.record(method, { resourceId, documentId, blockId })
    const doc = this.doc(resourceId, documentId)
    if (ifMatch !== null && doc.version !== ifMatch) throw new ConnectorError('version_conflict', 'version mismatch', { status: 412, code: 'VERSION_MISMATCH', outcome: 'not_applied' })
    this.blockOps.push({ method, blockId })
    const failing = this.failBlockOp && this.failBlockOp.at === this.blockOps.length ? this.failBlockOp.behavior : null
    if (failing === 'server_error_before_apply') throw new ConnectorError('server', 'server error', { status: 500, outcome: 'unknown' })
    if (failing === 'validation_error') throw new ConnectorError('validation', 'invalid', { status: 400, code: 'VALIDATION_ERROR', outcome: 'not_applied' })
    const result = apply(doc.blocks as Record<string, unknown>[])
    doc.version = `v${Number(doc.version.replace(/\D/g, '') || '1') + 1}`
    doc.text = JSON.stringify(doc.blocks)
    if (failing === 'apply_then_connection_error') throw new ConnectorError('connection', 'reply lost', { outcome: 'unknown' })
    return result
  }

  /** The list holding a block (at any depth), and its index. */
  private locate(blocks: Record<string, unknown>[], blockId: string): { list: Record<string, unknown>[]; index: number } | null {
    const at = blocks.findIndex((b) => b.id === blockId)
    if (at !== -1) return { list: blocks, index: at }
    for (const block of blocks) {
      if (Array.isArray(block.children)) {
        const found = this.locate(block.children as Record<string, unknown>[], blockId)
        if (found) return found
      }
    }
    return null
  }

  private infobox(blocks: Record<string, unknown>[], blockId: string) {
    const where = this.locate(blocks, blockId)
    const box = where ? where.list[where.index] : undefined
    if (!box || !Array.isArray(box.rows)) throw new ConnectorError('not_found', 'block not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    return box.rows as Record<string, unknown>[]
  }

  async assignBlockIds(resourceId: string, documentId: string): Promise<{ version: string }> {
    let n = 0
    this.blockWrite('assignBlockIds', resourceId, documentId, null, undefined, (blocks) => {
      const visit = (list: Record<string, unknown>[]) => {
        for (const block of list) {
          if (!block.id) block.id = `blk${n++}x${this.blockOps.length}`
          if (block.kind === 'infobox') for (const row of (block.rows as Record<string, unknown>[]) ?? []) if (!row.id) row.id = `row${n++}x${this.blockOps.length}`
          if (Array.isArray(block.children)) visit((block.children as Record<string, unknown>[]).filter((c) => typeof c.kind === 'string'))
        }
      }
      visit(blocks)
    })
    return { version: this.doc(resourceId, documentId).version }
  }

  async insertBlock(resourceId: string, documentId: string, input: { block: unknown; after?: string; before?: string; parent?: string }, ifMatch: string): Promise<{ version: string }> {
    const block = structuredClone(input.block) as Record<string, unknown>
    this.blockWrite('insertBlock', resourceId, documentId, ifMatch, block.id as string, (blocks) => {
      if (hasUnwritable(block)) throw unsupportedHref()
      if (block.id && this.locate(blocks, block.id as string)) throw new ConnectorError('duplicate_id', 'duplicate block id', { status: 409, code: 'DUPLICATE_ID', outcome: 'not_applied' })
      const notFound = () => new ConnectorError('not_found', 'anchor not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      if (input.parent) {
        const where = this.locate(blocks, input.parent)
        if (!where) throw notFound()
        const container = where.list[where.index]!
        container.children = [...((container.children as unknown[]) ?? []), block]
        return
      }
      const anchor = input.after ?? input.before
      if (!anchor) return void blocks.push(block)
      const where = this.locate(blocks, anchor)
      if (!where) throw notFound()
      where.list.splice(input.after ? where.index + 1 : where.index, 0, block)
    })
    return { version: this.doc(resourceId, documentId).version }
  }

  async replaceBlock(resourceId: string, documentId: string, blockId: string, block: unknown, ifMatch: string): Promise<{ version: string }> {
    this.blockWrite('replaceBlock', resourceId, documentId, ifMatch, blockId, (blocks) => {
      if (hasUnwritable(block)) throw unsupportedHref()
      const where = this.locate(blocks, blockId)
      if (!where) throw new ConnectorError('not_found', 'block not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      where.list[where.index] = { ...(structuredClone(block) as Record<string, unknown>), id: blockId }
    })
    return { version: this.doc(resourceId, documentId).version }
  }

  async updateBlock(resourceId: string, documentId: string, blockId: string, patch: Record<string, unknown>, ifMatch: string): Promise<{ version: string }> {
    this.blockWrite('updateBlock', resourceId, documentId, ifMatch, blockId, (blocks) => {
      const where = this.locate(blocks, blockId)
      if (!where) throw new ConnectorError('not_found', 'block not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      Object.assign(where.list[where.index]!, structuredClone(patch))
    })
    return { version: this.doc(resourceId, documentId).version }
  }

  async deleteBlock(resourceId: string, documentId: string, blockId: string, ifMatch: string): Promise<void> {
    this.blockWrite('deleteBlock', resourceId, documentId, ifMatch, blockId, (blocks) => {
      const where = this.locate(blocks, blockId)
      if (!where) throw new ConnectorError('not_found', 'block not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      where.list.splice(where.index, 1)
    })
  }

  async updateInfoboxProperty(resourceId: string, documentId: string, blockId: string, propertyId: string, patch: Record<string, unknown>, ifMatch: string): Promise<{ version: string }> {
    this.blockWrite('updateInfoboxProperty', resourceId, documentId, ifMatch, propertyId, (blocks) => {
      const row = this.infobox(blocks, blockId).find((r) => r.id === propertyId)
      if (!row) throw new ConnectorError('not_found', 'property not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      Object.assign(row, structuredClone(patch))
    })
    return { version: this.doc(resourceId, documentId).version }
  }

  async createInfoboxProperty(resourceId: string, documentId: string, blockId: string, property: unknown, ifMatch: string): Promise<{ version: string }> {
    this.blockWrite('createInfoboxProperty', resourceId, documentId, ifMatch, blockId, (blocks) => {
      const rows = this.infobox(blocks, blockId)
      const prop = structuredClone(property) as Record<string, unknown>
      if (prop.id && rows.some((r) => r.id === prop.id)) throw new ConnectorError('duplicate_id', 'duplicate id', { status: 409, code: 'DUPLICATE_ID', outcome: 'not_applied' })
      rows.push(prop)
    })
    return { version: this.doc(resourceId, documentId).version }
  }

  async deleteInfoboxProperty(resourceId: string, documentId: string, blockId: string, propertyId: string, ifMatch: string): Promise<void> {
    this.blockWrite('deleteInfoboxProperty', resourceId, documentId, ifMatch, propertyId, (blocks) => {
      const rows = this.infobox(blocks, blockId)
      const at = rows.findIndex((r) => r.id === propertyId)
      if (at === -1) throw new ConnectorError('not_found', 'property not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
      rows.splice(at, 1)
    })
  }

  // ── Timelines ───────────────────────────────────────────────────────────────
  calendars: LkCalendarInfo[] = [
    { id: 'greyhawk', name: 'Greyhawk', positiveEras: [{ abbr: 'CY', name: 'Common Year' }], negativeEra: null, months: ['Fireseek', 'Readying', 'Coldeven', 'Growfest', 'Planting', 'Flocktime', 'Wealsun', 'Richfest', 'Reaping', 'Goodmonth', 'Harvester', 'Brewfest', 'Patchwall', "Ready'reat", 'Sunsebb', 'Needfest'], builtIn: true },
    { id: 'gh-custom', name: 'Greyhawk (Use This)', positiveEras: [{ abbr: 'CY', name: 'Common Year' }], negativeEra: { abbr: 'BCY', name: 'Before Common Year' }, months: ['Needfest', 'Fireseek', 'Readying', 'Coldeven', 'Growfest', 'Planting', 'Flocktime', 'Wealsun', 'Richfest', 'Reaping', 'Goodmonth', 'Harvester', 'Brewfest', 'Patchwall', "Ready'reat", 'Sunsebb'], builtIn: false },
  ]
  /** Timeline documents by document id. Add one with `addTimeline`. */
  timelines = new Map<string, { resourceId: string; name: string; calendarId: string; lanes: TimelineLaneInfo[]; events: TimelineEventInfo[] }>()
  /** Makes event creation fail like this (e.g. to test uncertain outcomes). */
  eventCreateBehavior: CreateBehavior = 'ok'

  addTimeline(resourceId: string, documentId: string, options: { name?: string; calendarId?: string; lanes?: TimelineLaneInfo[]; events?: TimelineEventInfo[] } = {}) {
    const resource = this.resources.get(resourceId)
    if (resource && !resource.documents.some((d) => d.id === documentId)) resource.documents.push({ id: documentId, name: options.name ?? 'Timeline', type: 'time', blocks: [], version: 'v1', text: '' })
    this.timelines.set(documentId, { resourceId, name: options.name ?? 'Timeline', calendarId: options.calendarId ?? 'gh-custom', lanes: options.lanes ?? [{ id: 'lane1', name: 'History', external: false }], events: options.events ?? [] })
  }

  private timeline(resourceId: string, documentId: string) {
    const t = this.timelines.get(documentId)
    if (!t || t.resourceId !== resourceId) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    return t
  }

  async listCalendars(): Promise<LkCalendarInfo[]> {
    this.record('listCalendars', null)
    return this.calendars
  }

  async getTimelineDocument(resourceId: string, documentId: string): Promise<TimelineDocumentInfo> {
    this.record('getTimelineDocument', { resourceId, documentId })
    const t = this.timeline(resourceId, documentId)
    return { resourceId, documentId, name: t.name, type: 'time', calendarId: t.calendarId }
  }

  async listTimelineLanes(resourceId: string, documentId: string): Promise<TimelineLaneInfo[]> {
    this.record('listTimelineLanes', { resourceId, documentId })
    return this.timeline(resourceId, documentId).lanes
  }

  async listTimelineEvents(resourceId: string, documentId: string, max: number): Promise<TimelineEventInfo[]> {
    this.record('listTimelineEvents', { resourceId, documentId })
    return this.timeline(resourceId, documentId).events.slice(0, max)
  }

  async getTimelineEvent(resourceId: string, documentId: string, eventId: string): Promise<TimelineEventInfo> {
    this.record('getTimelineEvent', { resourceId, documentId, eventId })
    const event = this.timeline(resourceId, documentId).events.find((e) => e.id === eventId)
    if (!event) throw new ConnectorError('not_found', 'not found', { status: 404, code: 'NOT_FOUND', outcome: 'not_applied' })
    return event
  }

  async createTimelineEvent(input: CreateTimelineEventInput): Promise<TimelineEventInfo> {
    this.record('createTimelineEvent', input)
    const t = this.timeline(input.resourceId, input.documentId)
    if (this.eventCreateBehavior === 'connection_error_before_apply') throw new ConnectorError('connection', 'network down', { outcome: 'unknown' })
    if (t.events.some((e) => e.id === input.eventId)) throw new ConnectorError('duplicate_id', 'duplicate', { status: 409, code: 'DUPLICATE_ID', outcome: 'not_applied' })
    if (input.uri && !this.resources.has(input.uri.replace('lk://resources/', ''))) throw new ConnectorError('validation', 'uri target is not a resource', { status: 400, code: 'VALIDATION_ERROR', outcome: 'not_applied' })
    const calendar = this.calendars.find((c) => c.id === t.calendarId)!
    const read = (text: string | null) => {
      if (!text) return null
      const m = text.match(/^(?:([A-Za-z'’]+) (?:(\d+)\w\w, )?)?(\d+)(?: (\w+))?$/)
      if (!m) return null
      const negative = Boolean(m[4] && m[4] === calendar.negativeEra?.abbr)
      const monthIndex = m[1] ? calendar.months.indexOf(m[1]) : 0
      return { date: { year: Number(m[3]), month: monthIndex + 1, monthName: calendar.months[monthIndex] ?? '', day: m[2] ? Number(m[2]) : 1, era: { abbr: negative ? calendar.negativeEra!.abbr : calendar.positiveEras[0]!.abbr } }, detail: m[2] ? 3 : m[1] ? 2 : 1 }
    }
    const start = read(input.formattedStart)
    const end = read(input.formattedEnd)
    const event: TimelineEventInfo = {
      id: input.eventId,
      laneId: input.laneId,
      type: 'event',
      name: input.name,
      formattedStart: input.formattedStart,
      formattedEnd: input.formattedEnd,
      startDate: start?.date ?? null,
      endDate: end?.date ?? null,
      detail: start?.detail ?? 1,
      uri: input.uri,
      isHidden: false,
      external: false,
    }
    t.events.push(event)
    if (this.eventCreateBehavior === 'apply_then_connection_error') throw new ConnectorError('connection', 'reply lost', { outcome: 'unknown' })
    return event
  }
}

/** LegendKeeper's answer to an image without a picture. */
function unsupportedHref() {
  return new ConnectorError('validation', 'unsupported href', { status: 400, code: 'VALIDATION_ERROR', outcome: 'not_applied', issues: [{ path: 'url', message: 'unsupported href' }] })
}
