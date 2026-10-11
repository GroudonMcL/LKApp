import { handle } from '@/server/http'
import { copyLayoutFromLegendKeeper } from '@/server/services/lk-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Copies a LegendKeeper template's (or page's) layout into a local template. Reads only. */
export async function POST(request: Request) {
  return handle(async (ctx) => copyLayoutFromLegendKeeper(ctx, await request.json().catch(() => null)), 201)
}
