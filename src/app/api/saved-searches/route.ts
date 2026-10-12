import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { deleteSearch, saveSearch } from '@/server/services/advanced-search'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => ({ searches: ctx.repos.savedSearches.list() }))
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), name: z.string(), query: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('delete'), id: z.string() }),
])

/** Saved searches live in the app's own database only. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    return { searches: body.action === 'save' ? saveSearch(ctx, { name: body.name, query: body.query }) : deleteSearch(ctx, body.id) }
  })
}
