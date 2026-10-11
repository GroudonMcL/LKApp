import { handle } from '@/server/http'
import { testRecipe } from '@/server/services/recipes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Tries a recipe on pasted sample text (no AI, nothing stored, nothing sent to LegendKeeper). */
export async function POST(request: Request) {
  return handle(async (ctx) => testRecipe(ctx, await request.json().catch(() => null)))
}
