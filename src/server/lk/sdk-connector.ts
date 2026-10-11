import 'server-only'
import { LegendKeeper, SDK_VERSION, type components } from '@legendkeeper/sdk'
import { plainText, walk, type Block, type PropertyBlock } from '@legendkeeper/sdk/blocks'
import type { LegendKeeperConnector } from './connector'
import { toConnectorError } from './errors'
import type {
  CreatePageInput,
  CreatedPage,
  DocumentContent,
  ProjectInfo,
  PropertySummary,
  ResourceDetail,
  ResourcePage,
  ResourceSummary,
  SearchHit,
  TagCount,
} from './types'

type ResourceListItem = components['schemas']['ResourceListItem']
type Resource = components['schemas']['Resource']

export const LEGENDKEEPER_SDK_VERSION: string = SDK_VERSION

export interface SdkConnectorOptions {
  apiKey: string
  baseUrl?: string | null
  /** Inject a fetch for contract tests against a local mock server. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

/**
 * The production connector, built on the official `@legendkeeper/sdk`.
 *
 * Two clients are used:
 * - `reader`: the SDK's default retry policy (up to 2 retries on 429/502/503/504 and
 *   connection failures, honouring Retry-After). Safe for reads.
 * - `writer`: `maxRetries: 0`. The app never retries a write on its own. If a create's
 *   outcome is uncertain, the user checks whether the page exists before anything else.
 *   (The SDK's own POST retries would be safe thanks to the Idempotency-Key, but turning
 *   them off makes the behaviour easy to reason about.)
 */
export class SdkConnector implements LegendKeeperConnector {
  private readonly reader: LegendKeeper
  private readonly writer: LegendKeeper

  constructor(options: SdkConnectorOptions) {
    const common = {
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeoutMs: options.timeoutMs ?? 20_000,
    }
    this.reader = new LegendKeeper({ ...common, maxRetries: 2 })
    this.writer = new LegendKeeper({ ...common, maxRetries: 0 })
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      throw toConnectorError(error)
    }
  }

  async getProject(): Promise<ProjectInfo> {
    return this.call(async () => toProject(await this.reader.project()))
  }

  async pingProject(projectId: string): Promise<ProjectInfo> {
    return this.call(async () => toProject(await this.reader.projects.get({ projectId })))
  }

  async listResources(options: { cursor?: string | null; limit?: number; parentId?: string | null }): Promise<ResourcePage> {
    return this.call(async () => {
      const page = await this.reader.resources.list({
        limit: Math.min(Math.max(options.limit ?? 50, 1), 100),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.parentId ? { parentId: options.parentId } : {}),
      })
      return { items: page.data.map(toSummary), nextCursor: page.nextCursor, hasMore: page.hasMore }
    })
  }

  async getResource(resourceId: string): Promise<ResourceDetail> {
    return this.call(async () => toDetail(await this.reader.resources.get({ resourceId })))
  }

  async getDocumentContent(resourceId: string, documentId: string): Promise<DocumentContent> {
    return this.call(async () => {
      const content = await this.reader.documents.getBlocks({ resourceId, documentId })
      let unsupportedCount = 0
      walk(content, (block) => {
        if (block.kind === 'unsupported') unsupportedCount++
      })
      return { resourceId, documentId, version: content.version, text: content.text, blocks: content.blocks, unsupportedCount }
    })
  }

  async listTags(): Promise<TagCount[]> {
    return this.call(async () => {
      const page = await this.reader.tags.list()
      return page.data.map((tag) => ({ tag: tag.tag, count: tag.count }))
    })
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    return this.call(async () => {
      const page = await this.reader.search.search({ q: query, limit: Math.min(Math.max(limit, 1), 100) })
      return page.data.map((hit) => ({
        resourceId: hit.resource.id,
        name: hit.resource.name,
        parentId: hit.resource.parentId ?? null,
        tags: hit.resource.tags,
        path: (hit.resource.path ?? []).map((ancestor) => ancestor.name),
        documentName: hit.document?.name ?? null,
        highlight: hit.document?.highlights?.[0]?.segment ?? null,
      }))
    })
  }

  async createPage(input: CreatePageInput): Promise<CreatedPage> {
    return this.call(async () => {
      const created = await this.writer.resources.create({
        id: input.resourceId,
        name: input.name,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        tags: input.tags,
        aliases: input.aliases,
        documents: [{ type: 'page', name: input.documentName, blocks: input.blocks as Block[] }],
        idempotencyKey: input.idempotencyKey,
      })
      const document = created.documents[0]
      return {
        resourceId: created.id,
        name: created.name,
        parentId: created.parentId ?? null,
        tags: created.tags,
        documentId: document?.id ?? null,
        documentType: document?.type ?? null,
      }
    })
  }
}

function toProject(project: components['schemas']['Project']): ProjectInfo {
  return { id: project.id, name: project.name ?? '(unnamed project)', isPublic: project.isPublic ?? null, createdAt: project.createdAt ?? null }
}

function toSummary(item: ResourceListItem): ResourceSummary {
  return {
    id: item.id,
    name: item.name,
    parentId: item.parentId ?? null,
    tags: item.tags,
    aliases: item.aliases,
    iconGlyph: item.iconGlyph ?? null,
    isHidden: item.isHidden ?? false,
    rank: item.rank ?? null,
    updatedAt: item.updatedAt ?? null,
    documents: item.documents.map((doc) => ({ id: doc.id, name: doc.name ?? '(unnamed)', type: doc.type ?? 'unknown' })),
  }
}

function toDetail(resource: Resource): ResourceDetail {
  return {
    id: resource.id,
    name: resource.name,
    parentId: resource.parentId ?? null,
    tags: resource.tags,
    aliases: resource.aliases,
    iconGlyph: resource.iconGlyph ?? null,
    isHidden: resource.isHidden,
    isLocked: resource.isLocked ?? false,
    rank: resource.rank,
    updatedAt: resource.updatedAt ?? null,
    createdAt: resource.createdAt ?? null,
    documents: resource.documents.map((doc) => ({ id: doc.id, name: doc.name, type: doc.type, rank: doc.rank, isHidden: doc.isHidden })),
    properties: resource.properties.map(toProperty),
  }
}

function toProperty(property: PropertyBlock): PropertySummary {
  const p = property as PropertyBlock & { id?: string; title?: string; isHidden?: boolean; rows?: { key?: string; text?: string }[] }
  let text: string | null = null
  try {
    if (Array.isArray(p.rows)) text = p.rows.map((row) => `${row.key ?? ''}: ${row.text ?? ''}`).join('\n')
    else if (p.kind === 'textField') text = plainText(p as unknown as Block)
  } catch {
    text = null
  }
  return { id: p.id ?? null, kind: p.kind, title: p.title ?? null, isHidden: p.isHidden ?? false, text, raw: property }
}
