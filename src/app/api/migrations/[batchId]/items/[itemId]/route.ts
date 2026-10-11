import { handle } from '@/server/http'
import { migrationItem } from '@/server/services/migrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string; itemId: string }> }) {
  const { batchId, itemId } = await params
  return handle((ctx) => migrationItem(ctx, batchId, itemId))
}
