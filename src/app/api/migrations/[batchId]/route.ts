import { handle } from '@/server/http'
import { migrationView } from '@/server/services/migrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle((ctx) => migrationView(ctx, batchId))
}
