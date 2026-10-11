// Runs the Next.js CLI with its anonymous telemetry switched off (works on every OS).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let nextBin
try {
  nextBin = require.resolve('next/dist/bin/next')
} catch {
  console.error(
    [
      '',
      'Next.js is not installed in this folder, so the app cannot start.',
      `Folder: ${process.cwd()}`,
      '',
      'Fix: in this same folder (the one that contains package.json), run',
      '    npm ci',
      'and wait until it finishes. It should end with a line like "added NNN packages".',
      'If it prints an error instead, copy the last 20 lines of that output and ask for help.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
})
child.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)))
