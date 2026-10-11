import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { draftView, saveDraft } from '@/server/services/drafts'
import { draftBlockers } from '@/server/services/write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ draftId: string }> }

export async function GET(_request: Request, { params }: Params) {
  const { draftId } = await params
  return handle((ctx) => {
    const view = draftView(ctx, draftId)
    return { ...view, writeBlockers: draftBlockers(ctx, ctx.repos.drafts.get(draftId)!) }
  })
}

const Body = z.object({ page: z.unknown(), expectedRevision: z.number().int() })

/** Saves an edited draft (validated on the server). */
export async function PUT(request: Request, { params }: Params) {
  const { draftId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    const view = await saveDraft(ctx, draftId, body.page, body.expectedRevision)
    return { ...view, writeBlockers: draftBlockers(ctx, ctx.repos.drafts.get(draftId)!) }
  })
}
