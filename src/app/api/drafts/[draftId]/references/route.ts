import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { addReference, chooseReferenceTarget, linkReferenceToResource } from '@/server/services/drafts'
import { draftBlockers } from '@/server/services/write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('choose'), refId: z.string(), resourceId: z.string().nullable() }),
  z.object({ action: z.literal('link'), refId: z.string(), resourceId: z.string().min(1).max(256) }),
  z.object({ action: z.literal('add'), mention: z.string().min(1).max(500), relation: z.string().max(200).nullable() }),
])

/** Resolve, link (after confirming the page exists in LegendKeeper), or add a reference. */
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    const view =
      body.action === 'choose'
        ? chooseReferenceTarget(ctx, draftId, body.refId, body.resourceId)
        : body.action === 'link'
          ? await linkReferenceToResource(ctx, draftId, body.refId, body.resourceId)
          : addReference(ctx, draftId, body.mention, body.relation)
    return { ...view, writeBlockers: draftBlockers(ctx, ctx.repos.drafts.get(draftId)!) }
  })
}
