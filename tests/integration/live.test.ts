import { describe, expect, it } from 'vitest'
import { p } from '@legendkeeper/sdk/blocks'
import { LegendKeeper } from '@legendkeeper/sdk'
import { SdkConnector } from '@/server/lk/sdk-connector'
import { newLkResourceId, idempotencyKeyFor } from '@/core/ids'

/**
 * OPTIONAL live integration tests against a LegendKeeper project you choose.
 * They never run with `npm test`. Run them with `npm run test:integration`.
 *
 * Read-only tests (safe — they change nothing):
 *   LKC_INTEGRATION=1 LEGENDKEEPER_API_KEY=lk_... npm run test:integration
 *
 * Live write test (creates ONE page named "LK Companion integration test …" under a sandbox):
 *   add LKC_INTEGRATION_WRITE=1 and LKC_SANDBOX_PARENT_ID=<sandbox page id>
 *
 * Cleanup (deletes ONLY the page this test created, after checking its id and name):
 *   add LKC_INTEGRATION_CLEANUP=1. Without it the page is left for you to inspect and delete.
 *
 * Use a test project, or a sandbox page in your campaign project. Never point this at pages you care about.
 */

const enabled = process.env.LKC_INTEGRATION === '1' && !!process.env.LEGENDKEEPER_API_KEY
const writeEnabled = enabled && process.env.LKC_INTEGRATION_WRITE === '1' && !!process.env.LKC_SANDBOX_PARENT_ID
const cleanup = process.env.LKC_INTEGRATION_CLEANUP === '1'
const TEST_PREFIX = 'LK Companion integration test'

const connector = () => new SdkConnector({ apiKey: process.env.LEGENDKEEPER_API_KEY!, baseUrl: process.env.LEGENDKEEPER_BASE_URL || null })

describe.skipIf(!enabled)('live LegendKeeper — read-only', () => {
  it('connects and identifies the project', async () => {
    const project = await connector().getProject()
    expect(project.id).toBeTruthy()
    console.info(`Connected to ${project.name} (${project.id})`)
    expect((await connector().pingProject(project.id)).id).toBe(project.id)
  })

  it('lists resources with pagination', async () => {
    const first = await connector().listResources({ limit: 2 })
    expect(Array.isArray(first.items)).toBe(true)
    if (first.hasMore) {
      const second = await connector().listResources({ limit: 2, cursor: first.nextCursor })
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    }
  })

  it('reads a resource and the blocks of its first page document', async () => {
    const { items } = await connector().listResources({ limit: 20 })
    const withPage = items.find((r) => r.documents.some((d) => d.type === 'page'))
    if (!withPage) return
    const detail = await connector().getResource(withPage.id)
    const doc = detail.documents.find((d) => d.type === 'page')!
    const content = await connector().getDocumentContent(detail.id, doc.id)
    expect(typeof content.version).toBe('string')
    expect(Array.isArray(content.blocks)).toBe(true)
  })

  it('reads tags (ADMIN key) or reports a permission error (MEMBER key)', async () => {
    try {
      const tags = await connector().listTags()
      expect(Array.isArray(tags)).toBe(true)
    } catch (error) {
      expect((error as { kind?: string }).kind).toBe('permission')
    }
  })
})

describe.skipIf(!writeEnabled)('live LegendKeeper — one guarded write under the sandbox', () => {
  it('creates one page with a planned id, refuses a duplicate, and reads it back', async () => {
    const lk = connector()
    const sandbox = await lk.getResource(process.env.LKC_SANDBOX_PARENT_ID!)
    const id = newLkResourceId()
    const name = `${TEST_PREFIX} ${new Date().toISOString()}`
    const created = await lk.createPage({
      resourceId: id, name, parentId: sandbox.id, tags: [], aliases: [], documentName: 'Main',
      blocks: [p('Created by the LK Companion integration test. Safe to delete.')],
      idempotencyKey: idempotencyKeyFor('lkc-it', id),
    })
    expect(created.resourceId).toBe(id)
    console.info(`Created ${name} (${id}) under ${sandbox.name}`)

    // A second create with the same id must be refused, never duplicated.
    await expect(
      lk.createPage({ resourceId: id, name, parentId: sandbox.id, tags: [], aliases: [], documentName: 'Main', blocks: [p('dup')], idempotencyKey: idempotencyKeyFor('lkc-it-dup', id) }),
    ).rejects.toMatchObject({ kind: 'duplicate_id' })

    const readBack = await lk.getResource(id)
    expect(readBack).toMatchObject({ name, parentId: sandbox.id })
    const content = await lk.getDocumentContent(id, created.documentId!)
    expect(content.text).toContain('LK Companion integration test')

    if (cleanup) {
      // Only ever delete the page this test just created, after double-checking it.
      if (readBack.id !== id || !readBack.name.startsWith(TEST_PREFIX)) throw new Error('Refusing to delete: not the test page')
      const raw = new LegendKeeper({ apiKey: process.env.LEGENDKEEPER_API_KEY!, ...(process.env.LEGENDKEEPER_BASE_URL ? { baseUrl: process.env.LEGENDKEEPER_BASE_URL } : {}) })
      await raw.resources.delete({ resourceId: id })
      console.info(`Deleted test page ${id}`)
    } else {
      console.info(`Left test page ${id} in place. Delete it in LegendKeeper when you are done.`)
    }
  })
})

describe.skipIf(!writeEnabled)('live LegendKeeper — Phase 2 writes on one test page under the sandbox', () => {
  it('replaces tags, replaces content only at the expected version, and restores the original exactly', async () => {
    const lk = connector()
    const sandbox = await lk.getResource(process.env.LKC_SANDBOX_PARENT_ID!)
    const id = newLkResourceId()
    const name = `${TEST_PREFIX} phase 2 ${new Date().toISOString()}`
    const created = await lk.createPage({
      resourceId: id, name, parentId: sandbox.id, tags: ['LKC test'], aliases: [], documentName: 'Main',
      blocks: [p('Created by the LK Companion integration test. Safe to delete.'), p('Second paragraph.')],
      idempotencyKey: idempotencyKeyFor('lkc-it2', id),
    })
    const documentId = created.documentId!
    try {
      // Tags: the whole list is replaced (callers merge first).
      const tagged = await lk.updateResourceTags(id, ['LKC test', 'LKC test 2'])
      expect([...tagged.tags].sort()).toEqual(['LKC test', 'LKC test 2'])

      // Content: written only at the version read; a stale version is refused (nothing written).
      const original = await lk.getDocumentContent(id, documentId)
      const { version } = await lk.replaceDocumentBlocks(id, documentId, [p('Migrated content.')], original.version)
      await expect(lk.replaceDocumentBlocks(id, documentId, [p('Stale write.')], original.version)).rejects.toMatchObject({ kind: 'version_conflict' })
      expect((await lk.getDocumentContent(id, documentId)).text).toContain('Migrated content.')

      // Restore: the blocks exactly as read (with their ids) come back identical.
      await lk.replaceDocumentBlocks(id, documentId, original.blocks, version)
      const restored = await lk.getDocumentContent(id, documentId)
      expect(JSON.stringify(restored.blocks)).toBe(JSON.stringify(original.blocks))
    } finally {
      if (cleanup) {
        const readBack = await lk.getResource(id)
        if (readBack.id !== id || !readBack.name.startsWith(TEST_PREFIX)) throw new Error('Refusing to delete: not the test page')
        const raw = new LegendKeeper({ apiKey: process.env.LEGENDKEEPER_API_KEY!, ...(process.env.LEGENDKEEPER_BASE_URL ? { baseUrl: process.env.LEGENDKEEPER_BASE_URL } : {}) })
        await raw.resources.delete({ resourceId: id })
        console.info(`Deleted test page ${id}`)
      } else {
        console.info(`Left test page ${id} (${name}) in place. Delete it in LegendKeeper when you are done.`)
      }
    }
  })
})

describe.skipIf(!enabled)('live LegendKeeper — timelines and calendars (read-only)', () => {
  it('lists calendars, and reads the lanes and events of a timeline when the project has one', async () => {
    const calendars = await connector().listCalendars()
    expect(calendars.some((c) => c.id === 'greyhawk')).toBe(true)
    const { items } = await connector().listResources({ limit: 100 })
    const withTimeline = items.find((r) => r.documents.some((d) => d.type === 'time'))
    if (!withTimeline) return console.info('No timeline among the first 100 resources; event reading not exercised.')
    const doc = withTimeline.documents.find((d) => d.type === 'time')!
    const info = await connector().getTimelineDocument(withTimeline.id, doc.id)
    expect(info.type).toBe('time')
    const lanes = await connector().listTimelineLanes(withTimeline.id, doc.id)
    const events = await connector().listTimelineEvents(withTimeline.id, doc.id, 200)
    for (const e of events) expect(lanes.some((l) => l.id === e.laneId) || e.external).toBe(true)
    console.info(`Timeline “${info.name}” (${info.calendarId}): ${lanes.length} lane(s), ${events.length} event(s)`)
  })
})

describe.skipIf(!writeEnabled)('live LegendKeeper — Phase 3 timeline event write under the sandbox', () => {
  it('adds one event with a pre-chosen id to a test timeline, refuses a duplicate id, and reads it back', async () => {
    // The app never creates timelines; this test makes its own throwaway one with the SDK.
    const raw = new LegendKeeper({ apiKey: process.env.LEGENDKEEPER_API_KEY!, maxRetries: 0, ...(process.env.LEGENDKEEPER_BASE_URL ? { baseUrl: process.env.LEGENDKEEPER_BASE_URL } : {}) })
    const name = `${TEST_PREFIX} timeline ${new Date().toISOString()}`
    const resource = await raw.resources.create({ name, parentId: process.env.LKC_SANDBOX_PARENT_ID!, documents: [{ type: 'time', name: 'Timeline', calendarId: 'greyhawk' }] })
    const documentId = resource.documents[0]!.id
    try {
      const lane = await raw.timelines.createLane({ resourceId: resource.id, documentId }, { name: 'Test lane', rank: 'a0', size: 'sm' })
      const eventId = newLkResourceId()
      const input = { resourceId: resource.id, documentId, eventId, laneId: lane.id, name: 'Integration test event', formattedStart: 'Fireseek 12th, 576', formattedEnd: null, uri: `lk://resources/${process.env.LKC_SANDBOX_PARENT_ID}` }
      const created = await connector().createTimelineEvent(input)
      expect(created.id).toBe(eventId)
      await expect(connector().createTimelineEvent(input)).rejects.toMatchObject({ kind: 'duplicate_id' })
      const back = await connector().getTimelineEvent(resource.id, documentId, eventId)
      expect(back).toMatchObject({ name: 'Integration test event', detail: 3, uri: input.uri })
      expect(back.startDate).toMatchObject({ year: 576, monthName: 'Fireseek', day: 12 })
    } finally {
      if (cleanup) {
        const readBack = await raw.resources.get({ resourceId: resource.id })
        if (readBack.id !== resource.id || !readBack.name.startsWith(TEST_PREFIX)) throw new Error('Refusing to delete: not the test timeline')
        await raw.resources.delete({ resourceId: resource.id })
        console.info(`Deleted test timeline ${resource.id}`)
      } else {
        console.info(`Left test timeline ${resource.id} (${name}) in place.`)
      }
    }
  })
})
