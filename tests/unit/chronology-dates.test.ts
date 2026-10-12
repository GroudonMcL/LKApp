import { describe, expect, it } from 'vitest'
import { DEFAULT_CALENDAR_SETTINGS, validateCalendarSettings, type CalendarSettings } from '@/core/chronology/calendar'
import { datesConflict, findDates, formatDate, lkFormatted, orderKey, parseDate } from '@/core/chronology/dates'

const S = DEFAULT_CALENDAR_SETTINGS

describe('reading dates', () => {
  it('reads explicit years and eras, keeping the original wording', () => {
    const d = parseDate('576 CY', S)
    expect(d).toMatchObject({ original: '576 CY', kind: 'exact', precision: 'year', calendarId: 'greyhawk', approximate: false })
    expect(d.start).toMatchObject({ year: 576, era: 'CY', eraAssumed: false })
    expect(parseDate('CY 576', S).start?.year).toBe(576)
    expect(parseDate('in the year 576 C.Y.', S).start?.year).toBe(576)
  })

  it('reads months, festivals and days of the Greyhawk calendar', () => {
    const d = parseDate('Fireseek 12th, 576 CY', S)
    expect(d).toMatchObject({ precision: 'day', kind: 'exact' })
    expect(d.start).toMatchObject({ month: 'Fireseek', monthIndex: 1, day: 12, year: 576 })
    expect(parseDate('the 4th of Needfest, 591 CY', S).start).toMatchObject({ month: 'Needfest', day: 4, year: 591 })
    expect(parseDate('Readying 576 CY', S)).toMatchObject({ precision: 'month' })
    // Needfest opens the year, Sunsebb closes it.
    expect(orderKey(parseDate('Needfest 576 CY', S))!).toBeLessThan(orderKey(parseDate('Sunsebb 576 CY', S))!)
  })

  it('keeps approximate dates approximate', () => {
    const d = parseDate('c. 576 CY', S)
    expect(d).toMatchObject({ kind: 'approximate', approximate: true, precision: 'year' })
    expect(formatDate(d)).toBe('c. 576 CY')
    expect(parseDate('around 300 CY', S).approximate).toBe(true)
    expect(parseDate('576 CY?', S).approximate).toBe(true)
  })

  it('reads ranges, with the era written once', () => {
    const d = parseDate('576–585 CY', S)
    expect(d).toMatchObject({ kind: 'range' })
    expect(d.start).toMatchObject({ year: 576, era: 'CY' })
    expect(d.end).toMatchObject({ year: 585 })
    expect(d.sort!.lo).toBe(576)
    expect(Math.floor(d.sort!.hi)).toBe(585)
    expect(parseDate('from 582 to 584 CY', S).kind).toBe('range')
    expect(parseDate('between 570 and 575 CY', S).end?.year).toBe(575)
    expect(formatDate(d)).toBe('576–585 CY')
  })

  it('reads decades, centuries and early/late qualifiers as spans, not points', () => {
    const decade = parseDate('the 590s CY', S)
    expect(decade).toMatchObject({ precision: 'decade', approximate: true, kind: 'approximate' })
    expect(decade.sort).toMatchObject({ lo: 590 })
    expect(Math.floor(decade.sort!.hi)).toBe(599)
    const century = parseDate('late 6th century CY', S)
    expect(century).toMatchObject({ precision: 'century', qualifier: 'late' })
    expect(century.sort!.lo).toBeGreaterThan(560)
    expect(Math.floor(century.sort!.hi)).toBe(600)
  })

  it('reads years before the epoch in the backward era', () => {
    const d = parseDate('50 BCY', S)
    expect(d.start).toMatchObject({ year: -50, yearAsWritten: 50, era: 'BCY' })
    expect(orderKey(d)!).toBeLessThan(orderKey(parseDate('1 CY', S))!)
  })

  it('represents relative and unknown dates without inventing a year', () => {
    const rel = parseDate('shortly after 576 CY', S)
    expect(rel).toMatchObject({ kind: 'relative', sort: null })
    expect(rel.relative).toMatchObject({ relation: 'after', anchor: '576 CY' })
    expect(orderKey(rel)!).toBeGreaterThan(576.9)
    const event = parseDate('before the Greyhawk Wars', S)
    expect(event).toMatchObject({ kind: 'relative', sort: null })
    expect(event.relative?.anchorSort).toBeNull()
    expect(orderKey(event)).toBeNull()
    for (const text of ['unknown', '?', '', 'Unrecorded']) expect(parseDate(text, S)).toMatchObject({ kind: 'unknown', sort: null, original: text })
    expect(parseDate('when the moons align', S)).toMatchObject({ kind: 'unknown', notes: [expect.stringMatching(/kept as written/)] })
  })

  it('notes an assumed era for a bare year in a labelled field, and refuses one in running text', () => {
    const d = parseDate('576', S)
    expect(d.start).toMatchObject({ year: 576, era: 'CY', eraAssumed: true })
    expect(d.notes.join(' ')).toMatch(/Era not written/)
    expect(parseDate('576', S, { allowBareYear: false }).kind).toBe('unknown')
  })

  it('does not convert eras without a configured conversion', () => {
    const settings: CalendarSettings = {
      ...S,
      calendars: [{ ...S.calendars[0]!, eras: [...S.calendars[0]!.eras, { abbr: 'SD', label: 'Suloise Dating', names: [], direction: 'forward', offset: null }] }, S.calendars[1]!],
    }
    const d = parseDate('5086 SD', settings)
    expect(d.start).toMatchObject({ era: 'SD', yearAsWritten: 5086, year: null })
    expect(d.sort).toBeNull()
    expect(d.notes.join(' ')).toMatch(/no configured conversion/)
    const converted = parseDate('5086 SD', { ...settings, calendars: [{ ...settings.calendars[0]!, eras: settings.calendars[0]!.eras.map((e) => (e.abbr === 'SD' ? { ...e, offset: -4510 } : e)) }, S.calendars[1]!] })
    expect(converted.start?.year).toBe(576)
  })

  it('reads other calendars by their eras', () => {
    expect(parseDate('March 3rd, 1066 AD', S)).toMatchObject({ calendarId: 'gregorian', precision: 'day' })
  })
})

describe('conflicting chronology', () => {
  it('finds dates that cannot both be right, allowing for approximation', () => {
    expect(datesConflict(parseDate('576 CY', S), parseDate('579 CY', S), 5)).toBe(true)
    expect(datesConflict(parseDate('c. 576 CY', S), parseDate('579 CY', S), 5)).toBe(false)
    expect(datesConflict(parseDate('576–585 CY', S), parseDate('580 CY', S), 5)).toBe(false)
    expect(datesConflict(parseDate('unknown', S), parseDate('580 CY', S), 5)).toBe(false)
    expect(datesConflict(parseDate('Fireseek 576 CY', S), parseDate('Fireseek 576 CY', S), 0)).toBe(false)
  })
})

describe('finding dates in running text', () => {
  it('takes dated expressions and ignores counts', () => {
    const text = 'In 576 CY the town fell. Three hundred soldiers (300) died. The Battle of Emridy Meadows was fought in Reaping 569 CY, and the Greyhawk Wars raged from 582 to 584 CY. Around 300 CY the abbey was founded. AC 15, HP 45.'
    const found = findDates(text, S).map((m) => m.text)
    expect(found).toEqual(['576 CY', 'Reaping 569 CY', 'from 582 to 584 CY', 'Around 300 CY'])
  })

  it('does not read ordinary words that happen to be month names', () => {
    expect(findDates('They were planting 40 rows of barley.', S)).toEqual([])
  })
})

describe('LegendKeeper timeline dates', () => {
  const eras = { positive: ['CY'], negative: 'BCY' }
  it('produces only plain forms LegendKeeper reads reliably', () => {
    expect(lkFormatted(parseDate('576 CY', S).start, eras)).toEqual({ value: '576' })
    expect(lkFormatted(parseDate('Fireseek 576 CY', S).start, eras)).toEqual({ value: 'Fireseek 576' })
    expect(lkFormatted(parseDate('Fireseek 12, 576 CY', S).start, eras)).toEqual({ value: 'Fireseek 12th, 576' })
    expect(lkFormatted(parseDate('50 BCY', S).start, eras)).toEqual({ value: '50 BCY' })
    expect(lkFormatted(parseDate('50 BCY', S).start, { positive: ['CY'], negative: null })).toHaveProperty('refused')
  })
})

describe('calendar settings', () => {
  it('checks primary eras, duplicates and the default calendar', () => {
    expect(validateCalendarSettings(S).ok).toBe(true)
    const bad = validateCalendarSettings({ ...S, defaultCalendarId: 'nope', calendars: [{ ...S.calendars[0]!, primaryEra: 'XX' }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.join(' ')).toMatch(/primary era “XX”.*default calendar/s)
  })
})
