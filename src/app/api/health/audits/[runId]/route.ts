import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { resumeAudit, stopAudit } from '@/server/services/wiki-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ action: z.enum(['stop', 'resume']) })

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  return handle(async (ctx) => {
    const { action } = await readJson(request, Body)
    return action === 'stop' ? stopAudit(ctx, runId) : resumeAudit(ctx, runId)
  })
}
