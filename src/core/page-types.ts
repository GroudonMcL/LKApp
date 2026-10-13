import { z } from 'zod'

/**
 * Page types describe *what* a page is about and which structured fields it may carry.
 *
 * They are deliberately small in Phase 1. Recipes can add custom page types with their
 * own fields, so nothing here limits what a user can import.
 *
 * Fields are split into two groups so that game mechanics never get mixed into lore:
 * - `lore`: descriptive facts shown in the infobox (ancestry, region, rarity…).
 * - `mechanics`: rules and statistics, kept verbatim (AC, hit points, saving throws…).
 */

export const FieldKind = z.enum(['text', 'integer_prefixed', 'ability_score', 'challenge', 'list'])
export type FieldKind = z.infer<typeof FieldKind>

export const FieldDefinition = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Field keys use letters, digits and underscores, starting with a letter.'),
  label: z.string().min(1).max(100),
  group: z.enum(['lore', 'mechanics']),
  kind: FieldKind.default('text'),
  description: z.string().max(500).default(''),
  /**
   * Other labels sources use for this field, e.g. "AC" for Armor Class. Used when reading
   * "Label value" lines without AI, and shown to the AI as alternative names.
   */
  aliases: z.array(z.string().min(1).max(60)).max(20).default([]),
})
export type FieldDefinition = z.infer<typeof FieldDefinition>

export const PageTypeDefinition = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'Page type ids use lowercase letters, digits and underscores.'),
  label: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  /** The tag LegendKeeper projects conventionally use for this type, e.g. "NPC". Only a suggestion. */
  suggestedTag: z.string().max(100).nullable().default(null),
  /** Other conventional tags for this type; the first one that exists in the project is used. */
  alternativeTags: z.array(z.string().min(1).max(100)).max(10).default([]),
  fields: z.array(FieldDefinition).max(80),
  /** Default section headings, in order, for the page body. */
  sections: z.array(z.string().min(1).max(200)).max(40),
  /** Words that suggest a source is about this kind of page. Used only for a hint, never to decide. */
  detectionHints: z.array(z.string()).default([]),
  builtIn: z.boolean().default(false),
})
export type PageTypeDefinition = z.infer<typeof PageTypeDefinition>

const f = (
  key: string,
  label: string,
  group: 'lore' | 'mechanics',
  kind: FieldKind = 'text',
  description = '',
  aliases: string[] = [],
): FieldDefinition => ({ key, label, group, kind, description, aliases })

export const BUILT_IN_PAGE_TYPES: PageTypeDefinition[] = [
  {
    id: 'npc',
    label: 'NPC',
    description: 'A non-player character: a named person in the setting.',
    suggestedTag: 'NPC',
    alternativeTags: ['Character', 'Person'],
    fields: [
      f('ancestry', 'Ancestry', 'lore', 'text', 'Race, species or ancestry as written in the source.', ['Race', 'Species', 'Lineage', 'Heritage']),
      f('occupation', 'Occupation', 'lore', 'text', 'Class, profession or role.', ['Profession', 'Role', 'Class', 'Title']),
      f('alignment', 'Alignment', 'lore'),
      f('affiliations', 'Affiliations', 'lore', 'list', 'Factions, organisations or allegiances.', ['Affiliation', 'Faction', 'Factions', 'Allegiance', 'Allegiances']),
      f('residence', 'Residence', 'lore', 'text', 'Where the character lives or is usually found.', ['Home', 'Lives In', 'Location', 'Lair']),
      f('status', 'Status', 'lore', 'text', 'Alive, deceased, missing… only when the source says so.'),
      f('statblock', 'Statblock', 'mechanics', 'text', 'Game statistics or a reference such as "as veteran".', ['Stat Block', 'Stats', 'Statistics']),
    ],
    sections: ['Description', 'Personality', 'History', 'Relationships', 'Notes'],
    detectionHints: ['npc', 'personality', 'appearance', 'motivation', 'ally', 'villain', 'he is', 'she is'],
    builtIn: true,
  },
  {
    id: 'creature',
    label: 'Creature / statblock',
    description: 'A monster or creature with game statistics.',
    suggestedTag: 'Creature',
    alternativeTags: ['Monster', 'Monsters', 'Creatures', 'Bestiary'],
    fields: [
      f('size', 'Size', 'mechanics'),
      f('creatureType', 'Creature type', 'mechanics', 'text', '', ['Type']),
      f('alignment', 'Alignment', 'mechanics'),
      f('armorClass', 'Armor Class', 'mechanics', 'integer_prefixed', '', ['AC', 'Armour Class']),
      f('hitPoints', 'Hit Points', 'mechanics', 'integer_prefixed', '', ['HP', 'Hit Pts']),
      f('speed', 'Speed', 'mechanics', 'text', '', ['Movement']),
      f('initiative', 'Initiative', 'mechanics', 'text', '', ['Init']),
      f('str', 'STR', 'mechanics', 'ability_score', '', ['Strength']),
      f('dex', 'DEX', 'mechanics', 'ability_score', '', ['Dexterity']),
      f('con', 'CON', 'mechanics', 'ability_score', '', ['Constitution']),
      f('int', 'INT', 'mechanics', 'ability_score', '', ['Intelligence']),
      f('wis', 'WIS', 'mechanics', 'ability_score', '', ['Wisdom']),
      f('cha', 'CHA', 'mechanics', 'ability_score', '', ['Charisma']),
      f('savingThrows', 'Saving Throws', 'mechanics', 'text', '', ['Saves', 'Saving Throw', 'Save']),
      f('skills', 'Skills', 'mechanics', 'text', '', ['Skill']),
      f('damageVulnerabilities', 'Damage Vulnerabilities', 'mechanics', 'text', '', ['Vulnerabilities', 'Vulnerability']),
      f('damageResistances', 'Damage Resistances', 'mechanics', 'text', '', ['Resistances', 'Resistance']),
      f('damageImmunities', 'Damage Immunities', 'mechanics', 'text', '', ['Immunities', 'Immunity']),
      f('conditionImmunities', 'Condition Immunities', 'mechanics'),
      f('gear', 'Gear', 'mechanics', 'text', '', ['Equipment']),
      f('senses', 'Senses', 'mechanics', 'text', '', ['Sense']),
      f('languages', 'Languages', 'mechanics', 'text', '', ['Language']),
      f('challenge', 'Challenge', 'mechanics', 'challenge', '', ['CR', 'Challenge Rating']),
      f('proficiencyBonus', 'Proficiency Bonus', 'mechanics', 'text', '', ['PB', 'Prof. Bonus', 'Prof Bonus']),
      f('edition', 'Edition', 'lore', 'text', 'The game edition the statistics belong to.'),
      f('habitat', 'Habitat', 'lore', 'text', '', ['Environment', 'Environments', 'Terrain']),
    ],
    sections: ['Description', 'Traits', 'Actions', 'Bonus Actions', 'Reactions', 'Legendary Actions', 'Ecology', 'Notes'],
    detectionHints: ['armor class', 'hit points', 'challenge', 'saving throws', 'str', 'dex', 'multiattack', 'hit dice', 'thac0'],
    builtIn: true,
  },
  {
    id: 'location',
    label: 'Location',
    description: 'A place: a region, settlement, building or landmark.',
    suggestedTag: 'Location',
    alternativeTags: ['Place', 'Locations', 'Settlement'],
    fields: [
      f('locationType', 'Type', 'lore', 'text', 'City, town, region, fortress, ruin…', ['Location Type', 'Settlement Type']),
      f('region', 'Region', 'lore', 'text', '', ['Realm', 'Province']),
      f('ruler', 'Ruler', 'lore', 'text', '', ['Rulers', 'Leader', 'Lord']),
      f('government', 'Government', 'lore'),
      f('population', 'Population', 'lore', 'text', 'As written in the source, including any breakdown.', ['Pop.', 'Pop']),
      f('resources', 'Resources', 'lore', 'list'),
    ],
    sections: ['Overview', 'Geography', 'History', 'Notable Places', 'Notable People', 'Notes'],
    detectionHints: ['population', 'capital', 'ruler', 'located', 'region', 'city', 'town', 'village', 'kingdom', 'resources'],
    builtIn: true,
  },
  {
    id: 'magic_item',
    label: 'Magic item',
    description: 'A magic item, artifact or relic.',
    suggestedTag: 'Magic Item',
    alternativeTags: ['Item', 'Magic Items', 'Items', 'Artifact'],
    fields: [
      f('itemType', 'Item type', 'mechanics', 'text', 'Weapon, armor, wondrous item…', ['Type']),
      f('rarity', 'Rarity', 'mechanics'),
      f('attunement', 'Attunement', 'mechanics', 'text', 'Whether and by whom the item requires attunement.', ['Requires Attunement']),
      f('charges', 'Charges', 'mechanics'),
      f('edition', 'Edition', 'lore'),
      f('creator', 'Creator', 'lore', 'text', '', ['Made By', 'Crafted By']),
    ],
    sections: ['Description', 'Properties', 'History', 'Notes'],
    detectionHints: ['attunement', 'rarity', 'wondrous', 'charges', 'artifact', 'magic item', '+1', 'legendary', 'very rare'],
    builtIn: true,
  },
  {
    id: 'rule',
    label: 'Rule / reference entry',
    description: 'A spell, condition, class feature or other rules text. Kept verbatim.',
    suggestedTag: 'Rule',
    alternativeTags: ['Rules', 'Glossary', 'Reference'],
    fields: [
      f('category', 'Category', 'mechanics', 'text', 'Spell, condition, class feature, optional rule…', ['Type']),
      f('edition', 'Edition', 'mechanics'),
      f('sourceReference', 'Source', 'mechanics', 'text', 'Book and page as written.', ['Reference', 'Book']),
      f('prerequisites', 'Prerequisites', 'mechanics', 'text', '', ['Prerequisite']),
    ],
    sections: ['Rules Text', 'Notes'],
    detectionHints: ['casting time', 'components', 'duration', 'range', 'condition', 'prerequisite', 'saving throw', 'spell'],
    builtIn: true,
  },
  {
    id: 'historical_event',
    label: 'Historical event',
    description: 'Something that happened at a point or span of time.',
    suggestedTag: 'Event',
    alternativeTags: ['History', 'Events', 'Historical Event'],
    fields: [
      f('date', 'Date', 'lore', 'text', 'Exactly as written, e.g. "576 CY". Never converted or guessed.', ['When', 'Year']),
      f('endDate', 'End date', 'lore', 'text', '', ['Ended', 'Until']),
      f('location', 'Location', 'lore', 'text', '', ['Where', 'Place']),
      f('participants', 'Participants', 'lore', 'list', '', ['Combatants', 'Parties', 'Belligerents']),
      f('outcome', 'Outcome', 'lore', 'text', '', ['Result']),
    ],
    sections: ['Summary', 'Background', 'Events', 'Aftermath', 'Notes'],
    detectionHints: ['cy', 'year', 'battle', 'war', 'treaty', 'founded', 'siege', 'fell', 'crowned', 'invasion'],
    builtIn: true,
  },
]

export function findBuiltInPageType(id: string): PageTypeDefinition | undefined {
  return BUILT_IN_PAGE_TYPES.find((type) => type.id === id)
}

// ── Field value checks ─────────────────────────────────────────────────────────
// These never change a value. They only report when a value looks unusual for its
// kind, so a reviewer can double-check it against the source.

const INTEGER_PREFIXED = /^\s*\d+(\s|$|\(|,)/
const ABILITY_SCORE = /^\s*\d{1,2}(\s*\(\s*[+\-−–]\s*\d+\s*\))?\s*$/
const CHALLENGE = /^\s*(\d+|\d+\/\d+)(\s|$|\()/

export function checkFieldValue(kind: FieldKind, value: string): string | null {
  switch (kind) {
    case 'integer_prefixed':
      return INTEGER_PREFIXED.test(value) ? null : 'Expected a number first, e.g. "15 (natural armor)".'
    case 'ability_score': {
      if (!ABILITY_SCORE.test(value)) return 'Expected a score such as "18" or "18 (+4)".'
      const score = Number.parseInt(value, 10)
      return score >= 1 && score <= 30 ? null : 'Ability scores are normally between 1 and 30.'
    }
    case 'challenge':
      return CHALLENGE.test(value) ? null : 'Expected a challenge rating such as "5" or "1/2".'
    default:
      return null
  }
}

/**
 * Builds a typed Zod schema for one page type's structured fields.
 * Every field is optional (sources are often incomplete) but values must be
 * strings that pass the kind check.
 */
export function typedFieldsSchema(type: PageTypeDefinition) {
  const shape: Record<string, z.ZodType<string | undefined>> = {}
  for (const field of type.fields) {
    shape[field.key] = z
      .string()
      .superRefine((value, ctx) => {
        const problem = checkFieldValue(field.kind, value)
        if (problem) ctx.addIssue({ code: 'custom', message: problem })
      })
      .optional()
  }
  return z.object(shape).strict()
}

/** Typed schemas for the built-in page types, e.g. `TypedPageFields.creature.parse({...})`. */
export const TypedPageFields = Object.fromEntries(
  BUILT_IN_PAGE_TYPES.map((type) => [type.id, typedFieldsSchema(type)]),
) as Record<string, ReturnType<typeof typedFieldsSchema>>
