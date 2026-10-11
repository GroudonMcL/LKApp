/**
 * Response types for the UI, derived from the server code. These are type-only imports:
 * they are erased at build time, so no server code (or secret) reaches the browser bundle.
 */
import type { connectionSummary, ConnectionCheck } from '@/server/services/connection'
import type { scanStatus, browseIndex } from '@/server/services/discovery'
import type { draftView } from '@/server/services/drafts'
import type { prepareWrite, approveWrite, Blocker } from '@/server/services/write'
import type { TagOverview } from '@/server/services/tags'
import type { batchView, listBatches } from '@/server/services/import-batches'
import type { healthDashboard, listFindings } from '@/server/services/wiki-health'
import type { taggingView } from '@/server/services/tagging-batches'
import type { layoutReport, LkTemplateListing } from '@/server/services/lk-templates'
import type { PageTemplate } from '@/core/template'
import type { AuditEvent, ImportJob } from '@/server/db/repositories'
import type { ResourceDetail, DocumentContent, SearchHit, ResourcePage } from '@/server/lk/types'

export type ConnectionSummary = ReturnType<typeof connectionSummary>
export type { ConnectionCheck, TagOverview, AuditEvent, ResourceDetail, DocumentContent, SearchHit, ResourcePage, Blocker }
export type ScanStatus = ReturnType<typeof scanStatus>
export type BatchView = ReturnType<typeof batchView>
export type BatchItemRow = BatchView['items'][number]
export type BatchListing = ReturnType<typeof listBatches>
export type HealthDashboard = ReturnType<typeof healthDashboard>
export type TaggingView = ReturnType<typeof taggingView>
export type TaggingItem = TaggingView['items'][number]
export type FindingRow = ReturnType<typeof listFindings>['items'][number]
export type { LkTemplateListing }
export type LayoutReport = NonNullable<ReturnType<typeof layoutReport>>
export type TemplateWithReport = PageTemplate & { layoutReport: LayoutReport | null }
export type BrowseResult = ReturnType<typeof browseIndex>
export type DraftView = ReturnType<typeof draftView> & { writeBlockers: Blocker[] }
export type WritePreview = Awaited<ReturnType<typeof prepareWrite>>
export type WriteResult = Awaited<ReturnType<typeof approveWrite>>
export type JobSummary = Omit<ImportJob, 'sourceText' | 'sourceJson'> & { draft: { id: string; status: string; name: string; createdResourceId: string | null } | null }
export type JobDetail = Omit<ImportJob, 'sourceJson'>

export interface StatusResponse {
  connection: ConnectionSummary
  index: ScanStatus
  imports: Record<string, number>
  pagesCreated: number
  recipes: number
  writeBlockers: Blocker[]
  recentActivity: AuditEvent[]
}
