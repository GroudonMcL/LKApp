import { LegendKeeper, VersionMismatchError, type components } from '@legendkeeper/sdk'
import { image, walk, type Block } from '@legendkeeper/sdk/blocks'
import { idempotencyKeyFor, newLkResourceId } from '@/core/ids'
import { newPageBlocks, pageAfterAppend, sourcePageBlocks, type SourceRef } from '@/core/clipper/blocks'
import { ProjectIndex, writableDocuments, type IndexEntry, type SearchResult } from '@/core/clipper/project-index'

/**
 * Web Clipper: the LegendKeeper side of the clipper (Phase 1 of the Web Clipper brief).
 *
 * Every call the clipper makes to LegendKeeper goes through this class, on the local machine
 * only: the browser extension (Phase 2) will talk to the local service, never to LegendKeeper,
 * so the API key never reaches a web page. It deliberately has no `server-only` import, so the
 * Phase 1 proof of concept (`scripts/clipper-phase1.ts`) can run it from the command line.
 *
 * Writes:
 * - Creating a page or Source page uses an id chosen before the write plus an Idempotency-Key,
 *   so a repeated request can never make a second page.
 * - Appending reads the page, adds the new blocks after the existing ones (echoed exactly as
 *   read) and writes with `ifMatch`. If the page changed in between (someone typing in
 *   LegendKeeper), LegendKeeper refuses with 412 and nothing is written; the clipper reads the
 *   page again and re-applies the append, up to `maxAttempts` times. Writes are never retried
 *   automatically otherwise: a lost reply is reported, and the page is checked before anything else.
 */

type ImageContentType = 'image/jpeg' | 'image/jpg' | 'image/png' | 'image/gif' | 'image/webp'
const IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'])
/** Clipped images over this size are refused rather than uploaded. */
export const MAX_CLIP_IMAGE_BYTES = 15_000_000

export interface ClipperClientOptions {
  apiKey: string
  baseUrl?: string | null
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export interface CreatedClipPage {
  resourceId: string
  documentId: string
  name: string
  version: string
  blocks: Block[]
}

export interface AppendResult {
  resourceId: string
  documentId: string
  version: string
  /** Attempts used: 1 unless the page changed while the clip was being written. */
  attempts: number
  blocksBefore: number
  blocksAfter: number
  /** The document type before the write (`blank` becomes `page`). */
  documentTypeBefore: string
}

export interface UploadedImage {
  assetId: string
  url: string
  width: number | null
  height: number | null
  contentType: string
  bytes: number
}

export class ClipperClient {
  /** Reads (and image uploads): the SDK's default retries on 429/5xx and dropped connections. */
  readonly lk: LegendKeeper
  /**
   * Page writes: no automatic retries. A whole-tab replace whose reply was lost would otherwise
   * be re-sent by the SDK, answered 412 (the first one changed the version), and the append
   * loop would then add the clip a second time.
   */
  private readonly writer: LegendKeeper

  constructor(options: ClipperClientOptions) {
    const common = {
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeoutMs: 30_000,
    }
    this.lk = new LegendKeeper(common)
    this.writer = new LegendKeeper({ ...common, maxRetries: 0 })
  }

  async project(): Promise<{ id: string; name: string }> {
    const project = await this.lk.project()
    return { id: project.id, name: project.name ?? '(unnamed project)' }
  }

  /**
   * Every page of the project (all list pages of 100), as a searchable index. Templates (under
   * the virtual parent `templates`, at any depth) are listed too and are left out.
   */
  async loadIndex(): Promise<ProjectIndex> {
    const entries: IndexEntry[] = []
    for await (const item of await this.lk.resources.list({ limit: 100 })) entries.push(toEntry(item))
    return new ProjectIndex(withoutTemplates(entries))
  }

  /** Local ranked name search, then LegendKeeper's content matches. */
  async search(index: ProjectIndex, query: string, limit = 20): Promise<SearchResult[]> {
    const byName = index.search(query, { limit })
    const remote = await this.lk.search.search({ q: query, limit: 50 })
    const hits = remote.data.filter((hit) => hit.document).map((hit) => ({ resourceId: hit.resource.id, highlight: hit.document?.highlights?.[0]?.segment ?? null }))
    return index.mergeContentHits(byName, hits, limit)
  }

  /** LegendKeeper's own search, unranked by the clipper (for comparison). */
  async remoteSearch(query: string, limit = 20): Promise<{ resourceId: string; name: string; inContent: boolean }[]> {
    const remote = await this.lk.search.search({ q: query, limit })
    return remote.data.map((hit) => ({ resourceId: hit.resource.id, name: hit.resource.name, inContent: !!hit.document }))
  }

  /** Creates a page (one page document) under `parentId` (top level without one: ADMIN keys only). */
  async createPage(input: { name: string; parentId?: string | null; blocks: Block[]; tags?: string[]; aliases?: string[] }): Promise<CreatedClipPage> {
    const id = newLkResourceId()
    const created = await this.writer.resources.create({
      id,
      name: input.name,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      tags: input.tags ?? [],
      aliases: input.aliases ?? [],
      documents: [{ type: 'page', name: 'Main', blocks: input.blocks }],
      idempotencyKey: idempotencyKeyFor('lk-clipper', 'create', id),
    })
    const document = created.documents[0]
    if (!document) throw new Error(`LegendKeeper created "${created.name}" without a document`)
    const content = await this.lk.documents.getBlocks({ resourceId: created.id, documentId: document.id })
    return { resourceId: created.id, documentId: document.id, name: created.name, version: content.version, blocks: content.blocks }
  }

  /** A new clipped page: H1 "From <Source>" and the content. */
  async createClipPage(input: { name: string; parentId: string; source: SourceRef; content: Block[] }): Promise<CreatedClipPage> {
    return this.createPage({ name: input.name, parentId: input.parentId, blocks: newPageBlocks(input.source, input.content) })
  }

  /** A new Source page under the Sources page: a Backlinks collection, nothing else. */
  async createSourcePage(input: { name: string; sourcesParentId: string; aliases?: string[] }): Promise<CreatedClipPage> {
    return this.createPage({ name: input.name, parentId: input.sourcesParentId, blocks: sourcePageBlocks(), ...(input.aliases ? { aliases: input.aliases } : {}) })
  }

  /** The tab to append to: the given one, or the resource's first page (or blank) tab. */
  async pickDocument(resourceId: string, documentId?: string): Promise<{ id: string; type: string; name: string }> {
    const resource = await this.lk.resources.get({ resourceId })
    const docs = resource.documents.map((doc) => ({ id: doc.id, name: doc.name, type: doc.type }))
    if (documentId) {
      const doc = docs.find((d) => d.id === documentId)
      if (!doc) throw new Error(`"${resource.name}" has no tab ${documentId}`)
      if (!writableDocuments({ documents: [doc] }).length) throw new Error(`The tab "${doc.name}" of "${resource.name}" is a ${doc.type}, not a page`)
      return doc
    }
    const doc = writableDocuments({ documents: docs })[0]
    if (!doc) throw new Error(`"${resource.name}" has no page tab to append to`)
    return doc
  }

  /**
   * Appends divider + H1 "From <Source>" + content to the end of a page, never changing what
   * is already there. `beforeWrite` runs between the read and the write of each attempt (the
   * proof of concept uses it to simulate an edit made in LegendKeeper at that moment).
   */
  async appendClip(input: {
    resourceId: string
    documentId?: string
    source: SourceRef
    content: Block[]
    maxAttempts?: number
    beforeWrite?: (attempt: number) => Promise<void>
  }): Promise<AppendResult> {
    const doc = await this.pickDocument(input.resourceId, input.documentId)
    const ref = { resourceId: input.resourceId, documentId: doc.id }
    const maxAttempts = input.maxAttempts ?? 3
    await this.ensureUnsupportedBlocksHaveIds(ref)
    for (let attempt = 1; ; attempt++) {
      const current = await this.lk.documents.getBlocks(ref)
      const blocks = pageAfterAppend(current.blocks, input.source, input.content)
      await input.beforeWrite?.(attempt)
      try {
        const written = await this.writer.documents.replaceBlocks(ref, { blocks, ifMatch: current.version })
        return {
          resourceId: input.resourceId,
          documentId: doc.id,
          version: written.version,
          attempts: attempt,
          blocksBefore: current.blocks.length,
          blocksAfter: written.blocks.length,
          documentTypeBefore: doc.type,
        }
      } catch (error) {
        if (error instanceof VersionMismatchError && attempt < maxAttempts) continue
        throw error
      }
    }
  }

  /**
   * An `unsupported` block (content the API cannot express) survives a whole-page replace only
   * when it is echoed with its id. Pages made before block ids existed may lack them, so give
   * them ids first. This changes nothing visible.
   */
  private async ensureUnsupportedBlocksHaveIds(ref: { resourceId: string; documentId: string }): Promise<void> {
    const content = await this.lk.documents.getBlocks(ref)
    let missing = false
    walk(content, (block) => {
      if (block.kind === 'unsupported' && !block.id) missing = true
    })
    if (missing) await this.writer.documents.assignBlockIds(ref)
  }

  /** Uploads image bytes as an asset of this project. */
  async uploadImage(input: { data: Uint8Array; contentType: string; name: string; folderId?: string }): Promise<UploadedImage> {
    const contentType = input.contentType.toLowerCase().split(';')[0]!.trim()
    if (!IMAGE_TYPES.has(contentType)) throw new Error(`LegendKeeper accepts JPEG, PNG, GIF and WebP images, not ${contentType || 'an unknown type'}`)
    if (input.data.byteLength > MAX_CLIP_IMAGE_BYTES) throw new Error(`The image is ${input.data.byteLength} bytes; the limit is ${MAX_CLIP_IMAGE_BYTES}`)
    const asset = await this.lk.assets.uploadImage({
      data: input.data,
      contentType: contentType as ImageContentType,
      name: input.name.slice(0, 200) || 'Clipped image',
      ...(input.folderId ? { folderId: input.folderId } : {}),
    })
    if (!asset.url) throw new Error('LegendKeeper returned the uploaded image without a url')
    return { assetId: asset.id, url: asset.url, width: asset.width ?? null, height: asset.height ?? null, contentType, bytes: input.data.byteLength }
  }

  /**
   * Downloads an image from a web page and uploads it. Websites may refuse (hotlink rules,
   * sign-in, expired links); the caller decides what to do then (Phase 4: keep a link instead).
   */
  async uploadImageFromUrl(url: string, name: string, fetchImpl: typeof fetch = fetch): Promise<UploadedImage> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`Only http and https images can be clipped, not ${parsed.protocol}`)
    const response = await fetchImpl(url, { headers: { 'user-agent': 'LKWebClipper/0.1 (personal LegendKeeper clipper)', accept: 'image/*' }, redirect: 'follow' })
    if (!response.ok) throw new Error(`The website answered ${response.status} for the image`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_CLIP_IMAGE_BYTES) throw new Error(`The image is ${declared} bytes; the limit is ${MAX_CLIP_IMAGE_BYTES}`)
    const data = new Uint8Array(await response.arrayBuffer())
    const contentType = sniffImageType(data) ?? response.headers.get('content-type') ?? ''
    return this.uploadImage({ data, contentType, name })
  }
}

/** An image block for an uploaded asset, with its alt text. */
export function clipImageBlock(uploaded: UploadedImage, alt: string): Block {
  return image(uploaded.url, { alt })
}

/** The real type from the file's first bytes; websites often send the wrong Content-Type. */
export function sniffImageType(data: Uint8Array): ImageContentType | null {
  const starts = (...bytes: number[]) => bytes.every((byte, i) => data[i] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return null
}

function withoutTemplates(entries: IndexEntry[]): IndexEntry[] {
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]))
  const isTemplate = (entry: IndexEntry): boolean => {
    const seen = new Set<string>()
    let parentId = entry.parentId
    while (parentId && !seen.has(parentId)) {
      if (parentId === 'templates') return true
      seen.add(parentId)
      parentId = parentOf.get(parentId) ?? null
    }
    return false
  }
  return entries.filter((entry) => !isTemplate(entry))
}

function toEntry(item: components['schemas']['ResourceListItem']): IndexEntry {
  return {
    id: item.id,
    name: item.name,
    aliases: item.aliases,
    tags: item.tags,
    parentId: item.parentId ?? null,
    documents: item.documents.map((doc) => ({ id: doc.id, name: doc.name ?? '(unnamed)', type: doc.type ?? 'unknown' })),
  }
}
