import { handle } from '@/server/http'
import { listLkTemplates } from '@/server/services/lk-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Templates of the connected LegendKeeper project (read-only). */
export async function GET() {
  return handle((ctx) => listLkTemplates(ctx))
}
