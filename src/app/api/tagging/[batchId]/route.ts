import { handle } from '@/server/http'
import { taggingView } from '@/server/services/tagging-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle((ctx) => taggingView(ctx, batchId))
}
