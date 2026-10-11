import { handle, intParam } from '@/server/http'
import { createImport, listImports } from '@/server/services/imports'
import { readSourceForm } from '@/server/upload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  return handle((ctx) => listImports(ctx, intParam(params.get('page'), 1), intParam(params.get('pageSize'), 25)))
}

/** Creates an import job from an uploaded file or pasted text. Nothing is sent to the AI yet. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const source = await readSourceForm(request, ctx)
    return createImport(ctx, {
      ...source,
      name: source.fields.name || null,
      attributionTitle: source.fields.attributionTitle || null,
      citation: source.fields.citation || null,
      recipeId: source.fields.recipeId || null,
    })
  }, 201)
}
