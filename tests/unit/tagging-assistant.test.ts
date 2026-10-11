import { beforeAll, describe, expect, it } from 'vitest'
import { p } from '@legendkeeper/sdk/blocks'
import { applyTagChanges, existingTagMap, suggestTagsForPage, TaxonomyConfig, type TagPageInput } from '@/core/tag-assistant'
import { BUILT_IN_PAGE_TYPES } from '@/core/page-types'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { BATCH_TIMING } from '@/server/services/batch-engine'
import {
  approveTagging,
  createTaggingBatch,
  dryRunTagging,
  exportTagging,
  reconcileTagging,
  retryTagging,
  runTagging,
  saveTaxonomy,
  selectSuggestions,
  suggestTagging,
  taggingView,
} from '@/server/services/tagging-batches'
import { createTestContext } from '../helpers/test-context'

beforeAll(() => {
  BATCH_TIMING.writeSpacingMs = 0
  BATCH_TIMING.checkSpacingMs = 0
})

const existing = existingTagMap([
  { tag: 'Location', count: 40 },
  { tag: 'Saltmarsh', count: 12 },
  { tag: 'Haunted', count: 3 },
  { tag: 'NPC', count: 50 },
  { tag: 'Monster', count: 20 },
])
const page = (patch: Partial<TagPageInput> = {}): TagPageInput => ({
  id: 'p1',
  name: 'The Haunted House',
  parentId: 'salt',
  tags: [],
  ancestors: [{ id: 'world', name: 'Flanaess' }, { id: 'salt', name: 'Saltmarsh' }],
  siblingTags: [['Location', 'Saltmarsh'], ['Location', 'Saltmarsh'], ['Location']],
  linkedNames: [],
  text: 'An abandoned house on the cliffs, said to be haunted by smugglers.',
  ...patch,
})
const config = (input: Partial<TaxonomyConfig> = {}) => TaxonomyConfig.parse(input)

describe('tag suggestions', () => {
  it('suggests existing tags from the folder and siblings, with reasons, pre-selecting only sure ones', () => {
    const s = suggestTagsForPage(page(), { existing, pageTypes: BUILT_IN_PAGE_TYPES, config: config() })
    const byTag = Object.fromEntries(s.map((x) => [x.tag, x]))
    expect(byTag.Saltmarsh).toMatchObject({ source: 'folder', certainty: 'likely', existence: 'existing', selected: true })
    expect(byTag.Saltmarsh!.reason).toMatch(/inside “Saltmarsh”/)
    expect(byTag.Location).toMatchObject({ source: 'siblings', existence: 'existing' })
  })

  it('suggests an existing tag named in the page name or opening lines, as possible and unticked', () => {
    const s = suggestTagsForPage(page({ name: 'Old Mara', ancestors: [], siblingTags: [], text: 'An NPC who leads the village council. ' + 'x '.repeat(200) + 'Monster' }), { existing, pageTypes: BUILT_IN_PAGE_TYPES, config: config() })
    expect(s.find((x) => x.tag === 'NPC')).toMatchObject({ source: 'text', certainty: 'possible', selected: false, existence: 'existing' })
    // Only the opening is read for this, so a word far down the page is ignored.
    expect(s.find((x) => x.tag === 'Monster')).toBeUndefined()
    // The haunted house names “Haunted” in its title.
    expect(suggestTagsForPage(page(), { existing, pageTypes: BUILT_IN_PAGE_TYPES, config: config() }).find((x) => x.tag === 'Haunted')).toMatchObject({ source: 'text', selected: false })
  })

  it('policy A refuses new tags; policy B allows them but never pre-selects them', () => {
    const rule = { when: { nameContains: 'house' }, add: ['Smugglers'] }
    const a = suggestTagsForPage(page(), { existing, pageTypes: BUILT_IN_PAGE_TYPES, config: config({ rules: [rule] as never }) })
    expect(a.find((x) => x.tag === 'Smugglers')).toMatchObject({ existence: 'new', refused: expect.stringMatching(/existing tags only/), selected: false })
    const b = suggestTagsForPage(page(), { existing, pageTypes: BUILT_IN_PAGE_TYPES, config: config({ policy: 'allow_new', rules: [rule] as never }) })
    expect(b.find((x) => x.tag === 'Smugglers')).toMatchObject({ existence: 'new', refused: null, selected: false, certainty: 'definite' })
  })

  it('policy C uses the approved taxonomy, its aliases and page-type limits, and flags tags outside it', () => {
    const c = config({
      policy: 'approved_taxonomy',
      approved: [
        { tag: 'Haunted', aliases: ['Spooky'], pageTypes: ['location'], category: 'Subject' },
        { tag: 'Location', aliases: ['Locations'], category: 'Type' },
        { tag: 'Undead', aliases: [], pageTypes: ['creature'] },
      ] as never,
    })
    const s = suggestTagsForPage(page({ tags: ['Location', 'spooky place'], text: 'A spooky place full of undead.' }), { existing, pageTypes: BUILT_IN_PAGE_TYPES, config: c })
    expect(s.find((x) => x.tag === 'Haunted' && x.action === 'add')).toMatchObject({ source: 'text', refused: null })
    expect(s.find((x) => x.tag === 'Undead')).toMatchObject({ refused: expect.stringMatching(/limits “Undead” to creature/) })
    expect(s.find((x) => x.tag === 'Saltmarsh')!.refused).toMatch(/approved taxonomy/)
    expect(s.find((x) => x.tag === 'spooky place' && x.action === 'remove')).toMatchObject({ reason: 'Not in your approved taxonomy.', selected: false })
  })

  it('never merges tags; flags duplicates and plurals already on a page; never pre-selects removals', () => {
    const s = suggestTagsForPage(page({ tags: ['Monster', 'monster', 'Monsters'] }), { existing, pageTypes: BUILT_IN_PAGE_TYPES, config: config() })
    const removals = s.filter((x) => x.action === 'remove')
    expect(removals.map((r) => r.tag).sort()).toEqual(['Monsters', 'monster'])
    expect(removals.every((r) => !r.selected)).toBe(true)
  })

  it('applies only selected changes and keeps every other existing tag, in order', () => {
    const changes = [
      { tag: 'Saltmarsh', action: 'add', selected: true, refused: null },
      { tag: 'Haunted', action: 'add', selected: false, refused: null },
      { tag: 'Old', action: 'remove', selected: true, refused: null },
      { tag: 'Keep', action: 'remove', selected: false, refused: null },
    ] as never
    expect(applyTagChanges(['Location', 'Old', 'Keep'], changes)).toEqual(['Location', 'Keep', 'Saltmarsh'])
  })
})

async function setup() {
  const ctx = createTestContext({
    resources: [
      { id: 'world001', name: 'Flanaess', tags: ['Region'] },
      { id: 'salt0001', name: 'Saltmarsh', tags: ['Location', 'Saltmarsh'], parentId: 'world001' },
      { id: 'tav00001', name: 'The Wicker Goat', tags: ['Location', 'Saltmarsh'], parentId: 'salt0001' },
      { id: 'tav00002', name: 'The Empty Net', tags: ['Location', 'Saltmarsh'], parentId: 'salt0001' },
      { id: 'tav00003', name: 'Saltmarsh Docks', tags: ['Location', 'Saltmarsh'], parentId: 'salt0001' },
      { id: 'hau00001', name: 'The Haunted House', tags: [], parentId: 'salt0001', documents: [{ id: 'doc_h', name: 'Main', type: 'page', blocks: [p('A house said to be haunted.')], version: 'v1', text: '' }] },
      { id: 'npc00001', name: 'Eliander', tags: ['NPC'], parentId: 'salt0001' },
    ],
  })
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  return ctx
}

describe('tagging jobs', () => {
  it('suggests, needs approval, applies by merging with current tags, and reads back', async () => {
    const ctx = await setup()
    let view = await createTaggingBatch(ctx, { name: 'Untagged', scope: { mode: 'untagged' } })
    const batchId = view.batch.id
    expect(view.items.map((i) => i.title)).toEqual(['The Haunted House'])
    await expect(runTagging(ctx, batchId, { wait: true })).rejects.toThrow(/no approved pages/)

    await suggestTagging(ctx, batchId, { wait: true })
    view = taggingView(ctx, batchId)
    const item = view.items[0]!
    expect(item.status).toBe('awaiting_review')
    // Folder match is likely (pre-selected); 3 of 4 neighbours having "Location" is only possible (not pre-selected).
    expect(item.plan!.suggestions.filter((s) => s.selected).map((s) => s.tag)).toEqual(['Saltmarsh'])
    expect(item.plan!.suggestions.find((s) => s.tag === 'Location')).toMatchObject({ certainty: 'possible', selected: false })
    selectSuggestions(ctx, batchId, { itemId: item.id, selections: [{ tag: 'Location', action: 'add', selected: true }] })
    expect(ctx.lk.callCount('updateResourceTags')).toBe(0)

    approveTagging(ctx, batchId, { itemIds: [item.id], approveNewTags: false })
    await dryRunTagging(ctx, batchId, { wait: true })
    const report = JSON.parse(exportTagging(ctx, batchId, { report: 'dry_run', format: 'json' }).body)
    expect(report.entries[0].add.sort()).toEqual(['Location', 'Saltmarsh'])
    expect(report.entries[0].canProceed).toBe(true)
    expect(ctx.lk.callCount('updateResourceTags')).toBe(0)

    await runTagging(ctx, batchId, { wait: true })
    expect([...ctx.lk.resources.get('hau00001')!.tags].sort()).toEqual(['Location', 'Saltmarsh'])
    expect(taggingView(ctx, batchId).items[0]!.status).toBe('succeeded')
  })

  it('refreshes instead of writing when the page’s tags changed after the suggestion', async () => {
    const ctx = await setup()
    const batchId = (await createTaggingBatch(ctx, { name: 'Untagged', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    const item = taggingView(ctx, batchId).items[0]!
    selectSuggestions(ctx, batchId, { itemId: item.id, selections: [{ tag: 'Location', action: 'add', selected: true }] })
    approveTagging(ctx, batchId, { itemIds: [item.id], approveNewTags: false })
    ctx.lk.resources.get('hau00001')!.tags = ['Haunted']
    await runTagging(ctx, batchId, { wait: true })
    const after = taggingView(ctx, batchId).items[0]!
    expect(after.status).toBe('awaiting_review')
    expect(after.error).toMatch(/changed in LegendKeeper/)
    expect(after.plan!.before).toEqual(['Haunted'])
    expect(ctx.lk.callCount('updateResourceTags')).toBe(0)
    // Approving again applies on top of the current tags.
    approveTagging(ctx, batchId, { itemIds: [item.id], approveNewTags: false })
    await runTagging(ctx, batchId, { wait: true })
    // The tag added in LegendKeeper meanwhile is kept, first, untouched.
    expect(ctx.lk.resources.get('hau00001')!.tags).toEqual(['Haunted', 'Saltmarsh', 'Location'])
  })

  it('needs explicit approval for new tags', async () => {
    const ctx = await setup()
    saveTaxonomy(ctx, { policy: 'allow_new', rules: [{ when: { nameContains: 'haunted' }, add: ['Ghost Story'] }] })
    const batchId = (await createTaggingBatch(ctx, { name: 'New', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    const item = taggingView(ctx, batchId).items[0]!
    selectSuggestions(ctx, batchId, { itemId: item.id, selections: [{ tag: 'Ghost Story', action: 'add', selected: true }] })
    approveTagging(ctx, batchId, { itemIds: [item.id], approveNewTags: false })
    expect(taggingView(ctx, batchId).items[0]).toMatchObject({ status: 'awaiting_review', error: expect.stringMatching(/new tag/) })
    approveTagging(ctx, batchId, { itemIds: [item.id], approveNewTags: true })
    await runTagging(ctx, batchId, { wait: true })
    expect(ctx.lk.resources.get('hau00001')!.tags).toContain('Ghost Story')
  })

  it('reconciles an uncertain update by reading, and retries a failed one only after re-approval', async () => {
    const ctx = await setup()
    const batchId = (await createTaggingBatch(ctx, { name: 'U', scope: { mode: 'resources', resourceIds: ['hau00001', 'npc00001'] } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    const items = taggingView(ctx, batchId).items.filter((i) => i.status === 'awaiting_review')
    approveTagging(ctx, batchId, { itemIds: items.map((i) => i.id), approveNewTags: false })
    ctx.lk.tagUpdateBehavior.set('hau00001', 'apply_then_connection_error')
    ctx.lk.tagUpdateBehavior.set('npc00001', 'validation_error')
    await runTagging(ctx, batchId, { wait: true })
    let view = taggingView(ctx, batchId)
    expect(view.items.find((i) => i.resourceId === 'hau00001')!.status).toBe('needs_reconciliation')
    await reconcileTagging(ctx, batchId)
    view = taggingView(ctx, batchId)
    expect(view.items.find((i) => i.resourceId === 'hau00001')!.status).toBe('succeeded')
    const npc = view.items.find((i) => i.resourceId === 'npc00001')
    if (npc && npc.status === 'failed') {
      ctx.lk.tagUpdateBehavior.delete('npc00001')
      retryTagging(ctx, batchId, [npc.id])
      expect(taggingView(ctx, batchId).items.find((i) => i.id === npc.id)!.status).toBe('awaiting_review')
    }
    expect(ctx.lk.resources.get('npc00001')!.tags).toEqual(['NPC'])
  })

  it('uses AI suggestions only when switched on, limited by the policy, and reuses them for an unchanged page', async () => {
    const ctx = await setup()
    saveTaxonomy(ctx, { policy: 'existing_only', useAi: true })
    ctx.aiMock.nextTags = { suggestions: [{ tag: 'Location', reason: 'It is a place.', certainty: 'likely' }, { tag: 'Smuggling', reason: 'Smugglers.', certainty: 'possible' }], questionable: [], notes: [] }
    const batchId = (await createTaggingBatch(ctx, { name: 'AI', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, batchId, { wait: true })
    const item = taggingView(ctx, batchId).items[0]!
    expect(ctx.aiMock.tagRequests[0]!.allowedTags.map((t) => t.tag)).toContain('Saltmarsh')
    expect(item.plan!.suggestions.find((s) => s.tag === 'Smuggling')!.refused).toMatch(/existing tags only/)
    expect(item.plan!.suggestions.find((s) => s.tag === 'Location')!.reason).toMatch(/AI: It is a place/)
    // A second job on the same page version reuses the stored AI result.
    const second = (await createTaggingBatch(ctx, { name: 'AI 2', scope: { mode: 'untagged' } })).batch.id
    await suggestTagging(ctx, second, { wait: true })
    expect(ctx.aiMock.tagRequests).toHaveLength(1)
  })
})
