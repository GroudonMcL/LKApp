import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { requireProjectId } from '@/server/services/connection'
import { CHECK_LABELS, compareWithAi, comparePreview, runKnowledgeAnalysis } from '@/server/services/knowledge-analysis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Recent analysis runs and the available checks. */
export async function GET() {
  return handle(async (ctx) => ({ checks: CHECK_LABELS, runs: ctx.repos.analysisRuns.list(await requireProjectId(ctx), 'knowledge', 10) }))
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), input: z.unknown() }),
  z.object({ action: z.literal('comparePreview'), input: z.unknown() }),
  z.object({ action: z.literal('compare'), input: z.unknown() }),
])

/** `run`: read-only analysis of the local index and page content. `compare`: one AI request for 2–5 pages. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'run') return runKnowledgeAnalysis(ctx, body.input)
    if (body.action === 'comparePreview') {
      const p = comparePreview(ctx, await requireProjectId(ctx), body.input)
      return { provider: p.provider, model: p.model, sends: p.sends }
    }
    return compareWithAi(ctx, body.input)
  })
}
