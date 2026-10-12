import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { approveWrite, assignNewPlannedId, checkOutcome, finishTemplatePage, prepareWrite } from '@/server/services/write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare') }),
  z.object({ action: z.literal('approve'), approvalToken: z.string().min(1).max(200), acknowledgeWarnings: z.boolean(), confirm: z.literal(true) }),
  z.object({ action: z.literal('check') }),
  z.object({ action: z.literal('newId'), confirmCheckedLegendKeeper: z.boolean() }),
  z.object({ action: z.literal('finish'), confirm: z.literal(true) }),
])

/**
 * The guarded write flow:
 * - `prepare`: checks everything and returns the final preview plus a one-time approval token.
 * - `approve`: creates the page — only with the token, `confirm: true`, and unchanged content.
 * - `check`: after an uncertain outcome, asks LegendKeeper whether the page exists (read-only).
 * - `newId`: rare recovery step; see services/write.ts.
 * - `finish`: for a page created from a LegendKeeper template whose filling did not finish,
 *   repeats the filling steps (never creates anything).
 */
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    switch (body.action) {
      case 'prepare':
        return prepareWrite(ctx, draftId)
      case 'approve':
        return approveWrite(ctx, draftId, { approvalToken: body.approvalToken, acknowledgeWarnings: body.acknowledgeWarnings })
      case 'check':
        return checkOutcome(ctx, draftId)
      case 'newId':
        return assignNewPlannedId(ctx, draftId, { confirmCheckedLegendKeeper: body.confirmCheckedLegendKeeper })
      case 'finish':
        return finishTemplatePage(ctx, draftId)
    }
  })
}
