import { handle } from '@/server/http'
import { layoutReport } from '@/server/services/lk-templates'
import { createTemplate, listTemplates } from '@/server/services/recipes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => ({ templates: listTemplates(ctx).map((template) => ({ ...template, layoutReport: layoutReport(template) })) }))
}

export async function POST(request: Request) {
  return handle(async (ctx) => createTemplate(ctx, await request.json().catch(() => null)), 201)
}
