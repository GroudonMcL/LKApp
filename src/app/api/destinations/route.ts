import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { activeDestinations, listDestinations, removeDestination, setDestinationEnabled, setUpDestinations } from '@/server/services/destinations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => {
    const own = listDestinations(ctx)
    return { destinations: own, active: activeDestinations(ctx).map((d) => ({ key: d.key, label: d.label, builtIn: d.builtIn })), usingBuiltIn: !own.some((d) => d.enabled) }
  })
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setup'), lkTemplateIds: z.array(z.string().min(1).max(256)).max(200).optional() }),
  z.object({ action: z.literal('enable'), key: z.string().min(1).max(100), enabled: z.boolean() }),
  z.object({ action: z.literal('remove'), key: z.string().min(1).max(100) }),
])

/** Sets up page kinds from LegendKeeper templates (reads only), or switches one on or off. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'setup') return setUpDestinations(ctx, { lkTemplateIds: body.lkTemplateIds })
    if (body.action === 'enable') return { destinations: setDestinationEnabled(ctx, body.key, body.enabled) }
    return { destinations: removeDestination(ctx, body.key) }
  })
}
