import { z } from 'zod'
import { handle, readJson } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
import { connectionSummary } from '@/server/services/connection'
import { setAiEnabled, setApiKey } from '@/server/services/settings'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setKey'), kind: z.enum(['legendkeeper', 'anthropic']), value: z.string() }),
  z.object({ action: z.literal('clearKey'), kind: z.enum(['legendkeeper', 'anthropic']) }),
  z.object({ action: z.literal('setAiEnabled'), enabled: z.boolean() }),
])

export async function GET() {
  return handle((ctx) => connectionSummary(ctx))
}

export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'setKey') setApiKey(ctx, body.kind, body.value)
    else if (body.action === 'clearKey') setApiKey(ctx, body.kind, null)
    else setAiEnabled(ctx, body.enabled)
    // The response says whether a key is set and where from — never the key.
    return connectionSummary(ctx)
  })
}
