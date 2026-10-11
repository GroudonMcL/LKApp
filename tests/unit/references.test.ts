import { describe, expect, it } from 'vitest'
import { LinkPolicy } from '@/core/recipe'
import { ReferenceIndex, chooseReference, resolveReferences } from '@/core/references'

const index = new ReferenceIndex([
  { id: 'r_mordy', name: 'Mordenkainen', aliases: ['The Archmage of Obsidian Citadel'], parentId: null },
  { id: 'r_city', name: 'Free City of Greyhawk', aliases: ['Greyhawk City'], parentId: null },
  { id: 'r_gh_world', name: 'Greyhawk', aliases: [], parentId: null },
  { id: 'r_iuz_god', name: 'Iuz', aliases: [], parentId: null },
  { id: 'r_iuz_realm', name: 'Iuz', aliases: [], parentId: null, path: 'Flanaess / Realms' },
  { id: 'r_coe', name: 'Circle of Eight', aliases: [], parentId: null },
])
const policy = LinkPolicy.parse({})

describe('reference resolution', () => {
  it('auto-selects a single exact name or alias match', () => {
    const [byName, byAlias] = resolveReferences(
      [
        { mention: 'Mordenkainen', relation: 'ally of', origin: 'ai' },
        { mention: 'Greyhawk City', relation: null, origin: 'ai' },
      ],
      index,
      policy,
      'Elvera',
    )
    expect(byName).toMatchObject({ status: 'resolved', resourceId: 'r_mordy', resolvedBy: 'auto_exact' })
    expect(byAlias).toMatchObject({ status: 'resolved', resourceId: 'r_city' })
  })

  it('flags several exact matches as ambiguous and selects nothing', () => {
    const [iuz] = resolveReferences([{ mention: 'Iuz', relation: null, origin: 'ai' }], index, policy, 'x')
    expect(iuz!.status).toBe('ambiguous')
    expect(iuz!.resourceId).toBeNull()
    expect(iuz!.candidates.map((c) => c.resourceId).sort()).toEqual(['r_iuz_god', 'r_iuz_realm'])
  })

  it('offers near matches as suggestions only', () => {
    const [ref] = resolveReferences([{ mention: 'the circle of eight', relation: null, origin: 'ai' }], index, policy, 'x')
    expect(ref!.status).toBe('unresolved')
    expect(ref!.candidates[0]).toMatchObject({ resourceId: 'r_coe', matchType: 'normalized' })
  })

  it('leaves unknown names unresolved, with no invented ids', () => {
    const [ref] = resolveReferences([{ mention: 'Elminster', relation: null, origin: 'ai' }], index, policy, 'x')
    expect(ref).toMatchObject({ status: 'unresolved', resourceId: null, candidates: [] })
  })

  it('does not auto-select when the recipe says not to', () => {
    const [ref] = resolveReferences([{ mention: 'Mordenkainen', relation: null, origin: 'ai' }], index, LinkPolicy.parse({ autoSelectExactMatch: false }), 'x')
    expect(ref!.status).toBe('unresolved')
    expect(ref!.candidates).toHaveLength(1)
  })

  it('skips the page itself, duplicates, and everything when links are off', () => {
    const refs = resolveReferences(
      [
        { mention: 'Mordenkainen', relation: null, origin: 'ai' },
        { mention: 'Mordenkainen', relation: null, origin: 'index_scan' },
        { mention: 'Iuz', relation: null, origin: 'ai' },
      ],
      index,
      policy,
      'Iuz',
    )
    expect(refs.map((r) => r.mention)).toEqual(['Mordenkainen'])
    expect(resolveReferences([{ mention: 'Mordenkainen', relation: null, origin: 'ai' }], index, LinkPolicy.parse({ mode: 'off' }), 'x')).toEqual([])
  })

  it('only lets the user choose one of the listed candidates, or leave it unresolved', () => {
    const [iuz] = resolveReferences([{ mention: 'Iuz', relation: null, origin: 'ai' }], index, policy, 'x')
    expect(chooseReference(iuz!, 'r_iuz_god')).toMatchObject({ status: 'resolved', resourceId: 'r_iuz_god', resolvedBy: 'user' })
    expect(chooseReference(iuz!, null)).toMatchObject({ status: 'left_unresolved', resourceId: null })
    expect(() => chooseReference(iuz!, 'r_invented')).toThrow(/listed candidate/)
  })

  it('finds exact known names in text, longest first', () => {
    const found = index.scanText("Elvera trades with Mordenkainen's agents in the Free City of Greyhawk. greyhawk is lowercase here.", ['Elvera'])
    expect(found).toEqual(['Mordenkainen', 'Free City of Greyhawk'])
  })

  it('returns no references without an index', () => {
    const [ref] = resolveReferences([{ mention: 'Mordenkainen', relation: null, origin: 'ai' }], null, policy, 'x')
    expect(ref).toMatchObject({ status: 'unresolved', candidates: [] })
  })
})
