import { describe, expect, it } from 'vitest'
import { CanonicalPage, type CanonicalPageInput } from '@/core/page-model'
import { findBuiltInPageType } from '@/core/page-types'
import { RecipeDefinition } from '@/core/recipe'
import { hasBlockingErrors, validateDraft, type ValidationContext } from '@/core/validation'

const creature = findBuiltInPageType('creature')!
const recipe = RecipeDefinition.parse({ name: 'Creature', targetPageType: 'creature', requiredFields: ['armorClass'] })
const baseCtx: ValidationContext = { pageType: creature, recipe, sourceText: 'Armor Class 11. Hit Points 59.', sameNamePages: [], parentInIndex: true, indexAvailable: true }

function page(overrides: Partial<CanonicalPageInput> = {}): CanonicalPageInput {
  return {
    schemaVersion: 1,
    name: 'Ogre',
    pageType: 'creature',
    parentId: 'abcdefgh',
    fields: [{ key: 'armorClass', label: 'Armor Class', group: 'mechanics', value: '11', status: 'source', sourceQuote: 'Armor Class 11' }],
    sections: [{ id: 's', heading: 'Description', kind: 'lore', paragraphs: ['A big ogre.'] }],
    tags: [{ value: 'Creature', status: 'existing', existingMatch: 'Creature', origin: 'page_type', accepted: true }],
    ...overrides,
  }
}
const codes = (input: CanonicalPageInput, ctx = baseCtx) => validateDraft(input, ctx).findings.map((f) => `${f.severity}:${f.code}`)

describe('draft validation', () => {
  it('passes a complete, grounded draft', () => {
    const result = validateDraft(page(), baseCtx)
    expect(hasBlockingErrors(result.findings)).toBe(false)
    expect(result.page).toBeInstanceOf(Object)
  })

  it('reports schema problems as errors', () => {
    expect(codes({ ...page(), schemaVersion: 9 as 1 })).toContain('error:SCHEMA')
  })

  it('blocks when a required field is missing (never guessed)', () => {
    expect(codes(page({ fields: [{ key: 'armorClass', label: 'Armor Class', group: 'mechanics', value: null, status: 'missing' }] }))).toContain('error:REQUIRED_FIELD_MISSING')
  })

  it('treats an uncertain required field as missing until confirmed', () => {
    const result = codes(page({ fields: [{ key: 'armorClass', label: 'Armor Class', group: 'mechanics', value: '11', status: 'uncertain' }] }))
    expect(result).toContain('error:REQUIRED_FIELD_MISSING')
    expect(result).toContain('warning:FIELD_UNCERTAIN')
  })

  it('warns when a source value contains numbers not found in the source', () => {
    expect(codes(page({ fields: [{ key: 'armorClass', label: 'Armor Class', group: 'mechanics', value: '14', status: 'source' }] }))).toContain('warning:FIELD_NUMBER_NOT_IN_SOURCE')
  })

  it('blocks ambiguous references until the user chooses', () => {
    const ambiguous = page({
      references: [
        {
          id: 'r1',
          mention: 'Iuz',
          status: 'ambiguous',
          candidates: [
            { resourceId: 'a1', name: 'Iuz', matchType: 'exact_name' },
            { resourceId: 'a2', name: 'Iuz', matchType: 'exact_name' },
          ],
        },
      ],
    })
    expect(codes(ambiguous)).toContain('error:REFERENCE_AMBIGUOUS')
  })

  it('blocks a resolved reference whose ID did not come from LegendKeeper', () => {
    const invented = page({ references: [{ id: 'r1', mention: 'Iuz', status: 'resolved', resourceId: 'made-up', candidates: [] }] })
    expect(codes(invented)).toContain('error:REFERENCE_UNVERIFIED_ID')
  })

  it('warns about new tags, possible duplicates and root-level creation', () => {
    const result = codes(
      page({ parentId: null, tags: [{ value: 'Ogre Clan', status: 'new', origin: 'ai', accepted: true }] }),
      { ...baseCtx, sameNamePages: [{ id: 'x1', name: 'Ogre' }] },
    )
    expect(result).toEqual(expect.arrayContaining(['warning:TAG_NEW', 'warning:POSSIBLE_DUPLICATE', 'warning:PARENT_ROOT']))
  })

  it('blocks an empty draft and an unknown page type', () => {
    expect(codes(page({ fields: [], sections: [] }), { ...baseCtx, recipe: RecipeDefinition.parse({ name: 'x', targetPageType: 'creature' }) })).toContain('error:EMPTY_DRAFT')
    expect(codes(page(), { ...baseCtx, pageType: null })).toContain('error:PAGE_TYPE_UNKNOWN')
  })

  it('accepts a page whose parsed form round-trips', () => {
    expect(CanonicalPage.parse(page()).fields[0]!.status).toBe('source')
  })
})
