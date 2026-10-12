import { describe, expect, it } from 'vitest'
import { TaskPlan, interpretRequest, type NamedPage } from '@/core/assistant/plan'
import { startOrResumeScan } from '@/server/services/discovery'
import { planTask, runTask } from '@/server/services/task-assistant'
import { startAudit } from '@/server/services/wiki-health'
import { IDS, greyhawkContext } from '../helpers/greyhawk-fixture'

const PAGES: NamedPage[] = [
  { id: 'salt', name: 'Saltmarsh', aliases: [], hasChildren: true },
  { id: 'sea', name: 'Hold of the Sea Princes', aliases: ['Sea Princes'], hasChildren: false },
  { id: 'lan', name: 'Lanternwardens', aliases: [], hasChildren: false },
  { id: 'npc1', name: 'Idrenne Vosk', aliases: [], hasChildren: false },
  { id: 'npc2', name: 'Aubrel Thane', aliases: [], hasChildren: false },
  { id: 'god', name: 'Varrenna', aliases: [], hasChildren: false },
]

describe('turning requests into plans without AI', () => {
  const plan = (text: string) => interpretRequest(text, PAGES)!
  it('handles the example requests', () => {
    expect(plan('Find all untagged NPC pages in Saltmarsh.').steps).toEqual([{ op: 'find_pages', kind: 'person', untagged: true, within: 'Saltmarsh' }])
    expect(plan('Find historical events involving the Sea Princes that have no confirmed date.').steps).toEqual([{ op: 'events', dates: 'unconfirmed', involving: 'Sea Princes' }])
    expect(plan('Identify pages mentioning the Lanternwardens that are not linked to its resource.').steps).toEqual([{ op: 'unlinked_mentions', target: 'Lanternwardens' }])
    expect(plan('Find creatures that appear to use the old statblock layout.').steps).toEqual([{ op: 'old_layout', kind: 'creature' }])
    expect(plan('Suggest a chronology of events mentioned in these pages: Saltmarsh, Lanternwardens, Varrenna').steps[0]).toEqual({ op: 'discover_events', pages: ['Saltmarsh', 'Lanternwardens', 'Varrenna'], useAi: false })
    expect(plan('Find inconsistencies between these two NPC biographies: "Idrenne Vosk" and "Aubrel Thane"').steps).toEqual([{ op: 'compare_pages', pages: ['Idrenne Vosk', 'Aubrel Thane'] }])
    expect(plan('Prepare a report of all references to Varrenna.').steps).toEqual([{ op: 'references_to', target: 'Varrenna' }])
  })

  it('asks instead of guessing when something is missing', () => {
    const p = plan('Find inconsistencies between these biographies')
    expect(p.steps).toEqual([])
    expect(p.clarification?.question).toMatch(/Which pages/)
  })

  it('never plans a write: changes are handed to the tool that makes them with approval', () => {
    expect(plan('Add the NPC tag to all pages in Saltmarsh').steps).toEqual([expect.objectContaining({ op: 'handoff', tool: 'tagging' })])
    expect(plan('Delete the duplicate pages').steps[0]!.op).toBe('handoff')
  })

  it('recognises nothing it cannot map to an allowed operation', () => {
    expect(interpretRequest('Write me a poem about Varrenna', PAGES)?.steps.every((s) => s.op === 'handoff') ?? true).toBe(true)
    expect(interpretRequest('hello', PAGES)).toBeNull()
  })

  it('only accepts plans made of allowed operations', () => {
    expect(TaskPlan.safeParse({ understanding: 'x', steps: [{ op: 'delete_page', target: 'Iuz' }] }).success).toBe(false)
    expect(TaskPlan.safeParse({ understanding: 'x', steps: [{ op: 'find_pages', kind: 'dragon' }] }).success).toBe(false)
    expect(TaskPlan.safeParse({ understanding: 'x', steps: Array(5).fill({ op: 'relationships', target: 'Iuz' }) }).success).toBe(false)
  })
})

describe('running plans', () => {
  it('runs read-only plans straight away and changes nothing in LegendKeeper', async () => {
    const ctx = await greyhawkContext()
    const before = ctx.lk.calls.length
    const plan = await planTask(ctx, { request: 'Prepare a report of all references to Iuz.' })
    expect(plan).toMatchObject({ recognised: true, source: 'rules', canRun: true, needsAi: false, writes: false })
    const { results } = await runTask(ctx, { plan: (plan as { plan: unknown }).plan })
    expect(results[0]!.rows.map((r) => `${r.cells.Page}: ${r.cells.How}`)).toEqual(expect.arrayContaining(['Hold of the Sea Princes: names it without a link']))
    const unlinked = await planTask(ctx, { request: 'Identify pages mentioning Prince Thrommel that are not linked to it' })
    const r2 = await runTask(ctx, { plan: (unlinked as { plan: unknown }).plan })
    expect(r2.results[0]!.rows.map((r) => r.cells.Page)).toEqual(['Iuz'])
    const events = await planTask(ctx, { request: 'Find historical events involving Prince Thrommel' })
    const r3 = await runTask(ctx, { plan: (events as { plan: unknown }).plan })
    expect(r3.results[0]!.rows.map((r) => r.cells.Event)).toEqual(['Birth of Prince Thrommel', 'Battle of Emridy Meadows'])
    expect(ctx.lk.calls.slice(before).filter((c) => /create|update|replace/i.test(c.method))).toEqual([])
  })

  it('asks which page is meant when a name matches several, and runs once you choose', async () => {
    const ctx = await greyhawkContext()
    ctx.lk.add({ id: 'iuz00002', name: 'Iuz', tags: ['Story'], documents: [{ id: 'doc_iuz2', name: 'Main', type: 'page', blocks: [], version: 'v1', text: '' }] })
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    const plan = (await planTask(ctx, { request: 'Show the relationships of Iuz' })) as { canRun: boolean; clarification: { question: string; options: string[] }; plan: unknown; pendingChoices: { candidates: { id: string }[] }[] }
    expect(plan.canRun).toBe(false)
    expect(plan.clarification.question).toBe('“Iuz” matches 2 pages. Which one?')
    await expect(runTask(ctx, { plan: plan.plan })).rejects.toThrow(/matches 2 pages/)
    const { results } = await runTask(ctx, { plan: plan.plan, choices: { Iuz: IDS.iuz } })
    expect(results[0]!.title).toBe('Relationships of Iuz')
  })

  it('says when a name matches no page', async () => {
    const ctx = await greyhawkContext()
    const plan = (await planTask(ctx, { request: 'Report all references to "Lendore Isles"' })) as { recognised: boolean }
    expect(plan.recognised).toBe(true)
    const plan2 = await planTask(ctx, { request: 'Find inconsistencies between "Iuz" and "Lendore Isles"' })
    expect(plan2).toMatchObject({ canRun: false, clarification: { question: 'No page is called “Lendore Isles”. Which page did you mean?' } })
  })

  it('requires confirmation before sending page text to the AI, and says what will be sent', async () => {
    const ctx = await greyhawkContext()
    ctx.aiMock.nextAnalysis.compare_pages = { findings: [], suspectedInstructions: [] }
    const plan = (await planTask(ctx, { request: 'Find inconsistencies between "Iuz" and "Prince Thrommel"' })) as { needsAi: boolean; steps: { sends: string | null }[]; plan: unknown }
    expect(plan.needsAi).toBe(true)
    expect(plan.steps[0]!.sends).toMatch(/“Iuz”, “Prince Thrommel”/)
    await expect(runTask(ctx, { plan: plan.plan })).rejects.toMatchObject({ code: 'AI_CONFIRMATION_REQUIRED' })
    expect(ctx.aiMock.analysisRequests).toHaveLength(0)
    await runTask(ctx, { plan: plan.plan, confirmAi: true })
    expect(ctx.aiMock.analysisRequests).toHaveLength(1)
  })

  it('refuses a tampered plan with an operation outside the allowed set', async () => {
    const ctx = await greyhawkContext()
    await expect(runTask(ctx, { plan: { understanding: 'x', steps: [{ op: 'replace_page', target: 'Iuz' }] } })).rejects.toThrow(/only the listed operations/)
    await expect(runTask(ctx, { plan: { understanding: 'x', steps: [{ op: 'handoff', tool: 'shell', reason: 'rm' }] } })).rejects.toThrow(/only the listed operations/)
  })

  it('lets the AI plan a request, sending only the request, operations and tag names, and validates its plan', async () => {
    const ctx = await greyhawkContext()
    // Free models often fill unused fields with placeholders; they are removed, not read as names.
    ctx.aiMock.nextAnalysis.plan_task = { understanding: 'List deities.', steps: [{ op: 'find_pages', kind: 'deity', nameContains: '', linksTo: '[]' }], missing: [], clarification: null }
    const plan = (await planTask(ctx, { request: 'Which gods do we have?', useAi: true })) as { source: string; plan: unknown }
    expect(plan.source).toBe('ai')
    const sent = ctx.aiMock.analysisRequests[0]!.user
    expect(sent).toContain('<request>\nWhich gods do we have?\n</request>')
    expect(sent).toContain('"God"')
    expect(sent).not.toContain('Hommlet is a village')
    const { results } = await runTask(ctx, { plan: plan.plan })
    expect(results[0]!.rows.map((r) => r.cells.Page)).toEqual(['Iuz'])
    // A plan with an operation the app does not have is discarded.
    ctx.aiMock.nextAnalysis.plan_task = () => ({ understanding: 'x', steps: [{ op: 'run_sql', query: 'DROP TABLE' }], missing: [], clarification: null })
    await expect(planTask(ctx, { request: 'Clean up the database', useAi: true })).rejects.toThrow()
  })

  it('finds pages that do not match their template from the last audit', async () => {
    const ctx = await greyhawkContext()
    await startAudit(ctx, { mode: 'all' }, { wait: true })
    const plan = await planTask(ctx, { request: 'Find creatures that appear to use the old statblock layout' })
    const { results } = await runTask(ctx, { plan: (plan as { plan: unknown }).plan })
    expect(results[0]!.title).toBe('Pages that do not match their template')
    expect(results[0]!.links.map((l) => l.href)).toContain('/migrations')
  })
})
