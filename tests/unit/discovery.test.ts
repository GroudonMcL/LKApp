import { beforeEach, describe, expect, it } from 'vitest'
import { browseIndex, clearIndex, scanStatus, startOrResumeScan } from '@/server/services/discovery'
import { testConnection } from '@/server/services/connection'
import { tagOverview } from '@/server/services/tags'
import { ConnectorError } from '@/server/lk/errors'
import { createTestContext, type TestContext } from '../helpers/test-context'

function seed(ctx: TestContext, count: number) {
  for (let i = 0; i < count; i++) {
    ctx.lk.add({ id: `r${String(i).padStart(7, '0')}`, name: `Place ${i}`, tags: i % 3 === 0 ? [] : i % 3 === 1 ? ['Location'] : ['Location', 'Nyrond'], parentId: i > 0 && i % 10 === 0 ? 'r0000000' : null, aliases: i === 7 ? ['Seventh Heaven'] : [] })
  }
}

describe('read-only discovery', () => {
  let ctx: TestContext
  beforeEach(async () => {
    ctx = createTestContext()
    seed(ctx, 25)
    ctx.lk.pageSize = 10
    await testConnection(ctx)
  })

  it('tests the connection and remembers the project identity', async () => {
    const check = await testConnection(ctx)
    expect(check).toMatchObject({ ok: true, project: { id: 'proj_test', name: 'Greyhawk Test Project' } })
    expect(ctx.lk.callCount('pingProject')).toBeGreaterThan(0)
  })

  it('reports a failed connection in plain language', async () => {
    ctx.lk.failReads = new ConnectorError('authentication', 'LegendKeeper rejected the API key.', { status: 401, code: 'UNAUTHENTICATED', requestId: 'req_x', outcome: 'not_applied' })
    const check = await testConnection(ctx)
    expect(check.ok).toBe(false)
    expect(check.error).toMatchObject({ kind: 'authentication', requestId: 'req_x' })
  })

  it('scans every page of resources into the local index', async () => {
    const scan = await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    const status = scanStatus(ctx)
    expect(status.latest).toMatchObject({ id: scan.id, status: 'completed', pages: 3, resources: 25 })
    expect(status.stats).toEqual({ total: 25, untagged: 9, distinctTags: 2 })
  })

  it('resumes a failed scan from its saved cursor', async () => {
    let calls = 0
    const original = ctx.lk.listResources.bind(ctx.lk)
    ctx.lk.listResources = async (options) => {
      calls++
      if (calls === 2) throw new ConnectorError('rate_limited', 'slow down', { status: 429, outcome: 'not_applied' })
      return original(options)
    }
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    expect(scanStatus(ctx).latest).toMatchObject({ status: 'failed', pages: 1 })
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    expect(scanStatus(ctx).latest).toMatchObject({ status: 'completed', pages: 3, resources: 25 })
  })

  it('removes deleted resources only after a complete scan', async () => {
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    ctx.lk.resources.delete('r0000005')
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    expect(browseIndex(ctx, { q: 'Place 5', page: 1, pageSize: 50 }).items.map((i) => i.name)).not.toContain('Place 5')
  })

  it('filters and pages on the server: name, alias, tag, untagged, parent', async () => {
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    expect(browseIndex(ctx, { page: 1, pageSize: 10 })).toMatchObject({ total: 25, items: expect.any(Array) })
    expect(browseIndex(ctx, { page: 1, pageSize: 10 }).items).toHaveLength(10)
    expect(browseIndex(ctx, { untagged: true, page: 1, pageSize: 50 }).total).toBe(9)
    expect(browseIndex(ctx, { tag: 'Nyrond', page: 1, pageSize: 50 }).total).toBe(8)
    expect(browseIndex(ctx, { q: 'seventh', page: 1, pageSize: 50 }).items[0]!.name).toBe('Place 7')
    expect(browseIndex(ctx, { parentId: 'r0000000', page: 1, pageSize: 50 }).total).toBe(2)
    expect(browseIndex(ctx, { q: '100%_', page: 1, pageSize: 50 }).total).toBe(0)
  })

  it('clears the index on request', async () => {
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    clearIndex(ctx)
    expect(scanStatus(ctx).stats).toEqual({ total: 0, untagged: 0, distinctTags: 0 })
  })
})

describe('tag audit', () => {
  it('uses the live tag list with an ADMIN key', async () => {
    const ctx = createTestContext()
    seed(ctx, 9)
    await testConnection(ctx)
    const overview = await tagOverview(ctx, { refresh: true })
    expect(overview.source).toBe('api')
    expect(overview.tags).toEqual([
      { tag: 'Location', count: 6 },
      { tag: 'Nyrond', count: 3 },
    ])
  })

  it('falls back to the resource index with a MEMBER key, and says why', async () => {
    const ctx = createTestContext()
    seed(ctx, 9)
    ctx.lk.isAdmin = false
    await testConnection(ctx)
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    const overview = await tagOverview(ctx, { refresh: true })
    expect(overview.source).toBe('index')
    expect(overview.sourceNote).toMatch(/not an ADMIN key/)
    expect(overview.untaggedCount).toBe(3)
    expect(overview.tags[0]).toEqual({ tag: 'Location', count: 6 })
  })

  it('says plainly when no tag information is available', async () => {
    const ctx = createTestContext()
    ctx.lk.isAdmin = false
    await testConnection(ctx)
    const overview = await tagOverview(ctx, { refresh: true })
    expect(overview.source).toBe('none')
    expect(overview.tags).toEqual([])
  })
})

describe('automatic connection test', () => {
  it('runs once when needed, shares one test between callers, and reuses a recent result', async () => {
    const { ensureConnectionChecked } = await import('@/server/services/connection')
    ;(globalThis as Record<symbol, unknown>)[Symbol.for('lk-companion.last-connection-check')] = undefined
    const ctx = createTestContext()
    const [a, b] = await Promise.all([ensureConnectionChecked(ctx), ensureConnectionChecked(ctx)])
    expect(a?.ok).toBe(true)
    expect(b).toBe(a)
    expect(ctx.lk.callCount('pingProject')).toBe(1)
    await ensureConnectionChecked(ctx)
    expect(ctx.lk.callCount('pingProject')).toBe(1)
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 11 * 60 * 1000)
    await ensureConnectionChecked(ctx)
    expect(ctx.lk.callCount('pingProject')).toBe(2)
  })
})
