import type { TagProposal } from './page-model'
import type { TagPolicy } from './recipe'
import { levenshtein, normalizeTag } from './text'

/**
 * Tag suggestion logic.
 *
 * LegendKeeper tag filters match tags exactly, including case ("NPC" and "npc" are
 * different tags). So the rules are:
 * - An exact match to an existing tag is preferred and marked `existing`.
 * - A case/spacing variant of an existing tag is rewritten to the existing spelling and
 *   marked `case_variant`, so the project does not gain near-duplicate tags.
 * - Anything else is `new`. Under the `existing_only` policy new tags are rejected;
 *   under `allow_new` they are proposed but clearly marked as new.
 */

export interface ExistingTag {
  tag: string
  count: number | null
}

export interface TagCandidate {
  value: string
  origin: TagProposal['origin']
  reason: string
}

export const MAX_TAGS_PER_RESOURCE = 50
export const MAX_TAG_LENGTH = 100

export function suggestTags(candidates: TagCandidate[], existing: ExistingTag[], policy: TagPolicy): TagProposal[] {
  const byExact = new Map(existing.map((tag) => [tag.tag, tag]))
  const byNormalized = new Map<string, ExistingTag[]>()
  for (const tag of existing) {
    const key = normalizeTag(tag.tag)
    byNormalized.set(key, [...(byNormalized.get(key) ?? []), tag])
  }

  const proposals: TagProposal[] = []
  const seen = new Set<string>()
  let aiCount = 0

  for (const candidate of candidates) {
    const value = candidate.value.trim().replace(/\s+/g, ' ')
    if (value === '') continue
    if (candidate.origin === 'ai') {
      if (aiCount >= policy.maxSuggestions) continue
      aiCount++
    }

    let proposal: TagProposal
    if (value.length > MAX_TAG_LENGTH) {
      proposal = base(value.slice(0, MAX_TAG_LENGTH), candidate, 'rejected', false, `Longer than ${MAX_TAG_LENGTH} characters.`)
    } else if (byExact.has(value)) {
      proposal = base(value, candidate, 'existing', true, candidate.reason)
      proposal.existingMatch = value
    } else {
      const variants = byNormalized.get(normalizeTag(value)) ?? []
      if (variants.length > 0) {
        // Prefer the most used spelling when the project has several variants.
        const best = [...variants].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0]!
        proposal = base(value, candidate, 'case_variant', true, `Uses the existing tag “${best.tag}” (tags match exactly, including case).`)
        proposal.existingMatch = best.tag
      } else if (policy.mode === 'existing_only') {
        proposal = base(value, candidate, 'rejected', false, 'Not an existing tag, and this recipe only uses existing tags.')
        proposal.similarTo = closestTag(value, existing)
      } else {
        proposal = base(value, candidate, 'new', true, candidate.reason || 'Proposed new tag.')
        proposal.similarTo = closestTag(value, existing)
      }
    }

    const key = proposal.existingMatch ?? proposal.value
    if (seen.has(key)) continue
    seen.add(key)
    proposals.push(proposal)
  }
  return proposals
}

function base(value: string, candidate: TagCandidate, status: TagProposal['status'], accepted: boolean, reason: string): TagProposal {
  return { value, status, existingMatch: null, similarTo: null, origin: candidate.origin, accepted, reason }
}

/** A similar existing tag (edit distance ≤ 2 on the normalised form), for "did you mean". */
export function closestTag(value: string, existing: ExistingTag[]): string | null {
  const target = normalizeTag(value)
  if (target.length < 4) return null
  let best: { tag: string; distance: number } | null = null
  for (const tag of existing) {
    const distance = levenshtein(target, normalizeTag(tag.tag))
    if (distance > 0 && distance <= 2 && (!best || distance < best.distance)) best = { tag: tag.tag, distance }
  }
  return best?.tag ?? null
}

/** Re-checks tags after the user edits them in the review screen. */
export function recheckTags(tags: TagProposal[], existing: ExistingTag[], policy: TagPolicy): TagProposal[] {
  const rechecked = suggestTags(
    tags.map((tag) => ({ value: tag.value, origin: tag.origin, reason: tag.reason })),
    existing,
    { ...policy, maxSuggestions: Number.MAX_SAFE_INTEGER },
  )
  // Keep the user's accept/reject choices for tags that are still allowed.
  return rechecked.map((tag) => {
    const before = tags.find((original) => original.value === tag.value)
    return before && tag.status !== 'rejected' ? { ...tag, accepted: before.accepted } : tag
  })
}
