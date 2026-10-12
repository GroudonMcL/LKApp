import { z } from 'zod'
import { handle, readJson } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
import { connectionSummary } from '@/server/services/connection'
import { saveAiProvider, setAiEnabled, setAiProvider, setApiKey } from '@/server/services/settings'
import { openRouterStatus } from '@/server/services/ai-status'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setKey'), kind: z.enum(['legendkeeper', 'anthropic', 'openrouter']), value: z.string(), persist: z.boolean().optional() }),
  z.object({ action: z.literal('clearKey'), kind: z.enum(['legendkeeper', 'anthropic', 'openrouter']), persist: z.boolean().optional() }),
  z.object({ action: z.literal('setAiProvider'), provider: z.enum(['openrouter', 'anthropic']).nullable(), persist: z.boolean().optional() }),
  z.object({ action: z.literal('setAiEnabled'), enabled: z.boolean() }),
])

export async function GET() {
  return handle(async (ctx) => ({ ...connectionSummary(ctx), openrouterStatus: await openRouterStatus(ctx) }))
}

export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'setKey') setApiKey(ctx, body.kind, body.value, { persist: body.persist })
    else if (body.action === 'clearKey') setApiKey(ctx, body.kind, null, { persist: body.persist })
    else if (body.action === 'setAiProvider') (body.persist ? saveAiProvider(ctx, body.provider) : setAiProvider(ctx, body.provider))
    else setAiEnabled(ctx, body.enabled)
    // The response says whether a key is set and where from — never the key.
    return { ...connectionSummary(ctx), openrouterStatus: await openRouterStatus(ctx) }
  })
}
