import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { destinationType } from '@/core/destinations'
import { skeletonFromBlocks } from '@/core/lk-layout'
import { applySort, numberLines, sortChunks } from '@/core/sorting'
import { AiError } from '@/server/ai/provider'
import { BATCH_TIMING, waitForBatch } from '@/server/services/batch-engine'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { activeDestinations, listDestinations, setUpDestinations } from '@/server/services/destinations'
import { addSources, createChosenPages } from '@/server/services/import-batches'
import { addRecordFromLines, createSmartImport, setRecordDestination, smartView, continueSmartImport } from '@/server/services/smart-import'
import { aiOutput } from '../helpers/mock-ai'
import { createTestContext, utf8, type TestContext } from '../helpers/test-context'

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const statblockBlocks = (JSON.parse(fixture('lk-statblock-template.json')) as { blocks: unknown[] }).blocks

const kv = (keys: string[]) => ({ kind: 'keyValue', rows: keys.map((key) => ({ key, content: [] })) })
const characterBlocks = [
  { kind: 'infobox', rows: [kv(['Species', 'Gender', 'Age']), kv(['Titles', 'Professions']), kv(['Friends', 'Enemies']), kv(['Class'])] },
  { kind: 'textField', title: 'DESCRIPTION', isTitleHidden: false, children: [{ kind: 'paragraph', content: [] }] },
  { kind: 'textField', title: 'Notes', isTitleHidden: false, children: [{ kind: 'paragraph', content: [] }] },
  { kind: 'secret', children: [{ kind: 'paragraph', content: [] }] },
]
const classBlocks = [
  { kind: 'infobox', rows: [kv(['Hit Die', 'Primary Ability', 'Saving Throw Proficiencies'])] },
  { kind: 'textField', title: 'Class Features', isTitleHidden: false, children: [{ kind: 'paragraph', content: [{ text: 'Example' }] }] },
]

beforeAll(() => {
  BATCH_TIMING.writeSpacingMs = 0
  BATCH_TIMING.checkSpacingMs = 0
})

describe('page kinds from LegendKeeper templates', () => {
  it('matches a template to the built-in type it resembles, with its other rows as extra fields', () => {
    const statblock = destinationType('Statblock Template', skeletonFromBlocks(statblockBlocks).blocks)
    expect(statblock.pageType.id).toBe('creature')
    expect(statblock.custom).toBe(false)

    const character = destinationType('Character Template', characterBlocks)
    expect(character.pageType.id).toBe('npc')
    // Professions takes the occupation; Species the ancestry; the rest become fields of their own.
    expect(character.extraFields.map((f) => f.label)).toEqual(['Gender', 'Age', 'Titles', 'Friends', 'Enemies', 'Class'])
    expect(character.extraFields.map((f) => f.key)).toEqual(['gender', 'age', 'titles', 'friends', 'enemies', 'class'])
  })

  it('makes a page type from a template that resembles none', () => {
    const type = destinationType('Class Details Template', classBlocks)
    expect(type.custom).toBe(true)
    expect(type.pageType.id).toBe('tpl_class_details')
    expect(type.pageType.label).toBe('Class Details')
    expect(type.pageType.fields.map((f) => [f.key, f.label])).toEqual([
      ['hitDie', 'Hit Die'],
      ['primaryAbility', 'Primary Ability'],
      ['savingThrowProficiencies', 'Saving Throw Proficiencies'],
    ])
    expect(type.pageType.sections).toEqual(['Class Features'])
  })
})

describe('cutting a source by line numbers', () => {
  const text = ['Home | Shop | Login', '', '# Goblin', 'Small humanoid', 'AC 15', '', '# Elvera', 'Innkeeper of the Green Dragon.', '', 'Comments (3)', 'Great post!', 'Stray line'].join('\n')
  const lines = numberLines(text)

  it('keeps the source text exactly, clips bad ranges, and reports what nobody placed', () => {
    const result = applySort(
      lines,
      [
        {
          entries: [
            { title: 'Goblin', kind: 'k1', ranges: [{ from: 5, to: 3 }], confidence: 'high', why: 'statblock' },
            { title: 'Elvera', kind: 'K2', ranges: [{ from: 7, to: 900 }], confidence: 'medium', why: 'person' },
            { title: 'Ghost', kind: 'k9', ranges: [{ from: 50, to: 60 }], confidence: 'low', why: '?' },
          ],
          discarded: [
            { from: 1, to: 1, why: 'navigation' },
            { from: 10, to: 11, why: 'reader comments' },
          ],
        },
      ],
      new Map([
        ['k1', 'creature-key'],
        ['k2', 'npc-key'],
      ]),
    )
    expect(result.entries.map((e) => [e.title, e.destination, e.text])).toEqual([
      ['Goblin', 'creature-key', '# Goblin\nSmall humanoid\nAC 15'],
      ['Elvera', 'npc-key', '# Elvera\nInnkeeper of the Green Dragon.\n\nComments (3)\nGreat post!\nStray line'],
    ])
    // Lines an entry keeps are never discarded.
    expect(result.discarded.map((d) => [d.from, d.to, d.why])).toEqual([[1, 1, 'navigation']])
    expect(result.notes.join(' ')).toMatch(/k9.*Ghost|Ghost.*no lines/)
  })

  it('lists unplaced lines and unknown kinds as “other”', () => {
    const result = applySort(lines, [{ entries: [{ title: 'Goblin', kind: 'other', ranges: [{ from: 3, to: 5 }], confidence: 'low', why: '' }], discarded: [{ from: 1, to: 1, why: 'menu' }] }], new Map())
    expect(result.entries[0]!.destination).toBeNull()
    expect(result.unplaced.map((u) => [u.from, u.to])).toEqual([[7, 12]])
  })

  it('cuts long sources into parts for the AI, before headings', () => {
    const long = numberLines(Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? `# Part ${i}` : `Line ${i} ${'x'.repeat(50)}`)).join('\n'))
    const chunks = sortChunks(long, 800)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.flat().map((l) => l.n)).toEqual(long.map((l) => l.n))
    expect(chunks.slice(1).every((chunk) => chunk[0]!.text.startsWith('# '))).toBe(true)
  })
})

const WEB_PAGE = `Home | Monsters | Shop | Log in

# The Goblin and the Innkeeper

## Goblin

Small Humanoid (Goblinoid), Neutral Evil

AC 15
HP 7 (2d6)
Speed 30 ft.

## Elvera Tallowmere

Elvera runs the Green Dragon Inn in Hommlet.

### Secrets

She hides a map of the moathouse.

Share this: Facebook | Twitter
© 2026 Example Site. All rights reserved.`

async function setup(): Promise<TestContext> {
  const ctx = createTestContext({
    resources: [
      { id: 'statblk1', name: 'Statblock Template', parentId: 'templates', documents: [{ id: 'docst001', name: 'Main', type: 'page', blocks: statblockBlocks, version: 'v1', text: '' }] },
      { id: 'charact1', name: 'Character Template', parentId: 'templates', documents: [{ id: 'docch001', name: 'Main', type: 'page', blocks: characterBlocks, version: 'v1', text: '' }] },
      { id: 'sandbox0001', name: 'Sandbox' },
    ],
  })
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  return ctx
}

function scriptAi(ctx: TestContext) {
  ctx.aiMock.nextAnalysis.sort_source = (user: string) => {
    const code = (label: string) => new RegExp(`- (k\\d+): ${label}`).exec(user)![1]!
    return {
      entries: [
        { title: 'Goblin', kind: code('Statblock'), ranges: [{ from: 5, to: 11 }], confidence: 'high', why: 'A creature statblock.' },
        { title: 'Elvera Tallowmere', kind: code('Character'), ranges: [{ from: 13, to: 19 }], confidence: 'high', why: 'A person.' },
      ],
      discarded: [
        { from: 1, to: 1, why: 'site navigation' },
        { from: 21, to: 22, why: 'share buttons and copyright' },
      ],
      suspectedInstructions: [],
    }
  }
  ctx.aiMock.next = () => {
    const request = ctx.aiMock.requests.at(-1)!
    if (request.pageType.id === 'creature') {
      return aiOutput({
        pageName: 'Goblin',
        detectedPageType: 'creature',
        fields: [
          { key: 'armorClass', value: '15', status: 'source', sourceQuote: 'AC 15', note: null },
          { key: 'hitPoints', value: '7 (2d6)', status: 'source', sourceQuote: 'HP 7 (2d6)', note: null },
        ],
      })
    }
    return aiOutput({
      pageName: 'Elvera Tallowmere',
      fields: [{ key: 'residence', value: 'Hommlet', status: 'source', sourceQuote: 'in Hommlet', note: null }],
      sections: [
        { heading: 'Description', kind: 'lore', paragraphs: ['Elvera runs the Green Dragon Inn in Hommlet.'] },
        { heading: 'Secrets', kind: 'lore', paragraphs: ['She hides a map of the moathouse.'] },
      ],
    })
  }
}

describe('the import (sort, draft, check, create)', () => {
  it('sets up page kinds from the project’s templates (reads only)', async () => {
    const ctx = await setup()
    const writesBefore = ctx.lk.calls.filter((c) => /create|update|replace|delete|insert|assign/i.test(c.method)).length
    const { added, skipped } = await setUpDestinations(ctx)
    expect(skipped).toEqual([])
    expect(added.map((d) => [d.label, d.pageType, d.layout])).toEqual([
      ['Character', 'npc', 'exact'],
      ['Statblock', 'creature', 'fit'],
    ])
    expect(added.find((d) => d.label === 'Character')!.fields).toEqual(expect.arrayContaining(['Gender', 'Age', 'Friends']))
    expect(ctx.lk.calls.filter((c) => /create|update|replace|delete|insert|assign/i.test(c.method)).length).toBe(writesBefore)
    // Run again: nothing new.
    expect((await setUpDestinations(ctx)).added).toEqual([])
    expect(listDestinations(ctx)).toHaveLength(2)
  })

  it('without templates set up, offers the built-in page kinds', async () => {
    const ctx = await setup()
    expect(activeDestinations(ctx).map((d) => d.pageType)).toEqual(['npc', 'creature', 'location', 'magic_item', 'rule', 'historical_event'])
  })

  it('splits a web page into pages of different kinds, drops the clutter, and creates only what you choose', async () => {
    const ctx = await setup()
    await setUpDestinations(ctx)
    scriptAi(ctx)
    const created = await createSmartImport(ctx, { name: 'Web page', parentId: 'sandbox0001', files: [{ bytes: utf8(WEB_PAGE), fileName: 'goblin.md', mimeType: 'text/markdown' }], pastes: [] })
    await waitForBatch(created.batch.id)
    const view = smartView(ctx, created.batch.id)
    expect(view.batch.error).toBeNull()
    expect(view.pages.map((p) => [p.title, p.destination?.label, p.status])).toEqual([
      ['Goblin', 'Statblock', 'awaiting_review'],
      ['Elvera Tallowmere', 'Character', 'awaiting_review'],
    ])
    expect(view.state.sources[0]!.discarded.map((d) => d.why)).toEqual(['site navigation', 'share buttons and copyright'])
    expect(view.state.sources[0]!.unplaced.map((u) => u.preview)).toEqual(['# The Goblin and the Innkeeper'])
    // Only the AI's line numbers were used: each page's source is the page's own lines.
    const transformSources = ctx.aiMock.requests.map((r) => r.sourceText)
    expect(transformSources[0]).toContain('AC 15')
    expect(transformSources.join('\n')).not.toMatch(/Log in|rights reserved/)
    // Checked like a final preview, nothing written yet.
    expect(view.pages.every((p) => p.checked)).toBe(true)
    expect(view.totals.ready).toBe(2)
    expect(ctx.lk.calls.some((c) => c.method === 'createFromTemplate' || c.method === 'createPage')).toBe(false)

    // Create just the goblin.
    const goblin = view.pages.find((p) => p.title === 'Goblin')!
    await createChosenPages(ctx, created.batch.id, { itemIds: [goblin.id], includeWarnings: true, wait: true })
    const after = smartView(ctx, created.batch.id)
    expect(after.pages.find((p) => p.title === 'Goblin')!.status).toBe('succeeded')
    expect(after.pages.find((p) => p.title === 'Elvera Tallowmere')!.status).toBe('awaiting_review')
    expect(ctx.lk.calls.filter((c) => c.method === 'createFromTemplate')).toHaveLength(1)

    // Elvera's secrets go inside the Character template's secret block.
    await createChosenPages(ctx, created.batch.id, { itemIds: [after.pages.find((p) => p.title === 'Elvera Tallowmere')!.id], includeWarnings: true, wait: true })
    const elvera = smartView(ctx, created.batch.id).pages.find((p) => p.title === 'Elvera Tallowmere')!
    expect(elvera.status).toBe('succeeded')
    const page = ctx.lk.resources.get(elvera.resourceId!)!
    const secret = (page.documents[0]!.blocks as { kind: string; children?: unknown[] }[]).find((b) => b.kind === 'secret')!
    expect(JSON.stringify(secret)).toContain('She hides a map of the moathouse.')
    expect(JSON.stringify(page.documents[0]!.blocks.filter((b) => (b as { kind: string }).kind !== 'secret'))).not.toContain('moathouse')
  })

  it('lets you change a page’s kind, or make a page from unplaced lines', async () => {
    const ctx = await setup()
    await setUpDestinations(ctx)
    scriptAi(ctx)
    const created = await createSmartImport(ctx, { name: 'Web page', parentId: 'sandbox0001', files: [], pastes: [{ name: 'Page', text: WEB_PAGE, format: 'markdown' }] })
    await waitForBatch(created.batch.id)
    const view = smartView(ctx, created.batch.id)
    const statblock = view.destinations.find((d) => d.label === 'Statblock')!
    const elvera = view.pages.find((p) => p.title === 'Elvera Tallowmere')!
    setRecordDestination(ctx, created.batch.id, elvera.id, statblock.key)
    addRecordFromLines(ctx, created.batch.id, { sourceId: view.sources[0]!.id, from: 3, to: 3, title: 'Intro', key: statblock.key })
    await continueSmartImport(ctx, created.batch.id, { wait: true })
    const after = smartView(ctx, created.batch.id)
    expect(after.pages.map((p) => [p.title, p.destination?.label])).toEqual([
      ['Goblin', 'Statblock'],
      ['Goblin', 'Statblock'],
      ['Goblin', 'Statblock'],
    ])
    expect(after.state.sources[0]!.unplaced).toEqual([])
  })

  it('sorts without AI by headings, and reports an AI failure on the import', async () => {
    const ctx = await setup()
    await setUpDestinations(ctx)
    const rules = await createSmartImport(ctx, { name: 'No AI', mode: 'rules', files: [], pastes: [], start: false })
    await addSources(ctx, ctx.repos.batches.get(rules.batch.id)!, null, [], [{ name: 'Page', text: WEB_PAGE, format: 'markdown' }])
    const { startSmartImport } = await import('@/server/services/smart-import')
    await startSmartImport(ctx, rules.batch.id, { wait: true })
    const view = smartView(ctx, rules.batch.id)
    expect(view.pages.map((p) => p.title)).toEqual(['Goblin', 'Elvera Tallowmere'])
    expect(ctx.aiMock.analysisRequests).toHaveLength(0)

    ctx.aiMock.nextAnalysis.sort_source = new AiError('rate_limited', 'The free-model limit was reached.')
    const failing = await createSmartImport(ctx, { name: 'AI', files: [], pastes: [{ name: 'Page', text: WEB_PAGE, format: 'markdown' }] })
    await waitForBatch(failing.batch.id)
    expect(smartView(ctx, failing.batch.id).batch.error).toMatch(/free-model limit/)
  })
})
