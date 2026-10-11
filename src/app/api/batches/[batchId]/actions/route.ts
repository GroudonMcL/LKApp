import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import {
  approveItems,
  cancelBatch,
  closeBatch,
  decideItems,
  dryRunBatch,
  extractBatchRecords,
  generateDrafts,
  matchItems,
  reconcileBatch,
  retryItems,
  runBatch,
  stopBatch,
  unapproveItems,
} from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ids = z.array(z.string().min(1).max(100)).max(2000)
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('extract'), rules: z.unknown().optional() }),
  z.object({ action: z.literal('draft'), mode: z.enum(['ai', 'structural']), itemIds: ids.optional(), regenerate: z.boolean().optional() }),
  z.object({ action: z.literal('match') }),
  z.object({ action: z.literal('decide'), itemIds: ids, decision: z.enum(['create', 'skip', 'include', 'undecide']) }),
  z.object({ action: z.literal('dry_run'), itemIds: ids.optional() }),
  z.object({ action: z.literal('approve'), itemIds: ids, acknowledgeWarnings: z.boolean(), confirm: z.literal(true) }),
  z.object({ action: z.literal('unapprove'), itemIds: ids }),
  z.object({ action: z.literal('run'), confirm: z.literal(true) }),
  z.object({ action: z.literal('reconcile') }),
  z.object({ action: z.literal('retry'), itemIds: ids }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('cancel'), confirm: z.literal(true) }),
  z.object({ action: z.literal('close') }),
])

/**
 * Every batch step. Long steps (draft, dry run, approve, run) start in the background and
 * return at once; the page polls the batch for progress.
 */
export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    switch (body.action) {
      case 'extract':
        return extractBatchRecords(ctx, batchId, { rules: body.rules })
      case 'draft':
        return generateDrafts(ctx, batchId, { mode: body.mode, itemIds: body.itemIds, regenerate: body.regenerate })
      case 'match':
        return matchItems(ctx, batchId)
      case 'decide':
        return decideItems(ctx, batchId, body.itemIds, body.decision)
      case 'dry_run':
        return dryRunBatch(ctx, batchId, { itemIds: body.itemIds })
      case 'approve':
        return approveItems(ctx, batchId, { itemIds: body.itemIds, acknowledgeWarnings: body.acknowledgeWarnings })
      case 'unapprove':
        return unapproveItems(ctx, batchId, body.itemIds)
      case 'run':
        return runBatch(ctx, batchId)
      case 'reconcile':
        return reconcileBatch(ctx, batchId)
      case 'retry':
        return retryItems(ctx, batchId, body.itemIds)
      case 'stop':
        return stopBatch(ctx, batchId)
      case 'cancel':
        return cancelBatch(ctx, batchId)
      case 'close':
        return closeBatch(ctx, batchId)
    }
  })
}
