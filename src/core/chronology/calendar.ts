import { z } from 'zod'

/**
 * Calendar configuration for chronology.
 *
 * - Each calendar lists its eras (reckonings), months and whether a year 0 exists. Nothing
 *   here assumes that calendars share months, year lengths or eras.
 * - Eras convert to the calendar's primary era only when an `offset` is configured. An era
 *   without an offset is recognised (its dates are read and kept as written) but never
 *   placed on the primary count: the app does not invent conversions between reckonings.
 * - `lkCalendarIds` names the LegendKeeper calendars (`calendars.list`) that use this
 *   reckoning, so native timeline events can be read in it and written to it.
 *
 * Calendars are stored in the app's settings and can be edited on the Chronology page.
 */

export const CalendarEra = z.object({
  /** The abbreviation as dates write it, e.g. "CY". */
  abbr: z.string().min(1).max(20),
  label: z.string().min(1).max(100),
  /** Other spellings that mean this era, e.g. "C.Y.", "Common Year". */
  names: z.array(z.string().min(1).max(100)).max(20).default([]),
  /** `backward` counts down towards the epoch, like BCE. */
  direction: z.enum(['forward', 'backward']).default('forward'),
  /**
   * Primary-era year = year + offset (forward) or offset − year (backward). `null`: this era
   * cannot be converted; its dates are kept but not placed in order with the others.
   */
  offset: z.number().int().nullable().default(null),
})
export type CalendarEra = z.infer<typeof CalendarEra>

export const CalendarMonth = z.object({
  name: z.string().min(1).max(60),
  aliases: z.array(z.string().min(1).max(60)).max(10).default([]),
  /** A festival week or intercalary period rather than a month. */
  festival: z.boolean().default(false),
})
export type CalendarMonth = z.infer<typeof CalendarMonth>

export const CalendarConfig = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_-]*$/, 'Calendar ids use lowercase letters, digits, - and _.'),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  /** The era every other era converts to, and in which dates are ordered. */
  primaryEra: z.string().min(1).max(20),
  eras: z.array(CalendarEra).min(1).max(30),
  /** Months in order, festivals included. May be empty for calendars without months. */
  months: z.array(CalendarMonth).max(40).default([]),
  /** False: year −1 directly precedes year 1, as in the Gregorian calendar. */
  hasZeroYear: z.boolean().default(false),
  /** LegendKeeper calendar ids that use this reckoning (e.g. "greyhawk"). */
  lkCalendarIds: z.array(z.string().min(1).max(100)).max(20).default([]),
})
export type CalendarConfig = z.infer<typeof CalendarConfig>

export const CalendarSettings = z.object({
  calendars: z.array(CalendarConfig).min(1).max(20),
  /** The calendar used for dates that do not name an era that identifies another one. */
  defaultCalendarId: z.string().min(1).max(40),
  /**
   * Years either side of an approximate date ("c. 576 CY") that still count as agreeing when
   * looking for contradictions. Only used for comparisons; never stored as the date.
   */
  approximateToleranceYears: z.number().int().min(0).max(1000).default(5),
})
export type CalendarSettings = z.infer<typeof CalendarSettings>

const month = (name: string, aliases: string[] = [], festival = false): CalendarMonth => ({ name, aliases, festival })

/**
 * The Common Year reckoning of the World of Greyhawk. Months and festivals as in the common
 * calendar (Needfest opens the year). Other Greyhawk reckonings can be added as eras; they are
 * left out by default because their conversions vary between sources.
 */
export const GREYHAWK_CALENDAR: CalendarConfig = {
  id: 'greyhawk',
  name: 'Greyhawk (Common Year)',
  description: 'The Common Year (CY) reckoning of the Flanaess, with its twelve months and four festival weeks.',
  primaryEra: 'CY',
  eras: [
    { abbr: 'CY', label: 'Common Year', names: ['C.Y.', 'Common Year', 'Common Years', 'Common Reckoning'], direction: 'forward', offset: 0 },
    { abbr: 'BCY', label: 'Before the Common Year', names: ['B.C.Y.', 'before CY'], direction: 'backward', offset: 0 },
  ],
  months: [
    month('Needfest', [], true),
    month('Fireseek'),
    month('Readying'),
    month('Coldeven'),
    month('Growfest', [], true),
    month('Planting'),
    month('Flocktime'),
    month('Wealsun'),
    month('Richfest', [], true),
    month('Reaping'),
    month('Goodmonth'),
    month('Harvester'),
    month('Brewfest', [], true),
    month('Patchwall'),
    month("Ready'reat", ['Readyreat', 'Ready’reat']),
    month('Sunsebb'),
  ],
  hasZeroYear: false,
  lkCalendarIds: ['greyhawk'],
}

export const GREGORIAN_CALENDAR: CalendarConfig = {
  id: 'gregorian',
  name: 'Gregorian',
  description: 'For campaigns set on Earth or using real-world dates.',
  primaryEra: 'CE',
  eras: [
    { abbr: 'CE', label: 'Common Era', names: ['AD', 'A.D.', 'C.E.'], direction: 'forward', offset: 0 },
    { abbr: 'BCE', label: 'Before Common Era', names: ['BC', 'B.C.', 'B.C.E.'], direction: 'backward', offset: 0 },
  ],
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m) => month(m, [m.slice(0, 3)])),
  hasZeroYear: false,
  lkCalendarIds: ['gregorian'],
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  calendars: [GREYHAWK_CALENDAR, GREGORIAN_CALENDAR],
  defaultCalendarId: 'greyhawk',
  approximateToleranceYears: 5,
}

/** Checks a settings object beyond its schema: unique ids, known primary eras, a default that exists. */
export function validateCalendarSettings(input: unknown): { ok: true; settings: CalendarSettings } | { ok: false; issues: string[] } {
  const parsed = CalendarSettings.safeParse(input)
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`) }
  const issues: string[] = []
  const ids = new Set<string>()
  for (const calendar of parsed.data.calendars) {
    if (ids.has(calendar.id)) issues.push(`Calendar id “${calendar.id}” is used twice.`)
    ids.add(calendar.id)
    const primary = calendar.eras.find((e) => e.abbr === calendar.primaryEra)
    if (!primary) issues.push(`${calendar.name}: the primary era “${calendar.primaryEra}” is not in its eras.`)
    else if (primary.direction !== 'forward' || primary.offset !== 0) issues.push(`${calendar.name}: the primary era must count forward with offset 0.`)
    const abbrs = new Set<string>()
    for (const era of calendar.eras) {
      if (abbrs.has(era.abbr.toLowerCase())) issues.push(`${calendar.name}: era “${era.abbr}” is listed twice.`)
      abbrs.add(era.abbr.toLowerCase())
    }
  }
  if (!ids.has(parsed.data.defaultCalendarId)) issues.push(`The default calendar “${parsed.data.defaultCalendarId}” is not configured.`)
  return issues.length ? { ok: false, issues } : { ok: true, settings: parsed.data }
}

export function findCalendar(settings: CalendarSettings, id: string | null | undefined): CalendarConfig {
  return settings.calendars.find((c) => c.id === id) ?? settings.calendars.find((c) => c.id === settings.defaultCalendarId) ?? settings.calendars[0]!
}

/** The calendar configured for a LegendKeeper calendar id, if any. */
export function calendarForLk(settings: CalendarSettings, lkCalendarId: string | null | undefined): CalendarConfig | null {
  if (!lkCalendarId) return null
  return settings.calendars.find((c) => c.lkCalendarIds.includes(lkCalendarId)) ?? null
}

/**
 * Links LegendKeeper calendars that are evidently the same reckoning as a configured one:
 * every month name matches (in any order) and every era it counts in is configured. A copy of
 * a built-in calendar (such as a project's own "Greyhawk" calendar) is linked this way without
 * configuration. Anything less certain is left unlinked for you to decide.
 */
export function withAutoLinks(settings: CalendarSettings, lkCalendars: { id: string; positiveEras: { abbr: string }[]; negativeEra: { abbr: string } | null; months: string[] }[]): { settings: CalendarSettings; autoLinked: { lkCalendarId: string; calendarId: string }[] } {
  const autoLinked: { lkCalendarId: string; calendarId: string }[] = []
  const calendars = settings.calendars.map((c) => ({ ...c, lkCalendarIds: [...c.lkCalendarIds] }))
  const key = (s: string) => s.toLowerCase().replace(/[’']/g, '')
  for (const lk of lkCalendars) {
    if (calendars.some((c) => c.lkCalendarIds.includes(lk.id))) continue
    const months = new Set(lk.months.map(key))
    const eras = [...lk.positiveEras.map((e) => e.abbr), ...(lk.negativeEra ? [lk.negativeEra.abbr] : [])].filter(Boolean).map(key)
    const match = calendars.find((c) => {
      const configured = new Set(c.months.map((m) => key(m.name)))
      const configuredEras = new Set(c.eras.flatMap((e) => [e.abbr, ...e.names]).map(key))
      return configured.size > 0 && configured.size === months.size && [...months].every((m) => configured.has(m)) && eras.length > 0 && eras.every((e) => configuredEras.has(e))
    })
    if (match) {
      match.lkCalendarIds.push(lk.id)
      autoLinked.push({ lkCalendarId: lk.id, calendarId: match.id })
    }
  }
  return { settings: { ...settings, calendars }, autoLinked }
}
