import 'server-only'
import { configuredSecrets } from './config'
import { redactSecrets } from './redact'

/**
 * A minimal server logger. Everything passes through redaction first. By design it never
 * logs source documents: callers log ids, sizes and outcomes, not content.
 */
function write(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test') return
  const safe = details ? redactSecrets(details, configuredSecrets()) : undefined
  const line = `[lk-companion] ${level.toUpperCase()} ${message}`
  if (level === 'error') console.error(line, safe ?? '')
  else if (level === 'warn') console.warn(line, safe ?? '')
  else console.info(line, safe ?? '')
}

export const log = {
  info: (message: string, details?: Record<string, unknown>) => write('info', message, details),
  warn: (message: string, details?: Record<string, unknown>) => write('warn', message, details),
  error: (message: string, details?: Record<string, unknown>) => write('error', message, details),
}
