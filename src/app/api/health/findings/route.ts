import { handle, intParam } from '@/server/http'
import { listFindings, updateFindings } from '@/server/services/wiki-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : undefined)

export async function GET(request: Request) {
  const url = new URL(request.url)
  const q = url.searchParams
  return handle((ctx) =>
    listFindings(ctx, {
      categories: list(q.get('category')),
      statuses: list(q.get('status')),
      severity: list(q.get('severity')),
      resourceId: q.get('resource') ?? undefined,
      search: q.get('q') ?? undefined,
      sort: q.get('sort') ?? undefined,
      limit: intParam(q.get('limit'), 100),
      offset: intParam(q.get('offset'), 0),
    }),
  )
}

/** Changes the status of findings: open, queued (maintenance queue), dismissed, intentional. */
export async function POST(request: Request) {
  return handle(async (ctx) => updateFindings(ctx, await request.json().catch(() => null)))
}
