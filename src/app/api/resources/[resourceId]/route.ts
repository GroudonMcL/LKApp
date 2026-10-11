import { handle } from '@/server/http'
import { resourceDetail } from '@/server/services/discovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params
  return handle((ctx) => resourceDetail(ctx, resourceId))
}
