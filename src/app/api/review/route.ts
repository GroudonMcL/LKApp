import { handle } from '@/server/http'
import { reviewQueue } from '@/server/services/review-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  return handle((ctx) => reviewQueue(ctx, { type: url.searchParams.get('type') || undefined, severity: url.searchParams.get('severity') || undefined, q: url.searchParams.get('q') || undefined }))
}
