import { z } from 'zod'
import { FieldDefinition, PageTypeDefinition } from './page-types'
import { RecordRules } from './records'

/**
 * A conversion recipe: a reusable, saved description of how to turn a kind of source
 * into a kind of page. Recipes are data, edited in the UI, never code.
 */

export const SourceFormat = z.enum(['any', 'text', 'markdown', 'json'])
export type SourceFormat = z.infer<typeof SourceFormat>

export const FieldMapping = z.object({
  fieldKey: z.string().min(1).max(64),
  /**
   * For JSON sources: a dotted path such as `stats.ac` or `names[0]`.
   * A mapped value is copied verbatim and marked as a source fact; no AI is involved.
   */
  sourcePath: z.string().max(200).nullable().default(null),
  /** A hint for the AI about where this field is found, e.g. "the line starting AC". */
  hint: z.string().max(500).nullable().default(null),
  /** Extra labels your sources use for this field (added to the built-in aliases), e.g. ["Armour"]. */
  labels: z.array(z.string().min(1).max(60)).max(20).default([]),
})
export type FieldMapping = z.infer<typeof FieldMapping>

export const TagPolicy = z.object({
  /**
   * `existing_only`: only tags that already exist in the project are proposed.
   * `allow_new`: new tags may be proposed, clearly marked as new.
   */
  mode: z.enum(['existing_only', 'allow_new']).default('existing_only'),
  /** Tags to always propose (still checked against existing tags). */
  alwaysAdd: z.array(z.string().min(1).max(100)).max(20).default([]),
  /** Also propose the page type's conventional tag (e.g. "NPC"). */
  includePageTypeTag: z.boolean().default(true),
  maxSuggestions: z.number().int().min(0).max(20).default(6),
  guidance: z.string().max(2000).default(''),
})
export type TagPolicy = z.infer<typeof TagPolicy>

export const LinkPolicy = z.object({
  /** `suggest`: find mentions of other pages and propose links. `off`: no links. */
  mode: z.enum(['suggest', 'off']).default('suggest'),
  /** Automatically select a candidate when exactly one page has that exact name or alias. */
  autoSelectExactMatch: z.boolean().default(true),
  /** Also scan the source for exact names of pages already in the resource index. */
  scanForKnownNames: z.boolean().default(true),
  /**
   * Pages carrying any of these tags are never found by the name scan, e.g. ["Glossary"] so
   * rules terms such as "Armor Class" are not linked everywhere. Exact tag spelling.
   */
  scanExcludeTags: z.array(z.string().min(1).max(100)).max(50).default([]),
})
export type LinkPolicy = z.infer<typeof LinkPolicy>

/** File types a recipe accepts in a batch. Empty means any supported type. */
export const AcceptedFormat = z.enum(['text', 'markdown', 'json', 'html', 'docx', 'pdf', 'image'])
export type AcceptedFormat = z.infer<typeof AcceptedFormat>

export const AttributionRules = z.object({
  /** Add the source file name, the section heading and the page number to each page's source citation. */
  includeFile: z.boolean().default(true),
  includeSection: z.boolean().default(true),
  includePage: z.boolean().default(true),
  /** A page without source attribution is a validation error (and a Wiki Health finding). */
  required: z.boolean().default(false),
})
export type AttributionRules = z.infer<typeof AttributionRules>

/** How a recipe migrates existing pages to its template (Phase 2, template migration). */
export const MigrationSettings = z.object({
  /** Old text that fits nowhere in the new layout goes under this heading. It is never dropped. */
  notesHeading: z.string().trim().min(1).max(120).default('Notes from the previous layout'),
  /** Blocks kept as they are (images, secrets…) that have no matching section go under this heading. */
  keptHeading: z.string().trim().min(1).max(120).default('Kept from the previous layout'),
  /** `keep`: the page's tags are not changed. `add_accepted`: tags you accept in the draft are added (never removed). */
  tagHandling: z.enum(['keep', 'add_accepted']).default('keep'),
  /** `keep_all`: links the new layout would lose are added as a link list. `warn`: only reported. */
  linkHandling: z.enum(['keep_all', 'warn']).default('keep_all'),
})
export type MigrationSettings = z.infer<typeof MigrationSettings>

export const RecipeDefinition = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  sourceFormat: SourceFormat.default('any'),
  /** A built-in page type id, or the id of `customPageType`. */
  targetPageType: z.string().min(1).max(64),
  /** Lets a recipe define its own page type with its own fields. */
  customPageType: PageTypeDefinition.nullable().default(null),
  /** Extra fields added to the target page type for this recipe only. */
  extraFields: z.array(FieldDefinition).max(40).default([]),
  templateId: z.string().nullable().default(null),
  fieldMappings: z.array(FieldMapping).max(80).default([]),
  requiredFields: z.array(z.string().min(1).max(64)).max(80).default([]),
  tagPolicy: TagPolicy.default(TagPolicy.parse({})),
  linkPolicy: LinkPolicy.default(LinkPolicy.parse({})),
  /** Structured instructions for the AI. */
  aiInstructions: z.string().max(8000).default(''),
  /** A free-text description of the desired transformation, in your own words. */
  freeTextInstructions: z.string().max(8000).default(''),
  /** How to treat missing or uncertain information. Added to the AI rules; never relaxes them. */
  missingInfoRules: z.string().max(4000).default(''),
  /** Whether a draft made with this recipe may be written to LegendKeeper after approval. */
  allowCreate: z.boolean().default(true),
  defaultParentId: z.string().max(256).nullable().default(null),
  /**
   * Where a new page goes among the pages beside it: `end` (LegendKeeper's default, after the
   * last one) or `alphabetical` (before the first page whose name sorts after it, in
   * LegendKeeper's order).
   */
  placement: z.enum(['end', 'alphabetical']).default('end'),

  // ── Batch settings (Phase 2). All optional; older recipes get these defaults. ──
  /** How one source document is split into records. */
  extraction: RecordRules.default(RecordRules.parse({})),
  acceptedFormats: z.array(AcceptedFormat).max(7).default([]),
  /**
   * What to do when a record matches a page that already exists:
   * - `require_review` (default): stop and ask, for every possible match.
   * - `skip_exact`: skip records whose match is exact and verified; ask about the rest.
   * - `create_anyway`: create new pages even when a match exists (matches are still shown).
   * Pages are never merged or overwritten by an import.
   */
  duplicatePolicy: z.enum(['require_review', 'skip_exact', 'create_anyway']).default('require_review'),
  /** Values for fields the source leaves empty. Written with status "default" so they are never mistaken for source facts. */
  defaultValues: z.array(z.object({ fieldKey: z.string().min(1).max(64), value: z.string().min(1).max(2000) })).max(40).default([]),
  attribution: AttributionRules.default(AttributionRules.parse({})),
  /**
   * Uncertain values are never written. `warn`: a draft with uncertain values can still be
   * approved (those fields are left out). `block`: every uncertain value must be resolved first.
   */
  uncertainHandling: z.enum(['warn', 'block']).default('warn'),
  /**
   * Source text that fits no field or section. `keep`: written in an "Unmapped content" section
   * (nothing is lost). `block`: must be moved or removed by the reviewer before approval.
   */
  unmappedHandling: z.enum(['keep', 'block']).default('keep'),
  migration: MigrationSettings.default(MigrationSettings.parse({})),
})
export type RecipeDefinition = z.infer<typeof RecipeDefinition>
export type RecipeDefinitionInput = z.input<typeof RecipeDefinition>

export interface Recipe {
  id: string
  version: number
  definition: RecipeDefinition
  createdAt: string
  updatedAt: string
}

export const EXAMPLE_RECIPES: RecipeDefinitionInput[] = [
  {
    name: 'NPC from notes',
    description: 'Turns pasted session notes or a character write-up into an NPC page.',
    sourceFormat: 'any',
    targetPageType: 'npc',
    templateId: 'example-npc',
    requiredFields: [],
    tagPolicy: { mode: 'existing_only', includePageTypeTag: true, maxSuggestions: 5 },
    aiInstructions:
      'Write the Description section in the third person using only facts from the source. Put stated relationships in the Relationships section.',
    missingInfoRules: 'Leave alignment and status missing unless the source states them explicitly.',
    allowCreate: true,
  },
  {
    name: 'Creature statblock',
    description: 'Converts a statblock (any edition) into a creature page. Statistics are copied verbatim.',
    sourceFormat: 'any',
    targetPageType: 'creature',
    templateId: 'example-creature',
    requiredFields: ['armorClass', 'hitPoints'],
    tagPolicy: { mode: 'existing_only', includePageTypeTag: true, maxSuggestions: 4 },
    aiInstructions:
      'Copy every statistic exactly as written, including modifiers and parenthetical notes. Put each trait, action and reaction as its own paragraph in the matching section, starting with its name.',
    missingInfoRules: 'If a statistic such as a saving throw is absent, mark the field missing. Never calculate or infer it.',
    allowCreate: true,
  },
  {
    name: 'Location gazetteer entry',
    description: 'Turns a gazetteer-style entry into a location page.',
    sourceFormat: 'any',
    targetPageType: 'location',
    templateId: 'example-location',
    tagPolicy: { mode: 'existing_only', includePageTypeTag: true, maxSuggestions: 6 },
    aiInstructions: 'Keep population figures and dates exactly as written.',
    allowCreate: true,
  },
]
