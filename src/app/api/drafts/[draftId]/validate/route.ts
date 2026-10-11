import { handle } from '@/server/http'
import { revalidate } from '@/server/services/drafts'
import { draftBlockers } from '@/server/services/write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params
  return handle((ctx) => ({ ...revalidate(ctx, draftId), writeBlockers: draftBlockers(ctx, ctx.repos.drafts.get(draftId)!) }))
}
