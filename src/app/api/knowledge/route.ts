import { handle } from '@/server/http'
import { listItems } from '@/server/services/knowledge-items'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Findings and candidates of chronology and knowledge analysis, with your decisions. */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams)
  return handle((ctx) => listItems(ctx, params))
}
