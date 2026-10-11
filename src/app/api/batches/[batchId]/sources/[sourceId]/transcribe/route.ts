import { handle } from '@/server/http'
import { transcribeSource } from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Sends one image or scanned PDF to the AI provider for verbatim transcription (only when asked). */
export async function POST(_request: Request, { params }: { params: Promise<{ batchId: string; sourceId: string }> }) {
  const { batchId, sourceId } = await params
  return handle((ctx) => transcribeSource(ctx, batchId, sourceId))
}
