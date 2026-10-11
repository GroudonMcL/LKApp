import { handle, intParam, readJson } from '@/server/http'
import { CreateBatchInput, createImportBatch, listBatches } from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  return handle((ctx) => listBatches(ctx, kind === 'import' || kind === 'tagging' || kind === 'migration' ? kind : null, intParam(url.searchParams.get('page'), 1)))
}

/** Creates an empty import batch; files are added one per request (see ./[batchId]/sources). */
export async function POST(request: Request) {
  return handle(async (ctx) => createImportBatch(ctx, { ...(await readJson(request, CreateBatchInput)), files: [], pastes: [] }), 201)
}
