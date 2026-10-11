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
