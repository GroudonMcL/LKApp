import { handle } from '@/server/http'
import { healthDashboard } from '@/server/services/wiki-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => healthDashboard(ctx))
}
