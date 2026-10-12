// Builds the portable Windows package: dist/LK-Companion-Windows-<version>.zip
//
//   node scripts/package-windows.mjs            (from the project folder, after `npm ci`)
//
// The zip holds the built app, a private copy of Node.js for Windows, and the launcher. Unzip
// it anywhere and double-click "Start LK Companion"; nothing else needs installing.
//
// Safety: Next.js copies `.env*` files into its standalone build, so this script deletes every
// `.env*` file, database and log from the package, then scans every file for the values of
// your configured API keys and refuses to produce a zip if any is found. The official build
// runs on GitHub from a fresh checkout (.github/workflows/windows-package.yml), which has no
// keys at all.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
/** The Node.js release bundled when building on another system (Windows builds copy their own). */
const NODE_VERSION = process.env.LKC_NODE_VERSION || 'v24.21.0'
const out = join(root, 'dist', 'LK Companion')
const zipPath = join(root, 'dist', `LK-Companion-Windows-${pkg.version}.zip`)

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...options })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

function step(text) {
  console.log(`\n== ${text}`)
}

step('Building the app (self-contained server)')
rmSync(join(root, '.next', 'standalone'), { recursive: true, force: true })
run(process.execPath, [join(root, 'scripts', 'next.mjs'), 'build'], { env: { ...process.env, LKC_STANDALONE: '1' }, shell: false })

step('Assembling the package')
rmSync(join(root, 'dist'), { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(root, '.next', 'standalone'), join(out, 'app'), { recursive: true, verbatimSymlinks: false, dereference: true })
cpSync(join(root, '.next', 'static'), join(out, 'app', '.next', 'static'), { recursive: true })
if (existsSync(join(root, 'public'))) cpSync(join(root, 'public'), join(out, 'app', 'public'), { recursive: true })
cpSync(join(root, 'scripts', 'launcher.mjs'), join(out, 'launcher.mjs'))

// Never ship settings, keys, databases or logs.
const removed = []
function scrub(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (dir === join(out, 'app') && (name === 'data' || name === 'logs')) {
        rmSync(p, { recursive: true, force: true })
        removed.push(p)
      } else scrub(p)
    } else if (/^\.env(\..*)?$/.test(name) || /\.(db|db-journal|db-wal|db-shm|log)$/.test(name)) {
      rmSync(p, { force: true })
      removed.push(p)
    }
  }
}
scrub(out)
if (removed.length) console.log(`Removed from the package: ${removed.map((p) => p.slice(out.length + 1)).join(', ')}`)

step('Adding Node.js for Windows')
mkdirSync(join(out, 'node'), { recursive: true })
if (process.platform === 'win32') {
  cpSync(process.execPath, join(out, 'node', 'node.exe'))
  console.log(`Copied ${process.execPath} (${process.version})`)
} else {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`
  const file = `node-${NODE_VERSION}-win-x64.zip`
  const tmp = join(tmpdir(), `lkc-node-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const zipBytes = Buffer.from(await (await fetch(`${base}/${file}`)).arrayBuffer())
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${file}`))?.split(/\s+/)[0]
  const actual = createHash('sha256').update(zipBytes).digest('hex')
  if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${file}`)
  writeFileSync(join(tmp, file), zipBytes)
  run('unzip', ['-q', '-j', join(tmp, file), `node-${NODE_VERSION}-win-x64/node.exe`, `node-${NODE_VERSION}-win-x64/LICENSE`, '-d', join(out, 'node')])
  rmSync(tmp, { recursive: true, force: true })
  console.log(`Downloaded Node.js ${NODE_VERSION} for Windows (checksum verified)`)
}

step('Adding the launcher files')
const crlf = (text) => text.replace(/\r?\n/g, '\r\n')
// Starts the app. When the app stops asking for an update (exit code 75), or a downloaded
// update is waiting, it hands over to apply-update.cmd (run from a copy in %TEMP%, so this
// file can be replaced while it runs).
writeFileSync(
  join(out, 'Start LK Companion.cmd'),
  crlf(`@echo off
title LK Companion
cd /d "%~dp0"
if defined LKC_HOME (set "LKC_DATA=%LKC_HOME%") else (set "LKC_DATA=%LOCALAPPDATA%\\LK Companion")
if exist "%LKC_DATA%\\updates\\ready\\LK Companion\\apply-update.cmd" if not "%LKC_AFTER_UPDATE%"=="1" goto update
"%~dp0node\\node.exe" "%~dp0launcher.mjs"
if errorlevel 75 if not errorlevel 76 goto update
if errorlevel 1 (
  echo.
  echo Something went wrong. The details above may help; the full log is in
  echo %LKC_DATA%\\logs\\server.log
  pause
)
exit /b
:update
copy /y "%LKC_DATA%\\updates\\ready\\LK Companion\\apply-update.cmd" "%TEMP%\\lkc-apply-update.cmd" >nul
start "Updating LK Companion" "%TEMP%\\lkc-apply-update.cmd" "%~dp0." "%LKC_DATA%"
exit /b
`),
)
// Installs a downloaded update over this folder. Only the app's own files are replaced: the
// app and node folders are mirrored, the files at the top are overwritten. Settings and data
// live in %LOCALAPPDATA%\LK Companion and are not touched.
writeFileSync(
  join(out, 'apply-update.cmd'),
  crlf(`@echo off
setlocal
title Updating LK Companion
set "APPDIR=%~f1"
set "DATADIR=%~f2"
set "READY=%DATADIR%\\updates\\ready\\LK Companion"
rem This script removes the downloaded update when it is done, so it must not run from inside it.
if /i "%~dp0"=="%READY%\\" (
  copy /y "%~f0" "%TEMP%\\lkc-apply-update.cmd" >nul
  rem Without CALL, control passes to the copy for good: this file is never read again.
  "%TEMP%\\lkc-apply-update.cmd" %*
)
if not exist "%APPDIR%\\launcher.mjs" goto wrongfolder
if not exist "%APPDIR%\\app\\server.js" goto wrongfolder
if not exist "%READY%\\launcher.mjs" goto nothing
echo Installing the new version of LK Companion...
rem Give the old version a moment to close.
ping -n 3 127.0.0.1 >nul
robocopy "%READY%\\app" "%APPDIR%\\app" /MIR /R:5 /W:2 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto failed
robocopy "%READY%\\node" "%APPDIR%\\node" /MIR /R:5 /W:2 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto failed
robocopy "%READY%" "%APPDIR%" *.* /R:5 /W:2 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto failed
rmdir /s /q "%DATADIR%\\updates\\ready"
del /q "%DATADIR%\\updates\\ready.json" 2>nul
echo Done.
if "%LKC_NO_RESTART%"=="1" exit /b 0
set "LKC_AFTER_UPDATE=1"
start "LK Companion" "%APPDIR%\\Start LK Companion.cmd"
exit /b 0
:failed
echo.
echo The update could not be installed (some files may be in use).
echo Close LK Companion and double-click "Start LK Companion" again: it installs the update first.
pause
exit /b 1
:wrongfolder
echo This does not look like the LK Companion folder: %APPDIR%
echo Nothing was changed.
pause
exit /b 1
:nothing
echo There is no downloaded update to install.
exit /b 0
`),
)
writeFileSync(
  join(out, 'Create desktop shortcut.cmd'),
  crlf(`@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = [Environment]::GetFolderPath('Desktop'); $s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'LK Companion.lnk')); $s.TargetPath = (Join-Path (Get-Location) 'Start LK Companion.cmd'); $s.WorkingDirectory = (Get-Location).Path; $s.IconLocation = (Join-Path (Get-Location) 'lk-companion.ico'); $s.WindowStyle = 7; $s.Description = 'Start LK Companion'; $s.Save()"
if errorlevel 1 (
  echo The shortcut could not be created.
) else (
  echo A shortcut called "LK Companion" is now on your desktop.
)
pause
`),
)
cpSync(join(root, 'scripts', 'assets', 'lk-companion.ico'), join(out, 'lk-companion.ico'))
writeFileSync(
  join(out, 'READ ME FIRST.txt'),
  crlf(`LK Companion ${pkg.version} for Windows
================================

Starting the app
----------------
1. Double-click "Start LK Companion".
   (If Windows asks whether to run it, choose "Run" or "More info" > "Run anyway".
   This happens because the files came from the internet; see below.)
2. A small black window opens and says when the app is running, then the app opens in
   its own window. The first start takes a few seconds.
3. The first time, the app asks for your LegendKeeper API key (and, optionally, a free
   OpenRouter key for AI features) and saves them on this computer.

Keep the small black window open while you use the app. Close it to stop LK Companion.
Run "Start LK Companion" again to reopen the app window.

Optional: double-click "Create desktop shortcut" to put an "LK Companion" icon on your
desktop.

Where your data is kept
-----------------------
Your settings (including your API keys) and the app's database are kept in
    %LOCALAPPDATA%\\LK Companion
(type that into the Explorer address bar to open it). They are not in this folder, so
you can delete or replace this folder to update the app without losing anything.

Updating
--------
When a new version is published, the app says so at the top of its window. Press
"Update now": it downloads the new version, checks it, and restarts into it. Your
settings and data stay where they are. (Settings > Updates can switch the check off.)

You can also update by hand: close the app, delete this folder, unzip the new version
and start it the same way.

If Windows blocks the files
---------------------------
Before unzipping, right-click the downloaded zip > Properties > tick "Unblock" > OK.
Then unzip it again. This tells Windows you trust the download.

Privacy
-------
The app runs only on this computer and only answers this computer. It talks to
LegendKeeper (your project) and, only when you use an AI feature, to the AI service you
chose. Nothing else is sent anywhere.

Node.js (in the "node" folder) is included under its own licence (node\\LICENSE).
`),
)

// Which version this is: the app compares it with the latest published release.
const build = Number(process.env.LKC_BUILD || process.env.GITHUB_RUN_NUMBER || 0)
let commit = process.env.GITHUB_SHA || null
if (!commit) {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  commit = git.status === 0 ? git.stdout.trim() : null
}
writeFileSync(join(out, 'version.json'), `${JSON.stringify({ version: pkg.version, build, commit, builtAt: new Date().toISOString() }, null, 2)}\n`)
console.log(`Version ${pkg.version}, build ${build || 'local'}`)

step('Checking the package contains no keys')
const secrets = new Set()
const collect = (file) => {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*["']?([^"'\s#]+)/)
    if (m && m[2].length >= 8 && !/replace_me|^sk-ant-\.\.\.|^lk_\.\.\./.test(m[2])) secrets.add(m[2])
  }
}
collect(join(root, '.env.local'))
collect(join(root, '.env'))
if (process.env.LKC_HOME) collect(join(process.env.LKC_HOME, 'settings.env'))
for (const [k, v] of Object.entries(process.env)) if (/(KEY|TOKEN|SECRET)/.test(k) && v && v.length >= 12 && !/^(true|false)$/.test(v)) secrets.add(v)
let leaks = 0
const needles = [...secrets].map((s) => Buffer.from(s))
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) scan(p)
    else if (/^\.env/.test(name) || /\.db$/.test(name)) leaks++
    else if (needles.length && st.size < 50_000_000) {
      const bytes = readFileSync(p)
      for (const n of needles)
        if (bytes.includes(n)) {
          console.error(`A configured key was found in ${p.slice(out.length + 1)}`)
          leaks++
        }
    }
  }
}
scan(out)
if (leaks) {
  rmSync(join(root, 'dist'), { recursive: true, force: true })
  throw new Error('Packaging stopped: the package would contain a key or private file. Nothing was written.')
}
console.log(`No keys or private files found (${needles.length} key value(s) checked).`)

step('Creating the zip')
if (process.platform === 'win32') run('tar', ['-a', '-c', '-f', zipPath, '-C', join(root, 'dist'), 'LK Companion'], { shell: false })
else run('zip', ['-q', '-r', '-X', zipPath, 'LK Companion'], { cwd: join(root, 'dist') })
const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipPath.split(/[\\/]/).pop()}\n`)
console.log(`\nDone: ${zipPath} (${(statSync(zipPath).size / 1_000_000).toFixed(1)} MB, SHA-256 ${sha256})`)
