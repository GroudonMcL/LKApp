import { handle } from '@/server/http'
import { getTaxonomy, saveTaxonomy } from '@/server/services/tagging-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => getTaxonomy(ctx))
}

export async function PUT(request: Request) {
  return handle(async (ctx) => saveTaxonomy(ctx, await request.json().catch(() => null)))
}
