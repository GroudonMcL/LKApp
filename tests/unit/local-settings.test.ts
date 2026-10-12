import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getConfig } from '@/server/config'
import { readSettingsFile, settingsFilePath, writeSetting } from '@/server/local-settings'

const home = () => mkdtempSync(join(tmpdir(), 'lkc-home-'))
const env = (h: string) => ({ NODE_ENV: 'test', LKC_HOME: h }) as unknown as NodeJS.ProcessEnv

describe('the settings file on this computer', () => {
  it('lives in LKC_HOME when the app is installed from the package', () => {
    const h = home()
    expect(settingsFilePath(env(h))).toBe(join(h, 'settings.env'))
    // The database moves there too.
    expect(getConfig(env(h)).databasePath).toBe(join(h, 'lk-companion.db'))
    expect(getConfig({ NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv).databasePath).toBe('./data/lk-companion.db')
  })

  it('sets, replaces and removes one setting, keeping every other line', () => {
    const h = home()
    writeFileSync(join(h, 'settings.env'), '# my notes\nLKC_SANDBOX_PARENT_ID=abc12345\nOTHER=1\n')
    writeSetting('LEGENDKEEPER_API_KEY', 'lk_first_value_123', env(h))
    writeSetting('LEGENDKEEPER_API_KEY', 'lk_second_value_456', env(h))
    expect(readSettingsFile(env(h))).toEqual({ LKC_SANDBOX_PARENT_ID: 'abc12345', OTHER: '1', LEGENDKEEPER_API_KEY: 'lk_second_value_456' })
    expect(readFileSync(join(h, 'settings.env'), 'utf8')).toContain('# my notes')
    writeSetting('LEGENDKEEPER_API_KEY', null, env(h))
    expect(readSettingsFile(env(h))).toEqual({ LKC_SANDBOX_PARENT_ID: 'abc12345', OTHER: '1' })
  })

  it('refuses values that would break the file, and settings it does not manage', () => {
    const h = home()
    expect(() => writeSetting('OPENROUTER_API_KEY', 'sk-or-abc\nLKC_ALLOW_WRITES=false', env(h))).toThrow(/line breaks/)
    expect(() => writeSetting('LKC_ALLOW_WRITES' as never, 'false', env(h))).toThrow(/Not a writable setting/)
  })

  it('creates the file only readable by you (where the system supports it)', () => {
    const h = home()
    writeSetting('OPENROUTER_API_KEY', 'sk-or-test-value-1234', env(h))
    if (process.platform !== 'win32') {
      const { statSync } = require('node:fs') as typeof import('node:fs')
      expect(statSync(join(h, 'settings.env')).mode & 0o077).toBe(0)
    }
  })
})
