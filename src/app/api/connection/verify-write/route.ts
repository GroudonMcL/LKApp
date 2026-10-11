import { z } from 'zod'
import { handle, readJson } from '@/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
import { verifyWriteCapability } from '@/server/services/write'

const Body = z.object({ confirm: z.boolean() })

/** Runs the write check: creates one test page under the sandbox parent. Requires explicit confirmation. */
export async function POST(request: Request) {
  return handle(async (ctx) => verifyWriteCapability(ctx, await readJson(request, Body)))
}
