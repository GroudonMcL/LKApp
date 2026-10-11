import { handle, intParam } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  return handle((ctx) => ({
    events: ctx.repos.audit.list({
      limit: Math.min(intParam(params.get('limit'), 50), 200),
      beforeId: params.get('beforeId') ? intParam(params.get('beforeId'), 0) : undefined,
      operation: params.get('operation') || undefined,
      draftId: params.get('draftId') || undefined,
    }),
  }))
}
