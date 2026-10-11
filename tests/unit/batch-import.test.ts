import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { extractRecords, RecordRules } from '@/core/records'
import { Matcher } from '@/core/matching'
import { findBuiltInPageType } from '@/core/page-types'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { createRecipe, updateRecipe } from '@/server/services/recipes'
import { BATCH_TIMING } from '@/server/services/batch-engine'
import {
  approveItems,
  batchView,
  cancelBatch,
  closeBatch,
  createImportBatch,
  decideItems,
  dryRunBatch,
  exportBatch,
  extractBatchRecords,
  generateDrafts,
  reconcileBatch,
  retryItems,
  runBatch,
  toCsv,
  transcribeSource,
} from '@/server/services/import-batches'
import { createTestContext, type TestContext } from '../helpers/test-context'
import { makeDocx, makePdf } from '../helpers/make-documents'
import { aiOutput } from '../helpers/mock-ai'

const utf8 = (text: string) => new TextEncoder().encode(text)

const BESTIARY = `# Goblinoids

Goblinoids live in the hills of the Pomarj.

## Goblin Underboss

Small Fey (Goblinoid), Chaotic Neutral

AC 17
HP 21 (6d6)
Speed 30 ft.

Traits

Nimble Feet. The underboss can take the Disengage action as a bonus action.

## Hobgoblin Drillmaster

Medium Fey (Goblinoid), Lawful Evil

AC 18
HP 39 (6d8 + 12)
Speed 30 ft.

## Bugbear Lurker

Medium Fey (Goblinoid), Chaotic Evil

AC 16
Speed 30 ft.
`

const ITEMS_JSON = JSON.stringify({ items: [{ id: 'WOW-1', name: 'Wand of Webs', rarity: 'Uncommon' }, { id: 'RIN-2', name: 'Ring of Warmth', rarity: 'Uncommon' }, 'not an object'] })

beforeAll(() => {
  BATCH_TIMING.writeSpacingMs = 0
  BATCH_TIMING.checkSpacingMs = 0
})

async function setup(options: { duplicatePolicy?: 'require_review' | 'skip_exact' | 'create_anyway'; existing?: { id: string; name: string; tags?: string[]; parentId?: string | null }[] } = {}) {
  const ctx = createTestContext({
    resources: [{ id: 'sandbox0001', name: 'Sandbox', parentId: null }, ...(options.existing ?? []).map((r) => ({ ...r, parentId: r.parentId ?? null }))],
  })
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  const recipe = createRecipe(ctx, {
    name: 'Bestiary import',
    targetPageType: 'creature',
    requiredFields: ['armorClass', 'hitPoints'],
    defaultParentId: 'sandbox0001',
    duplicatePolicy: options.duplicatePolicy ?? 'require_review',
    extraction: { mode: 'heading', headingLevel: 2, expectLabels: ['AC', 'Armor Class'] },
    defaultValues: [{ fieldKey: 'edition', value: '5e (2024)' }],
  })
  return { ctx, recipe }
}

describe('record extraction rules', () => {
  const rules = (input: Partial<RecordRules>) => RecordRules.parse(input)

  it('splits at a heading level, keeps the chapter as section context and the intro as a preamble', () => {
    const records = extractRecords({ text: BESTIARY, format: 'markdown', title: 'Bestiary' }, rules({ mode: 'heading', headingLevel: 2 }), { maxChars: 10_000 })
    expect(records.map((r) => r.title)).toEqual(['Text before the first record', 'Goblin Underboss', 'Hobgoblin Drillmaster', 'Bugbear Lurker'])
    expect(records[0]!.flags).toEqual(['preamble'])
    expect(records[1]!.section).toBe('Goblinoids')
    // No text is lost: every non-blank line of the source is in some record.
    const all = records.map((r) => r.text).join('\n')
    for (const line of BESTIARY.split('\n').filter((l) => l.trim())) expect(all).toContain(line.trim())
  })

  it('splits statblocks in unstructured text (PDF) and keeps page numbers', () => {
    const text = 'Goblin Boss\nSmall Fey (Goblinoid), Chaotic Neutral\nAC 17\n\nHobgoblin\nMedium Fey, Lawful Evil\nAC 18'
    const records = extractRecords({ text, format: 'text', title: null, pages: [{ page: 4, offset: 0 }, { page: 5, offset: text.indexOf('Hobgoblin') }] }, rules({ mode: 'statblock' }), { maxChars: 10_000 })
    expect(records.map((r) => [r.title, r.page])).toEqual([
      ['Goblin Boss', 4],
      ['Hobgoblin', 5],
    ])
  })

  it('reads JSON arrays with their own ids and flags entries that are not objects', () => {
    const records = extractRecords({ text: ITEMS_JSON, json: JSON.parse(ITEMS_JSON), format: 'json', title: null }, rules({ mode: 'json_array', jsonPath: 'items', minChars: 0 }), { maxChars: 10_000 })
    expect(records.map((r) => [r.title, r.sourceRecordId])).toEqual([
      ['Wand of Webs', 'WOW-1'],
      ['Ring of Warmth', 'RIN-2'],
      ['Entry 3', null],
    ])
    expect(records[2]!.flags).toContain('invalid_json_record')
  })

  it('flags doubtful records instead of guessing', () => {
    const one = extractRecords({ text: 'Just some notes without headings at all.', format: 'markdown', title: 'Notes' }, rules({ mode: 'heading' }), { maxChars: 10_000 })
    expect(one).toHaveLength(1)
    expect(one[0]!.flags).toContain('no_split_found')
    const twins = extractRecords({ text: '## Orc\nAC 13 and more text here to pass\n## Orc\nAC 13 and more text here too, yes', format: 'markdown', title: null }, rules({ mode: 'heading', minChars: 5 }), { maxChars: 10_000 })
    expect(twins.every((r) => r.flags.includes('duplicate_title_in_source'))).toBe(true)
    const long = extractRecords({ text: `## Huge\n${'x'.repeat(500)}`, format: 'markdown', title: null }, rules({ mode: 'heading' }), { maxChars: 100 })
    expect(long[0]!.flags).toContain('too_long')
  })
})

describe('duplicate matching', () => {
  const creature = findBuiltInPageType('creature')!
  const index = [
    { id: 'a1', name: 'Goblin Boss', aliases: [], parentId: 'p1', path: 'Bestiary', tags: ['Monster'] },
    { id: 'a2', name: 'Hommlet', aliases: [], parentId: 'p2', path: 'Flanaess', tags: ['Location'] },
    { id: 'a3', name: 'Hommlet', aliases: [], parentId: 'p3', path: 'Adventures', tags: ['Adventure'] },
    { id: 'a4', name: 'Iggwilv', aliases: ['Tasha', 'Natasha'], parentId: null, path: null, tags: ['NPC'] },
    { id: 'a5', name: 'Bugbears', aliases: [], parentId: null, path: null, tags: [] },
    { id: 'a6', name: 'Owlbear', aliases: [], parentId: null, path: null, tags: [] },
  ]
  const matcher = new Matcher(index)

  it('distinguishes exact, strong, ambiguous and no match', () => {
    expect(matcher.match({ name: 'Goblin Boss' }, creature).category).toBe('exact')
    expect(matcher.match({ name: 'goblin boss' }, creature).category).toBe('strong')
    expect(matcher.match({ name: 'Hommlet' }, null).category).toBe('ambiguous')
    expect(matcher.match({ name: 'Tasha' }, null).category).toBe('strong')
    expect(matcher.match({ name: 'Bugbear' }, creature).category).toBe('ambiguous')
    expect(matcher.match({ name: 'Ettercap' }, creature).category).toBe('none')
  })

  it('uses the record’s aliases and the parent page as signals', () => {
    const viaAlias = matcher.match({ name: 'Witch Queen', aliases: ['Iggwilv'] }, null)
    expect(viaAlias.category).toBe('strong')
    expect(viaAlias.candidates[0]!.signals).toContain('alias_matches_name')
    expect(matcher.match({ name: 'Owlbear', parentId: null }, null).category).toBe('strong')
  })
})

describe('batch import', () => {
  let ctx: TestContext
  let recipeId: string

  beforeEach(async () => {
    const s = await setup({ existing: [{ id: 'ex000001', name: 'Bugbear Lurker', tags: ['Monster'], parentId: 'sandbox0001' }] })
    ctx = s.ctx
    recipeId = s.recipe.id
  })

  it('takes several files in one job; unreadable files are recorded, not fatal', async () => {
    const view = await createImportBatch(ctx, {
      name: 'Monsters',
      recipeId,
      files: [
        { bytes: utf8(BESTIARY), fileName: 'goblinoids.md', mimeType: 'text/markdown' },
        { bytes: makePdf([['Goblin Boss', 'Small Fey (Goblinoid), Chaotic Neutral', 'AC 17', 'HP 21 (6d6)']]), fileName: 'mm.pdf', mimeType: 'application/pdf' },
        { bytes: makeDocx([{ text: 'Kobolds', style: 'Heading2' }, { text: 'Small Dragon, Lawful Evil' }, { text: 'AC 12' }]), fileName: 'kobolds.docx', mimeType: null },
        { bytes: utf8('<h2>Gnoll</h2><p>AC 15, HP 22 (5d8)</p>'), fileName: 'gnoll.html', mimeType: 'text/html' },
        { bytes: utf8('{ broken json'), fileName: 'bad.json', mimeType: 'application/json' },
        { bytes: utf8('old'), fileName: 'old.doc', mimeType: null },
        { bytes: new Uint8Array(), fileName: 'empty.txt', mimeType: 'text/plain' },
      ],
      pastes: [{ name: 'Pasted orc', text: '## Orc\nMedium Humanoid, Chaotic Evil\nAC 13\nHP 15 (2d8 + 6)' }],
    })
    expect(view.sources.map((s) => [s.fileName ?? s.title, s.originalFormat, s.status])).toEqual([
      ['goblinoids.md', 'markdown', 'extracted'],
      ['mm.pdf', 'pdf', 'extracted'],
      ['kobolds.docx', 'docx', 'extracted'],
      ['gnoll.html', 'html', 'extracted'],
      ['bad.json', 'json', 'failed'],
      ['old.doc', 'doc', 'failed'],
      ['empty.txt', 'txt', 'failed'],
      ['Pasted orc', 'markdown', 'extracted'],
    ])
    expect(view.sources.find((s) => s.fileName === 'old.doc')!.error).toMatch(/save it as \.docx/)
    expect(view.sources.find((s) => s.fileName === 'mm.pdf')!.pages).toEqual([{ page: 1, offset: 0 }])
    expect(view.overview.inputFiles).toBe(8)
    expect(view.overview.failedFiles).toBe(3)
  })

  it('extracts many records with source context, drafts them and reports counts', async () => {
    await createImportBatch(ctx, { name: 'Goblinoids', recipeId, files: [{ bytes: utf8(BESTIARY), fileName: 'goblinoids.md', mimeType: 'text/markdown' }], pastes: [] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    let view = extractBatchRecords(ctx, batchId)
    expect(view.items.map((i) => [i.title, i.status])).toEqual([
      ['Text before the first record', 'skipped'],
      ['Goblin Underboss', 'pending'],
      ['Hobgoblin Drillmaster', 'pending'],
      ['Bugbear Lurker', 'pending'],
    ])
    const job = ctx.repos.jobs.get(view.items[1]!.jobId!)!
    expect(job.recordMeta).toMatchObject({ fileName: 'goblinoids.md', section: 'Goblinoids' })
    expect(job.attribution.citation).toBe('goblinoids.md — Goblinoids')
    // Batch records are listed with their batch, not as single imports.
    expect(ctx.repos.jobs.list().total).toBe(0)

    await generateDrafts(ctx, batchId, { mode: 'structural', wait: true })
    view = batchView(ctx, batchId)
    expect(view.items.filter((i) => i.status === 'awaiting_review')).toHaveLength(3)
    const byTitle = Object.fromEntries(view.items.map((i) => [i.title, i]))
    // Missing HP is a per-record error; it does not affect the other records.
    expect(byTitle['Bugbear Lurker']!.draft!.missingRequired).toBe(1)
    expect(byTitle['Goblin Underboss']!.draft!.errors).toBe(0)
    // Existing page with the same name, the creature tag and the same parent: exact duplicate.
    expect((byTitle['Bugbear Lurker']!.match as { category: string }).category).toBe('exact')
    expect(byTitle['Bugbear Lurker']!.matchBlocker).toMatch(/Possible duplicate/)
    expect(view.overview).toMatchObject({ records: 3, validDrafts: 2, needsReview: 3, possibleDuplicates: 1, missingRequired: 1, approved: 0 })
    // Recipe default values are marked as defaults, never as source facts.
    const draft = ctx.repos.drafts.getByJob(byTitle['Goblin Underboss']!.jobId!)!
    expect(draft.page.fields.find((f) => f.key === 'edition')).toMatchObject({ value: '5e (2024)', status: 'default' })
  })

  it('dry run writes nothing; approval needs resolved duplicates; run creates only approved pages', async () => {
    await createImportBatch(ctx, { name: 'Goblinoids', recipeId, files: [{ bytes: utf8(BESTIARY), fileName: 'goblinoids.md', mimeType: 'text/markdown' }], pastes: [] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(ctx, batchId)
    await generateDrafts(ctx, batchId, { mode: 'structural', wait: true })
    const before = ctx.lk.callCount('createPage')

    await dryRunBatch(ctx, batchId, { wait: true })
    expect(ctx.lk.callCount('createPage')).toBe(before)
    const report = JSON.parse(exportBatch(ctx, batchId, { report: 'dry_run', format: 'json' }).body)
    const byTitle = Object.fromEntries(report.entries.map((e: { title: string }) => [e.title, e]))
    expect(byTitle['Goblin Underboss'].canProceed).toBe(true)
    expect(byTitle['Bugbear Lurker'].canProceed).toBe(false)
    expect(byTitle['Bugbear Lurker'].problems.join(' ')).toMatch(/duplicate/i)
    expect(report.keyRole).toBe('ADMIN')

    let view = batchView(ctx, batchId)
    const ids = view.items.filter((i) => i.status === 'awaiting_review').map((i) => i.id)
    // Warnings must be acknowledged; nothing gets approved without it.
    await approveItems(ctx, batchId, { itemIds: ids, acknowledgeWarnings: false, wait: true })
    view = batchView(ctx, batchId)
    expect(view.items.find((i) => i.title === 'Goblin Underboss')!.status).toBe('approved') // no warnings to acknowledge
    await approveItems(ctx, batchId, { itemIds: ids, acknowledgeWarnings: true, wait: true })
    view = batchView(ctx, batchId)
    const status = Object.fromEntries(view.items.map((i) => [i.title, i.status]))
    expect(status['Goblin Underboss']).toBe('approved')
    expect(status['Bugbear Lurker']).toBe('awaiting_review') // duplicate unresolved
    expect(status['Hobgoblin Drillmaster']).toBe('approved')
    expect(ctx.lk.callCount('createPage')).toBe(before)

    // Skip the duplicate explicitly.
    decideItems(ctx, batchId, [view.items.find((i) => i.title === 'Bugbear Lurker')!.id], 'skip')
    await runBatch(ctx, batchId, { wait: true })
    view = batchView(ctx, batchId)
    expect(view.items.filter((i) => i.status === 'succeeded').map((i) => i.title).sort()).toEqual(['Goblin Underboss', 'Hobgoblin Drillmaster'])
    expect(ctx.lk.callCount('createPage') - before).toBe(2)
    expect(view.items.find((i) => i.title === 'Bugbear Lurker')!.status).toBe('skipped')
    const created = ctx.lk.resources.get(view.items.find((i) => i.title === 'Goblin Underboss')!.resourceId!)!
    expect(created.parentId).toBe('sandbox0001')

    // Running again creates nothing more.
    await expect(runBatch(ctx, batchId, { wait: true })).rejects.toThrow(/no approved records/)
    closeBatch(ctx, batchId)
    expect(ctx.repos.batches.get(batchId)!.status).toBe('completed')
    expect(ctx.repos.batchSources.list(batchId)[0]!.text).toBeNull()
  })

  it('does not approve a record with warnings unless they are acknowledged', async () => {
    await createImportBatch(ctx, { name: 'Orc', recipeId, files: [], pastes: [{ name: 'orc', text: '## Orc\nMedium Humanoid, Chaotic Evil\nAC 13\nHP 15 (2d8 + 6)' }] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(ctx, batchId)
    await generateDrafts(ctx, batchId, { mode: 'structural', wait: true })
    const item = batchView(ctx, batchId).items.find((i) => i.title === 'Orc')!
    const draft = ctx.repos.drafts.getByJob(item.jobId!)!
    const { saveDraft } = await import('@/server/services/drafts')
    const page = { ...draft.page, fields: draft.page.fields.map((f) => (f.key === 'speed' ? { ...f, value: '30 ft.', status: 'uncertain' as const } : f)) }
    await saveDraft(ctx, draft.id, page, draft.revision)
    await approveItems(ctx, batchId, { itemIds: [item.id], acknowledgeWarnings: false, wait: true })
    let after = batchView(ctx, batchId).items.find((i) => i.id === item.id)!
    expect(after.status).toBe('awaiting_review')
    expect(after.error).toMatch(/warnings/)
    expect(ctx.repos.drafts.getByJob(item.jobId!)!.approvalToken).toBeNull()
    await approveItems(ctx, batchId, { itemIds: [item.id], acknowledgeWarnings: true, wait: true })
    after = batchView(ctx, batchId).items.find((i) => i.id === item.id)!
    expect(after.status).toBe('approved')
    // Editing an approved draft withdraws the approval.
    const fresh = ctx.repos.drafts.getByJob(item.jobId!)!
    await saveDraft(ctx, fresh.id, { ...fresh.page, name: 'Orc Raider' }, fresh.revision)
    after = batchView(ctx, batchId).items.find((i) => i.id === item.id)!
    expect(after.status).toBe('awaiting_review')
    expect(after.error).toMatch(/changed after approval/)
  })

  it('handles partial failures, uncertain writes and retries without duplicates', async () => {
    await createImportBatch(ctx, { name: 'Goblinoids', recipeId, files: [{ bytes: utf8(BESTIARY), fileName: 'goblinoids.md', mimeType: 'text/markdown' }], pastes: [] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(ctx, batchId)
    await generateDrafts(ctx, batchId, { mode: 'structural', wait: true })
    let view = batchView(ctx, batchId)
    decideItems(ctx, batchId, [view.items.find((i) => i.title === 'Bugbear Lurker')!.id], 'skip')
    ctx.lk.createBehaviorByName.set('Goblin Underboss', 'validation_error')
    ctx.lk.createBehaviorByName.set('Hobgoblin Drillmaster', 'apply_then_connection_error')
    await approveItems(ctx, batchId, { itemIds: view.items.map((i) => i.id), acknowledgeWarnings: true, wait: true })
    await runBatch(ctx, batchId, { wait: true })
    view = batchView(ctx, batchId)
    const goblin = view.items.find((i) => i.title === 'Goblin Underboss')!
    const hob = view.items.find((i) => i.title === 'Hobgoblin Drillmaster')!
    expect(goblin.status).toBe('failed')
    expect(goblin.error).toMatch(/refused/)
    // The reply was lost, but the page was created: the app checked by reading and found it.
    expect(hob.status).toBe('succeeded')
    expect([...ctx.lk.resources.values()].filter((r) => r.name === 'Hobgoblin Drillmaster')).toHaveLength(1)

    // Retrying a failed write needs a new approval; it is never re-sent on its own.
    ctx.lk.createBehaviorByName.delete('Goblin Underboss')
    retryItems(ctx, batchId, [goblin.id])
    expect(batchView(ctx, batchId).items.find((i) => i.id === goblin.id)!.status).toBe('awaiting_review')
    await expect(runBatch(ctx, batchId, { wait: true })).rejects.toThrow(/no approved records/)
    await approveItems(ctx, batchId, { itemIds: [goblin.id], acknowledgeWarnings: true, wait: true })
    await runBatch(ctx, batchId, { wait: true })
    expect(batchView(ctx, batchId).items.find((i) => i.id === goblin.id)!.status).toBe('succeeded')
    expect([...ctx.lk.resources.values()].filter((r) => r.name === 'Goblin Underboss')).toHaveLength(1)
  })

  it('reconciles an uncertain write by reading before anything else', async () => {
    await createImportBatch(ctx, { name: 'Orc', recipeId, files: [], pastes: [{ name: 'orc', text: '## Orc\nMedium Humanoid, Chaotic Evil\nAC 13\nHP 15 (2d8 + 6)' }] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(ctx, batchId)
    await generateDrafts(ctx, batchId, { mode: 'structural', wait: true })
    const item = batchView(ctx, batchId).items.find((i) => i.title === 'Orc')!
    ctx.lk.createBehavior = 'server_error_before_apply'
    await approveItems(ctx, batchId, { itemIds: [item.id], acknowledgeWarnings: true, wait: true })
    await runBatch(ctx, batchId, { wait: true })
    // Server error, and the page does not exist: confirmed by reading, so it is safe to approve again.
    expect(batchView(ctx, batchId).items.find((i) => i.id === item.id)!.status).toBe('failed')
    expect(cancelBatch(ctx, batchId).batch.status).toBe('cancelled')
    expect(ctx.lk.resources.size).toBe(2)
  })

  it('treats interrupted writes as needing reconciliation', async () => {
    await createImportBatch(ctx, { name: 'Orc', recipeId, files: [], pastes: [{ name: 'orc', text: '## Orc\nMedium Humanoid, Chaotic Evil\nAC 13\nHP 15 (2d8 + 6)' }] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(ctx, batchId)
    await generateDrafts(ctx, batchId, { mode: 'structural', wait: true })
    const item = batchView(ctx, batchId).items.find((i) => i.title === 'Orc')!
    await approveItems(ctx, batchId, { itemIds: [item.id], acknowledgeWarnings: true, wait: true })
    // Simulate a crash in the middle of the write: the page was created, the app never heard back.
    const draft = ctx.repos.drafts.getByJob(item.jobId!)!
    const { approveWrite } = await import('@/server/services/write')
    ctx.lk.createBehavior = 'apply_then_connection_error'
    ctx.repos.batchItems.update(item.id, { status: 'running' })
    await approveWrite(ctx, draft.id, { approvalToken: draft.approvalToken!, acknowledgeWarnings: true }).catch(() => null)
    ctx.repos.drafts.setStatus(draft.id, 'writing')
    ctx.repos.batchItems.markInterrupted()
    expect(ctx.repos.batchItems.get(item.id)!.status).toBe('needs_reconciliation')
    expect(() => cancelBatch(ctx, batchId)).toThrow(/unknown outcome/)
    await reconcileBatch(ctx, batchId)
    expect(ctx.repos.batchItems.get(item.id)!.status).toBe('succeeded')
    expect([...ctx.lk.resources.values()].filter((r) => r.name === 'Orc')).toHaveLength(1)
  })

  it('pins the recipe version for the whole batch', async () => {
    await createImportBatch(ctx, { name: 'Orc', recipeId, files: [], pastes: [{ name: 'orc', text: '## Orc\nMedium Humanoid, Chaotic Evil\nAC 13\nHP 15 (2d8 + 6)' }] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    const recipe = ctx.repos.recipes.get(recipeId)!
    updateRecipe(ctx, recipeId, { ...recipe.definition, defaultValues: [{ fieldKey: 'edition', value: 'CHANGED' }] }, recipe.version)
    extractBatchRecords(ctx, batchId)
    await generateDrafts(ctx, batchId, { mode: 'structural', wait: true })
    const view = batchView(ctx, batchId)
    expect(view.recipe).toMatchObject({ version: 1, latestVersion: 2 })
    const draft = ctx.repos.drafts.getByJob(view.items.find((i) => i.title === 'Orc')!.jobId!)!
    expect(draft.recipeVersion).toBe(1)
    expect(draft.page.fields.find((f) => f.key === 'edition')!.value).toBe('5e (2024)')
  })

  it('applies the skip_exact policy to verified duplicates only', async () => {
    const s = await setup({ duplicatePolicy: 'skip_exact', existing: [{ id: 'ex000001', name: 'Bugbear Lurker', tags: ['Monster'], parentId: 'sandbox0001' }, { id: 'ex000002', name: 'goblin underboss', tags: [] }] })
    await createImportBatch(s.ctx, { name: 'Goblinoids', recipeId: s.recipe.id, files: [{ bytes: utf8(BESTIARY), fileName: 'g.md', mimeType: null }], pastes: [] })
    const batchId = s.ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(s.ctx, batchId)
    await generateDrafts(s.ctx, batchId, { mode: 'structural', wait: true })
    const view = batchView(s.ctx, batchId)
    const byTitle = Object.fromEntries(view.items.map((i) => [i.title, i]))
    expect(byTitle['Bugbear Lurker']!.status).toBe('skipped')
    expect(byTitle['Goblin Underboss']!.status).toBe('awaiting_review') // only a strong (case-insensitive) match
    expect((byTitle['Goblin Underboss']!.match as { category: string }).category).toBe('strong')
  })

  it('transcribes an image only on request, with the AI provider, and keeps the uncertainty', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    let view = await createImportBatch(ctx, { name: 'Scan', recipeId, files: [{ bytes: png, fileName: 'ogre.png', mimeType: 'image/png' }], pastes: [] })
    const source = view.sources[0]!
    expect(source.status).toBe('needs_transcription')
    expect(ctx.aiMock.transcriptions).toHaveLength(0)
    ctx.aiMock.nextTranscription = { markdown: '## Ogre\nLarge Giant, Chaotic Evil\nAC 11\nHP 68 (8d10 + 24) [?]', uncertainPassages: [{ text: '68', reason: 'smudged' }], suspectedInstructions: [], notes: [] }
    view = await transcribeSource(ctx, view.batch.id, source.id)
    expect(ctx.aiMock.transcriptions[0]).toMatchObject({ kind: 'image', mediaType: 'image/png' })
    const after = view.sources[0]!
    expect(after).toMatchObject({ status: 'extracted', method: 'ai_transcription', hasBlob: false })
    expect(after.warnings.join(' ')).toMatch(/Hard to read: “68”/)
    expect(view.usage.input).toBe(2000)
  })

  it('reuses an identical AI result instead of paying for it twice, and limits AI items per run', async () => {
    await createImportBatch(ctx, { name: 'Twins', recipeId, files: [], pastes: [{ name: 'a', text: '## Orc\nAC 13 HP 15 and more text' }, { name: 'b', text: '## Orc\nAC 13 HP 15 and more text' }] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(ctx, batchId)
    ctx.aiMock.next = aiOutput({ pageName: 'Orc', detectedPageType: 'creature' })
    const first = await generateDrafts(ctx, batchId, { mode: 'ai', wait: true })
    expect(first.deferred).toBe(0)
    // Redrafting the same records with the same recipe version, template and prompt reuses the stored AI results.
    const calls = ctx.aiMock.requests.length
    await generateDrafts(ctx, batchId, { mode: 'ai', regenerate: true, wait: true })
    expect(ctx.aiMock.requests.length).toBe(calls)
  })

  it('exports results as CSV without secrets and with spreadsheet formulas neutralised', async () => {
    await createImportBatch(ctx, { name: 'Formula', recipeId, files: [], pastes: [{ name: 'x', text: '## =HYPERLINK("http://evil")\nAC 13' }] })
    const batchId = ctx.repos.batches.list('import').items[0]!.id
    extractBatchRecords(ctx, batchId)
    const csv = exportBatch(ctx, batchId, { report: 'results', format: 'csv' }).body
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csv).not.toContain(ctx.settings.lk.apiKey!)
    expect(toCsv([{ a: 'x,y', b: null }])).toBe('a,b\r\n"x,y",\r\n')
  })
})
