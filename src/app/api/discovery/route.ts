import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { requireProjectId } from '@/server/services/connection'
import { DiscoveryInput, discoveryPreview, discoveryState, startDiscovery } from '@/server/services/event-discovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async (ctx) => discoveryState(ctx, await requireProjectId(ctx)))
}

const Body = z.object({ action: z.enum(['preview', 'start']), input: z.unknown() })

/** `preview` says which pages will be read and what (if anything) goes to the AI; `start` runs it. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'preview') return discoveryPreview(ctx, await requireProjectId(ctx), DiscoveryInput.parse(body.input ?? {}))
    return startDiscovery(ctx, body.input)
  })
}
