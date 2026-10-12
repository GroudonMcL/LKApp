import 'server-only'
import { LegendKeeper, SDK_VERSION, type components } from '@legendkeeper/sdk'
import { plainText, walk, type Block, type PropertyBlock } from '@legendkeeper/sdk/blocks'
import type { LegendKeeperConnector } from './connector'
import { toConnectorError } from './errors'
import type {
  CreateFromTemplateInput,
  CreateTimelineEventInput,
  Placement,
  SaveAsTemplateInput,
  LkCalendarInfo,
  TimelineDocumentInfo,
  TimelineEventDate,
  TimelineEventInfo,
  TimelineLaneInfo,
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

  async listTemplates(options: { cursor?: string | null; limit?: number }): Promise<ResourcePage> {
    return this.call(async () => {
      const page = await this.reader.templates.list({
        limit: Math.min(Math.max(options.limit ?? 50, 1), 100),
        ...(options.cursor ? { cursor: options.cursor } : {}),
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
      // LegendKeeper returns a resource once per matching document; keep its best (first) hit.
      const seen = new Set<string>()
      const unique = page.data.filter((hit) => (seen.has(hit.resource.id) ? false : (seen.add(hit.resource.id), true)))
      return unique.map((hit) => ({
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
      await pace()
      const created = await this.writer.resources.create({
        id: input.resourceId,
        name: input.name,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        tags: input.tags,
        aliases: input.aliases,
        documents: [{ type: 'page', name: input.documentName, blocks: input.blocks as Block[] }],
        ...placementOf(input.placement),
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

  async updateResourceTags(resourceId: string, tags: string[]): Promise<{ tags: string[]; updatedAt: string | null }> {
    return this.call(async () => {
      await pace()
      const updated = await this.writer.resources.update({ resourceId }, { tags })
      return { tags: updated.tags, updatedAt: updated.updatedAt ?? null }
    })
  }

  async updateResourceLabels(resourceId: string, labels: { tags: string[]; aliases: string[] }): Promise<{ tags: string[]; aliases: string[] }> {
    return this.call(async () => {
      await pace()
      const updated = await this.writer.resources.update({ resourceId }, { tags: labels.tags, aliases: labels.aliases })
      return { tags: updated.tags, aliases: updated.aliases }
    })
  }

  async createFromTemplate(input: CreateFromTemplateInput): Promise<ResourceDetail> {
    return this.call(async () => {
      await pace()
      const created = await this.writer.resources.createFromTemplate({
        templateId: input.templateId,
        id: input.resourceId,
        name: input.name,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...placementOf(input.placement),
        idempotencyKey: input.idempotencyKey,
      })
      return toDetail(created)
    })
  }

  async saveAsTemplate(input: SaveAsTemplateInput): Promise<ResourceDetail> {
    return this.call(async () => {
      await pace()
      const saved = await this.writer.resources.saveAsTemplate(
        { resourceId: input.resourceId },
        { id: input.templateId, name: input.name, includeChildren: input.includeChildren, idempotencyKey: input.idempotencyKey },
      )
      return toDetail(saved)
    })
  }

  async replaceDocumentBlocks(resourceId: string, documentId: string, blocks: unknown[], ifMatch: string): Promise<{ version: string }> {
    return this.call(async () => {
      await pace()
      const written = await this.writer.documents.replaceBlocks({ resourceId, documentId }, { blocks: blocks as Block[], ifMatch })
      return { version: written.version }
    })
  }

  async assignBlockIds(resourceId: string, documentId: string): Promise<{ version: string }> {
    return this.call(async () => {
      await pace()
      return { version: (await this.writer.documents.assignBlockIds({ resourceId, documentId })).version }
    })
  }

  async insertBlock(resourceId: string, documentId: string, input: { block: unknown; after?: string; before?: string; parent?: string }, ifMatch: string): Promise<{ version: string }> {
    return this.call(async () => {
      await pace()
      const where = input.after ? { after: input.after } : input.before ? { before: input.before } : input.parent ? { parent: input.parent } : {}
      const written = await this.writer.blocks.insert({ resourceId, documentId }, { block: input.block as Block, ...where, ifMatch })
      return { version: written.version }
    })
  }

  async updateBlock(resourceId: string, documentId: string, blockId: string, patch: Record<string, unknown>, ifMatch: string): Promise<{ version: string }> {
    return this.call(async () => {
      await pace()
      const written = await this.writer.blocks.update({ resourceId, documentId, blockId }, { ...(patch as object), ifMatch } as never)
      return { version: (written as { version: string }).version }
    })
  }

  async replaceBlock(resourceId: string, documentId: string, blockId: string, block: unknown, ifMatch: string): Promise<{ version: string }> {
    return this.call(async () => {
      await pace()
      const written = await this.writer.blocks.replace({ resourceId, documentId, blockId }, { ...(block as Block), ifMatch })
      return { version: written.version }
    })
  }

  async deleteBlock(resourceId: string, documentId: string, blockId: string, ifMatch: string): Promise<void> {
    return this.call(async () => {
      await pace()
      await this.writer.blocks.delete({ resourceId, documentId, blockId }, { ifMatch })
    })
  }

  async updateInfoboxProperty(resourceId: string, documentId: string, blockId: string, propertyId: string, patch: Record<string, unknown>, ifMatch: string): Promise<{ version: string }> {
    return this.call(async () => {
      await pace()
      const written = await this.writer.blocks.updateProperty({ resourceId, documentId, blockId, propertyId }, { ...(patch as object), ifMatch } as never)
      return { version: (written as { version: string }).version }
    })
  }

  async createInfoboxProperty(resourceId: string, documentId: string, blockId: string, property: unknown, ifMatch: string): Promise<{ version: string }> {
    return this.call(async () => {
      await pace()
      const written = await this.writer.blocks.createProperty({ resourceId, documentId, blockId }, { ...(property as object), ifMatch } as never)
      return { version: (written as { version: string }).version }
    })
  }

  async deleteInfoboxProperty(resourceId: string, documentId: string, blockId: string, propertyId: string, ifMatch: string): Promise<void> {
    return this.call(async () => {
      await pace()
      await this.writer.blocks.deleteProperty({ resourceId, documentId, blockId, propertyId }, { ifMatch })
    })
  }

  async listCalendars(): Promise<LkCalendarInfo[]> {
    return this.call(async () => {
      const list = await this.reader.calendars.list()
      const builtIn = new Set(['gregorian', 'harptos', 'eberron', 'exandria', 'greyhawk', 'elder-scrolls'])
      return list.data.map((c) => ({
        id: c.id,
        name: c.name,
        positiveEras: (c.positiveEras ?? []).map((e) => ({ abbr: e.abbr ?? '', name: e.name ?? '' })),
        negativeEra: c.negativeEra ? { abbr: c.negativeEra.abbr ?? '', name: c.negativeEra.name ?? '' } : null,
        months: c.months.map((m) => m.name),
        builtIn: builtIn.has(c.id),
      }))
    })
  }

  async getTimelineDocument(resourceId: string, documentId: string): Promise<TimelineDocumentInfo> {
    return this.call(async () => {
      const doc = await this.reader.documents.get({ resourceId, documentId })
      return { resourceId, documentId, name: doc.name, type: doc.type, calendarId: (doc as { calendarId?: string }).calendarId ?? null }
    })
  }

  async listTimelineLanes(resourceId: string, documentId: string): Promise<TimelineLaneInfo[]> {
    return this.call(async () => {
      const lanes = await this.reader.timelines.listLanes({ resourceId, documentId })
      return lanes.data.map((lane) => ({ id: lane.id, name: lane.name, external: isExternal(lane as typeof lane & { sourceUri?: string; isExternal?: boolean }, resourceId, documentId) }))
    })
  }

  async listTimelineEvents(resourceId: string, documentId: string, max: number): Promise<TimelineEventInfo[]> {
    return this.call(async () => {
      const out: TimelineEventInfo[] = []
      for await (const event of await this.reader.timelines.listEvents({ resourceId, documentId }, { limit: 100 })) {
        out.push(toEvent(event, resourceId, documentId))
        if (out.length >= max) break
      }
      return out
    })
  }

  async getTimelineEvent(resourceId: string, documentId: string, eventId: string): Promise<TimelineEventInfo> {
    return this.call(async () => toEvent(await this.reader.timelines.getEvent({ resourceId, documentId, eventId }), resourceId, documentId))
  }

  async createTimelineEvent(input: CreateTimelineEventInput): Promise<TimelineEventInfo> {
    return this.call(async () => {
      await pace()
      const created = await this.writer.timelines.createEvent(
        { resourceId: input.resourceId, documentId: input.documentId },
        {
          id: input.eventId,
          laneId: input.laneId,
          type: 'event',
          name: input.name,
          formattedStart: input.formattedStart,
          ...(input.formattedEnd ? { formattedEnd: input.formattedEnd } : {}),
          ...(input.uri ? { uri: input.uri } : {}),
        },
      )
      return toEvent(created, input.resourceId, input.documentId)
    })
  }
}

/**
 * Paces writes below LegendKeeper's limit of 120 a minute per key: a short burst (up to 15) goes
 * straight through, then at most one write every 600 ms (100 a minute). Shared by every
 * connector in this process, so a batch and a single page together stay under the limit.
 */
export const WRITE_PACING = { burst: 15, intervalMs: 600 }
const PACE = Symbol.for('lk-companion.write-pace')

async function pace(): Promise<void> {
  const store = globalThis as unknown as Record<symbol, { tokens: number; at: number } | undefined>
  const now = Date.now()
  const state = store[PACE] ?? { tokens: WRITE_PACING.burst, at: now }
  state.tokens = Math.min(WRITE_PACING.burst, state.tokens + (now - state.at) / WRITE_PACING.intervalMs) - 1
  state.at = now
  store[PACE] = state
  // A negative balance is the queue of writes ahead of this one.
  if (state.tokens < 0) await new Promise((resolve) => setTimeout(resolve, -state.tokens * WRITE_PACING.intervalMs))
}

function placementOf(placement: Placement | null | undefined): Placement {
  if (placement?.after) return { after: placement.after }
  if (placement?.before) return { before: placement.before }
  return {}
}

function isExternal(item: { sourceUri?: string; isExternal?: boolean }, resourceId: string, documentId: string): boolean {
  if (typeof item.isExternal === 'boolean') return item.isExternal
  return Boolean(item.sourceUri && item.sourceUri !== `lk://resources/${resourceId}/docs/${documentId}`)
}

function toEventDate(value: unknown): TimelineEventDate | null {
  const d = value as { year?: number; month?: number; monthName?: string; day?: number; era?: { id?: string; name?: string; abbr?: string } } | null | undefined
  if (!d || typeof d.year !== 'number') return null
  return { year: d.year, month: d.month ?? 1, monthName: d.monthName ?? '', day: d.day ?? 1, era: d.era ?? null }
}

function toEvent(event: components['schemas']['Event'], resourceId: string, documentId: string): TimelineEventInfo {
  const e = event as components['schemas']['Event'] & { sourceUri?: string; isExternal?: boolean }
  return {
    id: e.id,
    laneId: e.laneId ?? null,
    type: e.type,
    name: e.name ?? '',
    formattedStart: e.formattedStart ?? null,
    formattedEnd: e.formattedEnd ?? null,
    startDate: toEventDate(e.startDate),
    endDate: toEventDate(e.endDate),
    detail: e.detail ?? null,
    uri: e.uri ?? null,
    isHidden: e.isHidden ?? false,
    external: isExternal(e, resourceId, documentId),
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
