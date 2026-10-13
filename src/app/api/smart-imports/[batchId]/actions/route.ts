import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { cancelBatch, closeBatch, createChosenPages, reconcileBatch, stopBatch } from '@/server/services/import-batches'
import { addRecordFromLines, continueSmartImport, setRecordDestination, smartView, startSmartImport } from '@/server/services/smart-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), mode: z.enum(['ai', 'rules']).optional() }),
  z.object({ action: z.literal('continue'), mode: z.enum(['ai', 'rules']).optional() }),
  z.object({ action: z.literal('destination'), itemId: z.string().min(1).max(100), key: z.string().max(100).nullable() }),
  z.object({ action: z.literal('add_lines'), sourceId: z.string().min(1).max(100), from: z.number().int().min(1), to: z.number().int().min(1), title: z.string().max(200), key: z.string().min(1).max(100) }),
  z.object({ action: z.literal('create'), itemIds: z.array(z.string().min(1).max(100)).min(1).max(2000), includeWarnings: z.boolean(), confirm: z.literal(true) }),
  z.object({ action: z.literal('reconcile') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('cancel'), confirm: z.literal(true) }),
  z.object({ action: z.literal('close') }),
])

/** Every step of an import. Long steps start in the background and return at once; the page polls for progress. */
export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    switch (body.action) {
      case 'start':
        return startSmartImport(ctx, batchId, { mode: body.mode })
      case 'continue':
        return continueSmartImport(ctx, batchId, { mode: body.mode })
      case 'destination':
        return setRecordDestination(ctx, batchId, body.itemId, body.key)
      case 'add_lines':
        return addRecordFromLines(ctx, batchId, body)
      case 'create':
        await createChosenPages(ctx, batchId, { itemIds: body.itemIds, includeWarnings: body.includeWarnings })
        return smartView(ctx, batchId)
      case 'reconcile':
        await reconcileBatch(ctx, batchId)
        return smartView(ctx, batchId)
      case 'stop':
        stopBatch(ctx, batchId)
        return smartView(ctx, batchId)
      case 'cancel':
        cancelBatch(ctx, batchId)
        return smartView(ctx, batchId)
      case 'close':
        closeBatch(ctx, batchId)
        return smartView(ctx, batchId)
    }
  })
}
