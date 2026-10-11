/** Small, dependency-free text helpers shared by tagging, reference resolution and validation. */

/** Collapses runs of whitespace into single spaces and trims. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Removes diacritics: "Iuz" stays "Iuz", "Tenhá" becomes "Tenha". */
export function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/**
 * A forgiving comparison key for names: lowercase, no diacritics, punctuation as spaces,
 * whitespace collapsed, and a leading "the" dropped. "The Free City of Greyhawk" and
 * "free city of greyhawk" share a key.
 */
export function normalizeName(value: string): string {
  const base = collapseWhitespace(stripDiacritics(value).toLowerCase().replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' '))
  return base.replace(/^the /, '')
}

/** A comparison key for tags: case-insensitive and whitespace-insensitive, punctuation kept. */
export function normalizeTag(value: string): string {
  return collapseWhitespace(stripDiacritics(value).toLowerCase().replace(/[_-]+/g, ' '))
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost)
    }
    previous = current
  }
  return previous[b.length]!
}

/** Every number-like token in a string, e.g. "AC 15, HP 45 (6d10 + 12)" → ["15","45","6","10","12"]. */
export function numberTokens(value: string): string[] {
  return value.match(/\d+(?:[.,]\d+)?/g) ?? []
}

/**
 * Whether `needle` occurs in `haystack`, ignoring case, whitespace differences and
 * typographic quote/dash variants. Used to check that AI quotes really come from the source.
 */
export function containsLoosely(haystack: string, needle: string): boolean {
  const simplify = (s: string) =>
    collapseWhitespace(
      s
        .toLowerCase()
        .replace(/[‘’`]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—−]/g, '-')
        .replace(/[*_#>]/g, ' '),
    )
  const n = simplify(needle)
  if (n === '') return true
  return simplify(haystack).includes(n)
}

export function truncateForDisplay(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
