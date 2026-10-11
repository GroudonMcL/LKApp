import { handle } from '@/server/http'
import { connectionSummary, testConnection } from '@/server/services/connection'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => connectionSummary(ctx))
}

/** Tests the connection with live, read-only calls. */
export async function POST() {
  return handle(async (ctx) => ({ check: await testConnection(ctx), summary: connectionSummary(ctx) }))
}
