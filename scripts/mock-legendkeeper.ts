/**
 * A local REHEARSAL server that imitates the parts of the LegendKeeper v3 API this app uses,
 * with a small sample of Greyhawk data held in memory. It is NOT LegendKeeper.
 *
 * Use it to try the whole workflow — connection test, scan, browsing, imports, the write
 * check and page creation — without touching your real project:
 *
 *   npm run mock:lk                              # starts on http://127.0.0.1:4010
 *   LEGENDKEEPER_BASE_URL=http://127.0.0.1:4010  # in .env.local, then restart the app
 *   LEGENDKEEPER_API_KEY=lk_rehearsal_key        # any value starting with lk_ works
 *   LKC_SANDBOX_PARENT_ID=sandbox1               # the sample sandbox page
 *
 * Create requests are validated against the official OpenAPI schema shipped with the SDK,
 * so a body LegendKeeper would reject as malformed is rejected here too. Everything is
 * forgotten when the server stops.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { validateAgainstSpec } from '../tests/helpers/openapi-validator'

const PORT = Number(process.env.MOCK_LK_PORT ?? 4010)
const PROJECT = { id: 'projrehearsal', name: 'Greyhawk (rehearsal copy)', isPublic: false, createdAt: '2026-01-01T00:00:00Z' }

interface Doc { id: string; name: string; type: string; rank: string; isHidden: boolean; version: number; blocks: unknown[] }
interface Res { id: string; name: string; parentId: string | null; tags: string[]; aliases: string[]; rank: string; isHidden: boolean; documents: Doc[]; createdAt: string; updatedAt: string }

const resources = new Map<string, Res>()
let counter = 0
const now = () => new Date().toISOString()

function add(id: string, name: string, parentId: string | null, tags: string[], text: string, aliases: string[] = []) {
  counter++
  resources.set(id, {
    id, name, parentId, tags, aliases, rank: `a${counter}`, isHidden: false, createdAt: now(), updatedAt: now(),
    documents: [{ id: `doc_${id}`, name: 'Main', type: 'page', rank: 'a0', isHidden: false, version: 1, blocks: text ? [{ id: `b_${id}`, kind: 'paragraph', content: [{ text }] }] : [] }],
  })
}

add('flanaess', 'The Flanaess', null, ['Region'], 'The eastern part of Oerik.')
add('greyhawk', 'Free City of Greyhawk', 'flanaess', ['Location', 'City'], 'The Gem of the Flanaess.', ['Greyhawk City'])
add('greendrg', 'Green Dragon Inn', 'greyhawk', [], 'A rough tavern in the River Quarter.')
add('mordenkn', 'Mordenkainen', 'npcs0001', ['NPC', 'Circle of Eight'], 'Archmage of the Obsidian Citadel.')
add('circle08', 'Circle of Eight', 'flanaess', ['Faction'], 'A cabal of wizards.')
add('iuzdeity', 'Iuz', 'flanaess', ['Deity'], 'The Old One, demigod of evil.')
add('iuzrealm', 'Iuz', 'flanaess', ['Location', 'Realm'], 'The Empire of Iuz.')
add('npcs0001', 'NPCs', null, [], '')
add('sandbox1', 'LK Companion Sandbox', null, [], 'Test pages created by LK Companion go here.')
add('lortmils', 'Lortmil Mountains', 'flanaess', [], 'Mountains rich in gems.')

const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `mock_${Date.now().toString(36)}` })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
const fail = (res: ServerResponse, status: number, code: string, message: string, errors?: unknown) => json(res, status, { code, message, requestId: `mock_${Date.now().toString(36)}`, ...(errors ? { errors } : {}) })
const listItem = (r: Res) => ({ id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: r.aliases, rank: r.rank, isHidden: r.isHidden, createdAt: r.createdAt, updatedAt: r.updatedAt, iconGlyph: null, iconColor: null, documents: r.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })) })
const full = (r: Res) => ({ ...listItem(r), permissions: {}, properties: [], documents: r.documents.map(({ blocks: _b, version: _v, ...d }) => d) })
const plain = (blocks: unknown[]): string => JSON.stringify(blocks).match(/"text":"((?:[^"\\]|\\.)*)"/g)?.map((m) => JSON.parse(m.slice(7))).join(' ') ?? ''

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '')
  const auth = req.headers.authorization ?? ''
  console.log(`${req.method} ${url.pathname}${url.search}`)
  if (!/^Bearer lk_\S+$/.test(auth)) return fail(res, 401, 'UNAUTHENTICATED', 'Unknown API key (rehearsal server accepts any key starting with lk_).')
  const base = `/api/v3/projects/${PROJECT.id}`
  const m = (pattern: RegExp) => pattern.exec(path)

  if (req.method === 'GET' && path === '/api/v3/projects') return json(res, 200, { data: [PROJECT], hasMore: false, nextCursor: null })
  if (req.method === 'GET' && path === base) return json(res, 200, PROJECT)
  if (path.startsWith('/api/v3/projects/') && !path.startsWith(base)) return fail(res, 403, 'WRONG_PROJECT', 'The key belongs to another project.')

  if (req.method === 'GET' && path === `${base}/resources`) {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100)
    const start = Number(url.searchParams.get('cursor') ?? 0)
    const parentId = url.searchParams.get('parentId')
    const all = [...resources.values()].filter((r) => (parentId ? r.parentId === parentId : true)).sort((a, b) => (a.id < b.id ? -1 : 1))
    const page = all.slice(start, start + limit)
    const next = start + limit < all.length ? String(start + limit) : null
    return json(res, 200, { data: page.map(listItem), hasMore: next !== null, nextCursor: next })
  }
  if (req.method === 'POST' && path === `${base}/resources`) {
    const input = (await body(req)) as { id?: string; name: string; parentId?: string; tags?: string[]; aliases?: string[]; documents?: { type?: string; name?: string; blocks?: unknown[] }[] }
    const check = validateAgainstSpec('ResourceCreateParams', input)
    if (!check.valid) return fail(res, 400, 'VALIDATION_ERROR', 'The body does not match the schema.', check.errors.map((e) => ({ path: e.split(' ')[0], message: e })))
    if (input.id && resources.has(input.id)) return fail(res, 409, 'DUPLICATE_ID', 'A resource with this id already exists.')
    if (input.parentId && !resources.has(input.parentId)) return fail(res, 404, 'NOT_FOUND', 'Parent not found.')
    const id = input.id ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`.slice(0, 24).padEnd(24, '0')
    counter++
    const resource: Res = {
      id, name: input.name, parentId: input.parentId ?? null, tags: input.tags ?? [], aliases: input.aliases ?? [], rank: `a${counter}`, isHidden: false, createdAt: now(), updatedAt: now(),
      documents: (input.documents ?? [{ type: 'blank', name: 'Main' }]).map((d, i) => ({ id: `doc_${id}_${i}`, name: d.name ?? 'Main', type: d.type ?? (d.blocks ? 'page' : 'blank'), rank: `a${i}`, isHidden: false, version: 1, blocks: (d.blocks ?? []).map((b, j) => ({ id: `blk_${id}_${j}`, ...(b as object) })) })),
    }
    resources.set(id, resource)
    return json(res, 201, full(resource))
  }
  let match = m(/^\/api\/v3\/projects\/[^/]+\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/)
  if (req.method === 'GET' && match) {
    const doc = resources.get(match[1]!)?.documents.find((d) => d.id === match![2])
    if (!doc) return fail(res, 404, 'NOT_FOUND', 'Document not found.')
    return json(res, 200, { id: doc.id, version: `v${doc.version}`, schema: 1, text: plain(doc.blocks), blocks: doc.blocks })
  }
  match = m(/^\/api\/v3\/projects\/[^/]+\/resources\/([^/]+)$/)
  if (req.method === 'GET' && match) {
    const resource = resources.get(match[1]!)
    return resource ? json(res, 200, full(resource)) : fail(res, 404, 'NOT_FOUND', 'Resource not found.')
  }
  if (req.method === 'GET' && path === `${base}/tags`) {
    const counts = new Map<string, number>()
    for (const r of resources.values()) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return json(res, 200, { data: [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)), hasMore: false, nextCursor: null })
  }
  if (req.method === 'GET' && path === `${base}/search`) {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 32), 100)
    const path0 = (r: Res) => {
      const out: { id: string; name: string }[] = []
      let p = r.parentId ? resources.get(r.parentId) : undefined
      while (p) {
        out.unshift({ id: p.id, name: p.name })
        p = p.parentId ? resources.get(p.parentId) : undefined
      }
      return out
    }
    const hits = q ? [...resources.values()].filter((r) => r.name.toLowerCase().includes(q) || r.aliases.some((a) => a.toLowerCase().includes(q)) || plain(r.documents[0]?.blocks ?? []).toLowerCase().includes(q)) : []
    return json(res, 200, { data: hits.slice(0, limit).map((r) => ({ resource: { id: r.id, name: r.name, tags: r.tags, parentId: r.parentId, path: path0(r) } })), hasMore: false, nextCursor: null })
  }
  return fail(res, 404, 'NOT_FOUND', `The rehearsal server does not implement ${req.method} ${path}.`)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Rehearsal LegendKeeper server (NOT the real LegendKeeper) on http://127.0.0.1:${PORT}`)
})
