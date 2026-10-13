import { handle } from '@/server/http'
import { smartView } from '@/server/services/smart-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle((ctx) => smartView(ctx, batchId))
}
