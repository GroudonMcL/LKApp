import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

/**
 * A small wrapper around Node's built-in SQLite module (`node:sqlite`, Node 22.13+).
 *
 * Using the built-in module means there is no native add-on to download or compile, so
 * `npm ci` works the same on Windows, macOS and Linux without any build tools.
 * The wrapper offers the few conveniences the repositories use: prepared statements that
 * accept named parameters (`@name`) from an object (extra keys are ignored, `undefined`
 * becomes NULL, booleans become 0/1), `pragma()`, and `transaction()`.
 */

type Params = Record<string, unknown> | unknown[]

function toValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value as SQLInputValue
}

export class Statement {
  private readonly names: string[]

  constructor(
    private readonly statement: StatementSync,
    sql: string,
  ) {
    this.names = [...new Set([...sql.matchAll(/[@$:]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))]
  }

  private args(params: unknown[]): SQLInputValue[] | [Record<string, SQLInputValue>] {
    const first = params[0]
    if (params.length === 1 && first !== null && typeof first === 'object' && !Array.isArray(first) && !(first instanceof Uint8Array)) {
      const object = first as Record<string, unknown>
      const named: Record<string, SQLInputValue> = {}
      for (const name of this.names) named[name] = toValue(object[name])
      return [named]
    }
    return params.map(toValue)
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.statement.run(...(this.args(params) as SQLInputValue[]))
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  get(...params: unknown[]): unknown {
    return this.statement.get(...(this.args(params) as SQLInputValue[]))
  }

  all(...params: unknown[]): unknown[] {
    return this.statement.all(...(this.args(params) as SQLInputValue[]))
  }
}

export class SqliteDb {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(path: string) {
    this.db = new DatabaseSync(path)
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql), sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  pragma(setting: string): void {
    this.db.exec(`PRAGMA ${setting}`)
  }

  /** Wraps `fn` in a transaction (a savepoint when nested). Returns a function, like better-sqlite3. */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const savepoint = `sp_${this.depth}`
      this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
      this.depth++
      try {
        const result = fn()
        this.depth--
        this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (error) {
        this.depth--
        this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
        throw error
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

export type { Params }
