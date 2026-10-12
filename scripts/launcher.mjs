// LK Companion launcher: starts the app on this computer and opens it in its own window.
//
// Used by "Start LK Companion.cmd" in the Windows package, and by `npm run app` in the source
// folder. It needs nothing but Node.js (the Windows package brings its own copy).
//
// - Already running? It just opens the window again.
// - Otherwise it starts the app server (only reachable from this computer), waits until it
//   answers, and opens it: as an app window in Microsoft Edge or Chrome when available,
//   otherwise in your default browser.
// - Keep the launcher window open while you use the app; closing it (or Ctrl+C) stops the app.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isWindows = process.platform === 'win32'

// Packaged: <package>/launcher.mjs next to <package>/app/server.js.
// Source folder: <repo>/scripts/launcher.mjs, with <repo>/package.json.
const packagedServer = join(here, 'app', 'server.js')
const packaged = existsSync(packagedServer)
const root = packaged ? here : resolve(here, '..')


// Where settings and data live. Packaged: in your user profile, so updates never touch them.
// Source folder: as before (.env.local and ./data in the folder), unless LKC_HOME is set.
const home =
  process.env.LKC_HOME ||
  (packaged ? (isWindows ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'LK Companion') : join(homedir(), '.lk-companion')) : null)

/** LKC_PORT may also be set in the settings file. */
function settingFromFile(name) {
  const file = home ? join(home, 'settings.env') : join(root, '.env.local')
  try {
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.trim().startsWith(`${name}=`))
    return line ? line.split('=').slice(1).join('=').trim() : null
  } catch {
    return null
  }
}

const port = Number(process.env.LKC_PORT || settingFromFile('LKC_PORT') || (packaged ? 3127 : 3000))
const url = `http://127.0.0.1:${port}`

function say(...lines) {
  console.log(lines.join('\n'))
}

async function isRunning() {
  try {
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) })
    return res.status < 500
  } catch {
    return false
  }
}

function findBrowser() {
  if (!isWindows) return null
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  const candidates = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']
  for (const c of candidates) for (const r of roots) if (existsSync(join(r, c))) return join(r, c)
  return null
}

function openWindow() {
  if (process.env.LKC_NO_BROWSER === '1') return
  const browser = findBrowser()
  if (browser) {
    // App mode: a window of its own, without tabs or an address bar.
    spawn(browser, [`--app=${url}`, '--new-window'], { detached: true, stdio: 'ignore' }).unref()
  } else if (isWindows) {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

function newestMtime(dir) {
  let newest = 0
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.mtimeMs > newest) newest = st.mtimeMs
    }
  }
  if (existsSync(dir)) walk(dir)
  return newest
}

function npm(args) {
  const res = spawnSync(isWindows ? 'npm.cmd' : 'npm', args, { cwd: root, stdio: 'inherit', shell: isWindows })
  if (res.status !== 0) {
    say('', `“npm ${args.join(' ')}” did not finish. See the messages above.`)
    process.exit(1)
  }
}

/** Source folder only: install and build when needed, so a plain `npm run app` always works. */
function prepareSourceFolder() {
  if (!existsSync(join(root, 'node_modules', 'next'))) {
    say('Installing the app’s components (first run only, a few minutes)…')
    npm(['ci'])
  }
  const buildId = join(root, '.next', 'BUILD_ID')
  const built = existsSync(buildId) ? statSync(buildId).mtimeMs : 0
  if (!built || newestMtime(join(root, 'src')) > built) {
    say('Preparing the app (after an update this takes a minute or two)…')
    npm(['run', 'build'])
  }
}

async function main() {
  say('', 'LK Companion', '------------')
  if (await isRunning()) {
    say(`LK Companion is already running. Opening it: ${url}`)
    openWindow()
    return
  }
  if (!packaged) prepareSourceFolder()
  else if (!existsSync(join(root, 'app', '.next', 'BUILD_ID'))) {
    say(
      '',
      'This copy of LK Companion is incomplete: the folder app\\.next is missing.',
      'Download the package again and unzip all of it (some download tools skip folders whose',
      'names start with a dot). Your settings and data are not affected.',
    )
    process.exit(1)
  }

  const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', PORT: String(port), HOSTNAME: '127.0.0.1' }
  let logFile = null
  if (home) {
    mkdirSync(join(home, 'logs'), { recursive: true })
    env.LKC_HOME = home
    logFile = join(home, 'logs', 'server.log')
  }
  const command = packaged ? [process.execPath, [packagedServer]] : [process.execPath, [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)]]
  const server = spawn(command[0], command[1], { cwd: packaged ? join(root, 'app') : root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null
  log?.write(`\n--- started ${new Date().toISOString()} ---\n`)
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      log?.write(chunk)
      const text = String(chunk)
      // Show problems in the window; routine request lines go only to the log.
      if (/error|warn|fail/i.test(text) && !/ExperimentalWarning|trace-warnings/.test(text)) process.stderr.write(text)
    })
  }
  let exited = false
  server.on('exit', (code) => {
    exited = true
    say('', `LK Companion stopped${code ? ` (code ${code})` : ''}.${logFile ? ` Details are in ${logFile}` : ''}`)
    process.exit(code ?? 0)
  })
  const stop = () => {
    if (!exited) server.kill()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // Closing the window on Windows.
  process.on('SIGHUP', stop)
  process.on('exit', stop)

  say('Starting…')
  for (let i = 0; i < 120 && !exited; i++) {
    if (await isRunning()) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (exited) return
  if (!(await isRunning())) {
    say('', `The app did not start within a minute.${logFile ? ` See ${logFile}` : ''}`)
    stop()
    process.exit(1)
  }
  say(
    '',
    `LK Companion is running at ${url}`,
    home ? `Your settings and data: ${home}` : 'Your settings and data: .env.local and the data folder here',
    '',
    'Keep this window open while you use the app. Close it to stop LK Companion.',
    'To open the app window again, run “Start LK Companion” again.',
  )
  openWindow()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
