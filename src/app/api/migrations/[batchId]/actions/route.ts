import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { stopBatch } from '@/server/services/import-batches'
import {
  analyseMigration,
  approveMigration,
  closeMigration,
  dryRunMigration,
  migrationView,
  reconcileMigration,
  refreshMigration,
  restoreMigration,
  retryMigration,
  runMigration,
  skipMigration,
  unapproveMigration,
} from '@/server/services/migrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ids = z.array(z.string().min(1).max(100)).max(5000)
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('analyse'), itemIds: ids.optional() }),
  z.object({ action: z.literal('refresh'), itemIds: ids }),
  z.object({ action: z.literal('approve'), itemIds: ids, acknowledged: z.record(z.string(), z.array(z.string().max(200)).max(2000)), confirm: z.literal(true) }),
  z.object({ action: z.literal('unapprove'), itemIds: ids }),
  z.object({ action: z.literal('dry_run') }),
  z.object({ action: z.literal('run'), confirm: z.literal(true) }),
  z.object({ action: z.literal('reconcile') }),
  z.object({ action: z.literal('retry'), itemIds: ids }),
  z.object({ action: z.literal('skip'), itemIds: ids }),
  z.object({ action: z.literal('restore'), itemIds: ids, overwriteLaterEdits: z.boolean(), confirm: z.literal(true) }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('cancel'), confirm: z.literal(true) }),
])

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    switch (body.action) {
      case 'analyse':
        return analyseMigration(ctx, batchId, { itemIds: body.itemIds })
      case 'refresh':
        return refreshMigration(ctx, batchId, body.itemIds)
      case 'approve':
        return approveMigration(ctx, batchId, body)
      case 'unapprove':
        return unapproveMigration(ctx, batchId, body.itemIds)
      case 'dry_run':
        return dryRunMigration(ctx, batchId)
      case 'run':
        return runMigration(ctx, batchId)
      case 'reconcile':
        return reconcileMigration(ctx, batchId)
      case 'retry':
        return retryMigration(ctx, batchId, body.itemIds)
      case 'skip':
        return skipMigration(ctx, batchId, body.itemIds)
      case 'restore':
        return restoreMigration(ctx, batchId, body)
      case 'stop':
        stopBatch(ctx, batchId)
        return migrationView(ctx, batchId)
      case 'close':
        return closeMigration(ctx, batchId)
      case 'cancel':
        return closeMigration(ctx, batchId, true)
    }
  })
}
