import { handle } from '@/server/http'
import { batchView, updateBatchOptions } from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ batchId: string }> }

export async function GET(_request: Request, { params }: Params) {
  const { batchId } = await params
  return handle((ctx) => batchView(ctx, batchId))
}

export async function PATCH(request: Request, { params }: Params) {
  const { batchId } = await params
  return handle(async (ctx) => updateBatchOptions(ctx, batchId, await request.json().catch(() => null)))
}
