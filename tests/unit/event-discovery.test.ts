import { describe, expect, it } from 'vitest'
import { AiError } from '@/server/ai/provider'
import { chronologyView, readTimelines, syncChronologyFindings } from '@/server/services/chronology'
import { startDiscovery } from '@/server/services/event-discovery'
import { draftFromItem } from '@/server/services/knowledge-drafts'
import { decide, editItem, listItems } from '@/server/services/knowledge-items'
import { createRecipe } from '@/server/services/recipes'
import { startAudit } from '@/server/services/wiki-health'
import { approveTimelineEvent, checkTimelineEvent, prepareTimelineEvent } from '@/server/services/timeline-writes'
import { IDS, greyhawkContext } from '../helpers/greyhawk-fixture'

const candidates = (ctx: Awaited<ReturnType<typeof greyhawkContext>>) => listItems(ctx, { kinds: 'event_candidate', limit: 500 }).items
const byTitle = (ctx: Awaited<ReturnType<typeof greyhawkContext>>, title: string) => candidates(ctx).find((c) => c.title === title)!

describe('event discovery', () => {
  it('finds dated and named events across several pages, citing each passage', async () => {
    const ctx = await greyhawkContext()
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const found = candidates(ctx).map((c) => `${c.title} | ${(c.data as { date: string }).date}`)
    expect(found).toEqual(
      expect.arrayContaining([
        'Sack of Hommlet | 576 CY',
        'Greyhawk Wars | from 582 to 584 CY',
        'Disappearance of Prince Thrommel | 570 CY',
        'Raid on Lendore Isles | 584 CY',
        'Battle of Emridy Meadows | ',
      ]),
    )
    const sack = byTitle(ctx, 'Sack of Hommlet')
    expect(sack).toMatchObject({ origin: 'deterministic', certainty: 'stated', status: 'open' })
    expect(sack.evidence).toEqual([{ resourceId: IDS.hommlet, resourceName: 'Hommlet', field: null, passage: 'Bandits sacked the village in 576 CY, burning the old mill.', version: 'v1' }])
    expect((sack.data as { participants: { name: string }[] }).participants.map((p) => p.name)).toEqual(['Hommlet'])
    // A single source is flagged as such; nothing is called true.
    expect(sack.data).toMatchObject({ singleSource: true, sourceCount: 1 })
    // Nothing was written to LegendKeeper.
    expect(ctx.lk.calls.filter((c) => /create|update|replace/i.test(c.method))).toEqual([])
  })

  it('flags events that may already have a record', async () => {
    const ctx = await greyhawkContext()
    await readTimelines(ctx)
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const battle = byTitle(ctx, 'Battle of Emridy Meadows')
    const existing = (battle.data as { existing: { origin: string; resourceId: string | null }[] }).existing
    expect(existing.map((e) => e.origin).sort()).toEqual(['event_page', 'native_timeline'])
    expect(byTitle(ctx, 'Sack of Hommlet').data).toMatchObject({ existing: [] })
  })

  it('does not propose the same event from the same passage twice, and keeps your decisions', async () => {
    const ctx = await greyhawkContext()
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const before = candidates(ctx).length
    const sack = byTitle(ctx, 'Sack of Hommlet')
    decide(ctx, sack.id, { decision: 'reject', note: 'Bandit raids are too minor.' })
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    expect(candidates(ctx).length).toBe(before)
    expect(ctx.repos.knowledge.get(sack.id)!.status).toBe('rejected')
    // The page is edited: the cited wording changes, so the rejection is reconsidered.
    const page = ctx.lk.resources.get(IDS.hommlet)!.documents[0]!
    page.blocks = JSON.parse(JSON.stringify(page.blocks).replace('burning the old mill', 'burning the mill and the inn'))
    page.version = 'v2'
    await startAudit(ctx, { mode: 'resources', resourceIds: [IDS.hommlet] }, { wait: true })
    await startDiscovery(ctx, { scope: { mode: 'resources', resourceIds: [IDS.hommlet] } }, { wait: true })
    expect(ctx.repos.knowledge.get(sack.id)!).toMatchObject({ status: 'open', statusNote: expect.stringMatching(/wording changed/) })
  })

  it('keeps disagreeing dates as separate candidates', async () => {
    const ctx = await greyhawkContext()
    const iuz = ctx.lk.resources.get(IDS.thrommel)!.documents[0]!
    iuz.blocks = [...iuz.blocks, { kind: 'paragraph', content: [{ text: 'Some say the Greyhawk Wars began in 579 CY.' }] }]
    await startAudit(ctx, { mode: 'resources', resourceIds: [IDS.thrommel] }, { wait: true })
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const wars = candidates(ctx).filter((c) => c.title === 'Greyhawk Wars')
    expect(wars.map((w) => (w.data as { date: string }).date).sort()).toEqual(['579 CY', 'from 582 to 584 CY'])
    expect((wars[0]!.data as { notes: string[] }).notes.join(' ')).toMatch(/Sources disagree on the date/)
  })

  it('uses AI only when asked, sends only the selected pages, and drops proposals it cannot verify', async () => {
    const ctx = await greyhawkContext()
    ctx.aiMock.nextAnalysis.extract_events = () => ({
      events: [
        { title: 'The Lantern Wardens settle in Hommlet', passage: 'The Lantern Wardens keep a small chapter house here.', dateText: null, kind: 'founding_destruction', people: [], factions: ['Lantern Wardens'], places: ['Hommlet'], summary: 'A chapter house exists.', note: null },
        { title: 'Invented event', passage: 'In 590 CY the moon fell into the sea.', dateText: '590 CY', kind: 'other', people: [], factions: [], places: [], summary: 'Made up.', note: null },
        { title: 'Mill fire', passage: 'Bandits sacked the village in 576 CY, burning the old mill.', dateText: '577 CY', kind: 'treaty_raid_disaster', people: [], factions: [], places: ['Hommlet'], summary: 'The mill burned.', note: null },
      ],
      suspectedInstructions: [],
    })
    await startDiscovery(ctx, { scope: { mode: 'resources', resourceIds: [IDS.hommlet, IDS.iuz] }, useAi: true, aiPageLimit: 1 }, { wait: true })
    expect(ctx.aiMock.analysisRequests).toHaveLength(1)
    expect(ctx.aiMock.analysisRequests[0]!.user).toContain('<page name="Hommlet">')
    expect(ctx.aiMock.analysisRequests[0]!.user).not.toContain('Iuz')
    const titles = candidates(ctx).map((c) => c.title)
    expect(titles).not.toContain('Invented event')
    // An AI proposal is labelled as such and never "stated".
    expect(byTitle(ctx, 'The Lantern Wardens settle in Hommlet')).toMatchObject({ origin: 'ai', certainty: 'possible' })
    // The AI's "Mill fire" cites the same sentence as the rule-based "Sack of Hommlet": one event.
    expect(titles).not.toContain('Mill fire')
    const sack = byTitle(ctx, 'Sack of Hommlet')
    expect((sack.data as { date: string }).date).toBe('576 CY')
    expect((sack.data as { notes: string[] }).notes.join(' ')).toMatch(/not in the quoted passage.*Also called “Mill fire”/s)
    const run = ctx.repos.analysisRuns.list('proj_test', 'event_discovery')[0]!
    expect(run.ai).toMatchObject({ requests: 1, proposed: 3, dropped: 1 })
    // A later run without AI cannot re-find AI proposals, so it leaves them open.
    await startDiscovery(ctx, { scope: { mode: 'resources', resourceIds: [IDS.hommlet] } }, { wait: true })
    expect(byTitle(ctx, 'The Lantern Wardens settle in Hommlet').status).toBe('open')
  })

  it('stops AI use cleanly at the free daily limit, keeping the rule-based results', async () => {
    const ctx = await greyhawkContext()
    ctx.aiMock.nextAnalysis.extract_events = new AiError('rate_limited', 'The free-model limit was reached.')
    await startDiscovery(ctx, { scope: { mode: 'all' }, useAi: true, aiPageLimit: 3 }, { wait: true })
    expect(candidates(ctx).length).toBeGreaterThan(3)
    expect(ctx.repos.analysisRuns.list('proj_test', 'event_discovery')[0]!.ai).toMatchObject({ stopped: 'The free-model limit was reached.' })
  })
})

describe('reviewing event candidates', () => {
  it('accepts an edited candidate into the local chronology, where a disagreement is reported', async () => {
    const ctx = await greyhawkContext()
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const raid = byTitle(ctx, 'Raid on Lendore Isles')
    editItem(ctx, raid.id, { title: 'Sea Princes raid the Lendore Isles', summary: 'Raiders from the Hold struck the isles.' })
    decide(ctx, raid.id, { decision: 'accept' })
    const view = chronologyView(ctx, { origin: 'accepted_candidate' })
    expect(view.entries.map((e) => `${e.title} | ${e.display}`)).toEqual(['Sea Princes raid the Lendore Isles | 584 CY'])
    expect(view.entries[0]!.sources[0]!.resourceId).toBe(IDS.seaPrinces)

    // A second candidate for the same event with another date: both kept, conflict reported.
    const battle = byTitle(ctx, 'Battle of Emridy Meadows')
    editItem(ctx, battle.id, { date: '570 CY' })
    decide(ctx, battle.id, { decision: 'accept' })
    syncChronologyFindings(ctx, 'proj_test')
    const conflicts = listItems(ctx, { kinds: 'chronology_conflict' }).items.map((i) => i.title)
    expect(conflicts).toContain('Different dates for “Battle of Emridy Meadows”')
  })

  it('turns an accepted candidate into an ordinary draft with an event recipe, without writing', async () => {
    const ctx = await greyhawkContext()
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const npcRecipe = createRecipe(ctx, { name: 'NPCs', targetPageType: 'npc' })
    const eventRecipe = createRecipe(ctx, { name: 'Events', targetPageType: 'historical_event' })
    const sack = byTitle(ctx, 'Sack of Hommlet')
    decide(ctx, sack.id, { decision: 'accept' })
    await expect(draftFromItem(ctx, sack.id, { recipeId: npcRecipe.id })).rejects.toThrow(/not an event recipe/)
    const { jobId, item } = await draftFromItem(ctx, sack.id, { recipeId: eventRecipe.id })
    expect(item.status).toBe('drafted')
    const draft = ctx.repos.drafts.getByJob(jobId)!
    expect(draft.page.name).toBe('Sack of Hommlet')
    expect(draft.page.fields.find((f) => f.key === 'date')).toMatchObject({ value: '576 CY' })
    expect(draft.status).not.toBe('created')
    await expect(draftFromItem(ctx, sack.id, { recipeId: eventRecipe.id })).rejects.toThrow(/already/)
    expect(ctx.lk.createRequests).toEqual([])
  })
})

describe('adding an event to a LegendKeeper timeline', () => {
  async function accepted() {
    const ctx = await greyhawkContext()
    await readTimelines(ctx)
    await startDiscovery(ctx, { scope: { mode: 'all' } }, { wait: true })
    const raid = byTitle(ctx, 'Raid on Lendore Isles')
    decide(ctx, raid.id, { decision: 'accept' })
    return { ctx, entryId: `item:${raid.id}` }
  }

  it('previews, then adds the event once with a pre-chosen id and reads it back', async () => {
    const { ctx, entryId } = await accepted()
    const prep = await prepareTimelineEvent(ctx, { entryId, documentId: 'tldoc001', laneId: 'lane1', linkResourceId: IDS.seaPrinces })
    expect(prep.blockers).toEqual([])
    expect(prep.preview).toMatchObject({ formattedStart: '584', name: 'Raid on Lendore Isles', link: { resourceId: IDS.seaPrinces } })
    // Without approval nothing is sent.
    expect(ctx.lk.callCount('createTimelineEvent')).toBe(0)
    await expect(approveTimelineEvent(ctx, prep.writeId!, { approvalToken: 'wrong', acknowledgeWarnings: true, confirm: true })).rejects.toThrow(/not valid/)
    const { write } = await approveTimelineEvent(ctx, prep.writeId!, { approvalToken: prep.approvalToken!, acknowledgeWarnings: false, confirm: true })
    expect(write.status).toBe('verified')
    expect(ctx.lk.callCount('createTimelineEvent')).toBe(1)
    expect(ctx.lk.timelines.get('tldoc001')!.events.find((e) => e.id === prep.preview.eventId)).toMatchObject({ name: 'Raid on Lendore Isles', uri: `lk://resources/${IDS.seaPrinces}` })
    // Approving again, or preparing it again, cannot add it twice.
    await expect(approveTimelineEvent(ctx, prep.writeId!, { approvalToken: prep.approvalToken!, acknowledgeWarnings: false, confirm: true })).rejects.toThrow(/already verified/)
    expect((await prepareTimelineEvent(ctx, { entryId, documentId: 'tldoc001', laneId: 'lane1' })).blockers.map((b) => b.code)).toContain('ALREADY_ADDED')
    expect(ctx.repos.audit.list({ limit: 20, operation: 'timeline.verify' })[0]).toMatchObject({ outcome: 'success', approval: 'approved' })
  })

  it('refuses approximate, relative and undated events rather than losing their uncertainty', async () => {
    const { ctx } = await accepted()
    const hommlet = (await prepareTimelineEvent(ctx, { entryId: `field:${IDS.hommlet}:founded`, documentId: 'tldoc001', laneId: 'lane1' })).blockers.map((b) => b.code)
    expect(hommlet).toContain('APPROXIMATE_DATE')
    const undated = (await prepareTimelineEvent(ctx, { entryId: `page:${IDS.founding}`, documentId: 'tldoc001', laneId: 'lane1' })).blockers.map((b) => b.code)
    expect(undated).toContain('NO_DATE')
  })

  it('refuses when writes are switched off', async () => {
    const { ctx, entryId } = await accepted()
    ctx.settings.lk.allowWrites = false
    const prep = await prepareTimelineEvent(ctx, { entryId, documentId: 'tldoc001', laneId: 'lane1' })
    expect(prep.blockers.map((b) => b.code)).toContain('WRITES_DISABLED')
    expect(prep.approvalToken).toBeNull()
  })

  it('resolves a lost reply by reading, never by sending again', async () => {
    const { ctx, entryId } = await accepted()
    ctx.lk.eventCreateBehavior = 'apply_then_connection_error'
    const prep = await prepareTimelineEvent(ctx, { entryId, documentId: 'tldoc001', laneId: 'lane1' })
    const { write } = await approveTimelineEvent(ctx, prep.writeId!, { approvalToken: prep.approvalToken!, acknowledgeWarnings: true, confirm: true })
    expect(write.status).toBe('uncertain')
    const checked = await checkTimelineEvent(ctx, prep.writeId!)
    expect(checked.write.status).toBe('verified')
    expect(ctx.lk.callCount('createTimelineEvent')).toBe(1)
  })
})
