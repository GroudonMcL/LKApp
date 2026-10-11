import { handle } from '@/server/http'
import { allPageTypes } from '@/core/resolve'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handle((ctx) => {
    const custom = ctx.repos.recipes
      .list()
      .map((r) => r.definition.customPageType)
      .filter((t): t is NonNullable<typeof t> => t !== null)
    return { pageTypes: allPageTypes(custom) }
  })
}
