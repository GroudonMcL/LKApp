import { handle, intParam } from '@/server/http'
import { listBatches } from '@/server/services/import-batches'
import { createMigration } from '@/server/services/migrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  return handle((ctx) => listBatches(ctx, 'migration', intParam(url.searchParams.get('page'), 1)))
}

export async function POST(request: Request) {
  return handle(async (ctx) => createMigration(ctx, await request.json().catch(() => null)), 201)
}
