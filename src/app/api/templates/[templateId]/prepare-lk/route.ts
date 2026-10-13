import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { prepareLkTemplate } from '@/server/services/lk-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ confirm: z.literal(true) })

/** Gives the LegendKeeper template's blocks their ids (once), so each new page needs one write fewer. */
export async function POST(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params
  return handle(async (ctx) => {
    await readJson(request, Body)
    return prepareLkTemplate(ctx, templateId, { confirm: true })
  })
}
