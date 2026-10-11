import { z } from 'zod'
import { handle, readJson } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
import { archiveRecipe, getRecipe, updateRecipe } from '@/server/services/recipes'

type Params = { params: Promise<{ recipeId: string }> }
const Body = z.object({ definition: z.unknown(), expectedVersion: z.number().int() })

export async function GET(_request: Request, { params }: Params) {
  const { recipeId } = await params
  return handle((ctx) => getRecipe(ctx, recipeId))
}

/** Saves a new version of the recipe (earlier versions are kept). */
export async function PUT(request: Request, { params }: Params) {
  const { recipeId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    return updateRecipe(ctx, recipeId, body.definition, body.expectedVersion)
  })
}

/** Archives the recipe locally. Drafts that used it keep their recorded version. */
export async function DELETE(_request: Request, { params }: Params) {
  const { recipeId } = await params
  return handle((ctx) => archiveRecipe(ctx, recipeId))
}
