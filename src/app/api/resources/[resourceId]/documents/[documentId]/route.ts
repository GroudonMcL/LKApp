import { handle } from '@/server/http'
import { documentContent } from '@/server/services/discovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A page document's blocks, plain text and version (read-only). */
export async function GET(_request: Request, { params }: { params: Promise<{ resourceId: string; documentId: string }> }) {
  const { resourceId, documentId } = await params
  return handle((ctx) => documentContent(ctx, resourceId, documentId))
}
