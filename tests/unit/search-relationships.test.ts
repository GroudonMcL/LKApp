import { describe, expect, it } from 'vitest'
import { advancedSearch, deleteSearch, saveSearch } from '@/server/services/advanced-search'
import { relationshipsFor } from '@/server/services/knowledge-analysis'
import { decide, listItems } from '@/server/services/knowledge-items'
import { runKnowledgeAnalysis } from '@/server/services/knowledge-analysis'
import { exportRelationships } from '@/server/services/phase3-exports'
import { startDiscovery } from '@/server/services/event-discovery'
import { IDS, greyhawkContext } from '../helpers/greyhawk-fixture'

const names = (r: { rows: { name: string }[] }) => r.rows.map((x) => x.name)

describe('combined search', () => {
  it('combines name, kind, tags, text, fields, dates, links and findings', async () => {
    const ctx = await greyhawkContext()
    expect(names(advancedSearch(ctx, 'proj_test', { q: 'sea princes' }))).toEqual(['Hold of the Sea Princes'])
    expect(names(advancedSearch(ctx, 'proj_test', { kind: 'person' }))).toEqual(['Kas', 'Prince Thrommel'])
    expect(names(advancedSearch(ctx, 'proj_test', { tags: 'Location', text: 'lendore' }))).toEqual(['Hold of the Sea Princes', 'Hommlet'])
    expect(names(advancedSearch(ctx, 'proj_test', { field: 'Born', fieldValue: '545' }))).toEqual(['Prince Thrommel'])
    expect(names(advancedSearch(ctx, 'proj_test', { dateFrom: 560, dateTo: 575 }))).toEqual(['Battle of Emridy Meadows'])
    expect(names(advancedSearch(ctx, 'proj_test', { linksTo: IDS.hommlet }))).toEqual(['Battle of Emridy Meadows'])
    expect(names(advancedSearch(ctx, 'proj_test', { linkedFrom: IDS.battle })).sort()).toEqual(['Hommlet', 'Prince Thrommel', 'Temple of Elemental Evil'])
    await runKnowledgeAnalysis(ctx, { checks: ['missing'] })
    expect(names(advancedSearch(ctx, 'proj_test', { findings: 'knowledge', kind: 'person' }))).toEqual(['Prince Thrommel'])
  })

  it('saves and deletes searches in the app only', async () => {
    const ctx = await greyhawkContext()
    const list = saveSearch(ctx, { name: 'Undated places', query: { kind: 'place', read: 'read' } })
    expect(list.map((s) => s.name)).toEqual(['Undated places'])
    expect(() => saveSearch(ctx, { name: 'Bad', query: { kind: 'dragon' } })).toThrow()
    expect(deleteSearch(ctx, list[0]!.id)).toEqual([])
  })
})

describe('relationship browser', () => {
  it('shows one page with its neighbours, separating LegendKeeper data, links, fields and inferred relationships', async () => {
    const ctx = await greyhawkContext()
    const view = relationshipsFor(ctx, 'proj_test', IDS.iuz)
    const supports = new Set(view.edges.map((e) => e.support))
    expect([...supports].sort()).toEqual(['text'])
    expect(view.edges[0]).toMatchObject({ direction: 'incoming', other: IDS.seaPrinces, type: 'worships' })
    expect(view.note).toMatch(/no backlinks endpoint/)
    const hommlet = relationshipsFor(ctx, 'proj_test', IDS.hommlet)
    expect(hommlet.edges.filter((e) => e.direction === 'incoming').map((e) => `${e.type}/${e.support}`).sort()).toEqual(['links_to/link', 'located_in/field'])
  })

  it('exports relationships marking which are explicitly supported and which are only suggested', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, { checks: ['relationships'] })
    const rel = listItems(ctx, { kinds: 'relationship' }).items[0]!
    decide(ctx, rel.id, { decision: 'accept' })
    const json = JSON.parse(exportRelationships(ctx, {}, 'json').body)
    const worship = json.relationships.find((r: { relationship: string }) => r.relationship === 'worships')
    expect(worship).toMatchObject({ explicit: false, support: 'text', decision: 'accepted', from: { id: IDS.seaPrinces }, to: { id: IDS.iuz } })
    const field = json.relationships.find((r: { support: string }) => r.support === 'field')
    expect(field).toMatchObject({ explicit: true })
    const csv = exportRelationships(ctx, { resourceId: IDS.iuz }, 'csv').body
    expect(csv.split('\r\n')[0]).toBe('from_id,from,relationship,to_id,to,support,explicitly_supported,decision,evidence_page_id,evidence_field,evidence_passage')
    expect(csv).toContain('no (suggested)')
  })
})

describe('review queue for chronology and analysis', () => {
  it('lists proposed events with their evidence and drops them once decided', async () => {
    const ctx = await greyhawkContext()
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const { reviewQueue } = await import('@/server/services/review-queue')
    const before = reviewQueue(ctx, { type: 'proposed_event' })
    expect(before.items.length).toBeGreaterThan(3)
    expect(before.items[0]!.href).toBe('/chronology/discover')
    const item = listItems(ctx, { kinds: 'event_candidate' }).items[0]!
    decide(ctx, item.id, { decision: 'defer' })
    expect(reviewQueue(ctx, { type: 'proposed_event' }).items.length).toBe(before.items.length - 1)
  })
})
