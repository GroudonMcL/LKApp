import { handle } from '@/server/http'
import { createRecipe, listRecipes } from '@/server/services/recipes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => ({ recipes: listRecipes(ctx) }))
}

export async function POST(request: Request) {
  return handle(async (ctx) => createRecipe(ctx, await request.json().catch(() => null)), 201)
}
