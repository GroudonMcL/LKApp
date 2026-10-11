import 'server-only'
import type { Db } from './connection'

const now = () => new Date().toISOString()
const parse = <T>(value: string | null | undefined, fallback: T): T => (value === null || value === undefined ? fallback : (JSON.parse(value) as T))

/**
 * - `saved`: recorded before the write; the write's outcome is not known yet.
 * - `applied`: the migration was written (result_version is the page version after it).
 * - `not_applied`: LegendKeeper confirmed nothing was written.
 * - `restored`: the original content was written back (restore_version).
 */
export type BackupStatus = 'saved' | 'applied' | 'not_applied' | 'restored'

export interface MigrationBackup {
  id: string
  batchId: string
  itemId: string
  projectId: string | null
  resourceId: string
  resourceName: string
  documentId: string
  originalVersion: string
  originalBlocks: unknown[]
  originalTags: string[]
  proposedBlocks: unknown[]
  proposedTags: string[] | null
  status: BackupStatus
  resultVersion: string | null
  restoreVersion: string | null
  note: string | null
  createdAt: string
  appliedAt: string | null
  restoredAt: string | null
}

interface Row {
  id: string; batch_id: string; item_id: string; project_id: string | null; resource_id: string; resource_name: string; document_id: string
  original_version: string; original_blocks: string; original_tags: string; proposed_blocks: string; proposed_tags: string | null; status: BackupStatus
  result_version: string | null; restore_version: string | null; note: string | null; created_at: string; applied_at: string | null; restored_at: string | null
}

const toBackup = (r: Row): MigrationBackup => ({
  id: r.id,
  batchId: r.batch_id,
  itemId: r.item_id,
  projectId: r.project_id,
  resourceId: r.resource_id,
  resourceName: r.resource_name,
  documentId: r.document_id,
  originalVersion: r.original_version,
  originalBlocks: parse(r.original_blocks, []),
  originalTags: parse(r.original_tags, []),
  proposedBlocks: parse(r.proposed_blocks, []),
  proposedTags: parse(r.proposed_tags, null),
  status: r.status,
  resultVersion: r.result_version,
  restoreVersion: r.restore_version,
  note: r.note,
  createdAt: r.created_at,
  appliedAt: r.applied_at,
  restoredAt: r.restored_at,
})

export class MigrationBackupsRepo {
  constructor(private readonly db: Db) {}

  insert(b: Omit<MigrationBackup, 'createdAt' | 'appliedAt' | 'restoredAt' | 'resultVersion' | 'restoreVersion' | 'note' | 'status'>): MigrationBackup {
    this.db
      .prepare(
        `INSERT INTO migration_backups (id, batch_id, item_id, project_id, resource_id, resource_name, document_id, original_version, original_blocks, original_tags,
           proposed_blocks, proposed_tags, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?)`,
      )
      .run(b.id, b.batchId, b.itemId, b.projectId, b.resourceId, b.resourceName, b.documentId, b.originalVersion, JSON.stringify(b.originalBlocks), JSON.stringify(b.originalTags), JSON.stringify(b.proposedBlocks), b.proposedTags ? JSON.stringify(b.proposedTags) : null, now())
    return this.get(b.id)!
  }

  get(id: string): MigrationBackup | null {
    const row = this.db.prepare('SELECT * FROM migration_backups WHERE id = ?').get(id) as Row | undefined
    return row ? toBackup(row) : null
  }

  /** The newest record for a batch item. */
  latestForItem(itemId: string): MigrationBackup | null {
    const row = this.db.prepare('SELECT * FROM migration_backups WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(itemId) as Row | undefined
    return row ? toBackup(row) : null
  }

  listForResource(resourceId: string): MigrationBackup[] {
    return (this.db.prepare('SELECT * FROM migration_backups WHERE resource_id = ? ORDER BY created_at DESC').all(resourceId) as Row[]).map(toBackup)
  }

  listForBatch(batchId: string): Omit<MigrationBackup, 'originalBlocks' | 'proposedBlocks'>[] {
    return (this.db.prepare('SELECT * FROM migration_backups WHERE batch_id = ? ORDER BY created_at').all(batchId) as Row[]).map((r) => {
      const { originalBlocks: _o, proposedBlocks: _p, ...rest } = toBackup(r)
      return rest
    })
  }

  mark(id: string, patch: { status: BackupStatus; resultVersion?: string | null; restoreVersion?: string | null; note?: string | null }) {
    const current = this.get(id)
    if (!current) return
    const at = now()
    this.db
      .prepare('UPDATE migration_backups SET status = ?, result_version = ?, restore_version = ?, note = ?, applied_at = ?, restored_at = ? WHERE id = ?')
      .run(
        patch.status,
        patch.resultVersion !== undefined ? patch.resultVersion : current.resultVersion,
        patch.restoreVersion !== undefined ? patch.restoreVersion : current.restoreVersion,
        patch.note !== undefined ? patch.note : current.note,
        patch.status === 'applied' ? at : current.appliedAt,
        patch.status === 'restored' ? at : current.restoredAt,
        id,
      )
  }
}
