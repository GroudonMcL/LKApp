import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractZip, zipTopFolder } from '@/server/unzip'

/**
 * The app unpacks its own updates. This checks the extractor against the real package zip, as
 * built on this machine (on GitHub's Windows machine, by Windows' own tar). Runs only when asked
 * (LKC_TEST_PACKAGE_ZIP=1) after `node scripts/package-windows.mjs`.
 */
const zipPath = existsSync('dist') ? readdirSync('dist').find((name) => name.endsWith('.zip')) : undefined
describe.skipIf(process.env.LKC_TEST_PACKAGE_ZIP !== '1' || !zipPath)('the real package zip', () => {
  it('unpacks completely with the app’s own extractor', () => {
    const zip = readFileSync(join('dist', zipPath!))
    const dir = mkdtempSync(join(tmpdir(), 'lkc-package-'))
    try {
      expect(zipTopFolder(zip)).toBe('LK Companion')
      const { files } = extractZip(zip, dir)
      expect(files).toBeGreaterThan(1000)
      for (const required of ['launcher.mjs', 'version.json', 'apply-update.cmd', 'Start LK Companion.cmd', join('node', 'node.exe'), join('app', 'server.js'), join('app', '.next', 'BUILD_ID')]) {
        expect(existsSync(join(dir, 'LK Companion', required)), required).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
