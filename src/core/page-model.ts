import { z } from 'zod'

/**
 * The canonical page model: how this app represents a page internally.
 *
 * It is independent of LegendKeeper's block format. A draft is converted to
 * LegendKeeper blocks only at the very end, by the connector's renderer, so the
 * rest of the app (AI, validation, review UI) never depends on SDK details.
 */

export const CANONICAL_SCHEMA_VERSION = 1

/**
 * Where a field value came from.
 * - `source`: stated in the imported source (should be quotable).
 * - `suggested`: an interpretation or suggestion, not a source fact. Never written unless confirmed.
 * - `uncertain`: the source is ambiguous or contradictory. Never written unless confirmed.
 * - `missing`: the source does not say. Never guessed.
 * - `user`: entered or confirmed by the user in the review screen.
 */
export const FieldStatus = z.enum(['source', 'suggested', 'uncertain', 'missing', 'user'])
export type FieldStatus = z.infer<typeof FieldStatus>

/** Statuses whose values are written to LegendKeeper. Everything else is review-only. */
export const WRITABLE_FIELD_STATUSES: readonly FieldStatus[] = ['source', 'user']

export const PageField = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  group: z.enum(['lore', 'mechanics']),
  value: z.string().max(5000).nullable(),
  status: FieldStatus,
  /** A short verbatim quote from the source that supports the value. */
  sourceQuote: z.string().max(2000).nullable().default(null),
  note: z.string().max(2000).nullable().default(null),
})
export type PageField = z.infer<typeof PageField>

export const SectionKind = z.enum(['lore', 'mechanics', 'notes', 'unmapped'])
export type SectionKind = z.infer<typeof SectionKind>

export const PageSection = z.object({
  id: z.string().min(1).max(64),
  heading: z.string().min(1).max(200),
  kind: SectionKind,
  paragraphs: z.array(z.string().max(20000)).max(500),
})
export type PageSection = z.infer<typeof PageSection>

export const TagStatus = z.enum(['existing', 'case_variant', 'new', 'rejected'])
export type TagStatus = z.infer<typeof TagStatus>

export const TagProposal = z.object({
  value: z.string().min(1).max(100),
  status: TagStatus,
  /** The exact spelling of the matching existing tag, if any. */
  existingMatch: z.string().nullable().default(null),
  /** A similar existing tag, offered as a "did you mean" hint for new tags. */
  similarTo: z.string().nullable().default(null),
  origin: z.enum(['recipe', 'page_type', 'ai', 'user']),
  accepted: z.boolean(),
  reason: z.string().max(500).default(''),
})
export type TagProposal = z.infer<typeof TagProposal>

export const ReferenceMatchType = z.enum(['exact_name', 'exact_alias', 'case_insensitive', 'normalized', 'partial', 'search'])
export type ReferenceMatchType = z.infer<typeof ReferenceMatchType>

export const ReferenceCandidate = z.object({
  resourceId: z.string().min(1),
  name: z.string(),
  matchType: ReferenceMatchType,
  path: z.string().nullable().default(null),
})
export type ReferenceCandidate = z.infer<typeof ReferenceCandidate>

export const ReferenceStatus = z.enum(['resolved', 'ambiguous', 'unresolved', 'left_unresolved'])
export type ReferenceStatus = z.infer<typeof ReferenceStatus>

export const PageReference = z.object({
  id: z.string().min(1).max(64),
  /** The text as it appears in the source, e.g. "Mordenkainen". */
  mention: z.string().min(1).max(500),
  /** How the page relates to it, e.g. "member of", "ruled by". Optional. */
  relation: z.string().max(200).nullable().default(null),
  candidates: z.array(ReferenceCandidate).max(50).default([]),
  status: ReferenceStatus,
  resourceId: z.string().nullable().default(null),
  resolvedBy: z.enum(['auto_exact', 'user']).nullable().default(null),
  /** Set when the resource ID was confirmed to exist in LegendKeeper (at write time). */
  verifiedAt: z.string().nullable().default(null),
  origin: z.enum(['ai', 'index_scan', 'user']).default('ai'),
})
export type PageReference = z.infer<typeof PageReference>

export const SourceAttribution = z.object({
  title: z.string().min(1).max(500),
  kind: z.string().max(50),
  citation: z.string().max(1000).nullable().default(null),
  jobId: z.string().nullable().default(null),
  importedAt: z.string(),
})
export type SourceAttribution = z.infer<typeof SourceAttribution>

export const ProcessingMetadata = z.object({
  mode: z.enum(['ai', 'structural']),
  model: z.string().nullable().default(null),
  servedByModel: z.string().nullable().default(null),
  promptVersion: z.string().nullable().default(null),
  recipeId: z.string().nullable().default(null),
  recipeVersion: z.number().int().nullable().default(null),
  generatedAt: z.string(),
  inputTokens: z.number().int().nullable().default(null),
  outputTokens: z.number().int().nullable().default(null),
  detectedPageType: z.string().nullable().default(null),
  pageTypeConfidence: z.enum(['high', 'medium', 'low']).nullable().default(null),
})
export type ProcessingMetadata = z.infer<typeof ProcessingMetadata>

export const MigrationMetadata = z.object({
  sourceResourceId: z.string().nullable().default(null),
  sourceDocumentId: z.string().nullable().default(null),
  sourceVersion: z.string().nullable().default(null),
  notes: z.string().max(2000).default(''),
})
export type MigrationMetadata = z.infer<typeof MigrationMetadata>

export const CanonicalPage = z.object({
  schemaVersion: z.literal(CANONICAL_SCHEMA_VERSION),
  externalSourceId: z.string().max(500).nullable().default(null),
  /** Set once the page exists in LegendKeeper. */
  lkResourceId: z.string().nullable().default(null),
  name: z.string().max(500),
  aliases: z.array(z.string().min(1).max(256)).max(128).default([]),
  pageType: z.string().min(1).max(64),
  parentId: z.string().nullable().default(null),
  tags: z.array(TagProposal).max(100).default([]),
  templateId: z.string().nullable().default(null),
  fields: z.array(PageField).max(120).default([]),
  sections: z.array(PageSection).max(100).default([]),
  references: z.array(PageReference).max(200).default([]),
  sources: z.array(SourceAttribution).max(20).default([]),
  reviewerNotes: z.array(z.string().max(2000)).max(100).default([]),
  processing: ProcessingMetadata.nullable().default(null),
  migration: MigrationMetadata.nullable().default(null),
})
export type CanonicalPage = z.infer<typeof CanonicalPage>
export type CanonicalPageInput = z.input<typeof CanonicalPage>

export const FindingSeverity = z.enum(['error', 'warning', 'info'])
export type FindingSeverity = z.infer<typeof FindingSeverity>

/**
 * A validation finding. Errors block writing. Warnings must be acknowledged at approval.
 * Info is shown for context only.
 */
export const ValidationFinding = z.object({
  severity: FindingSeverity,
  code: z.string(),
  path: z.string().nullable().default(null),
  message: z.string(),
})
export type ValidationFinding = z.infer<typeof ValidationFinding>

export function acceptedTags(page: CanonicalPage): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of page.tags) {
    if (!tag.accepted || tag.status === 'rejected') continue
    const value = tag.existingMatch ?? tag.value
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

export function writableFields(page: CanonicalPage, group?: 'lore' | 'mechanics'): PageField[] {
  return page.fields.filter(
    (field) =>
      field.value !== null &&
      field.value.trim() !== '' &&
      WRITABLE_FIELD_STATUSES.includes(field.status) &&
      (group === undefined || field.group === group),
  )
}

export function resolvedReferences(page: CanonicalPage): PageReference[] {
  return page.references.filter((ref) => ref.status === 'resolved' && ref.resourceId)
}
