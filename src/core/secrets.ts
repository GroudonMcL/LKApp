import { isSecretHeading, type CanonicalPage, type PageSection } from './page-model'
import { sectionId } from './draft-common'

/**
 * Keeps what the source marks as secret out of what players can read.
 *
 * The AI is asked to put game-master-only text under "Secrets", but models do not always do so.
 * So, whatever the model returned: every passage the source itself places under a secret heading
 * ("Secrets", "GM Notes", "DM only"…) ends up in the page's Secrets section, word for word; any
 * other paragraph that repeats it (even reworded: it shares runs of words with it) is moved there
 * too; and a field whose value repeats it is not written (marked uncertain, with a note).
 *
 * Pure: no network, no database.
 */

/** Passages of the source under a secret heading, until the next heading of the same or a higher level. */
export function secretPassages(sourceText: string): string[] {
  const lines = sourceText.split('\n')
  const passages: string[] = []
  let level: number | null = null
  let current: string[] = []
  const flush = () => {
    const text = current.join('\n').trim()
    if (text) passages.push(...text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean))
    current = []
  }
  for (const line of lines) {
    const trimmed = line.trim()
    const markdown = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed)
    // A bold or plain line that is just a secret heading ("**Secrets**", "GM notes:") counts as one.
    const bareText = trimmed.replace(/^(\*\*|__)(.*?)(\*\*|__):?$/, '$2').replace(/:$/, '').trim()
    const bare = !markdown && /^[\p{L}' ]{3,40}$/u.test(bareText) ? bareText : null
    const depth = markdown ? markdown[1]!.length : bare !== null && isSecretHeading(bare) ? 6 : null
    if (depth !== null) {
      const title = markdown ? markdown[2]! : bare!
      if (level !== null && depth <= level) {
        flush()
        level = null
      }
      if (level === null && isSecretHeading(title)) {
        level = depth
        continue
      }
    }
    if (level !== null) current.push(line)
  }
  if (level !== null) flush()
  return passages
}

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

function shingles(text: string, size = 4): Set<string> {
  const list = words(text)
  const out = new Set<string>()
  for (let i = 0; i + size <= list.length; i++) out.add(list.slice(i, i + size).join(' '))
  return out
}

/** Whether `text` repeats a secret passage: two runs of four words in common, or a third of its own. */
export function repeatsSecret(text: string, secrets: Set<string>): boolean {
  const own = shingles(text)
  if (!own.size || !secrets.size) return false
  let shared = 0
  for (const shingle of own) if (secrets.has(shingle)) shared++
  return shared >= 2 || shared / own.size >= 0.34
}

export function protectSecrets(page: CanonicalPage, sourceText: string): { page: CanonicalPage; moved: number; withheld: string[] } {
  const passages = secretPassages(sourceText)
  if (!passages.length) return { page, moved: 0, withheld: [] }
  const secretShingles = new Set(passages.flatMap((p) => [...shingles(p)]))
  const sections: PageSection[] = []
  let secret = page.sections.find((section) => isSecretHeading(section.heading)) ?? null
  const toSecret: string[] = []
  let moved = 0
  for (const section of page.sections) {
    if (section === secret) continue
    if (isSecretHeading(section.heading)) {
      toSecret.push(...section.paragraphs)
      continue
    }
    const kept = section.paragraphs.filter((paragraph) => {
      if (!repeatsSecret(paragraph, secretShingles)) return true
      toSecret.push(paragraph)
      moved++
      return false
    })
    if (kept.length) sections.push({ ...section, paragraphs: kept })
  }
  // The source's own secret passages, word for word, then anything moved that adds to them.
  const existing = secret?.paragraphs ?? []
  const all = [...passages, ...existing, ...toSecret]
  const seen = new Set<string>()
  const paragraphs = all.filter((paragraph) => {
    const key = words(paragraph).join(' ')
    if (!key || seen.has(key)) return false
    // A reworded copy of a source passage adds nothing.
    if (!passages.includes(paragraph) && passages.some((p) => repeatsSecret(paragraph, shingles(p)) && words(paragraph).length <= words(p).length * 1.2)) return false
    seen.add(key)
    return true
  })
  secret = { id: secret?.id ?? sectionId(), heading: secret?.heading ?? 'Secrets', kind: secret?.kind ?? 'lore', paragraphs }
  sections.push(secret)

  const withheld: string[] = []
  const fields = page.fields.map((field) => {
    if (!field.value || !['source', 'user', 'default', 'suggested'].includes(field.status) || !repeatsSecret(field.value, secretShingles)) return field
    withheld.push(field.label)
    return { ...field, status: 'uncertain' as const, note: [field.note, 'Not written: it repeats what the source marks as secret. Keep it in the Secrets section, or confirm it if players may see it.'].filter(Boolean).join(' ') }
  })
  const notes = [...page.reviewerNotes]
  if (moved) notes.push(`${moved} paragraph(s) repeating what the source marks as secret were moved into the Secrets section, so players cannot read them.`)
  if (withheld.length) notes.push(`Not written because they repeat secret text: ${withheld.join(', ')}.`)
  return { page: { ...page, sections, fields, reviewerNotes: notes }, moved, withheld }
}
