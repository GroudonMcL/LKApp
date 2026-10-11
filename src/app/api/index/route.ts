import { z } from 'zod'
import { handle, readJson } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
import { clearIndex, requestScanPause, scanStatus, startOrResumeScan } from '@/server/services/discovery'

const Body = z.object({ action: z.enum(['start', 'pause']) })

export async function GET() {
  return handle((ctx) => scanStatus(ctx))
}

/** Starts or resumes the background scan (it keeps running after this returns), or pauses it. */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const { action } = await readJson(request, Body)
    if (action === 'start') await startOrResumeScan(ctx)
    else requestScanPause()
    return scanStatus(ctx)
  })
}

/** Deletes the local resource index. Nothing in LegendKeeper is affected. */
export async function DELETE() {
  return handle((ctx) => {
    clearIndex(ctx)
    return scanStatus(ctx)
  })
}
