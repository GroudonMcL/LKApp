import { handle } from '@/server/http'
import { cancelImport } from '@/server/services/imports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Cancels the import and deletes its stored source text. Nothing is written to LegendKeeper. */
export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  return handle((ctx) => cancelImport(ctx, jobId))
}
