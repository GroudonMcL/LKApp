import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractZip, zipTopFolder } from '@/server/unzip'
import { currentVersion, downloadUpdate, restartToUpdate, stagedUpdate, updateStatus } from '@/server/services/updates'
import { makeZip } from '../helpers/make-zip'
import { createTestContext } from '../helpers/test-context'

const pkg = (build: number) =>
  makeZip({
    'LK Companion/launcher.mjs': '// launcher',
    'LK Companion/Start LK Companion.cmd': '@echo off',
    'LK Companion/apply-update.cmd': '@echo off',
    'LK Companion/node/node.exe': 'MZ',
    'LK Companion/app/server.js': '// server',
    'LK Companion/app/.next/BUILD_ID': 'abc',
    'LK Companion/version.json': JSON.stringify({ version: '0.1.0', build }),
  })

describe('zip extraction', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lkc-zip-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('extracts files, hidden folders included, and checks each checksum', () => {
    const zip = pkg(5)
    expect(zipTopFolder(zip)).toBe('LK Companion')
    expect(extractZip(zip, dir).files).toBe(7)
    expect(readFileSync(join(dir, 'LK Companion', 'app', '.next', 'BUILD_ID'), 'utf8')).toBe('abc')
  })

  it('refuses paths that would leave the folder, and damaged files', () => {
    expect(() => extractZip(makeZip({ '../evil.txt': 'x' }), dir)).toThrow(/outside the folder/)
    expect(() => extractZip(makeZip({ 'C:/evil.txt': 'x' }), dir)).toThrow(/outside the folder/)
    const damaged = makeZip({ 'a.txt': 'hello hello hello' })
    damaged.writeUInt32LE(1234, damaged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16)
    expect(() => extractZip(damaged, dir)).toThrow(/checksum/)
    expect(existsSync(join(tmpdir(), 'evil.txt'))).toBe(false)
  })
})

describe('app updates', () => {
  let home: string
  let appDir: string
  const saved = { ...process.env }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lkc-home-'))
    appDir = mkdtempSync(join(tmpdir(), 'lkc-app-'))
    writeFileSync(join(appDir, 'version.json'), JSON.stringify({ version: '0.1.0', build: 3, commit: 'abcdef1' }))
    process.env.LKC_HOME = home
    process.env.LKC_APP_DIR = appDir
    process.env.LKC_LAUNCHED = '1'
  })
  afterEach(() => {
    process.env = { ...saved }
    rmSync(home, { recursive: true, force: true })
    rmSync(appDir, { recursive: true, force: true })
  })

  /** A stand-in for GitHub: the latest release, its zip and its checksum file. */
  function github(zip: Buffer, options: { build?: number; checksum?: string; status?: number } = {}) {
    const sha = createHash('sha256').update(zip).digest('hex')
    const requests: string[] = []
    const fetchImpl = async (url: string) => {
      requests.push(url)
      if (url.includes('/releases/latest')) {
        if (options.status) return new Response('{}', { status: options.status })
        return Response.json({
          tag_name: `build-${options.build ?? 7}`,
          name: `LK Companion 0.1.0 (build ${options.build ?? 7})`,
          body: 'Template pages keep their field order.',
          published_at: '2026-10-12T21:00:00Z',
          html_url: 'https://github.com/GroudonMcL/LKApp/releases/tag/build-7',
          assets: [
            { name: 'LK-Companion-Windows-0.1.0.zip', browser_download_url: 'https://github.com/GroudonMcL/LKApp/releases/download/build-7/LK-Companion-Windows-0.1.0.zip', size: zip.length },
            { name: 'LK-Companion-Windows-0.1.0.zip.sha256', browser_download_url: 'https://github.com/GroudonMcL/LKApp/releases/download/build-7/LK-Companion-Windows-0.1.0.zip.sha256', size: 90 },
          ],
        })
      }
      if (url.endsWith('.sha256')) return new Response(`${options.checksum ?? sha}  LK-Companion-Windows-0.1.0.zip\n`)
      if (url.endsWith('.zip')) return new Response(new Uint8Array(zip))
      return new Response('', { status: 404 })
    }
    return { fetchImpl, requests }
  }

  it('reads this version from the package, and offers a newer published build', async () => {
    const ctx = createTestContext()
    expect(currentVersion()).toEqual({ version: '0.1.0', build: 3, commit: 'abcdef1', packaged: true })
    const { fetchImpl, requests } = github(pkg(7))
    const status = await updateStatus(ctx, { refresh: true, fetchImpl })
    expect(status).toMatchObject({ available: true, latest: { build: 7 }, error: null })
    expect(requests).toEqual(['https://api.github.com/repos/GroudonMcL/LKApp/releases/latest'])
  })

  it('says plainly when no release can be seen (e.g. the repository is private)', async () => {
    const ctx = createTestContext()
    const status = await updateStatus(ctx, { refresh: true, fetchImpl: github(pkg(7), { status: 404 }).fetchImpl })
    expect(status.available).toBe(false)
    expect(status.error).toMatch(/must be public/)
  })

  it('downloads, checks the checksum and stages the update without touching the app folder; restart exits with 75', async () => {
    const ctx = createTestContext()
    const { fetchImpl } = github(pkg(7))
    expect(await downloadUpdate(ctx, { fetchImpl })).toEqual({ staged: { build: 7, version: '0.1.0' } })
    expect(stagedUpdate()).toMatchObject({ build: 7 })
    expect(existsSync(join(home, 'updates', 'ready', 'LK Companion', 'app', '.next', 'BUILD_ID'))).toBe(true)
    expect(JSON.parse(readFileSync(join(appDir, 'version.json'), 'utf8')).build).toBe(3)

    let exitCode: number | null = null
    expect(restartToUpdate(ctx, (code) => (exitCode = code))).toMatchObject({ restarting: true, build: 7 })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(exitCode).toBe(75)
  })

  it('discards a download that does not match its checksum, or is incomplete, or claims another build', async () => {
    const ctx = createTestContext()
    await expect(downloadUpdate(ctx, { fetchImpl: github(pkg(7), { checksum: 'f'.repeat(64) }).fetchImpl })).rejects.toThrow(/does not match its published checksum/)
    await expect(downloadUpdate(ctx, { fetchImpl: github(makeZip({ 'LK Companion/launcher.mjs': 'x' })).fetchImpl })).rejects.toThrow(/incomplete/)
    await expect(downloadUpdate(ctx, { fetchImpl: github(pkg(6)).fetchImpl })).rejects.toThrow(/does not say the build/)
    expect(stagedUpdate()).toBeNull()
  })

  it('does nothing when already up to date, and outside the Windows package', async () => {
    const ctx = createTestContext()
    await expect(downloadUpdate(ctx, { fetchImpl: github(pkg(3), { build: 3 }).fetchImpl })).rejects.toThrow(/latest version/)
    delete process.env.LKC_APP_DIR
    const status = await updateStatus(ctx, { refresh: true, fetchImpl: github(pkg(7)).fetchImpl })
    expect(status).toMatchObject({ available: false, current: { packaged: false } })
    expect(status.note).toMatch(/git/)
  })
})
