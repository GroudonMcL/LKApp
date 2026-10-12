import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  LegendKeeperError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  ValidationError,
  VersionMismatchError,
} from '@legendkeeper/sdk'

/**
 * Turns SDK errors into one app-level error type with a plain-English explanation and,
 * crucially for writes, whether the request may have been applied.
 */

export type ConnectorErrorKind =
  | 'not_configured'
  | 'authentication'
  | 'payment'
  | 'permission'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'duplicate_id'
  | 'version_conflict'
  | 'rate_limited'
  | 'too_large'
  | 'server'
  | 'connection'
  | 'unknown'

/**
 * - `not_applied`: LegendKeeper refused before writing anything. Safe to fix and retry.
 * - `unknown`: no reliable answer (timeout, dropped connection, server error). The write
 *   may or may not have happened. Check before doing anything else.
 */
export type WriteOutcome = 'not_applied' | 'unknown'

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly details: {
      status?: number
      code?: string
      requestId?: string
      issues?: { path: string; message: string }[]
      retryAfterMs?: number
      outcome: WriteOutcome
    },
  ) {
    super(message)
    this.name = 'ConnectorError'
  }

  toJSON() {
    return { kind: this.kind, message: this.message, ...this.details }
  }
}

export function notConfigured(): ConnectorError {
  return new ConnectorError(
    'not_configured',
    'No LegendKeeper API key is configured. Add LEGENDKEEPER_API_KEY to .env.local (or enter a key on the Settings page) and restart.',
    { outcome: 'not_applied' },
  )
}

export function toConnectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error

  if (error instanceof ConnectionError) {
    const timedOut = (error.cause as { name?: string } | undefined)?.name === 'TimeoutError'
    return new ConnectorError(
      'connection',
      timedOut
        ? 'LegendKeeper did not answer in time. Check your internet connection and try again.'
        : `Could not reach LegendKeeper (${error.message}). Check your internet connection, firewall or LEGENDKEEPER_BASE_URL.`,
      { outcome: 'unknown' },
    )
  }

  if (error instanceof LegendKeeperError) {
    const base = { status: error.status, code: error.code, requestId: error.requestId, outcome: 'not_applied' as WriteOutcome }
    const ref = error.requestId ? ` (request ID ${error.requestId})` : ''

    if (error instanceof AuthenticationError) {
      return new ConnectorError('authentication', `LegendKeeper rejected the API key: it is missing, unknown, revoked or expired. Create a new key in Project Settings → Developers → API Keys${ref}.`, base)
    }
    if (error.status === 402) {
      return new ConnectorError(
        'payment',
        error.code === 'SUBSCRIPTION_LAPSED'
          ? `The project owner's plan does not allow this write${ref}.`
          : `API keys need the project owner to be on a paid LegendKeeper plan (a trial does not count)${ref}.`,
        base,
      )
    }
    if (error instanceof PermissionError) {
      const why =
        error.code === 'WRONG_PROJECT'
          ? 'the key belongs to a different project'
          : error.code === 'FEATURE_UNAVAILABLE'
            ? 'the request uses a feature that is not available yet'
            : 'the key’s role, or the page’s permissions, do not allow it. Some operations (the tag list, creating top-level pages, hidden pages, saving a page as a template) need an ADMIN key'
      return new ConnectorError('permission', `LegendKeeper refused the request because ${why}${ref}.`, base)
    }
    if (error instanceof NotFoundError) {
      return new ConnectorError('not_found', `LegendKeeper could not find it: it does not exist, was deleted, or is hidden from this key${ref}.`, base)
    }
    if (error instanceof ValidationError) {
      return new ConnectorError('validation', `LegendKeeper rejected the content (${error.code ?? 'validation error'})${ref}. Nothing was written.`, {
        ...base,
        issues: error.errors,
      })
    }
    if (error instanceof VersionMismatchError) {
      return new ConnectorError('version_conflict', `The page changed in LegendKeeper since it was read. Reload it and reapply the change${ref}.`, base)
    }
    if (error instanceof ConflictError) {
      if (error.code === 'DUPLICATE_ID') {
        return new ConnectorError('duplicate_id', `A resource with this ID already exists in the project${ref}.`, base)
      }
      if (error.code === 'IN_PROGRESS') {
        return new ConnectorError('conflict', `An earlier attempt of this request is still running in LegendKeeper. Check the outcome before retrying${ref}.`, { ...base, outcome: 'unknown' })
      }
      return new ConnectorError('conflict', `LegendKeeper reported a conflict (${error.code ?? 'conflict'}): ${error.message}${ref}`, base)
    }
    if (error instanceof RateLimitError) {
      const wait = error.retryAfterMs ? ` Wait about ${Math.ceil(error.retryAfterMs / 1000)} seconds.` : ''
      return new ConnectorError('rate_limited', `LegendKeeper's rate limit was reached.${wait}${ref}`, { ...base, retryAfterMs: error.retryAfterMs })
    }
    if (error.status === 413 || error.code === 'DOCUMENT_TOO_LARGE') {
      return new ConnectorError('too_large', `The content is too large for LegendKeeper${ref}. Split it into smaller pages.`, base)
    }
    if (error instanceof ServerError) {
      return new ConnectorError('server', `LegendKeeper had an internal error${ref}. Report the request ID to LegendKeeper if it keeps happening.`, { ...base, outcome: 'unknown' })
    }
    return new ConnectorError('unknown', `LegendKeeper returned an unexpected error (HTTP ${error.status}${error.code ? `, ${error.code}` : ''})${ref}.`, {
      ...base,
      outcome: error.status >= 500 ? 'unknown' : 'not_applied',
    })
  }

  return new ConnectorError('unknown', `Unexpected error: ${(error as Error)?.message ?? String(error)}`, { outcome: 'unknown' })
}
