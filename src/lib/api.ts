/**
 * Browser-side helper for calling this app's own API routes.
 *
 * The browser never talks to LegendKeeper or Anthropic directly and never sees API keys:
 * it only calls `/api/...` on this local server. Every changing request carries the
 * `x-lkc-request` header that the server's request guard requires.
 */

export interface ApiErrorInfo {
  message: string
  issues: string[]
  code: string | null
  requestId: string | null
  kind: string | null
  status: number
}

export class ApiError extends Error {
  constructor(readonly info: ApiErrorInfo) {
    super(info.message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { 'x-lkc-request': '1' } }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new ApiError({ message: 'Could not reach the LK Companion server. Is it still running?', issues: [], code: null, requestId: null, kind: 'network', status: 0 })
  }
  const text = await response.text()
  const data = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) {
    const error = (data as { error?: Partial<ApiErrorInfo> } | null)?.error
    throw new ApiError({
      message: error?.message ?? `Request failed (HTTP ${response.status}).`,
      issues: error?.issues ?? [],
      code: error?.code ?? null,
      requestId: error?.requestId ?? null,
      kind: error?.kind ?? null,
      status: response.status,
    })
  }
  return data as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, form),
}

export function toErrorInfo(error: unknown): ApiErrorInfo {
  if (error instanceof ApiError) return error.info
  return { message: (error as Error)?.message ?? String(error), issues: [], code: null, requestId: null, kind: null, status: 0 }
}
