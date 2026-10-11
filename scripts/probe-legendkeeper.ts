/**
 * LIVE capability probe for a LegendKeeper TEST project.
 *
 * Exercises, against the real API, the behaviours this app relies on and records what
 * actually happens. Everything it creates lives under one new top-level page called
 * "LK Companion Dev Sandbox <time>", which it deletes (with its children) at the end
 * unless LKC_PROBE_KEEP=1.
 *
 * NEVER run this against a campaign project you care about. It needs explicit opt-in:
 *
 *   LKC_PROBE=1 npx tsx scripts/probe-legendkeeper.ts
 *
 * Reads LEGENDKEEPER_API_KEY (and optional LEGENDKEEPER_BASE_URL) from the environment or
 * .env.local. Writes a report to data/probe-report.json (git-ignored). Never prints the key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ConflictError, LegendKeeper, LegendKeeperError, NotFoundError, VersionMismatchError, SDK_VERSION } from '@legendkeeper/sdk'
import { h, keyValue, p, plainText, property, walk } from '@legendkeeper/sdk/blocks'
import { CanonicalPage } from '../src/core/page-model'
import { findBuiltInPageType } from '../src/core/page-types'
import { resolveTemplate } from '../src/core/resolve'
import { idempotencyKeyFor, newLkResourceId } from '../src/core/ids'
import { buildCreatePayload } from '../src/server/lk/render'

function loadEnv() {
  if (!existsSync('.env.local')) return
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim()
  }
}
loadEnv()
if (process.env.LKC_PROBE !== '1') {
  console.error('Refusing to run without LKC_PROBE=1 (this creates and deletes pages in the configured project).')
  process.exit(2)
}
const apiKey = process.env.LEGENDKEEPER_API_KEY
if (!apiKey) {
  console.error('LEGENDKEEPER_API_KEY is not set.')
  process.exit(2)
}

const lk = new LegendKeeper({ apiKey, ...(process.env.LEGENDKEEPER_BASE_URL ? { baseUrl: process.env.LEGENDKEEPER_BASE_URL } : {}) })
type Result = { check: string; outcome: 'pass' | 'fail' | 'info'; detail: unknown }
const results: Result[] = []
const record = (check: string, outcome: Result['outcome'], detail: unknown) => {
  results.push({ check, outcome, detail })
  console.log(`${outcome.toUpperCase().padEnd(4)} ${check}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const describeError = (e: unknown) =>
  e instanceof LegendKeeperError ? { name: e.name, status: e.status, code: e.code, message: e.message, requestId: e.requestId, errors: e.errors } : { name: (e as Error).name, message: (e as Error).message }
async function step(check: string, fn: () => Promise<unknown>) {
  try {
    const detail = await fn()
    record(check, 'pass', detail)
  } catch (e) {
    record(check, 'fail', describeError(e))
  }
}

const created: string[] = []
let sandboxId: string | null = null

async function main() {
  record('SDK version', 'info', SDK_VERSION)
  const project = await lk.project()
  record('project()', 'pass', { id: project.id, name: project.name })
  await step('projects.get (fresh read)', async () => (await lk.projects.get({ projectId: project.id })).name)

  await step('resources.list (count, up to 3,000)', async () => {
    let count = 0
    let pages = 0
    let page: Awaited<ReturnType<typeof lk.resources.list>> | null = await lk.resources.list({ limit: 100 })
    while (page && count < 3000) {
      count += page.data.length
      pages++
      page = await page.next()
    }
    return { resources: count, pages }
  })
  await step('tags.list (ADMIN)', async () => {
    const tags = await lk.tags.list()
    return { distinct: tags.data.length, top: tags.data.slice(0, 8) }
  })
  await step('calendars.list', async () => (await lk.calendars.list()).data.map((c) => c.id))
  await step('search.search', async () => (await lk.search.search({ q: 'a', limit: 3 })).data.length)
  await step('getResource on an unknown id → NotFoundError', async () => {
    try {
      await lk.resources.get({ resourceId: 'zzzzzzzz' })
      throw new Error('expected NotFoundError')
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e
      return { code: e.code, requestId: e.requestId ? 'present' : 'missing' }
    }
  })

  // ── Writes, all under a dedicated sandbox ────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const sandbox = await lk.resources.create({ name: `LK Companion Dev Sandbox ${stamp}` })
  sandboxId = sandbox.id
  created.push(sandbox.id)
  record('create top-level sandbox (ADMIN)', 'pass', { id: sandbox.id, firstDocument: sandbox.documents[0]?.type })

  const target = await lk.resources.create({ name: 'Probe Mention Target', parentId: sandbox.id, aliases: ['Probe Target Alias'] })
  record('create child resource', 'pass', { id: target.id, parentId: target.parentId })

  // The app's own renderer → create with planned id + idempotency key, then read back.
  const npc = findBuiltInPageType('npc')!
  const page = CanonicalPage.parse({
    schemaVersion: 1,
    name: 'Probe NPC Elvera',
    pageType: 'npc',
    parentId: sandbox.id,
    aliases: ['Elvera the Probe'],
    fields: [
      { key: 'ancestry', label: 'Ancestry', group: 'lore', value: 'half-elf', status: 'source' },
      { key: 'statblock', label: 'Statblock', group: 'mechanics', value: 'as veteran (MM p. 350)', status: 'source' },
    ],
    sections: [
      { id: 's1', heading: 'Description', kind: 'lore', paragraphs: ['Elvera trades secrets with Probe Mention Target.\nSecond line.', '- one\n- two'] },
      { id: 's2', heading: 'Actions', kind: 'mechanics', paragraphs: ['**Dagger.** Melee Weapon Attack: +4 to hit.'] },
    ],
    references: [{ id: 'r1', mention: 'Probe Mention Target', status: 'resolved', resourceId: target.id, candidates: [{ resourceId: target.id, name: target.name, matchType: 'exact_name' }] }],
    tags: [{ value: 'LKC Probe', status: 'new', origin: 'user', accepted: true }],
    sources: [{ title: 'Capability probe', kind: 'paste', importedAt: new Date().toISOString() }],
  })
  const plannedId = newLkResourceId()
  const payload = buildCreatePayload(page, { pageType: npc, template: resolveTemplate(npc, null) }, plannedId, idempotencyKeyFor('lkc-probe', plannedId))
  const body = {
    id: payload.resourceId,
    name: payload.name,
    parentId: payload.parentId!,
    tags: payload.tags,
    aliases: payload.aliases,
    documents: [{ type: 'page' as const, name: payload.documentName, blocks: payload.blocks as never }],
  }
  const first = await lk.resources.create({ ...body, idempotencyKey: payload.idempotencyKey })
  created.push(first.id)
  record('create page from the app renderer with a planned id', first.id === plannedId ? 'pass' : 'fail', { requested: plannedId, got: first.id, docType: first.documents[0]?.type })

  await step('idempotent replay (same key, same body) → same resource, no duplicate', async () => {
    const again = await lk.resources.create({ ...body, idempotencyKey: payload.idempotencyKey })
    const siblings = (await lk.resources.list({ parentId: sandbox.id, limit: 100 })).data.filter((r) => r.name === body.name)
    if (again.id !== first.id || siblings.length !== 1) throw new Error(`replay id ${again.id}, ${siblings.length} pages with that name`)
    return { sameId: true, pagesWithName: siblings.length }
  })
  await step('same planned id with a new key → 409 DUPLICATE_ID', async () => {
    try {
      await lk.resources.create({ ...body, idempotencyKey: `${payload.idempotencyKey}-second` })
      throw new Error('expected ConflictError')
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e
      return e.code
    }
  })

  const doc = { resourceId: first.id, documentId: first.documents[0]!.id }
  const read = await lk.documents.getBlocks(doc)
  const kinds: string[] = []
  walk(read, (block) => kinds.push(block.kind))
  const mentionNames: string[] = []
  walk(read, (block) => {
    for (const run of ((block as { content?: { mention?: { name?: string } }[] }).content ?? [])) if (run.mention) mentionNames.push(run.mention.name ?? '(no name)')
  })
  record('read back blocks', 'pass', { version: read.version, topLevel: read.blocks.map((b) => b.kind), allKinds: [...new Set(kinds)], mentionNames, textStart: read.text.slice(0, 120) })
  const full = await lk.resources.get({ resourceId: first.id })
  record('read back resource', full.name === body.name && full.parentId === sandbox.id ? 'pass' : 'fail', { name: full.name, parentId: full.parentId, tags: full.tags, aliases: full.aliases })

  await step('versioned write: replaceBlocks with current ifMatch', async () => {
    const written = await lk.documents.replaceBlocks(doc, { blocks: [...read.blocks, p('Appended by the probe.')], ifMatch: read.version })
    return { from: read.version, to: written.version }
  })
  await step('versioned write with a stale version → 412 VersionMismatchError', async () => {
    try {
      await lk.documents.replaceBlocks(doc, { blocks: [p('stale')], ifMatch: read.version })
      throw new Error('expected VersionMismatchError')
    } catch (e) {
      if (!(e instanceof VersionMismatchError)) throw e
      return { code: e.code, currentVersion: e.currentVersion ?? null }
    }
  })
  await step('single-block insert after the first heading', async () => {
    const current = await lk.documents.getBlocks(doc)
    const heading = current.blocks.find((b) => b.kind === 'heading')
    const inserted = await lk.blocks.insert(doc, { block: p('Inserted by the probe.'), ...(heading?.id ? { after: heading.id } : {}), ifMatch: current.version })
    return { id: inserted.id, version: inserted.version }
  })
  await step('resources.update tags and aliases (replace whole lists)', async () => {
    const updated = await lk.resources.update({ resourceId: first.id }, { tags: ['LKC Probe', 'LKC Probe Second'], aliases: ['Elvera'] })
    return { tags: updated.tags, aliases: updated.aliases }
  })
  await step('sidebar property create + list', async () => {
    const prop = await lk.properties.create({ resourceId: first.id }, property(keyValue([['Probe', 'value']]), { title: 'Probe facts' }))
    const list = await lk.properties.list({ resourceId: first.id })
    return { created: prop.kind, count: list.data.length }
  })
  await step('documents.create second page tab', async () => {
    const tab = await lk.documents.create({ resourceId: first.id }, { name: 'GM Notes', type: 'page', isHidden: true })
    await lk.documents.replaceBlocks({ resourceId: first.id, documentId: tab.id }, { blocks: [h(2, 'Secret'), p('Hidden tab content.')] })
    return { id: tab.id, plain: plainText(await lk.documents.getBlocks({ resourceId: first.id, documentId: tab.id })) }
  })
  await step('tags.list reflects new tags', async () => (await lk.tags.list()).data.filter((t) => t.tag.startsWith('LKC Probe')))
  await step('search finds the new page by alias', async () => (await lk.search.search({ q: 'Elvera', limit: 10 })).data.map((hit) => hit.resource.name))
  await step('delete child, then restore it', async () => {
    await lk.resources.delete({ resourceId: target.id })
    const restored = await lk.resources.restore({ resourceId: target.id })
    return restored.name
  })
  await step('delete parent with children without cascade → 409 HAS_CHILDREN', async () => {
    try {
      await lk.resources.delete({ resourceId: sandbox.id })
      throw new Error('expected HAS_CHILDREN')
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e
      return e.code
    }
  })
  record('templates', 'info', 'The v3 API has no template endpoints; nothing to probe.')
}

async function cleanup() {
  if (!sandboxId) return
  if (process.env.LKC_PROBE_KEEP === '1') {
    record('cleanup', 'info', `kept sandbox ${sandboxId} (LKC_PROBE_KEEP=1)`)
    return
  }
  await step('cleanup: delete sandbox with cascade', async () => {
    await lk.resources.delete({ resourceId: sandboxId! }, { cascade: true })
    return sandboxId
  })
}

main()
  .catch((e) => record('probe aborted', 'fail', describeError(e)))
  .finally(async () => {
    await cleanup().catch((e) => record('cleanup', 'fail', describeError(e)))
    mkdirSync('data', { recursive: true })
    writeFileSync('data/probe-report.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
    const failed = results.filter((r) => r.outcome === 'fail').length
    console.log(`\n${results.length} checks, ${failed} failed. Report: data/probe-report.json`)
    process.exit(failed ? 1 : 0)
  })
