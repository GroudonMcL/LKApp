import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { findCalendar } from '@/core/chronology/calendar'
import { formatDate, lkFormatted } from '@/core/chronology/dates'
import { newAppId, newLkResourceId } from '@/core/ids'
import { normalizeName } from '@/core/text'
import type { AppContext } from '../context'
import type { TimelineWrite } from '../db/knowledge-repositories'
import { ConnectorError, toConnectorError } from '../lk/errors'
import type { TimelineEventInfo } from '../lk/types'
import { recordAudit } from './audit'
import { chronologyData, lkCalendars } from './chronology'
import { requireProjectId } from './connection'
import { ServiceError } from './errors'
import { configBlockers, type Blocker } from './write'

/**
 * Adding one event to an existing LegendKeeper timeline: the only native timeline write the
 * app performs, using the documented `timelines.createEvent`.
 *
 * - Step 1, prepare: checks everything, shows exactly what will be sent, and issues a
 *   one-time approval token. The event id is chosen now, before anything is sent.
 * - Step 2, approve: sends the event once (never retried automatically) and reads it back.
 *   LegendKeeper refuses a second event with the same id, so a repeated approval or a retry
 *   after a lost reply cannot create a duplicate.
 * - The date sent is a plain form the app builds itself, never the source wording: in a live
 *   test LegendKeeper read "c. 576" as Coldeven 576 and "-50" as 50 CY. Approximate,
 *   relative and unknown dates are therefore not sent at all; LegendKeeper has no way to
 *   record that a date is uncertain.
 * - Nothing is ever changed or deleted on a timeline. Lanes, timelines and calendars are
 *   created in LegendKeeper by you.
 */

const PrepareInput = z.object({
  entryId: z.string().min(1).max(200),
  documentId: z.string().min(1).max(100),
  laneId: z.string().min(1).max(100),
  /** Overrides the page the event links to (must be a page in the last scan). */
  linkResourceId: z.string().max(100).nullable().optional(),
  name: z.string().trim().min(1).max(500).optional(),
})

const ApproveInput = z.object({ approvalToken: z.string().min(1).max(200), acknowledgeWarnings: z.boolean(), confirm: z.literal(true) })

const TOKEN_MINUTES = 30
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export async function prepareTimelineEvent(ctx: AppContext, rawInput: unknown) {
  const projectId = await requireProjectId(ctx)
  const input = PrepareInput.parse(rawInput ?? {})
  const blockers: Blocker[] = [...configBlockers(ctx)]
  const warnings: string[] = []
  const { entries, settings } = chronologyData(ctx, projectId)
  const entry = entries.find((e) => e.id === input.entryId)
  if (!entry) throw new ServiceError(404, 'That chronology entry was not found. Refresh the chronology.')
  if (entry.origin === 'native_timeline') throw new ServiceError(400, 'This event is already on a LegendKeeper timeline.')
  const timeline = ctx.repos.timelines.list(projectId).find((t) => t.documentId === input.documentId)
  if (!timeline) throw new ServiceError(404, 'That timeline has not been read. Read the LegendKeeper timelines first.')
  const lane = timeline.lanes.find((l) => l.id === input.laneId && !l.external)
  if (!lane) throw new ServiceError(400, 'Choose a lane that belongs to this timeline (not one from a chained timeline).')

  // Live reads: the timeline's calendar now, and that calendar's eras.
  const connector = ctx.connector()
  let calendarId: string | null
  try {
    calendarId = (await connector.getTimelineDocument(timeline.resourceId, timeline.documentId)).calendarId
  } catch (error) {
    throw toConnectorError(error)
  }
  const lkCalendar = (await connector.listCalendars().catch(() => lkCalendars(ctx))).find((c) => c.id === calendarId) ?? null
  const linked = settings.calendars.find((c) => c.lkCalendarIds.includes(calendarId ?? ''))
  if (!lkCalendar) blockers.push({ code: 'CALENDAR_UNKNOWN', message: `The timeline’s calendar “${calendarId ?? 'none'}” was not found in LegendKeeper.` })
  else if (!linked) blockers.push({ code: 'CALENDAR_NOT_LINKED', message: `The timeline uses the LegendKeeper calendar “${lkCalendar.name}”, which is not linked to any of your calendar settings. Link it on the Calendars tab first.` })
  else if (linked.id !== entry.date.calendarId) blockers.push({ code: 'CALENDAR_MISMATCH', message: `The event is dated in “${findCalendar(settings, entry.date.calendarId).name}”, but the timeline uses “${linked.name}”. The app does not convert between calendars.` })

  const date = entry.date
  if (date.kind === 'unknown') blockers.push({ code: 'NO_DATE', message: 'The event has no date, so it cannot be placed on a timeline.' })
  else if (date.kind === 'relative') blockers.push({ code: 'RELATIVE_DATE', message: `The event is only dated relative to another (“${date.original}”). Give it a date first; LegendKeeper needs a point on the calendar.` })
  else if (date.kind === 'approximate' || date.approximate)
    blockers.push({ code: 'APPROXIMATE_DATE', message: `The date is approximate (“${date.original}”). LegendKeeper cannot record that a date is uncertain, so it would show as exact. Edit the event to an exact date if you have decided on one.` })

  let formattedStart: string | null = null
  let formattedEnd: string | null = null
  if (lkCalendar && !blockers.some((b) => ['NO_DATE', 'RELATIVE_DATE', 'APPROXIMATE_DATE'].includes(b.code))) {
    const eras = { positive: lkCalendar.positiveEras.map((e) => e.abbr), negative: lkCalendar.negativeEra?.abbr ?? null }
    const start = lkFormatted(date.start, eras)
    if ('refused' in start) blockers.push({ code: 'DATE_NOT_PLACEABLE', message: start.refused })
    else formattedStart = start.value
    if (date.kind === 'range') {
      const end = lkFormatted(date.end, eras)
      if ('refused' in end) blockers.push({ code: 'DATE_NOT_PLACEABLE', message: `End date: ${end.refused}` })
      else formattedEnd = end.value
    }
  }

  const linkId = input.linkResourceId === undefined ? entry.resourceId : input.linkResourceId
  if (linkId && !ctx.repos.index.get(projectId, linkId)) blockers.push({ code: 'LINK_UNKNOWN', message: 'The page to link is not in the last project scan.' })
  const name = input.name ?? entry.title
  const sameName = ctx.repos.timelines.events(projectId, timeline.documentId).filter((e) => normalizeName(e.name) === normalizeName(name))
  if (sameName.length) warnings.push(`The timeline already has ${sameName.length === 1 ? 'an event' : `${sameName.length} events`} called “${sameName[0]!.name}” (${sameName.map((e) => e.formattedStart ?? '?').join(', ')}). Adding this one makes two.`)
  const done = ctx.repos.timelineWrites.list(projectId, 500).filter((w) => w.documentId === timeline.documentId && (w.payload as { entryId?: string }).entryId === entry.id && ['verified', 'mismatch', 'uncertain'].includes(w.status))
  if (done.length) blockers.push({ code: 'ALREADY_ADDED', message: `This event was already added to this timeline (${done[0]!.status}). Check it in LegendKeeper.` })

  const eventId = newLkResourceId()
  const token = randomBytes(24).toString('hex')
  const expiresAt = new Date(ctx.now().getTime() + TOKEN_MINUTES * 60_000).toISOString()
  const payload = {
    entryId: entry.id,
    name,
    laneId: lane.id,
    laneName: lane.name,
    formattedStart,
    formattedEnd,
    uri: linkId ? `lk://resources/${linkId}` : null,
    calendarId,
    expected: date.start ? { year: date.start.yearAsWritten, era: date.start.era, month: date.start.month, day: date.start.day, precision: date.precision } : null,
    dateAsWritten: date.original,
    tokenHash: hash(token),
    expiresAt,
    warnings,
  }
  const writeId = newAppId('tlw')
  if (!blockers.length) ctx.repos.timelineWrites.insert({ id: writeId, projectId, itemId: entry.id.startsWith('item:') ? entry.id.slice(5) : null, resourceId: timeline.resourceId, documentId: timeline.documentId, eventId, payload })
  recordAudit(ctx, { operation: 'timeline.prepare', outcome: blockers.length ? 'blocked' : 'success', approval: 'not_approved', projectId, resourceId: timeline.resourceId, message: `Timeline event preview: “${name}” on “${timeline.name}”`, details: { writeId: blockers.length ? null : writeId, blockers: blockers.map((b) => b.code), eventId } })
  return {
    writeId: blockers.length ? null : writeId,
    approvalToken: blockers.length ? null : token,
    expiresAt: blockers.length ? null : expiresAt,
    blockers,
    warnings,
    preview: {
      timeline: { resourceId: timeline.resourceId, resourceName: timeline.resourceName, documentId: timeline.documentId, name: timeline.name, calendar: lkCalendar?.name ?? calendarId },
      lane: lane.name,
      eventId,
      name,
      dateAsWritten: date.original,
      dateReadAs: formatDate(date),
      formattedStart,
      formattedEnd,
      link: linkId ? { resourceId: linkId, name: ctx.repos.index.get(projectId, linkId)?.name ?? linkId } : null,
    },
  }
}

function requireWrite(ctx: AppContext, writeId: string): TimelineWrite {
  const write = ctx.repos.timelineWrites.get(writeId)
  if (!write) throw new ServiceError(404, 'That timeline write was not found.')
  return write
}

/** Compares what LegendKeeper stored with what was approved. */
function verify(write: TimelineWrite, event: TimelineEventInfo): { ok: boolean; problems: string[] } {
  const p = write.payload as { name: string; uri: string | null; expected: { year: number | null; month: string | null; day: number | null; precision: string } | null }
  const problems: string[] = []
  if (event.name !== p.name) problems.push(`name is “${event.name}”`)
  if ((event.uri ?? null) !== p.uri) problems.push(`link is ${event.uri ?? 'missing'}`)
  const e = p.expected
  if (e && event.startDate) {
    if (e.year !== null && event.startDate.year !== e.year) problems.push(`year is ${event.startDate.year}`)
    if (e.month && event.startDate.monthName !== e.month) problems.push(`month is ${event.startDate.monthName}`)
    if (e.day !== null && event.startDate.day !== e.day) problems.push(`day is ${event.startDate.day}`)
    const detail = e.precision === 'day' ? 3 : e.precision === 'month' ? 2 : 1
    if (event.detail !== null && event.detail !== detail) problems.push(`precision is ${event.detail === 3 ? 'day' : event.detail === 2 ? 'month' : 'year'}`)
  } else if (e && !event.startDate) problems.push('no date was stored')
  return { ok: problems.length === 0, problems }
}

async function readBack(ctx: AppContext, write: TimelineWrite) {
  const event = await ctx.connector().getTimelineEvent(write.resourceId, write.documentId, write.eventId)
  const result = verify(write, event)
  ctx.repos.timelines.putEvent(write.projectId, {
    documentId: write.documentId,
    eventId: event.id,
    resourceId: write.resourceId,
    laneId: event.laneId,
    laneName: (write.payload as { laneName?: string }).laneName ?? null,
    type: event.type,
    name: event.name,
    formattedStart: event.formattedStart,
    formattedEnd: event.formattedEnd,
    startDate: event.startDate,
    endDate: event.endDate,
    detail: event.detail,
    uri: event.uri,
    isHidden: event.isHidden,
  })
  ctx.repos.timelineWrites.update(write.id, {
    status: result.ok ? 'verified' : 'mismatch',
    readback: { name: event.name, formattedStart: event.formattedStart, formattedEnd: event.formattedEnd, startDate: event.startDate, detail: event.detail, uri: event.uri },
    error: result.ok ? null : `LegendKeeper stored something different: ${result.problems.join('; ')}. Correct it in LegendKeeper; the app does not change timeline events.`,
    written: true,
  })
  recordAudit(ctx, { operation: 'timeline.verify', outcome: result.ok ? 'success' : 'failure', approval: 'approved', projectId: write.projectId, resourceId: write.resourceId, message: result.ok ? `Timeline event “${event.name}” read back as approved.` : `Timeline event read back differently: ${result.problems.join('; ')}`, details: { writeId: write.id, eventId: write.eventId } })
  return ctx.repos.timelineWrites.get(write.id)!
}

export async function approveTimelineEvent(ctx: AppContext, writeId: string, rawInput: unknown) {
  const input = ApproveInput.parse(rawInput ?? {})
  const write = requireWrite(ctx, writeId)
  const p = write.payload as { tokenHash: string; expiresAt: string; warnings: string[]; name: string; laneId: string; formattedStart: string; formattedEnd: string | null; uri: string | null }
  if (write.status !== 'prepared') throw new ServiceError(409, `This write is already ${write.status}.`)
  if (hash(input.approvalToken) !== p.tokenHash) throw new ServiceError(409, 'This approval is not valid. Open the preview again.')
  if (p.expiresAt < ctx.now().toISOString()) throw new ServiceError(409, 'The preview has expired. Open it again.')
  if (p.warnings.length && !input.acknowledgeWarnings) throw new ServiceError(409, 'Tick that you have read the warnings first.')
  const blockers = configBlockers(ctx)
  if (blockers.length) throw new ServiceError(409, blockers.map((b) => b.message).join(' '))

  ctx.repos.timelineWrites.update(write.id, { status: 'writing' })
  recordAudit(ctx, { operation: 'timeline.create_event', outcome: 'info', approval: 'approved', projectId: write.projectId, resourceId: write.resourceId, message: `Adding “${p.name}” to a timeline`, details: { writeId: write.id, eventId: write.eventId } })
  try {
    await ctx.connector().createTimelineEvent({ resourceId: write.resourceId, documentId: write.documentId, eventId: write.eventId, laneId: p.laneId, name: p.name, formattedStart: p.formattedStart, formattedEnd: p.formattedEnd, uri: p.uri })
  } catch (error) {
    const failure = error instanceof ConnectorError ? error : toConnectorError(error)
    if (failure.kind === 'duplicate_id') {
      // An event with the planned id exists: it can only be this write's own. Read it back.
      return { write: await readBack(ctx, write) }
    }
    const unknown = failure.details.outcome === 'unknown'
    ctx.repos.timelineWrites.update(write.id, { status: unknown ? 'uncertain' : 'failed', error: unknown ? `The reply was lost (${failure.message}). Use “Check outcome”: it looks for the event by its planned id; nothing is sent again.` : failure.message })
    recordAudit(ctx, { operation: 'timeline.create_event', outcome: unknown ? 'uncertain' : 'failure', approval: 'approved', projectId: write.projectId, resourceId: write.resourceId, errorCode: failure.details.code ?? failure.kind, message: failure.message, details: { writeId: write.id } })
    return { write: ctx.repos.timelineWrites.get(write.id)! }
  }
  return { write: await readBack(ctx, write) }
}

/** After an uncertain outcome: looks for the event by its planned id. Read-only. */
export async function checkTimelineEvent(ctx: AppContext, writeId: string) {
  const write = requireWrite(ctx, writeId)
  if (write.status !== 'uncertain') throw new ServiceError(409, `Nothing to check: this write is ${write.status}.`)
  try {
    return { write: await readBack(ctx, write) }
  } catch (error) {
    const failure = toConnectorError(error)
    if (failure.kind === 'not_found') {
      ctx.repos.timelineWrites.update(write.id, { status: 'failed', error: 'The event was not created. You can prepare it again.' })
      return { write: ctx.repos.timelineWrites.get(write.id)! }
    }
    throw failure
  }
}

export function timelineWrites(ctx: AppContext, projectId: string) {
  return ctx.repos.timelineWrites.list(projectId).map((w) => ({ ...w, payload: { ...w.payload, tokenHash: undefined } }))
}
