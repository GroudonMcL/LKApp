/**
 * Creates the local database (if needed) and applies any pending migrations.
 * The app also does this automatically on start; this command lets you do it explicitly.
 *
 *   npm run db:migrate
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/server/db/migrations'

function envPath(): string {
  if (process.env.LKC_DATABASE_PATH) return process.env.LKC_DATABASE_PATH
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('LKC_DATABASE_PATH='))
    const value = line?.slice('LKC_DATABASE_PATH='.length).trim()
    if (value) return value
  }
  return './data/lk-companion.db'
}

const path = envPath()
mkdirSync(dirname(resolve(path)), { recursive: true })
const db = new Database(path)
const applied = migrate(db)
db.close()
console.log(applied.length ? `Applied migrations ${applied.join(', ')} to ${path}` : `Database ${path} is up to date.`)
