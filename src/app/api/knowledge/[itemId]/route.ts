import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { decide, editItem } from '@/server/services/knowledge-items'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('decide'), decision: z.string(), note: z.string().nullable().optional() }),
  z.object({ action: z.literal('edit'), edits: z.unknown() }),
])

/** Decide on or edit one finding. Changes only the app's own records. */
export async function POST(request: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'decide') return { item: decide(ctx, itemId, { decision: body.decision, note: body.note ?? null }) }
    return { item: editItem(ctx, itemId, body.edits) }
  })
}
