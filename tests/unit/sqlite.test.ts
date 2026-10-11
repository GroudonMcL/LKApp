import { describe, expect, it } from 'vitest'
import { SqliteDb } from '@/server/db/sqlite'

describe('built-in SQLite adapter', () => {
  const db = () => {
    const d = new SqliteDb(':memory:')
    d.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, flag INTEGER, note TEXT)')
    return d
  }

  it('binds named parameters from an object, ignoring extra keys; undefined → NULL, booleans → 0/1', () => {
    const d = db()
    d.prepare('INSERT INTO t (id, n, flag, note) VALUES (@id, @n, @flag, @note)').run({ id: 'a', n: 2, flag: true, note: undefined, extra: 'ignored' })
    expect(d.prepare('SELECT * FROM t WHERE id = ?').get('a')).toEqual({ id: 'a', n: 2, flag: 1, note: null })
  })

  it('reports changes and returns undefined for no row', () => {
    const d = db()
    expect(d.prepare('INSERT INTO t (id) VALUES (?)').run('x').changes).toBe(1)
    expect(d.prepare('SELECT * FROM t WHERE id = ?').get('missing')).toBeUndefined()
  })

  it('rolls back a failed transaction, including nested ones', () => {
    const d = db()
    expect(() =>
      d.transaction(() => {
        d.prepare('INSERT INTO t (id) VALUES (?)').run('kept?')
        d.transaction(() => d.prepare('INSERT INTO t (id) VALUES (?)').run('inner'))()
        throw new Error('boom')
      })(),
    ).toThrow('boom')
    expect(d.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 })
    d.transaction(() => d.prepare('INSERT INTO t (id) VALUES (?)').run('ok'))()
    expect(d.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 })
  })

  it('supports the JSON functions the resource index uses', () => {
    const d = db()
    d.prepare('INSERT INTO t (id, note) VALUES (?, ?)').run('j', JSON.stringify(['NPC', 'Ally']))
    expect(d.prepare("SELECT COUNT(*) AS n FROM t, json_each(t.note) WHERE value = 'Ally'").get()).toEqual({ n: 1 })
  })
})
