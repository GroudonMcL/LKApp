import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { getImport, renameImport } from '@/server/services/imports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ jobId: string }> }

export async function GET(_request: Request, { params }: Params) {
  const { jobId } = await params
  return handle((ctx) => {
    const job = getImport(ctx, jobId)
    const draft = ctx.repos.drafts.getByJob(jobId)
    const { sourceJson: _json, ...rest } = job
    return { job: rest, draftId: draft?.id ?? null }
  })
}

const Patch = z.object({
  name: z.string().max(200).optional(),
  attributionTitle: z.string().max(500).optional(),
  citation: z.string().max(1000).nullable().optional(),
  recipeId: z.string().nullable().optional(),
})

export async function PATCH(request: Request, { params }: Params) {
  const { jobId } = await params
  return handle(async (ctx) => {
    const { sourceJson: _json, ...rest } = renameImport(ctx, jobId, await readJson(request, Patch))
    return { job: rest }
  })
}
