import { describe, expect, it } from 'vitest'
import { TagPolicy } from '@/core/recipe'
import { recheckTags, suggestTags } from '@/core/tagging'

const existing = [
  { tag: 'NPC', count: 120 },
  { tag: 'Free City of Greyhawk', count: 40 },
  { tag: 'Circle of Eight', count: 9 },
  { tag: 'Ally', count: 30 },
]
const existingOnly = TagPolicy.parse({ mode: 'existing_only', maxSuggestions: 10 })
const allowNew = TagPolicy.parse({ mode: 'allow_new', maxSuggestions: 10 })

describe('tag suggestions', () => {
  it('prefers exact matches to existing tags', () => {
    const [tag] = suggestTags([{ value: 'NPC', origin: 'ai', reason: '' }], existing, existingOnly)
    expect(tag).toMatchObject({ status: 'existing', existingMatch: 'NPC', accepted: true })
  })

  it('maps case and spacing variants to the existing spelling', () => {
    const tags = suggestTags(
      [
        { value: 'npc', origin: 'ai', reason: '' },
        { value: 'free  city of greyhawk', origin: 'ai', reason: '' },
      ],
      existing,
      existingOnly,
    )
    expect(tags.map((t) => [t.status, t.existingMatch])).toEqual([
      ['case_variant', 'NPC'],
      ['case_variant', 'Free City of Greyhawk'],
    ])
  })

  it('rejects new tags under the existing-only policy, with a did-you-mean hint', () => {
    const [tag] = suggestTags([{ value: 'Circle of Eigth', origin: 'ai', reason: '' }], existing, existingOnly)
    expect(tag).toMatchObject({ status: 'rejected', accepted: false, similarTo: 'Circle of Eight' })
  })

  it('marks new tags as new under the allow-new policy', () => {
    const [tag] = suggestTags([{ value: 'Innkeeper', origin: 'ai', reason: 'Occupation' }], existing, allowNew)
    expect(tag).toMatchObject({ status: 'new', accepted: true })
  })

  it('deduplicates and caps AI suggestions, but never caps recipe tags', () => {
    const tags = suggestTags(
      [
        { value: 'NPC', origin: 'page_type', reason: '' },
        { value: 'Ally', origin: 'recipe', reason: '' },
        { value: 'npc', origin: 'ai', reason: '' },
        { value: 'A', origin: 'ai', reason: '' },
        { value: 'B', origin: 'ai', reason: '' },
      ],
      existing,
      TagPolicy.parse({ mode: 'allow_new', maxSuggestions: 2 }),
    )
    expect(tags.map((t) => t.existingMatch ?? t.value)).toEqual(['NPC', 'Ally', 'A'])
  })

  it('re-checks tags after the user edits them, keeping their accept choices', () => {
    const before = suggestTags([{ value: 'Innkeeper', origin: 'ai', reason: '' }], existing, allowNew).map((t) => ({ ...t, accepted: false }))
    const after = recheckTags([...before, { value: 'ally', status: 'new', existingMatch: null, similarTo: null, origin: 'user', accepted: true, reason: '' }], existing, allowNew)
    expect(after.find((t) => t.value === 'Innkeeper')!.accepted).toBe(false)
    expect(after.find((t) => t.value === 'ally')).toMatchObject({ status: 'case_variant', existingMatch: 'Ally', accepted: true })
  })
})
