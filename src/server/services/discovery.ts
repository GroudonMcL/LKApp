import 'server-only'
import { newAppId } from '@/core/ids'
import type { AppContext } from '../context'
import type { ScanRecord } from '../db/repositories'
import { toConnectorError } from '../lk/errors'
import { log } from '../log'
import { recordAudit } from './audit'
import { knownProjectId, requireProjectId } from './connection'

/**
 * Read-only discovery of the LegendKeeper project.
 *
 * The API lists resources page by page (up to 100 per page) and cannot filter by name or
 * tag on the server. To browse, filter and audit a large project without loading it all
 * into the browser, a background *scan* copies resource **metadata** (names, parents,
 * tags, aliases, document list — no page content) into the local database.
 *
 * The scan:
 * - runs one page at a time with a pause between pages (well under the rate limits);
 * - saves the cursor after every page, so it can be paused and resumed, and resumes after
 *   a server restart (the scan shows as "interrupted");
 * - removes entries for deleted resources only after a complete pass.
 */

const SCAN_PAGE_SIZE = 100
const SCAN_DELAY_MS = 350

interface ScanControl {
  running: string | null
  pauseRequested: boolean
}
const CONTROL = Symbol.for('lk-companion.scan-control')
function control(): ScanControl {
  const g = globalThis as unknown as Record<symbol, ScanControl | undefined>
  if (!g[CONTROL]) g[CONTROL] = { running: null, pauseRequested: false }
  return g[CONTROL]!
}

export async function startOrResumeScan(ctx: AppContext, options: { wait?: boolean; delayMs?: number } = {}): Promise<ScanRecord> {
  const projectId = await requireProjectId(ctx)
  const state = control()
  if (state.running) return ctx.repos.index.getScan(state.running)!

  const latest = ctx.repos.index.latestScan(projectId)
  const resumable = latest && ['paused', 'interrupted', 'failed'].includes(latest.status) ? latest : null
  const scan = resumable ?? ctx.repos.index.createScan(newAppId('scan'), projectId)
  if (resumable) ctx.repos.index.setScanStatus(scan.id, 'running')

  state.running = scan.id
  state.pauseRequested = false
  recordAudit(ctx, { operation: 'index.scan', outcome: 'info', projectId, message: resumable ? 'Scan resumed' : 'Scan started', details: { scanId: scan.id } })

  const run = runScan(ctx, scan.id, projectId, options.delayMs ?? SCAN_DELAY_MS).finally(() => {
    state.running = null
  })
  if (options.wait) await run
  else run.catch((error) => log.error('Scan crashed', { error }))
  return ctx.repos.index.getScan(scan.id)!
}

export function requestScanPause() {
  if (control().running) control().pauseRequested = true
}

async function runScan(ctx: AppContext, scanId: string, projectId: string, delayMs: number) {
  const connector = ctx.connector()
  let cursor = ctx.repos.index.getScan(scanId)?.cursor ?? null
  try {
    for (;;) {
      if (control().pauseRequested) {
        ctx.repos.index.setScanStatus(scanId, 'paused')
        return
      }
      const page = await connector.listResources({ cursor, limit: SCAN_PAGE_SIZE })
      ctx.repos.index.upsertPage(projectId, scanId, page.items, page.nextCursor)
      cursor = page.nextCursor
      if (!page.hasMore || !page.nextCursor) break
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    const removed = ctx.repos.index.removeStale(projectId, scanId)
    ctx.repos.index.setScanStatus(scanId, 'completed')
    const scan = ctx.repos.index.getScan(scanId)!
    recordAudit(ctx, { operation: 'index.scan', outcome: 'success', projectId, message: `Scan completed: ${scan.resources} resources`, details: { scanId, pages: scan.pages, removed } })
  } catch (error) {
    const failure = toConnectorError(error)
    ctx.repos.index.setScanStatus(scanId, 'failed', failure.message)
    recordAudit(ctx, { operation: 'index.scan', outcome: 'failure', projectId, errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null, message: failure.message, details: { scanId } })
  }
}

export function scanStatus(ctx: AppContext) {
  const projectId = knownProjectId(ctx)
  if (!projectId) return { projectId: null, latest: null, lastCompleted: null, running: false, stats: null }
  return {
    projectId,
    latest: ctx.repos.index.latestScan(projectId),
    lastCompleted: ctx.repos.index.lastCompletedScan(projectId),
    running: control().running !== null,
    stats: ctx.repos.index.stats(projectId),
  }
}

export function clearIndex(ctx: AppContext) {
  const projectId = knownProjectId(ctx)
  if (!projectId) return
  if (control().running) throw new Error('A scan is running. Pause it before clearing the index.')
  ctx.repos.index.clear(projectId)
  ctx.repos.contentCache.clear(projectId)
  recordAudit(ctx, { operation: 'index.clear', outcome: 'success', projectId })
}

export interface BrowseQuery {
  q?: string
  tag?: string
  untagged?: boolean
  parentId?: string | null
  page: number
  pageSize: number
}

/** Server-side filtered, paginated browsing of the local index. */
export function browseIndex(ctx: AppContext, query: BrowseQuery) {
  const projectId = knownProjectId(ctx)
  if (!projectId) return { projectId: null, items: [], total: 0, page: query.page, pageSize: query.pageSize }
  const pageSize = Math.min(Math.max(query.pageSize, 1), 200)
  const page = Math.max(query.page, 1)
  const result = ctx.repos.index.query(projectId, {
    q: query.q?.trim() || undefined,
    tag: query.tag || undefined,
    untagged: query.untagged,
    parentId: query.parentId,
    offset: (page - 1) * pageSize,
    limit: pageSize,
  })
  return { projectId, ...result, page, pageSize }
}

/** One live page of resources straight from LegendKeeper, for use before a scan exists. */
export async function browseLive(ctx: AppContext, cursor: string | null, parentId: string | null) {
  return ctx.connector().listResources({ cursor, limit: 50, parentId })
}

export async function resourceDetail(ctx: AppContext, resourceId: string) {
  const resource = await ctx.connector().getResource(resourceId)
  const projectId = knownProjectId(ctx)
  const parent = resource.parentId && projectId ? ctx.repos.index.get(projectId, resource.parentId) : null
  return { resource, parentName: parent?.name ?? null }
}

export async function documentContent(ctx: AppContext, resourceId: string, documentId: string) {
  return ctx.connector().getDocumentContent(resourceId, documentId)
}

export async function liveSearch(ctx: AppContext, query: string, limit = 20) {
  if (query.trim() === '') return []
  return ctx.connector().search(query.trim(), limit)
}
