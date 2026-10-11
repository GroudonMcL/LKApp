import { z } from 'zod'
import { LkLayout } from './lk-layout'
import { BUILT_IN_PAGE_TYPES } from './page-types'

/**
 * Page templates.
 *
 * LegendKeeper's v3 API has no operation to apply the templates you build in the app (see
 * docs/CAPABILITIES.md). Templates here are stored locally and come in two forms:
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
