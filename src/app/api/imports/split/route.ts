import { handle } from '@/server/http'
import { previewSplit } from '@/server/services/imports'
import { readSourceForm } from '@/server/upload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Splits an over-long source into sections, without losing text. Creates nothing. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const source = await readSourceForm(request, ctx)
    return previewSplit(ctx, { bytes: source.bytes })
  })
}
