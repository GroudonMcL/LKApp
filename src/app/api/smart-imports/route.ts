import { handle, readJson } from '@/server/http'
import { CreateSmartImportInput, createSmartImport, listSmartImports } from '@/server/services/smart-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => ({ imports: listSmartImports(ctx) }))
}

/** Creates an import. Files are then added one per request (/api/batches/[id]/sources), and the "start" action begins sorting. */
export async function POST(request: Request) {
  return handle(async (ctx) => createSmartImport(ctx, { ...(await readJson(request, CreateSmartImportInput)), start: false, files: [], pastes: [] }), 201)
}
