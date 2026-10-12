import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { planTask, runTask } from '@/server/services/task-assistant'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plan'), request: z.string(), useAi: z.boolean().optional() }),
  z.object({ action: z.literal('run'), plan: z.unknown(), choices: z.record(z.string(), z.string()).optional(), confirmAi: z.boolean().optional() }),
])

/** `plan` turns a request into a validated plan; `run` runs a plan's allowed, read-only steps. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'plan') return planTask(ctx, { request: body.request, useAi: body.useAi ?? false })
    return runTask(ctx, { plan: body.plan, choices: body.choices ?? {}, confirmAi: body.confirmAi ?? false })
  })
}
