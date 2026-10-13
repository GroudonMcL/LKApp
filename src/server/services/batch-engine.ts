import 'server-only'
import type { AppContext } from '../context'
import type { BatchStatus } from '../db/batch-repositories'
import { log } from '../log'
import { recordAudit } from './audit'
import { ServiceError } from './errors'

/**
 * The batch job engine: runs long batch work (drafting many records, writing approved
 * operations) in the background of this server process, one batch at a time per batch id.
 *
 * - All state lives in the database (batch and item statuses), so a restart loses nothing:
 *   items that were mid-draft go back to `pending`; items that were mid-write become
 *   `needs_reconciliation` and are checked against LegendKeeper (read-only) before anything else.
 * - Cancellation is checked between items; the item in progress always finishes or fails cleanly.
 * - Writes are spaced out to stay well inside LegendKeeper's limit of 120 writes a minute.
 *
 * No external queue service is needed for a local, single-user app.
 */

interface Running {
  phase: string
  startedAt: string
  promise: Promise<void>
}

const RUNNERS = Symbol.for('lk-companion.batch-runners')
function runners(): Map<string, Running> {
  const g = globalThis as unknown as Record<symbol, Map<string, Running> | undefined>
  if (!g[RUNNERS]) g[RUNNERS] = new Map()
  return g[RUNNERS]!
}

export function runningPhase(batchId: string): string | null {
  return runners().get(batchId)?.phase ?? null
}

/** Changes the label of the work in progress (shown while it runs, e.g. "drafting 3 of 8"). */
export function setPhase(batchId: string, phase: string) {
  const running = runners().get(batchId)
  if (running) running.phase = phase
}

/** Waits for a batch's background work (used by tests and by callers that want to block). */
export async function waitForBatch(batchId: string): Promise<void> {
  await runners().get(batchId)?.promise
}

/**
 * Pauses between LegendKeeper calls in batches: writes at most ~100 a minute (the limit is
 * 120), and a short pause between per-item checks (the read limit is 300 a minute).
 * Tests set these to 0.
 */
export const BATCH_TIMING = { writeSpacingMs: 600, checkSpacingMs: 100 }

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Starts `work` in the background for a batch. Refuses when the batch already has work
 * running. The batch status is `processing` (or `running` for writes) while it runs, then
 * `finalStatus` (default `ready`). Errors are recorded on the batch, never thrown away.
 */
export function startBatchWork(
  ctx: AppContext,
  batchId: string,
  phase: string,
  options: { status: Extract<BatchStatus, 'processing' | 'running'>; wait?: boolean },
  work: () => Promise<void>,
): Promise<void> {
  if (runners().has(batchId)) throw new ServiceError(409, `This batch is already busy (${runners().get(batchId)!.phase}). Wait for it to finish or cancel it.`)
  const batch = ctx.repos.batches.get(batchId)
  if (!batch) throw new ServiceError(404, 'Batch not found.')
  ctx.repos.batches.update(batchId, { status: options.status, error: null, cancelRequested: false, startedAt: batch.startedAt ?? ctx.now().toISOString() })
  const promise = (async () => {
    try {
      await work()
      const after = ctx.repos.batches.get(batchId)
      if (after && (after.status === 'processing' || after.status === 'running')) ctx.repos.batches.update(batchId, { status: 'ready' })
    } catch (error) {
      const message = (error as Error).message ?? String(error)
      log.error('Batch work failed', { batchId, phase, error })
      ctx.repos.batches.update(batchId, { status: 'ready', error: `${phase} stopped: ${message}` })
      recordAudit(ctx, { operation: `batch.${phase}`, outcome: 'failure', message, details: { batchId } })
    } finally {
      runners().delete(batchId)
    }
  })()
  runners().set(batchId, { phase, startedAt: ctx.now().toISOString(), promise })
  return options.wait ? promise : Promise.resolve()
}

/** Records which AI model a batch used (shown in the job history). */
export function noteModel(ctx: AppContext, batchId: string, model: string) {
  const batch = ctx.repos.batches.get(batchId)
  if (!batch) return
  const models = ((batch.options as { models?: string[] }).models ?? []).filter(Boolean)
  if (models.includes(model)) return
  ctx.repos.batches.update(batchId, { options: { ...batch.options, models: [...models, model] } })
}

/** True when the user asked to stop this batch; checked between items. */
export function cancelRequested(ctx: AppContext, batchId: string): boolean {
  return ctx.repos.batches.get(batchId)?.cancelRequested === true
}

/** Runs `fn` over `items` with at most `concurrency` in flight, stopping early when `stop()` says so. */
export async function forEachLimited<T>(items: T[], concurrency: number, stop: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      if (stop()) return
      const item = items[next++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
}
