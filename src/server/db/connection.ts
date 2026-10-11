import 'server-only'
import { SqliteDb } from './sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { migrate } from './migrations'

export { migrate }

export type Db = SqliteDb

/** Opens a database and applies any pending migrations. `:memory:` gives a throwaway one. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new SqliteDb(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}
