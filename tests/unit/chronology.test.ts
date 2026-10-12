import { describe, expect, it } from 'vitest'
import { chronologyView, readTimelines, saveCalendarSettings, syncChronologyFindings } from '@/server/services/chronology'
import { decide, listItems } from '@/server/services/knowledge-items'
import { exportChronology } from '@/server/services/phase3-exports'
import { IDS, greyhawkContext } from '../helpers/greyhawk-fixture'

describe('chronology workspace', () => {
  it('builds a chronology from event pages, dated fields and LegendKeeper timelines, without writing anything', async () => {
    const ctx = await greyhawkContext()
    await readTimelines(ctx)
    const view = chronologyView(ctx, {})
    const titles = view.entries.map((e) => `${e.title} | ${e.display} | ${e.origin}`)
    expect(titles).toEqual(
      expect.arrayContaining([
        'Battle of Emridy Meadows | Reaping 569 CY | event_page',
        'Battle of Emridy Meadows | 567 CY | native_timeline',
        'Birth of Prince Thrommel | 545 CY | page_field',
        'Founding of Hommlet | c. 300 CY | page_field',
        'Greyhawk Wars | 582–584 CY | native_timeline',
        'Founding of Hommlet | unknown | event_page',
      ]),
    )
    // Ordered by date; undated at the end.
    const keys = view.entries.filter((e) => e.date.sort).map((e) => e.date.sort!.lo)
    expect(keys).toEqual([...keys].sort((a, b) => a - b))
    expect(view.entries.at(-1)!.status).toBe('undated')
    // The original wording and the source are kept.
    const battle = view.entries.find((e) => e.id === `page:${IDS.battle}`)!
    expect(battle.date.original).toBe('Reaping 569 CY')
    expect(battle.sources[0]).toMatchObject({ resourceId: IDS.battle, field: 'Date', passage: 'Date: Reaping 569 CY' })
    expect(battle.participants.map((p) => p.name).sort()).toEqual(['Hommlet', 'Prince Thrommel', 'Temple of Elemental Evil'])
    // The custom LegendKeeper calendar was linked automatically (same months and eras).
    expect(view.autoLinked).toEqual([{ lkCalendarId: 'gh-custom', calendarId: 'greyhawk' }])
    // Nothing was written.
    expect(ctx.lk.calls.filter((c) => /create|update|replace/i.test(c.method))).toEqual([])
  })

  it('reports conflicting dates and impossible sequences with their sources, without choosing', async () => {
    const ctx = await greyhawkContext()
    await readTimelines(ctx)
    const view = chronologyView(ctx, { status: 'conflicts' })
    expect(view.entries.map((e) => e.display).sort()).toEqual(['12 CY', '30 CY', '567 CY', 'Reaping 569 CY'])
    const kinds = view.conflicts.map((c) => `${c.kind}: ${c.title}`)
    expect(kinds).toEqual(expect.arrayContaining(['date: Different dates for “Battle of Emridy Meadows”', 'sequence: Kas dies before being born']))
    const date = view.conflicts.find((c) => c.kind === 'date')!
    expect(date.explanation).toContain('“Reaping 569 CY”')
    expect(date.explanation).toContain('“567 CY”')
  })

  it('filters by date range, participant, category and status', async () => {
    const ctx = await greyhawkContext()
    await readTimelines(ctx)
    expect(chronologyView(ctx, { from: 560, to: 575 }).entries.map((e) => e.title)).toEqual(['Battle of Emridy Meadows', 'Battle of Emridy Meadows'])
    expect(chronologyView(ctx, { participant: IDS.thrommel }).entries.map((e) => e.title)).toEqual(['Birth of Prince Thrommel', 'Battle of Emridy Meadows', 'Battle of Emridy Meadows'])
    expect(chronologyView(ctx, { category: 'Wars' }).entries.map((e) => e.title)).toEqual(['Battle of Emridy Meadows', 'Greyhawk Wars'])
    expect(chronologyView(ctx, { status: 'undated' }).entries.map((e) => e.title)).toEqual(['Founding of Hommlet'])
    expect(chronologyView(ctx, { status: 'uncertain' }).entries.map((e) => e.display)).toEqual(['c. 300 CY'])
  })

  it('records conflicts in the review list; a decision persists until the cited wording changes', async () => {
    const ctx = await greyhawkContext()
    await readTimelines(ctx)
    const first = syncChronologyFindings(ctx, 'proj_test')
    expect(first.created).toBeGreaterThanOrEqual(3)
    const items = listItems(ctx, { kinds: 'chronology_conflict,unresolved_date' }).items
    expect(items.map((i) => i.kind).sort()).toEqual(['chronology_conflict', 'chronology_conflict', 'unresolved_date'])
    const battle = items.find((i) => i.title.includes('Emridy'))!
    expect(battle.evidence.map((c) => c.resourceId).sort()).toEqual([IDS.battle, IDS.history].sort())
    decide(ctx, battle.id, { decision: 'intentional', note: 'The timeline follows a different chronicle.' })
    // Seen again unchanged: the decision stands.
    expect(syncChronologyFindings(ctx, 'proj_test').created).toBe(0)
    expect(ctx.repos.knowledge.get(battle.id)!.status).toBe('intentional')
    // The timeline now says 568 CY: the cited wording changed, so the conflict is opened again.
    const t = ctx.lk.timelines.get('tldoc001')!
    t.events[0] = { ...t.events[0]!, formattedStart: '568 CY', startDate: { ...t.events[0]!.startDate!, year: 568 } }
    await readTimelines(ctx)
    syncChronologyFindings(ctx, 'proj_test')
    expect(ctx.repos.knowledge.get(battle.id)!).toMatchObject({ status: 'open', statusNote: expect.stringMatching(/wording changed/) })
  })

  it('places nothing from a timeline whose calendar is not linked, and says why', async () => {
    const ctx = await greyhawkContext()
    ctx.lk.timelines.get('tldoc001')!.calendarId = 'harptos'
    ctx.lk.calendars.push({ id: 'harptos', name: 'Harptos', positiveEras: [{ abbr: 'DR', name: 'Dale Reckoning' }], negativeEra: null, months: ['Hammer'], builtIn: true })
    await readTimelines(ctx)
    const wars = chronologyView(ctx, {}).entries.find((e) => e.title === 'Greyhawk Wars')!
    expect(wars).toMatchObject({ status: 'undated' })
    expect(wars.date.notes[0]).toMatch(/not linked|which no configured calendar/)
  })

  it('validates calendar settings before saving them', async () => {
    const ctx = await greyhawkContext()
    expect(() => saveCalendarSettings(ctx, { calendars: [], defaultCalendarId: 'x' })).toThrow(/not valid/)
  })

  it('exports dates with their original wording, uncertainty and sources', async () => {
    const ctx = await greyhawkContext()
    await readTimelines(ctx)
    const csv = exportChronology(ctx, {}, 'csv').body
    expect(csv.split('\r\n')[0]).toContain('date_as_written,date_read_as,kind,precision,approximate')
    expect(csv).toContain('c. 300 CY')
    expect(csv).toContain(IDS.battle)
    const json = JSON.parse(exportChronology(ctx, {}, 'json').body)
    const hommlet = json.entries.find((e: { title: string; origin: string }) => e.title === 'Founding of Hommlet' && e.origin === 'page_field')
    expect(hommlet.date).toMatchObject({ asWritten: 'c. 300 CY', approximate: true, kind: 'approximate' })
    expect(hommlet.sources[0]).toMatchObject({ resourceId: IDS.hommlet, field: 'Founded' })
    expect(JSON.stringify(json)).not.toContain('lk_test_key_for_unit_tests')
  })
})
