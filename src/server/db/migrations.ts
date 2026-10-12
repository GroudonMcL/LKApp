import type { SqliteDb } from './sqlite'

/**
 * Database migrations, applied in order and recorded in `schema_migrations`.
 * Never edit a released migration; add a new one instead.
 *
 * What is stored, and why:
 * - recipes, templates: your saved conversion settings.
 * - import_jobs: each import, its status, and the source text *only while the job is open*
 *   (it is purged when the job is completed or cancelled; a SHA-256 hash is kept).
 * - drafts / draft_revisions: the canonical draft and earlier versions of it.
 * - audit_events: what was done, when, with which recipe and model, and the outcome.
 * - lk_index_*: a metadata-only index of your LegendKeeper resources (names, tags,
 *   aliases, parents). No page content. Used for tag audits and link suggestions.
 * - write_verifications: proof that page creation worked against your project.
 * - settings: non-secret preferences. API keys are never stored in the database.
 * - batches / batch_sources / batch_items: batch jobs (Phase 2). Source text and uploaded
 *   files are kept only while a batch is open, then deleted (hashes stay).
 * - ai_cache: AI results keyed by a fingerprint of their inputs, so identical work is not
 *   paid for twice.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('example', 'local')),
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipe_versions (
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, version)
);

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  source_name TEXT,
  source_kind TEXT NOT NULL,
  source_format TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_text TEXT,
  source_json TEXT,
  source_purged_at TEXT,
  attribution TEXT NOT NULL,
  recipe_id TEXT,
  page_type_guesses TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX import_jobs_created ON import_jobs(created_at);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES import_jobs(id),
  revision INTEGER NOT NULL,
  page TEXT NOT NULL,
  status TEXT NOT NULL,
  findings TEXT NOT NULL DEFAULT '[]',
  validated_at TEXT,
  recipe_id TEXT,
  recipe_version INTEGER,
  planned_resource_id TEXT,
  idempotency_key TEXT,
  approval_token TEXT,
  approval_payload_hash TEXT,
  approval_expires_at TEXT,
  created_resource_id TEXT,
  created_document_id TEXT,
  created_version TEXT,
  write_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE draft_revisions (
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  revision INTEGER NOT NULL,
  page TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (draft_id, revision)
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  approval TEXT NOT NULL DEFAULT 'not_required',
  project_id TEXT,
  resource_id TEXT,
  job_id TEXT,
  draft_id TEXT,
  recipe_id TEXT,
  recipe_version INTEGER,
  model TEXT,
  request_id TEXT,
  error_code TEXT,
  message TEXT,
  details TEXT
);
CREATE INDEX audit_events_at ON audit_events(at);

CREATE TABLE lk_index_resources (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  parent_id TEXT,
  tags TEXT NOT NULL,
  tag_count INTEGER NOT NULL,
  aliases TEXT NOT NULL,
  documents TEXT NOT NULL,
  icon_glyph TEXT,
  is_hidden INTEGER NOT NULL,
  rank TEXT,
  updated_at TEXT,
  scan_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX lk_index_name ON lk_index_resources(project_id, name_lower);
CREATE INDEX lk_index_parent ON lk_index_resources(project_id, parent_id);
CREATE INDEX lk_index_tag_count ON lk_index_resources(project_id, tag_count);

CREATE TABLE lk_index_scans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  resources INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE write_verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  document_id TEXT,
  details TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'batches: multi-file, multi-record jobs and shared batch items',
    sql: `
-- A batch is one job over many items: importing records, applying tags, migrating pages.
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  recipe_id TEXT,
  recipe_version INTEGER,
  template_id TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX batches_created ON batches(created_at);

-- The input files of an import batch. Text is kept only while the batch is open.
CREATE TABLE batch_sources (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  original_format TEXT NOT NULL,
  format TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  method TEXT NOT NULL,
  title TEXT,
  text TEXT,
  json TEXT,
  pages TEXT NOT NULL DEFAULT '[]',
  total_pages INTEGER,
  media_type TEXT,
  blob BLOB,
  warnings TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  purged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX batch_sources_batch ON batch_sources(batch_id, seq);

-- One item per record or page. Status: pending, processing, awaiting_review, approved,
-- running, succeeded, failed, skipped, cancelled, needs_reconciliation.
CREATE TABLE batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  source_id TEXT,
  job_id TEXT,
  resource_id TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  match TEXT,
  decision TEXT,
  plan TEXT,
  plan_hash TEXT,
  base_fingerprint TEXT,
  approved_at TEXT,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX batch_items_batch ON batch_items(batch_id, seq);
CREATE INDEX batch_items_status ON batch_items(batch_id, status);

-- Records of a batch are import jobs (each with its own draft), linked back to the batch.
ALTER TABLE import_jobs ADD COLUMN batch_id TEXT;
ALTER TABLE import_jobs ADD COLUMN record_meta TEXT;
CREATE INDEX import_jobs_batch ON import_jobs(batch_id);

-- AI results reused for an identical record, recipe version, template and prompt version.
CREATE TABLE ai_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  output TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'wiki health: audit runs, findings and a page-content cache',
    sql: `
-- One audit run: its scope, progress and outcome. Audits only read from LegendKeeper.
CREATE TABLE audit_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scope TEXT NOT NULL,
  checks TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  reused INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

-- Findings persist across runs. key identifies the same finding in later runs.
CREATE TABLE audit_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  certainty TEXT NOT NULL,
  resource_id TEXT,
  resource_name TEXT,
  related TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  remedy TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  status_note TEXT,
  fingerprint TEXT,
  status_fingerprint TEXT,
  run_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status_changed_at TEXT,
  UNIQUE (project_id, key)
);
CREATE INDEX audit_findings_category ON audit_findings(project_id, category, status);
CREATE INDEX audit_findings_resource ON audit_findings(project_id, resource_id);

-- What the audit last read of a page: its document version (the fingerprint) and a
-- structural summary. No full copy of the page is kept beyond a short text sample.
CREATE TABLE lk_content_cache (
  project_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version TEXT NOT NULL,
  structure TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (project_id, resource_id)
);
`,
  },
  {
    version: 4,
    name: 'template migration: recovery records (original and proposed page content)',
    sql: `
-- Recovery records for template migration. Before a page's content is replaced, the
-- original blocks (exactly as LegendKeeper returned them, with block ids) and the proposed
-- blocks are saved here. Rows are never deleted automatically.
CREATE TABLE migration_backups (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  project_id TEXT,
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  document_id TEXT NOT NULL,
  original_version TEXT NOT NULL,
  original_blocks TEXT NOT NULL,
  original_tags TEXT NOT NULL DEFAULT '[]',
  proposed_blocks TEXT NOT NULL,
  proposed_tags TEXT,
  status TEXT NOT NULL,
  result_version TEXT,
  restore_version TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  restored_at TEXT
);
CREATE INDEX migration_backups_item ON migration_backups(item_id);
CREATE INDEX migration_backups_resource ON migration_backups(resource_id);
`,
  },
  {
    version: 5,
    name: 'chronology and knowledge analysis: native timeline cache, findings and candidates, saved searches',
    sql: `
-- Native LegendKeeper timelines (documents of type "time"), as last read. Read-only copies.
CREATE TABLE lk_timelines (
  project_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  name TEXT NOT NULL,
  calendar_id TEXT,
  lanes TEXT NOT NULL DEFAULT '[]',
  event_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (project_id, document_id)
);

CREATE TABLE lk_timeline_events (
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  lane_id TEXT,
  lane_name TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  formatted_start TEXT,
  formatted_end TEXT,
  start_date TEXT,
  end_date TEXT,
  detail INTEGER,
  uri TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (project_id, document_id, event_id)
);

-- Findings of chronology and knowledge analysis, and event candidates, with your decisions.
-- key identifies the same finding from the same evidence in later runs; fingerprint changes
-- when the cited passages change, which re-opens a decision taken on the old wording.
CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  resource_ids TEXT NOT NULL DEFAULT '[]',
  data TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '[]',
  edits TEXT,
  origin TEXT NOT NULL,
  certainty TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  status_note TEXT,
  status_fingerprint TEXT,
  draft_job_id TEXT,
  run_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status_changed_at TEXT,
  UNIQUE (project_id, key)
);
CREATE INDEX knowledge_items_kind ON knowledge_items(project_id, kind, status);

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  ai TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Native timeline event writes: what was approved, the event id chosen before the write, and
-- what LegendKeeper returned on reading it back.
CREATE TABLE timeline_writes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_id TEXT,
  resource_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  readback TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  written_at TEXT
);
`,
  },
]

/** Applies pending migrations in order, each in its own transaction. Returns the versions applied. */
export function migrate(db: SqliteDb): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version))
  const ran: number[] = []
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      )
    })()
    ran.push(migration.version)
  }
  return ran
}
