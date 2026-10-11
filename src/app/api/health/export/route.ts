import { errorResponse } from '@/server/http'
import { getAppContext } from '@/server/context'
import { listFindings } from '@/server/services/wiki-health'
import { toCsv } from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** All findings of the given statuses (default: open and queued) as CSV or JSON. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv'
  const statuses = url.searchParams.get('status')?.split(',').filter(Boolean) ?? ['open', 'queued']
  try {
    const { items } = listFindings(getAppContext(), { statuses, limit: 500 })
    const all = [...items]
    for (let offset = 500; offset < 20_000; offset += 500) {
      const more = listFindings(getAppContext(), { statuses, limit: 500, offset }).items
      if (more.length === 0) break
      all.push(...more)
    }
    const body =
      format === 'json'
        ? JSON.stringify(all, null, 2)
        : toCsv(
            all.map((f) => ({
              category: f.category,
              severity: f.severity,
              certainty: f.certainty,
              status: f.status,
              page: f.resourceName,
              resource_id: f.resourceId,
              related: f.related.map((r) => r.name).join('; '),
              finding: f.title,
              explanation: f.explanation,
              remedy: f.remedy,
              first_seen: f.firstSeenAt,
              last_seen: f.lastSeenAt,
            })),
          )
    return new Response(body, {
      headers: { 'content-type': `${format === 'json' ? 'application/json' : 'text/csv'}; charset=utf-8`, 'content-disposition': `attachment; filename="wiki-health-findings.${format}"`, 'cache-control': 'no-store' },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
