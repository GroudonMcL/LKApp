import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { stopBatch } from '@/server/services/import-batches'
import {
  approveTagging,
  closeTagging,
  dryRunTagging,
  reconcileTagging,
  retryTagging,
  runTagging,
  selectSuggestions,
  skipTagging,
  suggestTagging,
  taggingView,
  unapproveTagging,
} from '@/server/services/tagging-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ids = z.array(z.string().min(1).max(100)).max(5000)
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suggest'), itemIds: ids.optional() }),
  z.object({ action: z.literal('select'), itemId: z.string(), selections: z.array(z.object({ tag: z.string(), action: z.enum(['add', 'remove']), selected: z.boolean() })).max(100) }),
  z.object({ action: z.literal('approve'), itemIds: ids, approveNewTags: z.boolean(), confirm: z.literal(true) }),
  z.object({ action: z.literal('unapprove'), itemIds: ids }),
  z.object({ action: z.literal('dry_run') }),
  z.object({ action: z.literal('run'), confirm: z.literal(true) }),
  z.object({ action: z.literal('reconcile') }),
  z.object({ action: z.literal('retry'), itemIds: ids }),
  z.object({ action: z.literal('skip'), itemIds: ids }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('cancel'), confirm: z.literal(true) }),
])

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    switch (body.action) {
      case 'suggest':
        return suggestTagging(ctx, batchId, { itemIds: body.itemIds })
      case 'select':
        return selectSuggestions(ctx, batchId, body)
      case 'approve':
        return approveTagging(ctx, batchId, body)
      case 'unapprove':
        return unapproveTagging(ctx, batchId, body.itemIds)
      case 'dry_run':
        return dryRunTagging(ctx, batchId)
      case 'run':
        return runTagging(ctx, batchId)
      case 'reconcile':
        return reconcileTagging(ctx, batchId)
      case 'retry':
        return retryTagging(ctx, batchId, body.itemIds)
      case 'skip':
        return skipTagging(ctx, batchId, body.itemIds)
      case 'stop':
        stopBatch(ctx, batchId)
        return taggingView(ctx, batchId)
      case 'close':
        return closeTagging(ctx, batchId)
      case 'cancel':
        return closeTagging(ctx, batchId, true)
    }
  })
}
