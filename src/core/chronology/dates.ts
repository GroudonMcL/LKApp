import { findCalendar, type CalendarConfig, type CalendarEra, type CalendarSettings } from './calendar'

/**
 * Dates as campaign sources write them.
 *
 * - `original` is always kept exactly as written; everything else is a reading of it.
 * - Uncertainty is part of the value: approximate dates, decades, centuries, ranges, dates
 *   known only relative to another event, and unknown dates are all represented, and none is
 *   turned into a single exact moment.
 * - `sort` places a date on the calendar's primary count (e.g. CY years) for ordering and
 *   comparison. It is `null` when that is impossible (an era without a configured
 *   conversion, a relative or unknown date). It is a reading aid, never a replacement.
 */

export interface DatePoint {
  /** Signed year on the primary count: 50 BCY is −50. Null when the year is not known. */
  year: number | null
  /** The year as written in its own era ("50" for 50 BCY). */
  yearAsWritten: number | null
  /** Era abbreviation as configured (e.g. "CY"); null when the source names none. */
  era: string | null
  eraAssumed: boolean
  month: string | null
  monthIndex: number | null
  day: number | null
}

export type DateKind = 'exact' | 'approximate' | 'range' | 'relative' | 'unknown'
export type DatePrecision = 'day' | 'month' | 'year' | 'decade' | 'century' | 'none'

export interface ChronoDate {
  original: string
  calendarId: string
  kind: DateKind
  precision: DatePrecision
  approximate: boolean
  qualifier: 'early' | 'mid' | 'late' | null
  start: DatePoint | null
  end: DatePoint | null
  relative: { relation: 'before' | 'after' | 'during'; anchor: string; anchorSort: { lo: number; hi: number } | null } | null
  sort: { lo: number; hi: number } | null
  notes: string[]
}

const ORDINAL = '(?:st|nd|rd|th)'

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** "circa" → "[Cc]irca": keywords may start a sentence. */
function kw(word: string) {
  return word.replace(/^[a-z]/, (c) => `[${c.toUpperCase()}${c}]`)
}

interface EraName {
  name: string
  era: CalendarEra
  calendar: CalendarConfig
}

function eraNames(settings: CalendarSettings): EraName[] {
  const out: EraName[] = []
  for (const calendar of settings.calendars)
    for (const era of calendar.eras) for (const name of new Set([era.abbr, ...era.names])) out.push({ name, era, calendar })
  return out.sort((a, b) => b.name.length - a.name.length)
}

function monthNames(settings: CalendarSettings) {
  const out: { name: string; month: string; index: number; calendar: CalendarConfig }[] = []
  for (const calendar of settings.calendars)
    calendar.months.forEach((m, index) => {
      for (const name of new Set([m.name, ...m.aliases])) out.push({ name, month: m.name, index, calendar })
    })
  return out.sort((a, b) => b.name.length - a.name.length)
}

const APPROX = /^(?:c\.|ca\.|circa|around|about|approximately|approx\.|roughly|some ?time (?:in|around|about)|~)\s*/i
const QUALIFIER = /^(early|mid|middle|late)[\s-]+/i
const UNKNOWN = /^(?:unknown|unrecorded|undated|uncertain|not known|lost to history|n\/a|\?+|—|–|-)$/i
const RELATIVE = /^(?:(?:shortly|long|soon|just|some (?:years|time)|many years|a few years|several years|years|decades|centuries)\s+)?(before|after|during|following|prior to|since|until|in the time of)\s+(.+)$/i

function emptyDate(original: string, calendarId: string): ChronoDate {
  return { original, calendarId, kind: 'unknown', precision: 'none', approximate: false, qualifier: null, start: null, end: null, relative: null, sort: null, notes: [] }
}

/** Primary-count year for a year written in an era; null when the era cannot be converted. */
function toPrimary(yearAsWritten: number, era: CalendarEra): number | null {
  if (era.offset === null) return null
  return era.direction === 'backward' ? era.offset - yearAsWritten : yearAsWritten + era.offset
}

interface PointReading {
  point: DatePoint
  calendar: CalendarConfig | null
  precision: DatePrecision
  span: { lo: number; hi: number } | null
  notes: string[]
}

/**
 * Reads one date point (no range, no approximation markers). Returns null when the text
 * holds no year, month or recognisable period.
 */
function readPoint(raw: string, settings: CalendarSettings, options: { allowBareYear: boolean; inherit?: { era: EraName | null; calendar: CalendarConfig | null } }): PointReading | null {
  let text = ` ${raw.trim().replace(/,/g, ' ')} `
  const notes: string[] = []

  // Era.
  let era: EraName | null = null
  for (const candidate of eraNames(settings)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(candidate.name)}(?![\\p{L}\\p{N}])`, 'u')
    if (re.test(text)) {
      era = candidate
      text = text.replace(re, ' ')
      break
    }
  }
  if (!era && options.inherit?.era) era = options.inherit.era
  const calendarFromEra = era?.calendar ?? options.inherit?.calendar ?? null

  // Decade / century.
  const century = text.match(new RegExp(`(\\d{1,3})${ORDINAL}\\s+century`, 'i'))
  const decade = century ? null : text.match(/(?<![\p{N}])(\d{1,4}0)['’]?s(?![\p{L}])/u)
  if (century || decade) {
    const calendar = calendarFromEra ?? findCalendar(settings, settings.defaultCalendarId)
    const eraDef = era?.era ?? calendar.eras.find((e) => e.abbr === calendar.primaryEra)!
    let lo: number
    let hi: number
    if (century) {
      const n = Number(century[1])
      lo = calendar.hasZeroYear ? (n - 1) * 100 : (n - 1) * 100 + 1
      hi = calendar.hasZeroYear ? n * 100 - 1 : n * 100
    } else {
      lo = Number(decade![1])
      hi = lo + 9
    }
    const a = toPrimary(lo, eraDef)
    const b = toPrimary(hi, eraDef)
    if (!era) notes.push(`Era not written; read as ${eraDef.abbr}.`)
    if (a === null || b === null) notes.push(`The ${eraDef.abbr} era has no configured conversion, so this date is not placed in order.`)
    return {
      point: { year: null, yearAsWritten: null, era: eraDef.abbr, eraAssumed: !era, month: null, monthIndex: null, day: null },
      calendar,
      precision: century ? 'century' : 'decade',
      span: a === null || b === null ? null : { lo: Math.min(a, b), hi: Math.max(a, b) + 0.999 },
      notes,
    }
  }

  // Month.
  let month: { month: string; index: number; calendar: CalendarConfig } | null = null
  for (const candidate of monthNames(settings)) {
    if (calendarFromEra && candidate.calendar.id !== calendarFromEra.id) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(candidate.name)}(?![\\p{L}\\p{N}])`, 'u')
    if (re.test(text)) {
      month = candidate
      text = text.replace(re, ' ')
      break
    }
  }

  // Numbers: a day carries an ordinal or sits next to a month; the rest is the year.
  text = text.replace(/\bof\b/gi, ' ').replace(/\bthe\b/gi, ' ').replace(/\byear\b/gi, ' ')
  const numbers = [...text.matchAll(/(-?\d{1,6})(st|nd|rd|th)?/g)].map((m) => ({ value: Number(m[1]), ordinal: Boolean(m[2]) }))
  const leftovers = text.replace(/(-?\d{1,6})(st|nd|rd|th)?/g, ' ').replace(/[\s.]+/g, '')
  if (leftovers.length > 0) return null
  let day: number | null = null
  let year: number | null = null
  for (const n of numbers) {
    if (month && day === null && (n.ordinal || (numbers.length > 1 && n.value >= 1 && n.value <= 31 && n !== numbers[numbers.length - 1]))) day = n.value
    else if (year === null && !n.ordinal) year = n.value
    else return null
  }
  if (year === null && !month) return null
  if (year === null && !era && !options.inherit) {
    // A month alone ("Fireseek") carries no year.
    notes.push('No year written.')
  }

  const calendar = calendarFromEra ?? month?.calendar ?? findCalendar(settings, settings.defaultCalendarId)
  let eraDef = era?.era ?? null
  let eraAssumed = false
  if (!eraDef && year !== null) {
    if (!options.allowBareYear) return null
    eraDef = calendar.eras.find((e) => e.abbr === calendar.primaryEra)!
    eraAssumed = true
    if (year < 0) {
      // "-50": a minus sign on the primary count.
      notes.push(`Era not written; read the negative year as before ${eraDef.abbr}.`)
    } else notes.push(`Era not written; read as ${eraDef.abbr}.`)
  }
  let primary: number | null = null
  let asWritten: number | null = year
  if (year !== null && eraDef) {
    if (year < 0 && eraDef.direction === 'forward') {
      primary = eraDef.offset === null ? null : year + eraDef.offset
      asWritten = Math.abs(year)
    } else primary = toPrimary(year, eraDef)
    if (primary === null) notes.push(`The ${eraDef.abbr} era has no configured conversion, so this date is not placed in order.`)
  }
  const months = Math.max(1, calendar.months.length)
  let span: { lo: number; hi: number } | null = null
  if (primary !== null) {
    if (month) {
      const start = primary + month.index / months
      span = day !== null ? { lo: start + (day - 1) / (months * 31), hi: start + day / (months * 31) - 0.0001 } : { lo: start, hi: start + 1 / months - 0.0001 }
    } else span = { lo: primary, hi: primary + 0.999 }
  }
  return {
    point: { year: primary, yearAsWritten: asWritten, era: eraDef?.abbr ?? null, eraAssumed, month: month?.month ?? null, monthIndex: month?.index ?? null, day },
    calendar,
    precision: day !== null ? 'day' : month ? 'month' : 'year',
    span,
    notes,
  }
}

function splitRange(text: string): [string, string] | null {
  const between = text.match(/^(?:between)\s+(.+?)\s+and\s+(.+)$/i)
  if (between) return [between[1]!, between[2]!]
  const from = text.match(/^(?:from)\s+(.+?)\s+(?:to|until|till|through)\s+(.+)$/i)
  if (from) return [from[1]!, from[2]!]
  const plain = text.match(/^(.+?\S)\s*(?:–|—|(?<=\S)\s*-\s*(?=\S)|\s+to\s+|\s+until\s+|\s+till\s+|\s+through\s+)\s*(.+)$/i)
  if (plain && !/^-?\d+$/.test(text)) return [plain[1]!, plain[2]!]
  return null
}

function narrow(span: { lo: number; hi: number }, qualifier: 'early' | 'mid' | 'late' | null) {
  if (!qualifier) return span
  const third = (span.hi - span.lo) / 3
  if (qualifier === 'early') return { lo: span.lo, hi: span.lo + third }
  if (qualifier === 'mid') return { lo: span.lo + third, hi: span.hi - third }
  return { lo: span.hi - third, hi: span.hi }
}

/**
 * Reads a date expression such as "576 CY", "c. 576 CY", "Fireseek 12th, 576 CY",
 * "576–585 CY", "the 590s CY", "late 6th century CY", "before the Greyhawk Wars" or
 * "unknown". Always returns a value; when nothing can be read, the kind is `unknown` and the
 * original wording is kept.
 *
 * `allowBareYear`: a number without an era ("576") is read in the default calendar's
 * primary era and noted as assumed. Use it for labelled date fields, not for running text.
 */
export function parseDate(original: string, settings: CalendarSettings, options: { allowBareYear?: boolean } = {}): ChronoDate {
  const allowBareYear = options.allowBareYear ?? true
  const defaultCalendar = findCalendar(settings, settings.defaultCalendarId)
  const result = emptyDate(original, defaultCalendar.id)
  let text = original.trim().replace(/[;:,]+$/, '').replace(/(?<=\p{N}|\p{L}{3})\.$/u, '').replace(/\s+/g, ' ')
  if (text === '' || UNKNOWN.test(text)) {
    result.notes.push(text === '' ? 'No date given.' : 'The source says the date is unknown.')
    return result
  }
  text = text.replace(/^(?:in|on|by|during the year|in the year)\s+(?=\S)/i, '')

  const relative = text.match(RELATIVE)
  if (relative) {
    const relation = /before|prior|until/i.test(relative[1]!) ? 'before' : /during|in the time of/i.test(relative[1]!) ? 'during' : 'after'
    const anchorText = relative[2]!.trim()
    const anchor = parseDate(anchorText, settings, { allowBareYear: false })
    result.kind = 'relative'
    result.relative = { relation, anchor: anchorText, anchorSort: anchor.sort }
    result.calendarId = anchor.kind !== 'unknown' ? anchor.calendarId : defaultCalendar.id
    result.notes.push(anchor.sort ? `Known only as ${relation} ${anchorText}.` : `Known only as ${relation} “${anchorText}”, which has no date of its own here.`)
    result.precision = 'none'
    return result
  }

  let approximate = false
  const approx = text.match(APPROX)
  if (approx) {
    approximate = true
    text = text.slice(approx[0].length)
  }
  if (/\?\s*$/.test(text)) {
    approximate = true
    text = text.replace(/\?\s*$/, '').trim()
  }
  let qualifier: ChronoDate['qualifier'] = null
  const q = text.match(QUALIFIER)
  if (q) {
    qualifier = q[1]!.toLowerCase() === 'early' ? 'early' : q[1]!.toLowerCase() === 'late' ? 'late' : 'mid'
    text = text.slice(q[0].length)
  }
  text = text.replace(/^the\s+/i, '')

  const range = splitRange(text)
  if (range) {
    // "576–585 CY": the era (and month calendar) written once applies to both ends.
    const right = readPoint(range[1], settings, { allowBareYear })
    const rightEra = right?.point.era && right.calendar ? eraNames(settings).find((e) => e.era.abbr === right.point.era && e.calendar.id === right.calendar!.id) ?? null : null
    const left = readPoint(range[0], settings, { allowBareYear: allowBareYear || Boolean(right?.point.era && !right.point.eraAssumed), inherit: { era: right?.point.eraAssumed ? null : rightEra, calendar: right?.calendar ?? null } })
    if (left && right) {
      if (left.point.year === null && left.point.month && right.point.year !== null) {
        left.point.year = right.point.year
        left.point.yearAsWritten = right.point.yearAsWritten
        left.point.era = right.point.era
        const months = Math.max(1, (right.calendar ?? defaultCalendar).months.length)
        left.span = { lo: right.point.year + left.point.monthIndex! / months, hi: right.point.year + (left.point.monthIndex! + 1) / months }
      }
      result.kind = 'range'
      result.calendarId = (right.calendar ?? left.calendar ?? defaultCalendar).id
      result.start = left.point
      result.end = right.point
      result.precision = left.precision === right.precision ? left.precision : 'year'
      result.approximate = approximate
      result.qualifier = qualifier
      result.notes.push(...new Set([...left.notes, ...right.notes]))
      if (left.span && right.span) {
        result.sort = { lo: left.span.lo, hi: right.span.hi }
        if (left.span.lo > right.span.hi) result.notes.push('The range ends before it starts, as written.')
      }
      return result
    }
  }

  const point = readPoint(text, settings, { allowBareYear })
  if (!point) {
    result.notes.push('This could not be read as a date; it is kept as written.')
    return result
  }
  result.calendarId = (point.calendar ?? defaultCalendar).id
  result.start = point.point
  result.precision = point.precision
  result.approximate = approximate || point.precision === 'decade' || point.precision === 'century'
  result.qualifier = qualifier
  result.kind = result.approximate || qualifier ? 'approximate' : 'exact'
  result.notes.push(...point.notes)
  result.sort = point.span ? narrow(point.span, qualifier) : null
  if (point.point.year === null && point.precision !== 'decade' && point.precision !== 'century') result.kind = 'approximate'
  return result
}

/** A short, normalised rendering ("Fireseek 12, 576 CY", "c. 576 CY", "576–585 CY"). The original is shown beside it. */
export function formatDate(date: ChronoDate): string {
  if (date.kind === 'unknown') return 'unknown'
  if (date.kind === 'relative' && date.relative) return `${date.relative.relation} ${date.relative.anchor}`
  const point = (p: DatePoint | null, withEra: boolean) => {
    if (!p) return '?'
    const year = p.yearAsWritten !== null ? `${p.yearAsWritten}${withEra && p.era ? ` ${p.era}` : ''}` : ''
    if (p.month && p.day !== null) return `${p.month} ${p.day}${year ? `, ${year}` : ''}`
    if (p.month) return `${p.month}${year ? ` ${year}` : ''}`
    return year || '?'
  }
  const prefix = `${date.approximate && date.precision !== 'decade' && date.precision !== 'century' ? 'c. ' : ''}${date.qualifier ? `${date.qualifier} ` : ''}`
  if (date.precision === 'decade' || date.precision === 'century') return date.original.trim()
  if (date.kind === 'range') {
    const sameEra = date.start?.era === date.end?.era
    return `${prefix}${point(date.start, !sameEra)}–${point(date.end, true)}`
  }
  return `${prefix}${point(date.start, true)}`
}

/** A single number to order dates by: the start of the span, or next to the anchor for relative dates. */
export function orderKey(date: ChronoDate): number | null {
  if (date.sort) return date.sort.lo
  if (date.relative?.anchorSort) return date.relative.relation === 'before' ? date.relative.anchorSort.lo - 0.0005 : date.relative.anchorSort.hi + 0.0005
  return null
}

/**
 * Whether two readings of the same event cannot both be right. Approximate dates are given
 * `toleranceYears` either side. Undated, relative-without-anchor and unconvertible dates
 * never conflict (there is nothing to compare).
 */
export function datesConflict(a: ChronoDate, b: ChronoDate, toleranceYears: number): boolean {
  if (!a.sort || !b.sort) return false
  const widen = (d: ChronoDate) => (d.approximate || d.kind === 'approximate' ? toleranceYears : 0)
  const aLo = a.sort.lo - widen(a)
  const aHi = a.sort.hi + widen(a)
  const bLo = b.sort.lo - widen(b)
  const bHi = b.sort.hi + widen(b)
  return aHi < bLo || bHi < aLo
}

/** Year label for grouping (e.g. the year, decade or century a date starts in). */
export function periodOf(date: ChronoDate, grouping: 'year' | 'decade' | 'century'): number | null {
  const key = orderKey(date)
  if (key === null) return null
  const year = Math.floor(key)
  if (grouping === 'year') return year
  if (grouping === 'decade') return Math.floor(year / 10) * 10
  return Math.floor(year / 100) * 100
}

export interface DateMention {
  index: number
  text: string
  date: ChronoDate
}

/**
 * Finds date expressions in running text. Only expressions that name an era, a month with a
 * year, a decade or century with an era, or "the year N" are taken: bare numbers in prose
 * are far more often counts than years.
 */
export function findDates(text: string, settings: CalendarSettings): DateMention[] {
  const eras = eraNames(settings)
    .map((e) => escapeRegex(e.name))
    .join('|')
  const months = monthNames(settings)
    .map((m) => escapeRegex(m.name))
    .join('|')
  const B = '(?<![\\p{L}\\p{N}])'
  const E = '(?![\\p{L}\\p{N}])'
  const approx = `(?:(?:${['c\\.', 'ca\\.', kw('circa'), kw('around'), kw('about'), kw('approximately'), kw('roughly')].join('|')})\\s*)?`
  const qual = `(?:(?:${[kw('early'), kw('mid'), kw('middle'), kw('late')].join('|')})[\\s-]+)?`
  const dayN = `\\d{1,2}${ORDINAL}?`
  const yearEra = `(?:-?\\d{1,5}\\s*(?:${eras})${E}|(?:${eras})\\s*-?\\d{1,5}${E})`
  const monthPart = months ? `(?:(?:${dayN}\\s+(?:of\\s+)?)?(?:${months})(?:\\s+${dayN})?,?\\s+)` : '(?!)'
  const point = [
    `${monthPart}(?:${yearEra}|\\d{1,5}${E})`,
    yearEra,
    `(?:${kw('the')}\\s+)?\\d{1,4}0['’]?s\\s*(?:${eras})${E}`,
    `(?:${kw('the')}\\s+)?\\d{1,2}${ORDINAL}\\s+century\\s*(?:${eras})${E}`,
    `${kw('the')}\\s+year\\s+-?\\d{1,5}${E}`,
  ]
    .map((p) => `(?:${p})`)
    .join('|')
  const bareYear = `-?\\d{1,5}`
  const range = `(?:(?:${kw('between')}|${kw('from')})\\s+)?(?:${point}|${monthPart}?${bareYear})\\s*(?:–|—|-|\\s(?:to|and|until|through)\\s)\\s*(?:${point})`
  const re = new RegExp(`${B}(?:${approx}${qual}(?:${range}|${point}))`, 'gu')
  const out: DateMention[] = []
  for (const match of text.matchAll(re)) {
    const raw = match[0].trim()
    const date = parseDate(raw, settings, { allowBareYear: /\byear\b/i.test(raw) })
    if (date.kind === 'unknown') continue
    out.push({ index: match.index!, text: raw, date })
  }
  return out
}

/**
 * The date as LegendKeeper's timeline should receive it (`formattedStart`), or why it can't.
 * LegendKeeper reads `formattedStart` loosely ("c. 576" became Coldeven 576, "-50" became
 * 50 CY in a live test), so only plain, verified forms are produced, and only for dates that
 * are not approximate, relative or unknown.
 */
export function lkFormatted(point: DatePoint | null, lkEras: { positive: string[]; negative: string | null }): { value: string } | { refused: string } {
  if (!point || point.yearAsWritten === null || point.year === null) return { refused: 'The date has no year LegendKeeper could place.' }
  const negative = point.year < 0
  if (negative && !lkEras.negative) return { refused: 'The LegendKeeper calendar has no era before year 1, so this date cannot be placed there.' }
  if (point.era && !negative && !lkEras.positive.includes(point.era)) return { refused: `The LegendKeeper calendar has no “${point.era}” era.` }
  const yearText = negative ? `${Math.abs(point.year)} ${lkEras.negative}` : String(point.year)
  const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`
  if (point.month && point.day !== null) return { value: `${point.month} ${ordinal(point.day)}, ${yearText}` }
  if (point.month) return { value: `${point.month} ${yearText}` }
  return { value: yearText }
}
