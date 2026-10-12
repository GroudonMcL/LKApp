import 'server-only'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '../context'
import { effectiveEnv } from '../config'
import { appHome, writeSetting } from '../local-settings'
import { extractZip, zipTopFolder } from '../unzip'
import { recordAudit } from './audit'
import { ServiceError } from './errors'

/**
 * Updates for the Windows app.
 *
 * Every change that passes the Windows checks on GitHub is published as a release of the
 * LKApp repository, tagged `build-<n>`, with the package zip and its SHA-256 checksum. The
 * app compares its own build number (`version.json` in the package) with the latest release:
 *
 * 1. Check: one request to GitHub's public API (`api.github.com`). Nothing about you or your
 *    data is sent; GitHub sees an ordinary request from your computer. On by default when the
 *    app starts (at most every 6 hours); can be switched off in Settings.
 * 2. Download: the zip from GitHub, checked against the release's SHA-256 checksum, unpacked
 *    into `<data folder>/updates/ready`. Nothing in the app folder changes yet.
 * 3. Restart: the app stops with a special exit code; "Start LK Companion" sees it, copies the
 *    new version over the app folder (your settings and data are elsewhere and are not
 *    touched), and starts it again.
 *
 * Only for the packaged app; the source folder is updated with git.
 */

export const UPDATE_REPO = process.env.LKC_UPDATE_REPO || 'GroudonMcL/LKApp'
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const MAX_ZIP_BYTES = 400_000_000
/** The exit code that asks "Start LK Companion" to apply a downloaded update and restart. */
export const RESTART_FOR_UPDATE_EXIT_CODE = 75

export interface AppVersion {
  version: string
  /** The GitHub build number; 0 for a package built by hand or the source folder. */
  build: number
  commit: string | null
  /** Running from the Windows package (updates possible). */
  packaged: boolean
}

export interface ReleaseInfo {
  build: number
  name: string
  notes: string
  publishedAt: string | null
  pageUrl: string
  zip: { name: string; url: string; size: number; digest: string | null }
  checksumUrl: string | null
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

interface CheckState {
  checkedAt: string | null
  latest: ReleaseInfo | null
  error: string | null
}
const STATE = Symbol.for('lk-companion.update-check')
const store = () => globalThis as unknown as Record<symbol, CheckState | undefined>

/** This app's version, from the package's `version.json` (the launcher says where the package is). */
export function currentVersion(env: NodeJS.ProcessEnv = process.env): AppVersion {
  const dir = env.LKC_APP_DIR
  if (dir) {
    try {
      const info = JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')) as { version?: string; build?: number; commit?: string }
      return { version: info.version ?? '0.0.0', build: Number(info.build) || 0, commit: info.commit ?? null, packaged: true }
    } catch {
      /* fall through */
    }
  }
  let version = '0.0.0'
  try {
    version = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? version
  } catch {
    /* standalone package without package.json */
  }
  return { version, build: 0, commit: null, packaged: false }
}

export function updateChecksEnabled(): boolean {
  return (effectiveEnv().LKC_UPDATE_CHECK ?? '').toLowerCase() !== 'off'
}

function buildOf(release: { tag_name?: string; name?: string }): number {
  const match = /build[-\s]?(\d+)/i.exec(release.tag_name ?? '') ?? /build[-\s]?(\d+)/i.exec(release.name ?? '')
  return match ? Number(match[1]) : 0
}

/** The newest published release, or null when there is none (or the repository is not public). */
export async function latestRelease(fetchImpl: Fetch = fetch): Promise<ReleaseInfo | null> {
  const response = await fetchImpl(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'LK-Companion-updater' },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`)
  const release = (await response.json()) as {
    tag_name?: string
    name?: string
    body?: string
    published_at?: string
    html_url?: string
    assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[]
  }
  const assets = release.assets ?? []
  const zip = assets.find((a) => /^LK-Companion-Windows.*\.zip$/i.test(a.name))
  if (!zip) return null
  const checksum = assets.find((a) => a.name === `${zip.name}.sha256`)
  return {
    build: buildOf(release),
    name: release.name ?? release.tag_name ?? 'New version',
    notes: (release.body ?? '').slice(0, 4000),
    publishedAt: release.published_at ?? null,
    pageUrl: release.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
    zip: { name: zip.name, url: zip.browser_download_url, size: zip.size, digest: zip.digest ?? null },
    checksumUrl: checksum?.browser_download_url ?? null,
  }
}

function readyDir(home: string) {
  return join(home, 'updates', 'ready')
}

/** The update downloaded and waiting for a restart, if any. */
export function stagedUpdate(home: string | null = appHome()): { build: number; version: string } | null {
  if (!home) return null
  try {
    const info = JSON.parse(readFileSync(join(home, 'updates', 'ready.json'), 'utf8')) as { build: number; version: string }
    return existsSync(join(readyDir(home), 'LK Companion', 'launcher.mjs')) ? info : null
  } catch {
    return null
  }
}

/** What the app knows about updates. Checks GitHub when asked, or when the last check is old. */
export async function updateStatus(ctx: AppContext, options: { refresh?: boolean; fetchImpl?: Fetch } = {}) {
  const current = currentVersion()
  const checksEnabled = updateChecksEnabled()
  const state = store()[STATE] ?? { checkedAt: null, latest: null, error: null }
  const stale = !state.checkedAt || ctx.now().getTime() - Date.parse(state.checkedAt) > CHECK_EVERY_MS
  if (current.packaged && (options.refresh || (checksEnabled && stale))) {
    try {
      state.latest = await latestRelease(options.fetchImpl)
      state.error = state.latest ? null : 'No published version was found. (The LKApp repository on GitHub must be public for the app to see its releases.)'
    } catch (error) {
      state.error = `Could not check for updates: ${error instanceof Error ? error.message : String(error)}`
    }
    state.checkedAt = ctx.now().toISOString()
    store()[STATE] = state
  }
  const staged = stagedUpdate()
  return {
    current,
    latest: state.latest,
    available: Boolean(current.packaged && state.latest && state.latest.build > current.build),
    staged: staged && staged.build > current.build ? staged : null,
    checksEnabled,
    checkedAt: state.checkedAt,
    error: current.packaged ? state.error : null,
    note: current.packaged ? null : 'Automatic updates are for the Windows app. In the source folder, update with git (git pull), then start the app again.',
    source: `https://github.com/${UPDATE_REPO}/releases`,
  }
}

export function setUpdateChecks(enabled: boolean) {
  writeSetting('LKC_UPDATE_CHECK', enabled ? null : 'off')
  return { checksEnabled: enabled }
}

async function download(url: string, fetchImpl: Fetch, limit: number): Promise<Buffer> {
  const host = new URL(url).hostname
  if (host !== 'github.com' && !host.endsWith('.githubusercontent.com')) throw new Error(`Refusing to download from ${host}.`)
  const response = await fetchImpl(url, { headers: { 'user-agent': 'LK-Companion-updater', accept: 'application/octet-stream' }, signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok) throw new Error(`The download failed (HTTP ${response.status}).`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new Error('The download is larger than expected.')
  return bytes
}

/**
 * Downloads the latest version, checks it against its published SHA-256 checksum and unpacks
 * it next to your data, ready for a restart. Changes nothing in the app folder.
 */
export async function downloadUpdate(ctx: AppContext, options: { fetchImpl?: Fetch } = {}) {
  const current = currentVersion()
  const home = appHome()
  if (!current.packaged || !home) throw new ServiceError(409, 'Automatic updates are for the Windows app.')
  const fetchImpl = options.fetchImpl ?? fetch
  const release = await latestRelease(fetchImpl).catch((error: unknown) => {
    throw new ServiceError(502, `Could not check for updates: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!release || release.build <= current.build) throw new ServiceError(409, 'You already have the latest version.')
  if (!release.checksumUrl && !release.zip.digest) throw new ServiceError(502, 'The new version has no checksum, so it was not downloaded.')

  try {
    const zip = await download(release.zip.url, fetchImpl, MAX_ZIP_BYTES)
    const actual = createHash('sha256').update(zip).digest('hex')
    const expected = release.checksumUrl ? (await download(release.checksumUrl, fetchImpl, 10_000)).toString('utf8').trim().split(/\s+/)[0]!.toLowerCase() : null
    const digest = release.zip.digest?.replace(/^sha256:/i, '').toLowerCase() ?? null
    if ((expected && expected !== actual) || (digest && digest !== actual)) throw new Error('The download does not match its published checksum, so it was discarded.')
    if (zipTopFolder(zip) !== 'LK Companion') throw new Error('The download is not an LK Companion package.')

    const updates = join(home, 'updates')
    const staging = join(updates, `staging-${Date.now()}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    extractZip(zip, staging)
    const app = join(staging, 'LK Companion')
    for (const required of ['launcher.mjs', 'Start LK Companion.cmd', 'apply-update.cmd', join('node', 'node.exe'), join('app', 'server.js'), join('app', '.next', 'BUILD_ID'), 'version.json']) {
      if (!existsSync(join(app, required))) throw new Error(`The new version is incomplete (${required} is missing), so it was discarded.`)
    }
    const packaged = JSON.parse(readFileSync(join(app, 'version.json'), 'utf8')) as { build?: number; version?: string }
    if (Number(packaged.build) !== release.build) throw new Error('The new version does not say the build it should, so it was discarded.')

    rmSync(readyDir(home), { recursive: true, force: true })
    renameSync(staging, readyDir(home))
    writeFileSync(join(updates, 'ready.json'), JSON.stringify({ build: release.build, version: packaged.version ?? current.version, stagedAt: ctx.now().toISOString() }))
    recordAudit(ctx, { operation: 'app.update.download', outcome: 'success', message: `Downloaded and checked ${release.name} (build ${release.build}); it is applied on restart`, details: { sha256: actual, from: release.zip.url } })
    return { staged: { build: release.build, version: packaged.version ?? current.version } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordAudit(ctx, { operation: 'app.update.download', outcome: 'failure', message })
    throw new ServiceError(502, message)
  }
}

/**
 * Restarts the app into the downloaded version. Only when it was started by "Start LK
 * Companion" (which applies the update when the app stops with the special exit code).
 */
export function restartToUpdate(ctx: AppContext, exit: (code: number) => void = (code) => process.exit(code)) {
  const staged = stagedUpdate()
  if (!staged) throw new ServiceError(409, 'There is no downloaded update to install.')
  if (process.env.LKC_LAUNCHED !== '1') throw new ServiceError(409, 'Close LK Companion and start it again with “Start LK Companion” to install the update.')
  recordAudit(ctx, { operation: 'app.update.restart', outcome: 'info', message: `Restarting to install build ${staged.build}` })
  // Answer first, then stop.
  setTimeout(() => exit(RESTART_FOR_UPDATE_EXIT_CODE), 500)
  return { restarting: true, build: staged.build }
}
