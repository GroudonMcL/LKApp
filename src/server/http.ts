import 'server-only'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AiError } from './ai/provider'
import { configuredSecrets } from './config'
import { getAppContext, type AppContext } from './context'
import { ConnectorError } from './lk/errors'
import { log } from './log'
import { redactSecrets } from './redact'
import { ServiceError } from './services/errors'

/**
 * Helpers for API route handlers. Route handlers stay thin: parse input, call a service,
 * return JSON. Errors become `{ error: { message, issues, code, requestId } }` with a fitting
 * status. Responses are scrubbed of secrets as a last line of defence.
 */

export interface ApiErrorBody {
  error: { message: string; issues: string[]; code: string | null; requestId: string | null; kind: string | null }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(redactSecrets(body, configuredSecrets()), { status, headers: { 'cache-control': 'no-store' } })
}

export function errorResponse(error: unknown) {
  const body = (message: string, extra: Partial<ApiErrorBody['error']> = {}): ApiErrorBody => ({
    error: { message, issues: [], code: null, requestId: null, kind: null, ...extra },
  })
  if (error instanceof ServiceError) return json(body(error.message, { issues: error.issues, code: error.code }), error.status)
  if (error instanceof ConnectorError) {
    const status = error.kind === 'not_configured' ? 400 : error.kind === 'not_found' ? 404 : error.kind === 'permission' ? 403 : error.kind === 'authentication' ? 401 : error.kind === 'rate_limited' ? 429 : 502
    return json(
      body(error.message, {
        kind: error.kind,
        code: error.details.code ?? null,
        requestId: error.details.requestId ?? null,
        issues: (error.details.issues ?? []).map((i) => `${i.path}: ${i.message}`),
      }),
      status,
    )
  }
  if (error instanceof AiError) return json(body(error.message, { kind: error.kind, requestId: error.details.requestId ?? null, issues: error.details.issues ?? [] }), 502)
  if (error instanceof z.ZodError) return json(body('The request is not valid.', { issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }), 400)
  log.error('Unhandled error in API route', { error })
  return json(body('Something went wrong on the server. Check the server console for details.'), 500)
}

export async function handle(fn: (ctx: AppContext) => Promise<unknown> | unknown, status = 200) {
  try {
    const result = await fn(getAppContext())
    return json(result ?? { ok: true }, status)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new ServiceError(400, 'The request body must be JSON.')
  }
  return schema.parse(raw)
}

export function intParam(value: string | null, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}
