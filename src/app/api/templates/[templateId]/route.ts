import { handle } from '@/server/http'
import { deleteTemplate, updateTemplate } from '@/server/services/recipes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ templateId: string }> }

export async function PUT(request: Request, { params }: Params) {
  const { templateId } = await params
  return handle(async (ctx) => updateTemplate(ctx, templateId, await request.json().catch(() => null)))
}

export async function DELETE(_request: Request, { params }: Params) {
  const { templateId } = await params
  return handle((ctx) => deleteTemplate(ctx, templateId))
}
