import { describe, expect, it } from 'vitest'
import { CanonicalPage, acceptedTags, writableFields } from '@/core/page-model'
import { BUILT_IN_PAGE_TYPES, TypedPageFields, checkFieldValue } from '@/core/page-types'
import { RecipeDefinition, EXAMPLE_RECIPES } from '@/core/recipe'
import { TemplateDefinition, EXAMPLE_TEMPLATES } from '@/core/template'

const basePage = {
  schemaVersion: 1,
  name: 'Elvera Tallowmere',
  pageType: 'npc',
}

describe('canonical page schema', () => {
  it('accepts a minimal page and fills defaults', () => {
    const page = CanonicalPage.parse(basePage)
    expect(page.tags).toEqual([])
    expect(page.parentId).toBeNull()
    expect(page.references).toEqual([])
  })

  it('rejects an unknown schema version and bad field statuses', () => {
    expect(CanonicalPage.safeParse({ ...basePage, schemaVersion: 2 }).success).toBe(false)
    const bad = CanonicalPage.safeParse({ ...basePage, fields: [{ key: 'ancestry', label: 'Ancestry', group: 'lore', value: 'Half-elf', status: 'guessed' }] })
    expect(bad.success).toBe(false)
  })

  it('writes only confirmed values (source or user)', () => {
    const page = CanonicalPage.parse({
      ...basePage,
      fields: [
        { key: 'ancestry', label: 'Ancestry', group: 'lore', value: 'Half-elf', status: 'source' },
        { key: 'alignment', label: 'Alignment', group: 'lore', value: 'Neutral good', status: 'suggested' },
        { key: 'status', label: 'Status', group: 'lore', value: 'Alive', status: 'uncertain' },
        { key: 'residence', label: 'Residence', group: 'lore', value: null, status: 'missing' },
        { key: 'occupation', label: 'Occupation', group: 'lore', value: 'Innkeeper', status: 'user' },
      ],
    })
    expect(writableFields(page).map((f) => f.key)).toEqual(['ancestry', 'occupation'])
  })

  it('collapses accepted tags to the existing spelling and drops rejected ones', () => {
    const page = CanonicalPage.parse({
      ...basePage,
      tags: [
        { value: 'npc', status: 'case_variant', existingMatch: 'NPC', origin: 'ai', accepted: true },
        { value: 'NPC', status: 'existing', existingMatch: 'NPC', origin: 'page_type', accepted: true },
        { value: 'Spy', status: 'rejected', origin: 'ai', accepted: false },
        { value: 'Innkeeper', status: 'new', origin: 'ai', accepted: false },
      ],
    })
    expect(acceptedTags(page)).toEqual(['NPC'])
  })
})

describe('page types', () => {
  it('defines the six Phase 1 page types, keeping mechanics apart from lore', () => {
    expect(BUILT_IN_PAGE_TYPES.map((t) => t.id)).toEqual(['npc', 'creature', 'location', 'magic_item', 'rule', 'historical_event'])
    const creature = BUILT_IN_PAGE_TYPES.find((t) => t.id === 'creature')!
    expect(creature.fields.find((f) => f.key === 'armorClass')!.group).toBe('mechanics')
    expect(creature.fields.find((f) => f.key === 'habitat')!.group).toBe('lore')
  })

  it('has typed schemas that check value formats without changing them', () => {
    expect(TypedPageFields.creature!.safeParse({ armorClass: '15 (natural armor)', str: '19 (+4)', challenge: '1/2' }).success).toBe(true)
    expect(TypedPageFields.creature!.safeParse({ armorClass: 'natural armor' }).success).toBe(false)
    expect(TypedPageFields.creature!.safeParse({ str: '35' }).success).toBe(false)
    expect(TypedPageFields.creature!.safeParse({ unknownField: 'x' }).success).toBe(false)
    expect(checkFieldValue('ability_score', '8 (−1)')).toBeNull()
  })
})

describe('recipes and templates', () => {
  it('validates the shipped example recipes and templates', () => {
    for (const recipe of EXAMPLE_RECIPES) expect(RecipeDefinition.safeParse(recipe).success).toBe(true)
    for (const template of EXAMPLE_TEMPLATES) expect(TemplateDefinition.safeParse(template.definition).success).toBe(true)
  })

  it('defaults to the safest policies', () => {
    const recipe = RecipeDefinition.parse({ name: 'x', targetPageType: 'npc' })
    expect(recipe.allowCreate).toBe(false)
    expect(recipe.tagPolicy.mode).toBe('existing_only')
    expect(recipe.linkPolicy.autoSelectExactMatch).toBe(true)
  })

  it('rejects malformed recipes', () => {
    expect(RecipeDefinition.safeParse({ name: '', targetPageType: 'npc' }).success).toBe(false)
    expect(RecipeDefinition.safeParse({ name: 'x', targetPageType: 'npc', tagPolicy: { mode: 'anything' } }).success).toBe(false)
    expect(RecipeDefinition.safeParse({ name: 'x', targetPageType: 'npc', extraFields: [{ key: '1bad', label: 'Bad', group: 'lore' }] }).success).toBe(false)
  })
})
