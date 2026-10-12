import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { downloadUpdate, restartToUpdate, setUpdateChecks, updateStatus } from '@/server/services/updates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Downloading the package can take a few minutes on a slow connection.
export const maxDuration = 900

/** Update status. Checks GitHub at most every 6 hours (or now with `?refresh=1`). */
export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'
  return handle((ctx) => updateStatus(ctx, { refresh }))
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('download') }),
  z.object({ action: z.literal('restart'), confirm: z.literal(true) }),
  z.object({ action: z.literal('setChecks'), enabled: z.boolean() }),
])

/**
 * - `download`: downloads the latest version, checks its SHA-256 checksum and unpacks it next to
 *   your data (the app folder is not changed yet).
 * - `restart`: restarts into the downloaded version.
 * - `setChecks`: switches the check at startup on or off.
 */
export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    if (body.action === 'download') return downloadUpdate(ctx)
    if (body.action === 'restart') return restartToUpdate(ctx)
    return setUpdateChecks(body.enabled)
  })
}
