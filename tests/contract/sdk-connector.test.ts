import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { p } from '@legendkeeper/sdk/blocks'
import { SdkConnector } from '@/server/lk/sdk-connector'
import { ConnectorError } from '@/server/lk/errors'
import { validateAgainstSpec } from '../helpers/openapi-validator'

/**
 * Contract tests: the real `@legendkeeper/sdk` client, via our SdkConnector, talking HTTP to
 * a small local server that answers like the documented API (paths, envelopes, error
 * bodies). Request bodies are validated against the official OpenAPI spec.
 *
 * This verifies how *our code uses the SDK*. It does not prove the live service behaves the
 * same — that is what the optional integration tests are for.
 */

interface Recorded {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: unknown
}

const PROJECT = { id: 'projcontract', name: 'Contract Project', isPublic: false, createdAt: '2026-01-01T00:00:00Z' }
const KEY = 'lk_contract_test_key_123'
let server: Server
let baseUrl: string
let requests: Recorded[] = []
let createMode: 'ok' | '503' | 'invalid' = 'ok'
let resourcesListMode: 'ok' | '503' = 'ok'
let patchMode: 'ok' | '503' = 'ok'

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req_${requests.length}` })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
const error = (code: string, message: string) => ({ code, message, requestId: `req_${requests.length}` })

const resources = Array.from({ length: 5 }, (_, i) => ({
  id: `res${i}aaaaa`,
  name: `Resource ${i}`,
  parentId: null,
  tags: i % 2 ? ['NPC'] : [],
  aliases: [],
  rank: `a${i}`,
  isHidden: false,
  documents: [{ id: `doc${i}`, name: 'Main', type: 'page' }],
}))

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url!, 'http://localhost')
    // The SDK may send a trailing slash (e.g. GET /api/v3/projects/); treat both forms alike.
    const normalized = url.pathname.replace(/\/+$/, '')
    requests.push({ method: req.method!, path: normalized + url.search, headers: req.headers, body: raw ? JSON.parse(raw) : undefined })

    if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, error('UNAUTHENTICATED', 'Unknown key'))
    const path = normalized
    const base = `/api/v3/projects/${PROJECT.id}`

    if (req.method === 'GET' && path === '/api/v3/projects') return send(res, 200, { data: [PROJECT], hasMore: false, nextCursor: null })
    if (req.method === 'GET' && path === base) return send(res, 200, PROJECT)
    if (req.method === 'GET' && path === `${base}/resources`) {
      if (resourcesListMode === '503') return send(res, 503, error('INTERNAL', 'Unavailable'))
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const slice = resources.slice(start, start + limit)
      const next = start + limit < resources.length ? String(start + limit) : null
      return send(res, 200, { data: slice, hasMore: next !== null, nextCursor: next })
    }
    if (req.method === 'GET' && path === `${base}/tags`) return send(res, 403, error('FORBIDDEN', 'Requires the ADMIN role'))
    if (req.method === 'GET' && path === `${base}/search`) {
      return send(res, 200, { data: [{ resource: { id: 'res1aaaaa', name: 'Resource 1', tags: ['NPC'], parentId: null, path: [{ id: 'x', name: 'World' }] }, document: { id: 'doc1', name: 'Main', highlights: [{ segment: 'a match', index: 0, matchStart: 2, matchEnd: 7 }] } }], hasMore: false, nextCursor: null })
    }
    const blocksMatch = /^\/api\/v3\/projects\/[^/]+\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(path)
    if (req.method === 'GET' && blocksMatch) {
      return send(res, 200, { id: blocksMatch[2], version: 'ver-7', schema: 1, text: 'Hello', blocks: [{ id: 'b1', kind: 'paragraph', content: [{ text: 'Hello' }] }, { id: 'b2', kind: 'unsupported' }] })
    }
    if (req.method === 'PUT' && blocksMatch) {
      if (req.headers['if-match'] !== 'ver-7' && (requests.at(-1)!.body as { ifMatch?: string })?.ifMatch !== 'ver-7') return send(res, 412, error('VERSION_MISMATCH', 'The document is at ver-8'))
      return send(res, 200, { id: blocksMatch[2], version: 'ver-8', schema: 1, text: 'New', blocks: [] })
    }
    const resourceMatch = /^\/api\/v3\/projects\/[^/]+\/resources\/([^/]+)$/.exec(path)
    if (req.method === 'PATCH' && resourceMatch) {
      if (patchMode === '503') return send(res, 503, error('INTERNAL', 'Unavailable'))
      const found = resources.find((r) => r.id === resourceMatch[1])
      if (!found) return send(res, 404, error('NOT_FOUND', 'Resource not found'))
      const body = requests.at(-1)!.body as { tags?: string[] }
      return send(res, 200, { ...found, tags: body.tags ?? found.tags, updatedAt: '2026-10-11T12:00:00Z', permissions: {}, documents: found.documents.map((d) => ({ ...d, rank: 'a0', isHidden: false })), properties: [] })
    }
    if (req.method === 'GET' && resourceMatch) {
      const found = resources.find((r) => r.id === resourceMatch[1])
      if (!found) return send(res, 404, error('NOT_FOUND', 'Resource not found'))
      return send(res, 200, { ...found, permissions: {}, documents: found.documents.map((d) => ({ ...d, rank: 'a0', isHidden: false })), properties: [{ kind: 'keyValue', id: 'p1', title: 'Facts', rows: [{ id: 'r1', rank: 'a0', key: 'Ruler', content: [{ text: 'Iuz' }], text: 'Iuz' }] }] })
    }
    if (req.method === 'POST' && path === `${base}/resources`) {
      if (createMode === '503') return send(res, 503, error('INTERNAL', 'Unavailable'))
      if (createMode === 'invalid') return send(res, 400, { ...error('INVALID_CONTENT', 'The editor cannot hold it'), errors: [{ path: 'documents[0].blocks[0]', message: 'bad' }] })
      const body = requests.at(-1)!.body as { id: string; name: string; parentId?: string; tags: string[] }
      return send(res, 201, { id: body.id, name: body.name, parentId: body.parentId, tags: body.tags, aliases: [], rank: 'a9', isHidden: false, permissions: {}, documents: [{ id: 'docnew', name: 'Main', type: 'page', rank: 'a0', isHidden: false }], properties: [] })
    }
    return send(res, 404, error('NOT_FOUND', `No route ${req.method} ${path}`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  requests = []
  createMode = 'ok'
  resourcesListMode = 'ok'
  patchMode = 'ok'
})

const connector = () => new SdkConnector({ apiKey: KEY, baseUrl, timeoutMs: 5000 })

describe('SdkConnector against a local server that follows the documented API', () => {
  it('reads the project with a bearer key, and pings it with a fresh request', async () => {
    const lk = connector()
    const project = await lk.getProject()
    expect(project).toMatchObject({ id: PROJECT.id, name: PROJECT.name })
    await lk.pingProject(project.id)
    // lk.project() resolves the key's project with one projects.list call; the ping is a fresh projects.get.
    expect(requests.map((r) => r.path)).toEqual(['/api/v3/projects', `/api/v3/projects/${PROJECT.id}`])
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('pages through resources with the opaque cursor', async () => {
    const lk = connector()
    const first = await lk.listResources({ limit: 2 })
    expect(first.items.map((r) => r.id)).toEqual(['res0aaaaa', 'res1aaaaa'])
    expect(first).toMatchObject({ hasMore: true, nextCursor: '2' })
    const second = await lk.listResources({ limit: 2, cursor: first.nextCursor })
    expect(second.items.map((r) => r.id)).toEqual(['res2aaaaa', 'res3aaaaa'])
  })

  it('reads a resource with its sidebar properties, and a document’s blocks with version', async () => {
    const lk = connector()
    const resource = await lk.getResource('res1aaaaa')
    expect(resource.properties[0]).toMatchObject({ kind: 'keyValue', title: 'Facts', text: 'Ruler: Iuz' })
    const content = await lk.getDocumentContent('res1aaaaa', 'doc1')
    expect(content).toMatchObject({ version: 'ver-7', text: 'Hello', unsupportedCount: 1 })
  })

  it('maps errors to plain-language connector errors with the request id', async () => {
    const lk = connector()
    await expect(lk.getResource('nope')).rejects.toMatchObject({ kind: 'not_found', details: { status: 404, code: 'NOT_FOUND', requestId: expect.stringMatching(/^req_/) } })
    await expect(lk.listTags()).rejects.toMatchObject({ kind: 'permission' })
    const bad = new SdkConnector({ apiKey: 'lk_wrong_key_0000', baseUrl })
    await expect(bad.getProject()).rejects.toMatchObject({ kind: 'authentication' })
  })

  it('maps search hits', async () => {
    const hits = await connector().search('Resource', 5)
    expect(hits[0]).toMatchObject({ resourceId: 'res1aaaaa', path: ['World'], documentName: 'Main', highlight: 'a match' })
  })

  it('creates a page with the planned id, an Idempotency-Key, and a schema-valid body', async () => {
    const created = await connector().createPage({
      resourceId: 'abcdefghijklmnopqrstuvwx',
      name: 'Elvera Tallowmere',
      parentId: 'res0aaaaa',
      tags: ['NPC'],
      aliases: ['Elvera'],
      documentName: 'Main',
      blocks: [p('Runs the Green Dragon Inn.')],
      idempotencyKey: 'lkc.abcdefghijklmnopqrstuvwx.0123456789abcdef',
    })
    expect(created).toMatchObject({ resourceId: 'abcdefghijklmnopqrstuvwx', documentId: 'docnew', documentType: 'page' })
    const post = requests.find((r) => r.method === 'POST')!
    expect(post.headers['idempotency-key']).toBe('lkc.abcdefghijklmnopqrstuvwx.0123456789abcdef')
    expect(post.body).toMatchObject({ id: 'abcdefghijklmnopqrstuvwx', documents: [{ type: 'page', name: 'Main' }] })
    expect(validateAgainstSpec('ResourceCreateParams', post.body)).toEqual({ valid: true, errors: [] })
  })

  it('never retries a create, and marks a server error as an uncertain outcome', async () => {
    createMode = '503'
    const failure = await connector()
      .createPage({ resourceId: 'abcdefghijklmnopqrstuvwx', name: 'X', parentId: null, tags: [], aliases: [], documentName: 'Main', blocks: [p('x')], idempotencyKey: 'k' })
      .catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ConnectorError)
    expect(failure).toMatchObject({ kind: 'server', details: { outcome: 'unknown' } })
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('reports validation refusals with the failing paths, as not applied', async () => {
    createMode = 'invalid'
    const failure = await connector()
      .createPage({ resourceId: 'abcdefghijklmnopqrstuvwx', name: 'X', parentId: null, tags: [], aliases: [], documentName: 'Main', blocks: [p('x')], idempotencyKey: 'k' })
      .catch((e: unknown) => e)
    expect(failure).toMatchObject({ kind: 'validation', details: { outcome: 'not_applied', issues: [{ path: 'documents[0].blocks[0]', message: 'bad' }] } })
  })

  it('retries reads on 503 (the SDK’s documented policy), then reports the failure', async () => {
    resourcesListMode = '503'
    await expect(connector().listResources({ limit: 2 })).rejects.toMatchObject({ kind: 'server' })
    expect(requests.filter((r) => r.path.startsWith(`/api/v3/projects/${PROJECT.id}/resources`))).toHaveLength(3)
  }, 20_000)

  it('replaces a resource’s tags with a body that matches the spec, and never retries a failed update', async () => {
    const lk = connector()
    const result = await lk.updateResourceTags('res1aaaaa', ['NPC', 'Greyhawk'])
    expect(result).toEqual({ tags: ['NPC', 'Greyhawk'], updatedAt: '2026-10-11T12:00:00Z' })
    const patch = requests.find((r) => r.method === 'PATCH')!
    expect(patch.body).toEqual({ tags: ['NPC', 'Greyhawk'] })
    expect(validateAgainstSpec('ResourceUpdateParams', patch.body).valid).toBe(true)
    requests = []
    patchMode = '503'
    await expect(lk.updateResourceTags('res1aaaaa', ['NPC'])).rejects.toMatchObject({ kind: 'server', details: { outcome: 'unknown' } })
    expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(1)
  })

  it('replaces page content only at the expected version', async () => {
    const lk = connector()
    await expect(lk.replaceDocumentBlocks('res1aaaaa', 'doc1', [p('New')], 'ver-7')).resolves.toEqual({ version: 'ver-8' })
    const put = requests.find((r) => r.method === 'PUT')!
    expect(validateAgainstSpec('DocumentBlocksWrite', put.body).valid).toBe(true)
    await expect(lk.replaceDocumentBlocks('res1aaaaa', 'doc1', [p('New')], 'ver-6')).rejects.toMatchObject({ kind: 'version_conflict', details: { outcome: 'not_applied' } })
  })
})
