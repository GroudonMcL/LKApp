import { z } from 'zod'
import { LkLayout } from './lk-layout'
import { BUILT_IN_PAGE_TYPES } from './page-types'

/**
 * Page templates.
 *
 * Templates here are stored locally and come in two forms:
 * - a configured structure: an ordered list of section headings plus the fields shown in the
 *   infobox, laid out by the app's own renderer;
 * - a layout copied from LegendKeeper (`lkLayout`): the block structure of one of your
 *   LegendKeeper templates (or an example page), filled with the draft's values. See
 *   `lk-layout.ts`.
 *
 * `origin` says where a template came from, and the UI always shows it:
 * - `example`: shipped with this app as a starting point. Read-only.
 * - `local`: created in this app, or copied from LegendKeeper (then `lkLayout` is set).
 */

/**
 * How a page follows a layout copied from LegendKeeper:
 * - `emptyFields`: infobox fields the source has no value for stay, blank (`keep`), or are
 *   removed (`remove`). Image slots always stay.
 * - `emptySections`: text sections the source has nothing for stay, blank (`keep`), or are
 *   removed (`remove`).
 * - `additions`: fields the template has no row for are added in line, where they come in a
 *   statblock or field list, and sections with no matching box are added as new boxes (`add`);
 *   or nothing is added to the template's structure (`none`): such sections go into the
 *   template's Notes box or description area, and anything with no place is listed in the final
 *   preview as not written.
 */
export const LayoutRules = z.object({
  emptyFields: z.enum(['keep', 'remove']).default('keep'),
  emptySections: z.enum(['keep', 'remove']).default('remove'),
  additions: z.enum(['add', 'none']).default('add'),
})
export type LayoutRules = z.infer<typeof LayoutRules>

/** Presets offered when copying a template. */
export const LAYOUT_PRESETS: Record<'exact' | 'fit', LayoutRules> = {
  /** Every field and section of the template, in place, and nothing added. */
  exact: { emptyFields: 'keep', emptySections: 'keep', additions: 'none' },
  /** Empty fields and sections removed; extra fields and sections added in place. */
  fit: { emptyFields: 'remove', emptySections: 'remove', additions: 'add' },
}

export const TemplateOrigin = z.enum(['example', 'local'])
export type TemplateOrigin = z.infer<typeof TemplateOrigin>

export const TemplateDefinition = z.object({
  name: z.string().min(1).max(200),
  pageType: z.string().min(1).max(64),
  description: z.string().max(2000).default(''),
  /** Section headings, in page order. */
  sections: z.array(z.string().min(1).max(200)).min(1).max(40),
  /** Field keys shown in the infobox at the top of the page, in order. Empty = all lore fields. */
  infoboxFields: z.array(z.string().min(1).max(64)).max(60).default([]),
  /** Title of the statistics block for mechanics fields. */
  mechanicsHeading: z.string().min(1).max(200).default('Statistics'),
  includeSourcesSection: z.boolean().default(true),
  /** Free-text notes, e.g. a description of the matching template in LegendKeeper. */
  notes: z.string().max(4000).default(''),
  /** A layout copied from LegendKeeper. When set, it replaces the app's own page layout. */
  lkLayout: LkLayout.nullable().default(null),
  /** How strictly pages follow a layout copied from LegendKeeper (see LayoutRules). */
  layoutRules: LayoutRules.default({ emptyFields: 'keep', emptySections: 'remove', additions: 'add' }),
})
export type TemplateDefinition = z.infer<typeof TemplateDefinition>
export type TemplateDefinitionInput = z.input<typeof TemplateDefinition>

export interface PageTemplate {
  id: string
  origin: TemplateOrigin
  definition: TemplateDefinition
  createdAt: string
  updatedAt: string
}

export const EXAMPLE_TEMPLATES: { id: string; definition: TemplateDefinitionInput }[] = BUILT_IN_PAGE_TYPES.map((type) => ({
  id: `example-${type.id.replace(/_/g, '-')}`,
  definition: {
    name: `${type.label} (example)`,
    pageType: type.id,
    description: `A starting point for ${type.label} pages. Duplicate it to make your own.`,
    sections: type.sections,
    infoboxFields: type.fields.filter((field) => field.group === 'lore').map((field) => field.key),
    mechanicsHeading: 'Statistics',
    includeSourcesSection: true,
  },
}))
