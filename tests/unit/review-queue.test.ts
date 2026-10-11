import { beforeAll, describe, expect, it } from 'vitest'
import { p } from '@legendkeeper/sdk/blocks'
import { BATCH_TIMING } from '@/server/services/batch-engine'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { exportHistory, jobSummary, listBatches } from '@/server/services/import-batches'
import { reviewCounts, reviewQueue } from '@/server/services/review-queue'
import { createTaggingBatch, dryRunTagging, exportTagging, suggestTagging } from '@/server/services/tagging-batches'
import { createTestContext } from '../helpers/test-context'

beforeAll(() => {
  BATCH_TIMING.writeSpacingMs = 0
  BATCH_TIMING.checkSpacingMs = 0
})

async function setup(allowWrites = true) {
  const ctx = createTestContext({
    config: { lk: { allowWrites } },
    resources: [
      { id: 'salt0001', name: 'Saltmarsh', tags: ['Location', 'Saltmarsh'] },
      { id: 'hau00001', name: 'The Haunted House', tags: [], parentId: 'salt0001', documents: [{ id: 'doc_h', name: 'Main', type: 'page', blocks: [p('A Location said to be haunted.')], version: 'v1', text: '' }] },
      { id: 'inn00001', name: 'The Snapping Line', tags: [], parentId: 'salt0001', documents: [{ id: 'doc_i', name: 'Main', type: 'page', blocks: [p('An inn by the docks.')], version: 'v1', text: '' }] },
    ],
  })
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  return ctx
}

describe('review queue', () => {
  it('collects what needs a decision, with a reason and a link, and filters by type, severity and page', async () => {
    const ctx = await setup()
    const batchId = (await createTaggingBatch(ctx, { name: 'Untagged', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    let queue = reviewQueue(ctx)
    expect(queue.items.map((e) => e.type)).toEqual(['tag_suggestion', 'tag_suggestion'])
    expect(queue.items[0]).toMatchObject({ href: `/tagging/${batchId}`, job: 'Untagged' })
    expect(queue.items[0]!.explanation.length).toBeGreaterThan(10)

    // A write with an unknown outcome is high priority and comes first.
    const [first] = ctx.repos.batchItems.list(batchId)
    ctx.repos.batchItems.update(first!.id, { status: 'needs_reconciliation', error: 'reply lost' })
    queue = reviewQueue(ctx)
    expect(queue.items[0]).toMatchObject({ type: 'uncertain_write', severity: 'high', resourceId: first!.resourceId })
    expect(reviewCounts(ctx)).toMatchObject({ total: 2, high: 1 })
    expect(reviewQueue(ctx, { severity: 'high' }).items).toHaveLength(1)
    expect(reviewQueue(ctx, { type: 'tag_suggestion' }).items).toHaveLength(1)
    expect(reviewQueue(ctx, { q: 'snapping' }).items.map((e) => e.title)).toEqual(['The Snapping Line'])

    // Closed jobs drop out of the queue.
    ctx.repos.batchItems.update(first!.id, { status: 'awaiting_review', error: null })
    ctx.repos.batches.update(batchId, { status: 'completed' })
    expect(reviewQueue(ctx).total).toBe(0)
  })

  it('says when a page in an open job no longer exists, instead of asking for a decision', async () => {
    const ctx = await setup()
    const batchId = (await createTaggingBatch(ctx, { name: 'Untagged', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    ctx.lk.resources.delete('inn00001')
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    const gone = reviewQueue(ctx).items.find((e) => e.resourceId === 'inn00001')
    expect(gone).toMatchObject({ type: 'gone', severity: 'low' })
  })

  it('summarises every job and exports the history without secrets', async () => {
    const ctx = await setup()
    const batchId = (await createTaggingBatch(ctx, { name: 'Untagged', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    const listed = listBatches(ctx, null).items[0]!
    expect(listed.summary).toEqual({ total: 2, succeeded: 0, failed: 0, skipped: 0, needsReview: 2, remaining: 2 })
    expect(listed.models).toEqual([])
    expect(jobSummary({ pending: 1, processing: 0, awaiting_review: 0, approved: 1, running: 0, succeeded: 3, failed: 1, skipped: 1, cancelled: 1, needs_reconciliation: 1 })).toEqual({ total: 9, succeeded: 3, failed: 2, skipped: 2, needsReview: 1, remaining: 2 })

    const csv = exportHistory(ctx, 'csv').body
    expect(csv.split('\n')[0]).toContain('job_id,kind,name,status,recipe,recipe_version,ai_models')
    expect(csv).toContain('tagging,Untagged')
    expect(csv).not.toContain(ctx.config().lk.apiKey ?? 'no-key-configured')
  })

  it('dry runs report switched-off writes as a reason nothing could be written', async () => {
    const ctx = await setup(false)
    const batchId = (await createTaggingBatch(ctx, { name: 'Untagged', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    await dryRunTagging(ctx, batchId, { wait: true })
    const report = JSON.parse(exportTagging(ctx, batchId, { report: 'dry_run', format: 'json' }).body)
    expect(report.entries[0].problems.join(' ')).toMatch(/Writes are switched off/)
    expect(report.entries[0].canProceed).toBe(false)
  })
})
