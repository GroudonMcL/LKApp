import { infobox, keyValue, mention, p, property } from '@legendkeeper/sdk/blocks'
import { AUDIT_TIMING, startAudit } from '@/server/services/wiki-health'
import { TIMELINE_TIMING } from '@/server/services/chronology'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { createTestContext } from './test-context'

/**
 * A small Greyhawk wiki for chronology and knowledge-analysis tests. Every page is fiction
 * written for the tests; the mock connector holds it in memory.
 *
 * Built-in disagreements (so the analyses have something to find):
 * - The Battle of Emridy Meadows is Reaping 569 CY on its page and 567 CY on the timeline.
 * - Kas is recorded as dying (12 CY) before being born (30 CY).
 * - "Founding of Hommlet" is an event page with no date.
 * - The Lendore Isles are mentioned on three pages but have no page of their own.
 * - "Sea Princes" and "Sea-Princes" are both used; "Lantern Wardens" is used for the
 *   Lanternwardens.
 * - Thrommel is "Prince of Furyondy" on his page and "Knight of the Hart" on Iuz's page.
 */

const doc = (id: string, blocks: unknown[], version = 'v1') => [{ id: `doc_${id}`, name: 'Main', type: 'page', blocks, version, text: '' }]
const kv = (rows: [string, unknown][]) => infobox([property(keyValue(rows as never))])
const m = (resourceId: string, text: string) => mention({ resourceId, text })

export const IDS = {
  battle: 'evtbattle',
  founding: 'evtfound',
  hommlet: 'plchomml',
  thrommel: 'npcthrom',
  iuz: 'godiuz00',
  kas: 'npckas00',
  furyondy: 'plcfury0',
  wardens: 'fctwarde',
  seaPrinces: 'plcseapr',
  temple: 'plctempl',
  history: 'tlhist00',
  sandbox: 'sandbox0001',
}

export async function greyhawkContext() {
  AUDIT_TIMING.readSpacingMs = 0
  TIMELINE_TIMING.readSpacingMs = 0
  const ctx = createTestContext({
    resources: [
      { id: IDS.sandbox, name: 'Sandbox', tags: [], documents: doc(IDS.sandbox, [p('Sandbox.')]) },
      {
        id: IDS.battle,
        name: 'Battle of Emridy Meadows',
        tags: ['Event'],
        documents: doc(IDS.battle, [
          kv([
            ['Date', 'Reaping 569 CY'],
            ['Location', [...m(IDS.hommlet, 'Hommlet')]],
          ]),
          p('The armies of good under ', ...m(IDS.thrommel, 'Prince Thrommel'), ' broke the hordes of the ', ...m(IDS.temple, 'Temple of Elemental Evil'), ' near ', ...m(IDS.hommlet, 'Hommlet'), '.'),
        ]),
      },
      { id: IDS.founding, name: 'Founding of Hommlet', tags: ['Event'], documents: doc(IDS.founding, [p('The village of Hommlet grew up around a crossroads inn. No record says when.')]) },
      {
        id: IDS.hommlet,
        name: 'Hommlet',
        tags: ['Location'],
        documents: doc(IDS.hommlet, [
          kv([['Founded', 'c. 300 CY']]),
          p('Hommlet is a village in the Kron Hills. Bandits sacked the village in 576 CY, burning the old mill.'),
          p('Traders from the Lendore Isles visit each summer. The Lantern Wardens keep a small chapter house here.'),
        ]),
      },
      {
        id: IDS.thrommel,
        name: 'Prince Thrommel',
        tags: ['NPC'],
        aliases: ['Thrommel'],
        documents: doc(IDS.thrommel, [
          kv([
            ['Born', '545 CY'],
            ['Titles', 'Prince of Furyondy'],
            ['Affiliations', [...m(IDS.furyondy, 'Furyondy')]],
          ]),
          p('Thrommel led the host of good at the Battle of Emridy Meadows. He vanished in 570 CY.'),
          p('He once sailed to the Lendore Isles to treat with the elves.'),
        ]),
      },
      {
        id: IDS.iuz,
        name: 'Iuz',
        tags: ['God'],
        aliases: ['Old Wicked'],
        documents: doc(IDS.iuz, [
          p('Iuz the Evil is worshipped by the Horned Society and the Boneheart. The Greyhawk Wars raged from 582 to 584 CY.'),
          p('Iuz imprisoned Thrommel, Knight of the Hart, beneath Dorakaa.'),
        ]),
      },
      {
        id: IDS.kas,
        name: 'Kas',
        tags: ['NPC'],
        documents: doc(IDS.kas, [
          kv([
            ['Born', '30 CY'],
            ['Died', '12 CY'],
          ]),
          p('Kas the Bloody-Handed betrayed Vecna.'),
        ]),
      },
      { id: IDS.furyondy, name: 'Furyondy', tags: ['Location'], documents: doc(IDS.furyondy, [p('A kingdom of the Flanaess, ally of the Lantern Wardens.')]) },
      { id: IDS.wardens, name: 'Lanternwardens', tags: ['Faction'], documents: doc(IDS.wardens, [p('An order of lamp-keepers.')]) },
      {
        id: IDS.seaPrinces,
        name: 'Hold of the Sea Princes',
        tags: ['Location'],
        aliases: ['Sea Princes'],
        documents: doc(IDS.seaPrinces, [p('The Sea-Princes raided the Lendore Isles in 584 CY. The Sea Princes fell to the Scarlet Brotherhood that same year.')]),
      },
      { id: IDS.temple, name: 'Temple of Elemental Evil', tags: ['Location'], documents: doc(IDS.temple, [p('A temple near Hommlet, founded in 569 CY according to rumour... no, the temple was destroyed in 569 CY.')]) },
      { id: IDS.history, name: 'History of the Flanaess', tags: [], documents: doc(IDS.history, [p('Overview.')]) },
    ],
  })
  ctx.lk.addTimeline(IDS.history, 'tldoc001', {
    name: 'Flanaess Timeline',
    calendarId: 'gh-custom',
    lanes: [{ id: 'lane1', name: 'Wars', external: false }],
    events: [
      {
        id: 'ev000001',
        laneId: 'lane1',
        type: 'event',
        name: 'Battle of Emridy Meadows',
        formattedStart: '567 CY',
        formattedEnd: null,
        startDate: { year: 567, month: 1, monthName: 'Needfest', day: 1, era: { abbr: 'CY' } },
        endDate: null,
        detail: 1,
        uri: `lk://resources/${IDS.battle}`,
        isHidden: false,
        external: false,
      },
      {
        id: 'ev000002',
        laneId: 'lane1',
        type: 'event',
        name: 'Greyhawk Wars',
        formattedStart: '582 CY',
        formattedEnd: '584 CY',
        startDate: { year: 582, month: 1, monthName: 'Needfest', day: 1, era: { abbr: 'CY' } },
        endDate: { year: 584, month: 1, monthName: 'Needfest', day: 1, era: { abbr: 'CY' } },
        detail: 1,
        uri: null,
        isHidden: false,
        external: false,
      },
    ],
  })
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  await startAudit(ctx, { mode: 'all' }, { wait: true })
  return ctx
}
