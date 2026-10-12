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

describe.skipIf(!enabled)('live LegendKeeper — templates (read-only)', () => {
  it('lists templates at any depth; each sits under “templates” or under another template', async () => {
    const page = await connector().listTemplates({ limit: 100 })
    const ids = new Set(page.items.map((t) => t.id))
    for (const template of page.items) expect(template.parentId === 'templates' || ids.has(template.parentId ?? '')).toBe(true)
    console.info(`Templates: ${page.items.map((t) => `${t.name}${t.parentId === 'templates' ? '' : ' (nested)'}`).join(', ') || 'none'}`)
  })
})

describe.skipIf(!writeEnabled)('live LegendKeeper — page from a template, under the sandbox (SDK 4.1.0)', () => {
  it('creates a copy of a template with a planned id, refuses a duplicate, fills it in place keeping order, image slots and built-in boxes, and places a page beside it', async () => {
    const { hasAllIds, planFill } = await import('@/core/template-fill')
    const lk = connector()
    const sandbox = process.env.LKC_SANDBOX_PARENT_ID!
    // The template whose first page tab has the most built-in boxes the API cannot write (e.g. infobox Tags rows).
    const countBoxes = (value: unknown): number =>
      Array.isArray(value) ? value.reduce((n: number, v) => n + countBoxes(v), 0) : value && typeof value === 'object' ? ((value as { kind?: string }).kind === 'unsupported' ? 1 : Object.values(value).reduce((n: number, v) => n + countBoxes(v), 0)) : 0
    const templates = (await lk.listTemplates({ limit: 100 })).items.filter((t) => t.documents.some((d) => d.type === 'page'))
    if (!templates.length) return console.info('No template with a page tab; skipped.')
    let chosen = templates[0]!
    let best = -1
    for (const t of templates) {
      const doc = t.documents.find((d) => d.type === 'page')!
      const boxes = countBoxes((await lk.getDocumentContent(t.id, doc.id)).blocks)
      if (boxes > best) [chosen, best] = [t, boxes]
    }
    const template = await lk.getResource(chosen.id)

    const resourceId = newLkResourceId()
    const name = `${TEST_PREFIX} from template ${new Date().toISOString()}`
    const input = { templateId: template.id, resourceId, name, parentId: sandbox, idempotencyKey: idempotencyKeyFor('lkc-it-tpl', resourceId) }
    const created = await lk.createFromTemplate(input)
    expect(created).toMatchObject({ id: resourceId, name, parentId: sandbox })
    expect(created.documents.map((d) => d.type)).toEqual(template.documents.map((d) => d.type))
    // Same planned id with a fresh key: LegendKeeper refuses a second copy.
    await expect(lk.createFromTemplate({ ...input, idempotencyKey: `${input.idempotencyKey}.again` })).rejects.toMatchObject({ kind: 'duplicate_id' })

    const tab = [...created.documents].filter((d) => d.type === 'page').sort((a, b) => ((a.rank ?? '') < (b.rank ?? '') ? -1 : 1))[0]!
    // Filled in place, as the app does: ids first, then small edits planned against the copy.
    let before = await lk.getDocumentContent(resourceId, tab.id)
    if (!hasAllIds(before.blocks)) {
      await lk.assignBlockIds(resourceId, tab.id)
      before = await lk.getDocumentContent(resourceId, tab.id)
    }
    const boxesBefore = countBoxes(before.blocks)
    const marker = 'Filled by the LK Companion integration test.'
    // Every key-value row blanked (as for a page with no values), plus one new paragraph at the end.
    const blank = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(blank) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'rows' && Array.isArray(v) && v.every((r) => r && typeof r === 'object' && 'key' in r) ? v.map((r) => ({ ...r, content: [] })) : blank(v)])) : value
    const desired = [...(blank(before.blocks) as unknown[]), p(marker)]
    let version = before.version
    let n = 0
    for (const op of planFill(before.blocks, desired, () => `${resourceId.slice(0, 8)}b${n++}`.padEnd(24, '0'))) {
      if (op.op === 'replaceAll') version = (await lk.replaceDocumentBlocks(resourceId, tab.id, op.blocks, version)).version
      else if (op.op === 'updateProperty') version = (await lk.updateInfoboxProperty(resourceId, tab.id, op.blockId, op.propertyId, op.patch, version)).version
      else if (op.op === 'replace') version = (await lk.replaceBlock(resourceId, tab.id, op.blockId, op.block, version)).version
      else if (op.op === 'insert') version = (await lk.insertBlock(resourceId, tab.id, op, version)).version
      else throw new Error(`unexpected ${op.op}`)
    }
    const after = await lk.getDocumentContent(resourceId, tab.id)
    expect(after.text).toContain(marker)
    expect(countBoxes(after.blocks)).toBe(boxesBefore)
    // Row keys in the same order, all blank; image slots still there.
    const keysOf = (blocks: unknown[]) => JSON.stringify(blocks).match(/"key":"[^"]*"/g) ?? []
    expect(keysOf(after.blocks)).toEqual(keysOf(before.blocks))
    expect(JSON.stringify(after.blocks).match(/"kind":"image"/g)?.length ?? 0).toBe(JSON.stringify(before.blocks).match(/"kind":"image"/g)?.length ?? 0)
    console.info(`Template “${template.name}”: ${template.documents.length} tab(s), ${template.properties.length} sidebar propert(ies); filled in place keeping ${boxesBefore} built-in box(es), its image slots and its row order.`)

    const labels = await lk.updateResourceLabels(resourceId, { tags: [...created.tags, 'LKC integration test'], aliases: ['LKC template test'] })
    expect(labels.tags).toContain('LKC integration test')
    expect(labels.aliases).toEqual(['LKC template test'])

    // A plain page placed directly before the copy.
    const plainId = newLkResourceId()
    await lk.createPage({ resourceId: plainId, name: `${TEST_PREFIX} placed before ${new Date().toISOString()}`, parentId: sandbox, tags: [], aliases: [], documentName: 'Main', blocks: [p('Placement test.')], idempotencyKey: idempotencyKeyFor('lkc-it-place', plainId), placement: { before: resourceId } })
    const siblings: { id: string; rank: string | null }[] = []
    let cursor: string | null = null
    do {
      const page = await lk.listResources({ parentId: sandbox, cursor, limit: 100 })
      siblings.push(...page.items)
      cursor = page.hasMore ? page.nextCursor : null
    } while (cursor)
    const order = siblings.sort((a, b) => ((a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0)).map((s) => s.id)
    expect(order.indexOf(plainId)).toBe(order.indexOf(resourceId) - 1)
    console.info(`Left ${resourceId} (${name}) and ${plainId} under the sandbox.`)
  })
})

describe.skipIf(!enabled)('live LegendKeeper — template example text (read-only)', () => {
  it('leaves no example text of any template on a page with nothing to fill in', async () => {
    const { renderFromLayout } = await import('@/server/lk/render-layout')
    const { findBuiltInPageType } = await import('@/core/page-types')
    const { CanonicalPage } = await import('@/core/page-model')
    const lk = connector()
    const kindFor = (name: string) => (/stat\s*block|creature|monster/i.test(name) ? 'creature' : /item|weapon|armou?r/i.test(name) ? 'magic_item' : /location|place|city/i.test(name) ? 'location' : /rule|spell|class/i.test(name) ? 'rule' : 'npc')
    // The text a template holds (not its block titles or row keys, which are structure).
    const texts = (value: unknown, out: string[] = []): string[] => {
      if (Array.isArray(value)) value.forEach((v) => texts(v, out))
      else if (value && typeof value === 'object') {
        const block = value as Record<string, unknown>
        for (const [key, inner] of Object.entries(block)) {
          if (key === 'text' && typeof inner === 'string' && !('key' in block) && inner.trim().length > 2) out.push(inner.trim())
          else if (key !== 'title' && key !== 'key') texts(inner, out)
        }
      }
      return out
    }
    const report: string[] = []
    for (const listed of (await lk.listTemplates({ limit: 100 })).items) {
      const template = await lk.getResource(listed.id)
      const tab = template.documents.find((d) => d.type === 'page')
      if (!tab) continue
      const blocks = (await lk.getDocumentContent(template.id, tab.id)).blocks
      const pageType = findBuiltInPageType(kindFor(template.name))!
      const page = CanonicalPage.parse({ schemaVersion: 1, name: 'Audit Page', pageType: pageType.id, sections: [{ id: 's1', heading: 'Description', kind: 'lore', paragraphs: ['Audit description.'] }] })
      const out = renderFromLayout(page, pageType, { sourceProjectId: null, sourceResourceId: template.id, sourceName: template.name, sourceKind: 'template', documentName: tab.name, blocks: blocks as Record<string, unknown>[], droppedParts: [], fetchedAt: '' }, false, { keepEmptyImages: true })
      const left = [...new Set(texts(out).filter((t) => texts(blocks).includes(t)))]
      report.push(`${template.name} (${pageType.id}): ${left.length ? left.map((t) => JSON.stringify(t.slice(0, 60))).join(', ') : 'no example text left'}`)
    }
    console.info(report.join('\n'))
  })
})
