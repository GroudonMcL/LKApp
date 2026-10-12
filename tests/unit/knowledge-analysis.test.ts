import { describe, expect, it } from 'vitest'
import { AiError } from '@/server/ai/provider'
import { decide, listItems } from '@/server/services/knowledge-items'
import { compareWithAi, relationshipsFor, runKnowledgeAnalysis } from '@/server/services/knowledge-analysis'
import { draftFromItem } from '@/server/services/knowledge-drafts'
import { exportKnowledge } from '@/server/services/phase3-exports'
import { createRecipe } from '@/server/services/recipes'
import { reviewQueue } from '@/server/services/review-queue'
import { startAudit } from '@/server/services/wiki-health'
import { IDS, greyhawkContext } from '../helpers/greyhawk-fixture'

const items = (ctx: Awaited<ReturnType<typeof greyhawkContext>>, kinds: string) => listItems(ctx, { kinds, limit: 500 }).items

describe('knowledge analysis', () => {
  it('runs without changing LegendKeeper, and every finding cites its source', async () => {
    const ctx = await greyhawkContext()
    const before = ctx.lk.calls.length
    const { summary } = await runKnowledgeAnalysis(ctx, {})
    expect(summary.created).toBeGreaterThan(5)
    expect(ctx.lk.calls.length).toBe(before)
    for (const item of listItems(ctx, { limit: 500 }).items) {
      expect(item.evidence.length).toBeGreaterThan(0)
      for (const c of item.evidence) expect(c.resourceId).toMatch(/\S/)
    }
  })

  it('separates explicit relationships (links, fields, the page tree) from relationships inferred from wording', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, { checks: ['relationships'] })
    const view = relationshipsFor(ctx, 'proj_test', IDS.thrommel)
    const out = view.edges.filter((e) => e.direction === 'outgoing').map((e) => `${e.type}/${e.support}→${e.other}`)
    expect(out).toEqual(expect.arrayContaining([`member_of/field→${IDS.furyondy}`, `links_to/link→${IDS.furyondy}`]))
    const incoming = view.edges.filter((e) => e.direction === 'incoming').map((e) => `${e.type}/${e.support}←${e.other}`)
    expect(incoming).toContain(`links_to/link←${IDS.battle}`)
    // Inferred from wording: recorded as a suggestion, not a fact.
    const rel = items(ctx, 'relationship')
    expect(rel.map((r) => r.title)).toContain('Hold of the Sea Princes — worships — Iuz')
    expect(rel.find((r) => r.title.includes('worships'))).toMatchObject({ certainty: 'likely', data: { support: 'text' } })
    // "worship" never points at something that is not a deity.
    expect(rel.every((r) => !(r.data as { type: string }).type.includes('worships') || (r.data as { to: string }).to === IDS.iuz)).toBe(true)
  })

  it('finds pages that name another page without linking to it, skipping ambiguous names', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, { checks: ['links'] })
    const titles = items(ctx, 'link_suggestion').map((i) => i.title)
    expect(titles).toEqual(expect.arrayContaining(['Prince Thrommel names Battle of Emridy Meadows without linking to it', 'Iuz names Prince Thrommel without linking to it']))
    expect(titles.some((t) => t.startsWith('Battle of Emridy Meadows names Hommlet'))).toBe(false)
  })

  it('finds names used on several pages that have no page, and ignores one-off and generic names', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, { checks: ['missing'] })
    const missing = items(ctx, 'missing_page')
    expect(missing.map((m) => m.title)).toEqual(['Lendore Isles'])
    expect(missing[0]).toMatchObject({ certainty: 'likely', data: { kindGuess: 'place', pageCount: 3 } })
    expect(missing[0]!.evidence.map((e) => e.resourceName).sort()).toEqual(['Hold of the Sea Princes', 'Hommlet', 'Prince Thrommel'])
  })

  it('reports contradictions with both sides cited and no verdict', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, { checks: ['contradictions'] })
    const c = items(ctx, 'contradiction')
    expect(c.map((x) => x.title)).toContain('Prince Thrommel is called “Knight of the Hart” on Iuz')
    const thrommel = c.find((x) => x.title.includes('Knight of the Hart'))!
    expect(thrommel.certainty).toBe('possible')
    expect(thrommel.evidence.map((e) => `${e.resourceName}: ${e.passage}`)).toEqual(['Prince Thrommel: Titles: Prince of Furyondy', 'Iuz: Iuz imprisoned Thrommel, Knight of the Hart, beneath Dorakaa.'])
    expect(thrommel.summary).toMatch(/may be another title/)
  })

  it('finds spelling variants of page names and never renames anything', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, { checks: ['terminology'] })
    const t = items(ctx, 'terminology').map((i) => i.title)
    expect(t).toEqual(expect.arrayContaining(['“Sea-Princes” for Sea Princes', '“Lantern Wardens” for Lanternwardens']))
    expect(ctx.lk.callCount('updateResourceTags') + ctx.lk.callCount('replaceDocumentBlocks')).toBe(0)
  })

  it('keeps decisions across runs and reopens them when the cited wording changes', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, {})
    const variant = items(ctx, 'terminology').find((i) => i.title.includes('Sea-Princes'))!
    decide(ctx, variant.id, { decision: 'intentional', note: 'In-world spelling used by sailors.' })
    await runKnowledgeAnalysis(ctx, {})
    expect(ctx.repos.knowledge.get(variant.id)!.status).toBe('intentional')
    // The variant disappears from the page: the open findings it rested on are resolved.
    const missing = items(ctx, 'missing_page')[0]!
    const page = ctx.lk.resources.get(IDS.seaPrinces)!.documents[0]!
    page.blocks = JSON.parse(JSON.stringify(page.blocks).replace('The Sea-Princes raided', 'The Sea Princes raided'))
    page.version = 'v2'
    await startAudit(ctx, { mode: 'resources', resourceIds: [IDS.seaPrinces] }, { wait: true })
    await runKnowledgeAnalysis(ctx, {})
    expect(ctx.repos.knowledge.get(missing.id)!.status).toBe('open')
    expect(ctx.repos.knowledge.get(variant.id)!.status).toBe('intentional')
  })

  it('lets you draft a page for a missing name with a recipe, and only through the usual approval', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, { checks: ['missing'] })
    const recipe = createRecipe(ctx, { name: 'Places', targetPageType: 'location' })
    const isles = items(ctx, 'missing_page')[0]!
    decide(ctx, isles.id, { decision: 'accept' })
    const { jobId } = await draftFromItem(ctx, isles.id, { recipeId: recipe.id })
    expect(ctx.repos.drafts.getByJob(jobId)!.page.name).toBe('Lendore Isles')
    expect(ctx.lk.createRequests).toEqual([])
  })

  it('appears in the review queue with its evidence', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, {})
    const q = reviewQueue(ctx, {})
    expect(q.byType.missing_page).toBe(1)
    expect(q.byType.terminology).toBeGreaterThanOrEqual(2)
    expect(q.items.find((e) => e.type === 'missing_page')!.explanation).toMatch(/Evidence: Hommlet|Evidence: .*Hommlet/)
  })

  it('compares pages with the AI only on request, and drops findings without verifiable quotes', async () => {
    const ctx = await greyhawkContext()
    ctx.aiMock.nextAnalysis.compare_pages = {
      findings: [
        { topic: 'Thrommel’s title', kind: 'role_title_allegiance', quotes: [{ page: 'Iuz', quote: 'Thrommel, Knight of the Hart' }, { page: 'Prince Thrommel', quote: 'Thrommel led the host of good' }], explanation: 'One page calls him a knight of the Hart.' },
        { topic: 'Invented', kind: 'other', quotes: [{ page: 'Iuz', quote: 'Iuz loves kittens' }, { page: 'Prince Thrommel', quote: 'He vanished in 570 CY.' }], explanation: 'Made up.' },
      ],
      suspectedInstructions: [],
    }
    const result = await compareWithAi(ctx, { pageRefs: ['Iuz', 'Prince Thrommel'] })
    expect(result).toMatchObject({ kept: 1, dropped: 1, created: 1 })
    expect(ctx.aiMock.analysisRequests).toHaveLength(1)
    expect(ctx.aiMock.analysisRequests[0]!.user).not.toContain('Hommlet is a village')
    const ai = items(ctx, 'contradiction').find((i) => i.origin === 'ai')!
    expect(ai).toMatchObject({ certainty: 'possible', title: 'Thrommel’s title' })
    ctx.aiMock.nextAnalysis.compare_pages = new AiError('rate_limited', 'The free-model limit was reached.')
    await expect(compareWithAi(ctx, { pageRefs: ['Iuz', 'Prince Thrommel'] })).rejects.toThrow(/free-model limit/)
  })

  it('exports findings with their support and source ids', async () => {
    const ctx = await greyhawkContext()
    await runKnowledgeAnalysis(ctx, {})
    const json = JSON.parse(exportKnowledge(ctx, { kinds: 'relationship' }, 'json').body)
    expect(json.items[0]).toMatchObject({ kind: 'relationship', support: 'inferred (likely)' })
    const csv = exportKnowledge(ctx, {}, 'csv').body
    expect(csv.split('\r\n')[0]).toBe('kind,title,summary,status,support,resource_ids,evidence_pages,evidence_fields,evidence_passages,note,first_seen,last_seen')
    expect(csv).toContain(IDS.seaPrinces)
  })
})
