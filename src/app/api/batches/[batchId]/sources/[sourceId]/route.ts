import { handle } from '@/server/http'
import { sourceText } from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The extracted text of one input file, for inspection. */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string; sourceId: string }> }) {
  const { batchId, sourceId } = await params
  return handle((ctx) => sourceText(ctx, batchId, sourceId))
}
