import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { decide, editItem } from '@/server/services/knowledge-items'
import { draftFromItem } from '@/server/services/knowledge-drafts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('decide'), decision: z.string(), note: z.string().nullable().optional() }),
  z.object({ action: z.literal('edit'), edits: z.unknown() }),
  z.object({ action: z.literal('draft'), recipeId: z.string() }),
])

/** Decide on, edit or draft from one finding. Changes only the app's own records (a draft is written only after its own approval). */
export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'decide') return { item: decide(ctx, itemId, { decision: body.decision, note: body.note ?? null }) }
    if (body.action === 'draft') return draftFromItem(ctx, itemId, { recipeId: body.recipeId })
    return { item: editItem(ctx, itemId, body.edits) }
  })
}
