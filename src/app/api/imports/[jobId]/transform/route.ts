import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { runTransform } from '@/server/services/transform'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// AI transformations of long sources can take a few minutes.
export const maxDuration = 600

const Body = z.object({ mode: z.enum(['ai', 'structural']), recipeId: z.string().nullable().optional(), templateId: z.string().max(100).nullable().optional() })

/** Produces (or regenerates) the job's draft. Never writes to LegendKeeper. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  return handle(async (ctx) => runTransform(ctx, jobId, await readJson(request, Body)))
}
