import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { requireProjectId } from '@/server/services/connection'
import { prepareTimelineEvent, timelineWrites } from '@/server/services/timeline-writes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async (ctx) => ({ writes: timelineWrites(ctx, await requireProjectId(ctx)) }))
}

/** Step 1 of adding an event to a LegendKeeper timeline: the final preview and an approval token. */
export async function POST(request: Request) {
  return handle(async (ctx) => prepareTimelineEvent(ctx, await readJson(request, z.unknown())))
}
