import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DraftContext } from '@/core/draft-common'
import { findBuiltInPageType } from '@/core/page-types'
import { RecipeDefinition } from '@/core/recipe'
import { resolveTemplate } from '@/core/resolve'
import { buildLabelIndex, matchLabel, readAbilityLine, readTypeLine } from '@/core/statblock'
import { buildStructuralDraft } from '@/core/structural'

const creature = findBuiltInPageType('creature')!
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

function draft(text: string, recipeInput: Record<string, unknown> = {}, existingTags: string[] = []) {
  const recipe = RecipeDefinition.parse({ name: 'Creature', targetPageType: 'creature', ...recipeInput })
  const ctx: DraftContext = {
    pageType: creature,
    template: resolveTemplate(creature, null),
    recipe,
    recipeId: 'r',
    recipeVersion: 1,
    templateId: null,
    jobId: 'j',
    sourceText: text,
    sourceTitle: text.split('\n')[0]!,
    attribution: { title: 'Test', kind: 'paste', citation: null, jobId: 'j', importedAt: '2026-01-01T00:00:00Z' },
    now: '2026-01-01T00:00:00Z',
    existingTags,
  }
  const result = buildStructuralDraft(ctx, 'text')
  const fields = Object.fromEntries(result.page.fields.map((f) => [f.key, f.value]))
  return { result, fields, sections: result.page.sections }
}

describe('statblock reading without AI', () => {
  it('reads a 2024-style statblock (AC/HP abbreviations, MOD/SAVE table, plain headings)', () => {
    const { fields, sections, result } = draft(fixture('statblock-2024.txt'))
    expect(result.page.name).toBe('Goblin Underboss')
    expect(fields).toMatchObject({
      size: 'Small',
      creatureType: 'Fey (Goblinoid)',
      alignment: 'Chaotic Neutral',
      armorClass: '17',
      initiative: '+2 (12)',
      hitPoints: '21 (6d6)',
      speed: '30 ft.',
      str: '10 (+0)',
      dex: '15 (+2)',
      wis: '8 (−1)',
      savingThrows: 'Str +0, Dex +2, Con +0, Int +0, Wis −1, Cha +0',
      skills: 'Stealth +6',
      gear: 'Chain Shirt, Scimitar, Shortbow',
      senses: 'Darkvision 60 ft.; Passive Perception 9',
      languages: 'Common, Goblin',
      challenge: '1 (XP 200; PB +2)',
    })
    expect(sections.map((s) => [s.heading, s.kind, s.paragraphs.length])).toEqual([
      ['Traits', 'mechanics', 1],
      ['Actions', 'mechanics', 2],
      ['Reactions', 'mechanics', 1],
    ])
    // Nothing was left behind in a "Description" section.
    expect(sections.some((s) => s.heading === 'Description')).toBe(false)
  })

  it('reads a 2014-style statblock (full labels without colons, STR…CHA header row)', () => {
    const { fields, sections } = draft(fixture('statblock-2014.txt'))
    expect(fields).toMatchObject({
      size: 'Medium',
      creatureType: 'humanoid (goblinoid)',
      alignment: 'lawful evil',
      armorClass: '18 (plate)',
      hitPoints: '39 (6d8 + 12)',
      str: '15 (+2)',
      cha: '13 (+1)',
      savingThrows: 'Con +4, Wis +2',
      conditionImmunities: 'frightened',
      challenge: '2 (450 XP)',
      proficiencyBonus: '+2',
    })
    // Traits that precede "Actions" without a heading stay in the first section, verbatim.
    expect(sections[0]!.paragraphs.join(' ')).toContain('Martial Advantage.')
    expect(sections.map((s) => s.heading)).toEqual(['Description', 'Actions', 'Legendary Actions'])
  })

  it('still reads the Markdown statblock fixture', () => {
    const { fields } = draft(fixture('ogre-statblock.md'))
    expect(fields).toMatchObject({ armorClass: '11 (hide armor)', hitPoints: '59 (7d10 + 21)', str: '19 (+4)', challenge: '2 (450 XP)' })
  })

  it('uses your own extra labels from the recipe', () => {
    const { fields } = draft('Thing\nArmour Rating 14\nVitality 33\n', { fieldMappings: [{ fieldKey: 'hitPoints', labels: ['Vitality'] }, { fieldKey: 'armorClass', labels: ['Armour Rating'] }] })
    expect(fields).toMatchObject({ armorClass: '14', hitPoints: '33' })
  })

  it('does not mistake prose for a field', () => {
    const labels = buildLabelIndex(creature.fields, null)
    expect(matchLabel('Speed is what saves the goblins from the hobgoblins.', labels)).toBeNull()
    expect(matchLabel('Challenge the party to a duel.', labels)).toBeNull()
    expect(matchLabel('AC 17', labels)).toMatchObject({ fieldKey: 'armorClass', value: '17' })
    expect(matchLabel('**Hit Points** 59 (7d10 + 21)', labels)).toMatchObject({ fieldKey: 'hitPoints', value: '59 (7d10 + 21)' })
  })

  it('parses ability scores and type lines in both styles', () => {
    expect(readAbilityLine('STR 19 (+4) DEX 8 (−1) CON 16 (+3)')?.scores).toEqual({ str: '19 (+4)', dex: '8 (−1)', con: '16 (+3)' })
    expect(readAbilityLine('Str 10 +0 +0   Dex 15 +2 +4')).toMatchObject({ scores: { str: '10 (+0)', dex: '15 (+2)' }, saves: { str: '+0', dex: '+4' }, rest: '' })
    expect(readTypeLine('*Large giant, chaotic evil*')).toEqual({ size: 'Large', creatureType: 'giant', alignment: 'chaotic evil' })
    expect(readTypeLine('Medium or Small Humanoid, Any Alignment')).toMatchObject({ size: 'Medium or Small' })
  })

  it('uses the tag the project already has for the page type (Monster instead of Creature)', () => {
    const { result } = draft('X\nAC 12\n', {}, ['Glossary', 'Monster', 'NPC', 'Creature'])
    expect(result.tagCandidates[0]!.value).toBe('Monster')
    expect(draft('X\nAC 12\n').result.tagCandidates[0]!.value).toBe('Creature')
  })
})
