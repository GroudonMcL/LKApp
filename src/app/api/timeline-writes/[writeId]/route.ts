import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { approveTimelineEvent, checkTimelineEvent } from '@/server/services/timeline-writes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), approvalToken: z.string(), acknowledgeWarnings: z.boolean(), confirm: z.literal(true) }),
  z.object({ action: z.literal('check') }),
])

/** Step 2: `approve` adds the event (once) and reads it back; `check` resolves an uncertain outcome by reading. */
export async function POST(request: Request, { params }: { params: Promise<{ writeId: string }> }) {
  const { writeId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    return body.action === 'approve' ? approveTimelineEvent(ctx, writeId, body) : checkTimelineEvent(ctx, writeId)
  })
}
