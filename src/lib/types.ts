/**
 * Response types for the UI, derived from the server code. These are type-only imports:
 * they are erased at build time, so no server code (or secret) reaches the browser bundle.
 */
import type { connectionSummary, ConnectionCheck } from '@/server/services/connection'
import type { scanStatus, browseIndex } from '@/server/services/discovery'
import type { draftView } from '@/server/services/drafts'
import type { prepareWrite, approveWrite, Blocker } from '@/server/services/write'
import type { TagOverview } from '@/server/services/tags'
import type { AuditEvent, ImportJob } from '@/server/db/repositories'
import type { ResourceDetail, DocumentContent, SearchHit, ResourcePage } from '@/server/lk/types'

export type ConnectionSummary = ReturnType<typeof connectionSummary>
export type { ConnectionCheck, TagOverview, AuditEvent, ResourceDetail, DocumentContent, SearchHit, ResourcePage, Blocker }
export type ScanStatus = ReturnType<typeof scanStatus>
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
