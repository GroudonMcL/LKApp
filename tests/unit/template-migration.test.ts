import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { compareContent, mechanicsChanges, numberTokens } from '@/core/migration-check'
import { readPage } from '@/server/lk/page-reader'
import { BATCH_TIMING } from '@/server/services/batch-engine'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { copyLayoutFromLegendKeeper } from '@/server/services/lk-templates'
import {
  analyseMigration,
  approveMigration,
  createMigration,
  dryRunMigration,
  exportMigration,
  migrationItem,
  migrationView,
  reconcileMigration,
  refreshMigration,
  restoreMigration,
  retryMigration,
  runMigration,
} from '@/server/services/migrations'
import { reviewQueue } from '@/server/services/review-queue'
import { draftBlockers } from '@/server/services/write'
import { createTestContext } from '../helpers/test-context'

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const templateBlocks = (JSON.parse(fixture('lk-statblock-template.json')) as { blocks: unknown[] }).blocks
const oldBlocks = () => {
  const blocks = structuredClone((JSON.parse(fixture('lk-old-creature-page.json')) as { blocks: Record<string, unknown>[] }).blocks)
  // Extras an older page might have: a portrait, a GM secret, a link, a divider, unreadable content.
  ;(blocks[0]!.rows as unknown[]).unshift({ id: 'imgprop1', kind: 'image', url: 'https://assets.legendkeeper.com/x.png', title: 'Portrait', isTitleHidden: true })
  blocks.push({ id: 'rule0001', kind: 'rule' })
  blocks.push({ id: 'para0001', kind: 'paragraph', content: [{ text: 'Aboleths lair in ' }, { mention: { resourceId: 'lake0001', text: 'the Nyr Dyv', name: 'Nyr Dyv' } }, { text: ' and ' }, { text: 'hate', underline: true }, { text: ' the gods.' }] })
  blocks.push({ id: 'secret01', kind: 'secret', children: [{ id: 'sp000001', kind: 'paragraph', content: [{ text: 'GM only: the aboleth remembers the fall of the Suel.' }] }] })
  blocks.push({ id: 'unsup001', kind: 'unsupported' })
  return blocks
}

beforeAll(() => {
  BATCH_TIMING.writeSpacingMs = 0
  BATCH_TIMING.checkSpacingMs = 0
})

async function setup() {
  const ctx = createTestContext({
    resources: [
      { id: 'l1ylm24t', name: 'Statblock', parentId: 'templates', documents: [{ id: 'rjemxmxe', name: 'Main', type: 'page', blocks: templateBlocks, version: 'v1', text: '' }] },
      { id: 'best0001', name: 'Bestiary', parentId: null },
      { id: 'lake0001', name: 'Nyr Dyv', parentId: null, tags: ['Location'] },
      { id: 'abo00001', name: 'Aboleth', parentId: 'best0001', tags: ['Monster', 'CR 10'], aliases: ['Deep One'], documents: [{ id: 'docabo01', name: 'Main', type: 'page', blocks: oldBlocks(), version: 'v1', text: '' }] },
    ],
  })
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  const { template, recipe } = await copyLayoutFromLegendKeeper(ctx, { resource: 'l1ylm24t', pageType: 'creature' })
  return { ctx, template, recipe: recipe! }
}

async function analysed() {
  const s = await setup()
  const view = await createMigration(s.ctx, { name: 'Aboleth test', recipeId: s.recipe.id, templateId: s.template.id, scope: { mode: 'resources' }, pageRefs: ['Aboleth'] })
  const batchId = view.batch.id
  await analyseMigration(s.ctx, batchId, { wait: true })
  const item = migrationView(s.ctx, batchId).items[0]!
  return { ...s, batchId, item, plan: migrationItem(s.ctx, batchId, item.id).plan! }
}

const textOf = (blocks: unknown[], name = 'Aboleth') =>
  readPage(blocks, name)
    .lines.map((l) => l.text)
    .join('\n')

describe('reading a page for migration', () => {
  it('turns text into Markdown and keeps images, secrets and unreadable blocks as they are', () => {
    const reading = readPage(oldBlocks(), 'Aboleth')
    expect(reading.markdown).toContain('Armor Class: 17 (natural armor)')
    expect(reading.markdown).toContain('***Amphibious.*** The aboleth can breathe air and water.')
    expect(reading.markdown).toContain('## Traits')
    // Secret text never becomes ordinary text.
    expect(reading.markdown).not.toContain('GM only')
    expect(reading.preserved.map((p) => [p.id, p.container])).toEqual([
      ['imgprop1', 'infobox'],
      ['secret01', 'page'],
      ['unsup001', 'page'],
    ])
    expect(reading.mentions).toEqual([{ text: 'the Nyr Dyv', resourceId: 'lake0001' }])
    expect(reading.dropped).toEqual({ rule: 1 })
    expect(reading.formatting.underline).toBe(1)
  })

  it('compares literally: missing sentences, relabelled rows and changed numbers', () => {
    const before = readPage([{ kind: 'keyValue', rows: [{ key: 'AC', content: [{ text: '17' }] }] }, { kind: 'paragraph', content: [{ text: 'It hates the gods. It lairs underwater.' }] }], 'X')
    const after = readPage([{ kind: 'keyValue', rows: [{ key: 'Armour Class', content: [{ text: '17' }] }] }, { kind: 'paragraph', content: [{ text: 'It hates the gods.' }] }], 'X')
    const result = compareContent(before, after)
    expect(result.fields[0]).toMatchObject({ oldKey: 'AC', newKey: 'Armour Class', change: 'relabelled' })
    expect(result.unmapped.map((u) => u.text)).toEqual(['It hates the gods. It lairs underwater.'])
    const changed = readPage([{ kind: 'keyValue', rows: [{ key: 'Armour Class', content: [{ text: '18' }] }] }], 'X')
    expect(mechanicsChanges(before, changed).map((m) => m.id)).toEqual(['missing:17:1', 'added:18:1'])
    expect(numberTokens('135 (18d10+36), DC 14, 5,900 XP, CR 1/4, −1')).toEqual(['135', '18d10', '+36', '14', '5900', '1/4', '-1'])
  })
})

describe('template migration jobs', () => {
  it('tests one page: maps fields, keeps every sentence, link and special block, and writes nothing', async () => {
    const { ctx, plan, item } = await analysed()
    expect(item.status).toBe('awaiting_review')
    expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(0)
    expect(ctx.lk.callCount('createPage')).toBe(0)
    expect(plan.template.kind).toBe('native')

    // Field mapping into the new layout's rows, with relabelling shown.
    const ac = plan.fields.find((f) => f.oldKey === 'Armor Class')!
    expect(ac).toMatchObject({ newKey: 'Armour Class', newValue: '17 (natural armor)' })
    // Every old sentence is in the proposed page; numbers are all still there.
    const proposed = textOf(plan.proposedBlocks)
    for (const sentence of ['The aboleth can breathe air and water.', 'Hit: 12 (2d6 + 5) bludgeoning damage.', 'the gods.']) expect(proposed).toContain(sentence)
    expect(plan.mechanics.filter((m) => m.change === 'missing')).toEqual([])
    expect(plan.blockers).toEqual([])
    // Kept blocks are sent back by id; the secret stays a secret.
    const json = JSON.stringify(plan.proposedBlocks)
    for (const id of ['imgprop1', 'secret01', 'unsup001']) expect(json).toContain(`"id":"${id}"`)
    expect(plan.kept.find((k) => k.id === 'imgprop1')?.placement).toBe('In the infobox')
    expect(plan.kept.find((k) => k.id === 'secret01')?.placement).toBe('At the end of the page')
    expect((plan.proposedBlocks as { id?: string; kind: string }[]).find((b) => b.id === 'secret01')?.kind).toBe('secret')
    // The link survives, with the page's own wording.
    expect(plan.links.lost).toEqual([])
    expect(plan.links.after).toContain('lake0001')
    // Identity and metadata unchanged; formatting differences reported.
    expect(plan.metadata).toMatchObject({ tagsBefore: ['Monster', 'CR 10'], tagsAfter: ['Monster', 'CR 10'] })
    expect(plan.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['FORMATTING_SIMPLIFIED', 'DIVIDERS_REMOVED', 'BLOCKS_KEPT']))
    expect(plan.findings.map((f) => f.code)).not.toContain('POSSIBLE_DUPLICATE')
    // The migration draft can never be created as a new page.
    const draft = ctx.repos.drafts.get(plan.draftId)!
    expect(draftBlockers(ctx, draft).map((b) => b.code)).toContain('MIGRATION_DRAFT')
  })

  it('applies after approval with a version check, keeps the page identity, saves the original and restores it', async () => {
    const { ctx, batchId, item, plan } = await analysed()
    await expect(runMigration(ctx, batchId, { wait: true })).rejects.toThrow(/no approved pages/)
    approveMigration(ctx, batchId, { itemIds: [item.id], acknowledged: { [item.id]: plan.acknowledgements.map((a) => a.id) } })
    expect(migrationView(ctx, batchId).items[0]!.status).toBe('approved')
    await dryRunMigration(ctx, batchId, { wait: true })
    expect(JSON.parse(exportMigration(ctx, batchId, { report: 'dry_run', format: 'json' }).body).entries[0].canProceed).toBe(true)
    expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(0)

    await runMigration(ctx, batchId, { wait: true })
    const after = migrationView(ctx, batchId).items[0]!
    expect(after.status).toBe('succeeded')
    expect(after.error).toBeNull()
    const call = ctx.lk.calls.find((c) => c.method === 'replaceDocumentBlocks')!.args as { ifMatch: string; resourceId: string }
    expect(call).toMatchObject({ resourceId: 'abo00001', ifMatch: 'v1' })
    const page = ctx.lk.resources.get('abo00001')!
    expect(page).toMatchObject({ id: 'abo00001', name: 'Aboleth', parentId: 'best0001', tags: ['Monster', 'CR 10'], aliases: ['Deep One'] })
    expect(ctx.lk.callCount('createPage')).toBe(0)
    expect(ctx.lk.callCount('updateResourceTags')).toBe(0)
    const backup = ctx.repos.migrationBackups.latestForItem(item.id)!
    expect(backup).toMatchObject({ status: 'applied', originalVersion: 'v1', resultVersion: 'v2' })
    expect(backup.originalBlocks).toEqual(oldBlocks())

    // Restore: refused while the page has later edits, unless explicitly accepted.
    page.documents[0]!.version = 'v3'
    let restored = await restoreMigration(ctx, batchId, { itemIds: [item.id] })
    expect(restored.restoreResults[0]).toMatchObject({ outcome: 'refused' })
    page.documents[0]!.version = 'v2'
    restored = await restoreMigration(ctx, batchId, { itemIds: [item.id] })
    expect(restored.restoreResults[0]).toMatchObject({ outcome: 'restored' })
    expect(page.documents[0]!.blocks).toEqual(oldBlocks())
    expect(ctx.repos.migrationBackups.latestForItem(item.id)!.status).toBe('restored')
  })

  it('protects numbers: an edited mechanical value must be acknowledged after refreshing', async () => {
    const { ctx, batchId, item, plan } = await analysed()
    const draft = ctx.repos.drafts.get(plan.draftId)!
    const page = structuredClone(draft.page)
    const hp = page.fields.find((f) => f.key === 'hitPoints')!
    hp.value = hp.value!.replace('135', '136')
    ctx.repos.drafts.upsertContent({ id: draft.id, jobId: draft.jobId, page, findings: [], recipeId: draft.recipeId, recipeVersion: draft.recipeVersion, reason: 'test edit' })

    approveMigration(ctx, batchId, { itemIds: [item.id], acknowledged: {} })
    expect(migrationView(ctx, batchId).items[0]).toMatchObject({ status: 'awaiting_review', draftChanged: true, error: expect.stringMatching(/Refresh the comparison/) })

    refreshMigration(ctx, batchId, [item.id])
    const fresh = migrationItem(ctx, batchId, item.id).plan!
    // The new number must be acknowledged; the old line is kept word for word in the notes.
    expect(fresh.mechanics.map((m) => m.id)).toContain('added:136:1')
    expect(fresh.acknowledgements.map((a) => a.id)).toContain('added:136:1')
    expect(fresh.fields.find((f) => f.oldKey === 'Hit Points')).toMatchObject({ change: 'changed', oldValue: '135 (18d10+36)', newValue: '136 (18d10+36)' })
    expect(fresh.unmapped.map((u) => u.text)).toContain('Hit Points: 135 (18d10+36)')
    expect(textOf(fresh.proposedBlocks)).toContain('Hit Points: 135 (18d10+36)')
    // It is in the central review queue as a high-priority mechanics change.
    expect(reviewQueue(ctx).items[0]).toMatchObject({ type: 'migration_mechanics', severity: 'high', resourceId: 'abo00001' })
    approveMigration(ctx, batchId, { itemIds: [item.id], acknowledged: { [item.id]: fresh.acknowledgements.map((a) => a.id).filter((id) => id !== 'added:136:1') } })
    expect(migrationView(ctx, batchId).items[0]).toMatchObject({ status: 'awaiting_review', error: expect.stringMatching(/Tick every change/) })
    approveMigration(ctx, batchId, { itemIds: [item.id], acknowledged: { [item.id]: fresh.acknowledgements.map((a) => a.id) } })
    expect(migrationView(ctx, batchId).items[0]!.status).toBe('approved')
  })

  it('writes nothing when the page changed after the analysis', async () => {
    const { ctx, batchId, item, plan } = await analysed()
    approveMigration(ctx, batchId, { itemIds: [item.id], acknowledged: { [item.id]: plan.acknowledgements.map((a) => a.id) } })
    ctx.lk.resources.get('abo00001')!.documents[0]!.version = 'v7'
    await runMigration(ctx, batchId, { wait: true })
    expect(migrationView(ctx, batchId).items[0]).toMatchObject({ status: 'pending', error: expect.stringMatching(/edited in LegendKeeper after the analysis/) })
    expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(0)
    expect(ctx.repos.migrationBackups.latestForItem(item.id)).toBeNull()
  })

  it('reconciles an unknown outcome by reading, and never re-sends a failed write on its own', async () => {
    const { ctx, batchId, item, plan } = await analysed()
    const ack = { [item.id]: plan.acknowledgements.map((a) => a.id) }
    approveMigration(ctx, batchId, { itemIds: [item.id], acknowledged: ack })
    ctx.lk.replaceBehavior.set('abo00001', 'apply_then_connection_error')
    await runMigration(ctx, batchId, { wait: true })
    expect(migrationView(ctx, batchId).items[0]!.status).toBe('needs_reconciliation')
    await reconcileMigration(ctx, batchId)
    expect(migrationView(ctx, batchId).items[0]!.status).toBe('succeeded')
    expect(ctx.repos.migrationBackups.latestForItem(item.id)).toMatchObject({ status: 'applied', resultVersion: 'v2' })
    expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(1)
  })

  it('a failure before applying is checked, then needs a fresh analysis and approval', async () => {
    const { ctx, batchId, item, plan } = await analysed()
    approveMigration(ctx, batchId, { itemIds: [item.id], acknowledged: { [item.id]: plan.acknowledgements.map((a) => a.id) } })
    ctx.lk.replaceBehavior.set('abo00001', 'server_error_before_apply')
    await runMigration(ctx, batchId, { wait: true })
    await reconcileMigration(ctx, batchId)
    expect(migrationView(ctx, batchId).items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not happen/) })
    expect(ctx.repos.migrationBackups.latestForItem(item.id)!.status).toBe('not_applied')
    retryMigration(ctx, batchId, [item.id])
    expect(migrationView(ctx, batchId).items[0]!.status).toBe('pending')
    expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(1)
  })

  it('refuses a target template made for another page type', async () => {
    const { ctx, template } = await setup()
    const { createRecipe } = await import('@/server/services/recipes')
    const npc = createRecipe(ctx, { name: 'NPC', targetPageType: 'npc' })
    await expect(createMigration(ctx, { name: 'x', recipeId: npc.id, templateId: template.id, scope: { mode: 'resources' }, pageRefs: ['Aboleth'] })).rejects.toThrow(/is for “creature” pages/)
    await expect(createMigration(ctx, { name: 'x', recipeId: npc.id, templateId: 'tpl_missing', scope: { mode: 'resources' }, pageRefs: ['Aboleth'] })).rejects.toThrow(/does not exist/)
  })
})
