import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { approveSaveAsTemplate, prepareSaveAsTemplate } from '@/server/services/lk-save-template'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), resource: z.string().min(1).max(500), name: z.string().max(500).optional(), includeChildren: z.boolean().default(false) }),
  z.object({ action: z.literal('approve'), approvalToken: z.string().min(1).max(200), confirm: z.literal(true) }),
])

/**
 * Saving a LegendKeeper page as a template:
 * - `prepare`: reads the page and returns the final preview with a one-time approval token.
 * - `approve`: saves it — only with the token and `confirm: true`.
 */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'prepare') return prepareSaveAsTemplate(ctx, { resource: body.resource, name: body.name?.trim() || undefined, includeChildren: body.includeChildren })
    return approveSaveAsTemplate(ctx, { approvalToken: body.approvalToken })
  })
}
