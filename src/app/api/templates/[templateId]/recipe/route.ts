import { handle } from '@/server/http'
import { recipeFromTemplate } from '@/server/services/recipes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Makes a recipe that uses this template. */
export async function POST(_request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params
  return handle((ctx) => recipeFromTemplate(ctx, templateId), 201)
}
