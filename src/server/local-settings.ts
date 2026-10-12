import 'server-only'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The settings file on this computer: API keys and a few preferences, in `NAME=value` lines.
 *
 * - When the app runs from the Windows package (or with `LKC_HOME` set), the file is
 *   `<LKC_HOME>/settings.env`, in your user profile, outside the app folder, so updating the
 *   app never touches it.
 * - When it runs from the source folder, the file is `.env.local` there (as before).
 *
 * It is the only place keys are stored on disk: never in the database, never in logs. The
 * Settings page can write it ("Save on this computer"); it never reads keys back out to the
 * browser. Anyone who can read your user profile can read this file, as with `.env.local`.
 */

/** Settings the app may write. Anything else in the file is left exactly as it is. */
export const WRITABLE_SETTINGS = ['LEGENDKEEPER_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'LKC_AI_PROVIDER', 'LKC_SANDBOX_PARENT_ID', 'LKC_UPDATE_CHECK'] as const
export type WritableSetting = (typeof WRITABLE_SETTINGS)[number]

export function appHome(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LKC_HOME?.trim() || null
}

export function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = appHome(env)
  return home ? join(home, 'settings.env') : join(process.cwd(), '.env.local')
}

let cache: { path: string; mtimeMs: number; values: Record<string, string> } | null = null

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) out[key] = value
  }
  return out
}

/** The values in the settings file (re-read only when the file changes). */
export function readSettingsFile(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = settingsFilePath(env)
  try {
    const { mtimeMs } = statSync(path)
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.values
    const values = parse(readFileSync(path, 'utf8'))
    cache = { path, mtimeMs, values }
    return values
  } catch {
    return {}
  }
}

/**
 * Sets or removes one setting in the file, keeping every other line (and comments) as they
 * are. Written to a temporary file first, then moved into place.
 */
export function writeSetting(name: WritableSetting, value: string | null, env: NodeJS.ProcessEnv = process.env) {
  if (!WRITABLE_SETTINGS.includes(name)) throw new Error('Not a writable setting.')
  if (value !== null && /[\r\n]/.test(value)) throw new Error('Settings cannot contain line breaks.')
  const path = settingsFilePath(env)
  mkdirSync(dirname(path), { recursive: true })
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : ['# LK Companion settings. Keep this file private; it holds your API keys.']
  let found = false
  const next: string[] = []
  for (const line of lines) {
    const key = line.trim().split('=')[0]?.trim()
    if (key === name && !line.trim().startsWith('#')) {
      if (!found && value !== null) next.push(`${name}=${value}`)
      found = true
      continue
    }
    next.push(line)
  }
  if (!found && value !== null) next.push(`${name}=${value}`)
  while (next.length && next.at(-1) === '') next.pop()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${next.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows ignores POSIX modes; the file is in your user profile.
  }
  cache = null
}
