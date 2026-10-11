import { NextResponse, type NextRequest } from 'next/server'

/**
 * Request guard for a local, single-user tool.
 *
 * - Only requests addressed to this machine (localhost / 127.0.0.1 / [::1]) are served. This
 *   blocks "DNS rebinding", where a malicious website tricks your browser into talking to
 *   a local app under another hostname.
 * - Requests that change anything (POST, PUT, PATCH, DELETE) must come from this app's own
 *   pages: they need the `x-lkc-request` header (which other websites cannot add without
 *   permission) and, when the browser sends one, a matching Origin.
 *
 * This is not a login system. Before hosting the app anywhere but your own computer, add
 * real authentication (see README → Security).
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function hostname(host: string | null): string | null {
  if (!host) return null
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  return host.split(':')[0] ?? null
}

export function proxy(request: NextRequest) {
  const host = request.headers.get('host')
  if (!LOCAL_HOSTS.has(hostname(host) ?? '')) {
    return new NextResponse('LK Companion only accepts requests addressed to localhost.', { status: 403 })
  }

  const method = request.method.toUpperCase()
  if (request.nextUrl.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (request.headers.get('x-lkc-request') !== '1') {
      return NextResponse.json({ error: { message: 'Missing request header.', issues: [], code: 'CSRF', requestId: null, kind: null } }, { status: 403 })
    }
    const origin = request.headers.get('origin')
    if (origin) {
      let originHost: string | null = null
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = null
      }
      if (originHost !== host) {
        return NextResponse.json({ error: { message: 'Cross-origin request refused.', issues: [], code: 'CSRF', requestId: null, kind: null } }, { status: 403 })
      }
    }
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
