import { describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '@/server/db/migrations'
import { createRepos } from '@/server/db/repositories'
import { SqliteDb } from '@/server/db/sqlite'

/** A database as Phase 1 left it: only the first migration applied, with real-looking rows. */
function phase1Database() {
  const db = new SqliteDb(':memory:')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  db.exec(MIGRATIONS[0]!.sql)
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)').run(MIGRATIONS[0]!.name, '2026-09-01T00:00:00Z')
  const at = '2026-09-01T00:00:00Z'
  // A Phase 1 recipe has none of the Phase 2 settings.
  const definition = JSON.stringify({ name: 'Old NPC recipe', targetPageType: 'npc', allowCreate: false, aiInstructions: 'Keep it short.' })
  db.prepare('INSERT INTO recipes (id, version, definition, archived, created_at, updated_at) VALUES (?, 1, ?, 0, ?, ?)').run('rcp_old', definition, at, at)
  db.prepare('INSERT INTO recipe_versions (recipe_id, version, definition, created_at) VALUES (?, 1, ?, ?)').run('rcp_old', definition, at)
  db.prepare(
    `INSERT INTO import_jobs (id, name, status, source_name, source_kind, source_format, source_size, source_sha256, source_text, attribution, recipe_id, warnings, created_at, updated_at)
     VALUES ('job_old', 'Eliander notes', 'drafted', 'notes.txt', 'paste', 'text', 11, 'x', 'Eliander...', ?, 'rcp_old', '[]', ?, ?)`,
  ).run(JSON.stringify({ title: 'notes', kind: 'paste', citation: null, jobId: 'job_old', importedAt: at }), at, at)
  return db
}

describe('database migrations', () => {
  it('upgrade a Phase 1 database in place, keeping its recipes and imports', () => {
    const db = phase1Database()
    expect(migrate(db)).toEqual(MIGRATIONS.slice(1).map((m) => m.version))
    // Running again changes nothing.
    expect(migrate(db)).toEqual([])

    const repos = createRepos(db)
    const recipe = repos.recipes.get('rcp_old')!
    expect(recipe.definition).toMatchObject({ name: 'Old NPC recipe', allowCreate: false, aiInstructions: 'Keep it short.' })
    // New settings get their defaults.
    expect(recipe.definition.migration).toEqual({ notesHeading: 'Notes from the previous layout', keptHeading: 'Kept from the previous layout', tagHandling: 'keep', linkHandling: 'keep_all' })
    expect(recipe.definition.duplicatePolicy).toBe('require_review')
    expect(repos.recipes.getVersion('rcp_old', 1)).toMatchObject({ name: 'Old NPC recipe' })

    const job = repos.jobs.get('job_old')!
    expect(job).toMatchObject({ name: 'Eliander notes', status: 'drafted', batchId: null, sourceText: 'Eliander...' })
    // Phase 2 tables exist and are empty.
    expect(repos.batches.list(null).total).toBe(0)
    expect(repos.migrationBackups.listForResource('anything')).toEqual([])
  })
})
