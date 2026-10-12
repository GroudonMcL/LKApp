import { z } from 'zod'
import { handle, readJson } from '@/server/http'
import { chronologyView, readTimelines, resetCalendarSettings, saveCalendarSettings, syncChronologyFindings } from '@/server/services/chronology'
import { requireProjectId } from '@/server/services/connection'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The local chronology, filtered. Read-only. */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams)
  return handle((ctx) => chronologyView(ctx, params))
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('readTimelines') }),
  z.object({ action: z.literal('checkConflicts') }),
  z.object({ action: z.literal('saveCalendars'), settings: z.unknown() }),
  z.object({ action: z.literal('resetCalendars') }),
])

export async function POST(request: Request) {
  return handle(async (ctx) => {
    const body = await readJson(request, Body)
    switch (body.action) {
      case 'readTimelines': {
        const result = await readTimelines(ctx)
        const sync = syncChronologyFindings(ctx, await requireProjectId(ctx))
        return { ...result, sync }
      }
      case 'checkConflicts':
        return syncChronologyFindings(ctx, await requireProjectId(ctx))
      case 'saveCalendars':
        return { settings: saveCalendarSettings(ctx, body.settings) }
      case 'resetCalendars':
        return { settings: resetCalendarSettings(ctx) }
    }
  })
}
