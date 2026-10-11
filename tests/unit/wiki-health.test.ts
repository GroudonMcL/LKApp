import { beforeAll, describe, expect, it } from 'vitest'
import { h, infobox, keyValue, mention, p, property, textField } from '@legendkeeper/sdk/blocks'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { createRecipe } from '@/server/services/recipes'
import { AUDIT_TIMING, healthDashboard, listFindings, startAudit, updateFindings } from '@/server/services/wiki-health'
import { createTestContext } from '../helpers/test-context'

beforeAll(() => {
  AUDIT_TIMING.readSpacingMs = 0
})

const doc = (id: string, blocks: unknown[], version = 'v1') => [{ id: `doc_${id}`, name: 'Main', type: 'page', blocks, version, text: '' }]

const creatureBlocks = (opts: { ac?: boolean; link?: string } = {}) => [
  infobox([property(keyValue([...(opts.ac === false ? [] : [['Armour Class', '15'] as [string, string]]), ['Hit Points', '20 (3d8)']]), { title: 'Stats' })]),
  textField([p(opts.link ? [{ text: 'Rival of ' }, ...mention({ resourceId: opts.link, text: 'Someone' })] : 'A creature.')], { title: 'Traits' }),
]

async function setup() {
  const ctx = createTestContext({
    resources: [
      { id: 'r_untag', name: 'Lonely Page', tags: [], documents: doc('r_untag', [p('Nothing.')]) },
      { id: 'r_m1', name: 'Ogre', tags: ['Monster'], documents: doc('r_m1', creatureBlocks()) },
      { id: 'r_m2', name: 'Troll', tags: ['monster'], documents: doc('r_m2', creatureBlocks({ ac: false })) },
      { id: 'r_m3', name: 'Ghoul', tags: ['Monsters'], documents: doc('r_m3', creatureBlocks({ link: 'gone0001' })) },
      { id: 'r_m4', name: 'Old Wight', tags: ['Monster'], documents: doc('r_m4', [h(2, 'Wight'), p('AC 14. HP 45.')]) },
      { id: 'r_e1', name: 'Some Entity', tags: ['Entitiyy'], documents: doc('r_e1', [p('x')]) },
      { id: 'r_e2', name: 'Other Entity', tags: ['Entity'], documents: doc('r_e2', [p('x')]) },
      { id: 'r_h1', name: 'Hommlet', tags: ['Location'], documents: doc('r_h1', [p('A village.')]) },
      { id: 'r_h2', name: 'Hommlet', tags: ['Adventure'], documents: doc('r_h2', [p('An adventure.')]) },
      { id: 'r_sp', name: 'Spacey  Name ', tags: ['Location'], documents: doc('r_sp', [p('x')]) },
      { id: 'r_bad', name: 'Broken Page', tags: ['Location'], documents: doc('r_bad', [p('x')]) },
      { id: 'tpl00001', name: 'Statblock', tags: [], parentId: 'templates', documents: doc('tpl00001', [p('template')]) },
    ],
  })
  ctx.lk.failDocuments.add('r_bad')
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  createRecipe(ctx, { name: 'Creatures', targetPageType: 'creature', requiredFields: ['armorClass', 'hitPoints'], attribution: { required: false } })
  return ctx
}

const byCategory = (items: { category: string; resourceId: string | null; title: string }[]) => {
  const out: Record<string, string[]> = {}
  for (const f of items) (out[f.category] ??= []).push(f.title)
  return out
}

describe('wiki health audit', () => {
  it('reports untagged pages, tag variants, duplicates, names, missing fields, broken links and unreadable pages — read-only', async () => {
    const ctx = await setup()
    await startAudit(ctx, { mode: 'all' }, { wait: true })
    const findings = listFindings(ctx, { limit: 500 }).items
    const cats = byCategory(findings)
    // Templates are not pages: the Statblock template is not reported as untagged.
    expect(cats.untagged).toEqual(['“Lonely Page” has no tags'])
    expect(cats.tags!.join(' ')).toMatch(/“monster”.*“Monster”/)
    expect(cats.tags!.join(' ')).toMatch(/Monsters/)
    expect(cats.tags!.join(' ')).toMatch(/Entitiyy/)
    const hommlet = findings.find((f) => f.category === 'duplicates')!
    expect(hommlet.certainty).toBe('possible') // different kinds of page share the name
    expect(cats.naming!.join(' ')).toMatch(/stray spaces/)
    expect(cats.missing_fields).toEqual(['“Troll” seems to lack Armor Class'])
    expect(cats.broken_links).toEqual(['“Ghoul” links to 1 page(s) that were not found'])
    expect(cats.unreadable).toEqual(['“Broken Page” could not be read'])
    // Untagged is definite; a layout difference is never definite.
    expect(findings.find((f) => f.category === 'untagged')!.certainty).toBe('definite')
    expect(ctx.lk.callCount('createPage')).toBe(0)
    const dash = healthDashboard(ctx)
    expect(dash.indexed).toBe(11)
    expect(dash.untaggedInIndex).toBe(1)
    expect(dash.runs[0]!.status).toBe('completed')
  })

  it('keeps dismissed findings quiet until the page changes, and resolves fixed ones', async () => {
    const ctx = await setup()
    await startAudit(ctx, { mode: 'all' }, { wait: true })
    const troll = listFindings(ctx, { categories: ['missing_fields'] }).items[0]!
    updateFindings(ctx, { ids: [troll.id], status: 'intentional', note: 'House-ruled' })
    await startAudit(ctx, { mode: 'all' }, { wait: true })
    expect(listFindings(ctx, { categories: ['missing_fields'] }).items).toHaveLength(0)
    expect(listFindings(ctx, { categories: ['missing_fields'], statuses: ['intentional'] }).items).toHaveLength(1)

    // The page is edited (new document version): the finding comes back with an explanation.
    ctx.lk.resources.get('r_m2')!.documents[0]!.version = 'v2'
    await startAudit(ctx, { mode: 'all' }, { wait: true })
    const reopened = listFindings(ctx, { categories: ['missing_fields'] }).items[0]!
    expect(reopened.statusNote).toMatch(/changed after it was marked intentional/)

    // The broken link is fixed: the next audit marks it resolved.
    ctx.lk.resources.get('r_m3')!.documents[0]!.blocks = creatureBlocks()
    ctx.lk.resources.get('r_m3')!.documents[0]!.version = 'v2'
    await startAudit(ctx, { mode: 'all' }, { wait: true })
    expect(listFindings(ctx, { categories: ['broken_links'] }).items).toHaveLength(0)
    expect(listFindings(ctx, { categories: ['broken_links'], statuses: ['resolved'] }).items).toHaveLength(1)
  })

  it('audits a scope only, without touching findings outside it, and can repeat previous problems', async () => {
    const ctx = await setup()
    await startAudit(ctx, { mode: 'all' }, { wait: true })
    const before = ctx.lk.callCount('getDocumentContent')
    await startAudit(ctx, { mode: 'criteria', criteria: { tag: 'Location' } }, { wait: true })
    expect(ctx.lk.callCount('getDocumentContent') - before).toBe(3)
    expect(listFindings(ctx, { categories: ['untagged'] }).items).toHaveLength(1) // not resolved by an unrelated scope
    const reads = ctx.lk.callCount('getDocumentContent')
    await startAudit(ctx, { mode: 'open_findings', readContent: false }, { wait: true })
    expect(ctx.lk.callCount('getDocumentContent')).toBe(reads) // used what earlier audits read
  })

  it('flags pages that differ from a copied LegendKeeper layout as possible, never definite', async () => {
    const ctx = await setup()
    const { copyLayoutFromLegendKeeper } = await import('@/server/services/lk-templates')
    ctx.lk.add({ id: 'l1ylm24t', name: 'Statblock', parentId: 'templates', documents: doc('l1ylm24t', creatureBlocks()) })
    await copyLayoutFromLegendKeeper(ctx, { resource: 'l1ylm24t', pageType: 'creature', createRecipe: false })
    await startAudit(ctx, { mode: 'page_types', pageTypes: ['creature'] }, { wait: true })
    const template = listFindings(ctx, { categories: ['template'] }).items
    expect(template.map((f) => f.resourceName)).toEqual(['Old Wight'])
    expect(template[0]!.certainty).toBe('likely')
    expect(template[0]!.explanation).toMatch(/may be intentional/)
  })
})
