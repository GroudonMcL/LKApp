/**
 * LK Web Clipper — Phase 1 proof of concept (see docs/WEB_CLIPPER_PHASE1.md).
 *
 * Proves the LegendKeeper side of the clipper against a TEST project before any browser
 * extension is built: project details, the page tree, search, a new clipped page, appending
 * (with a simulated edit made in LegendKeeper at the same moment), real mentions, a Source page
 * with a Backlinks collection, and an uploaded image.
 *
 * Everything it writes goes under one top-level page, "LK Web Clipper Sandbox" (found or
 * created), in a new "Phase 1 run <time>" page. Nothing is deleted; the run page ends with a
 * table of the results so they can be checked in LegendKeeper. The only change outside the
 * sandbox is a backlink: one clipped page names the project's existing "D&D Beyond" source.
 *
 *   LKC_CLIPPER_POC=1 npx tsx scripts/clipper-phase1.ts
 *
 * Reads LEGENDKEEPER_API_KEY (and optional LEGENDKEEPER_BASE_URL) from the environment or
 * .env.local. Optional: LKC_CLIPPER_IMAGE_URL (an image to clip), LKC_CLIPPER_SOURCES_ID (the
 * project's Sources page; found by name otherwise). Writes data/clipper-phase1-report.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { LegendKeeperError, SDK_VERSION } from '@legendkeeper/sdk'
import {
  bold, code, h, italic, li, link, mention, ol, p, plainText, quote, rule, table, td, th, tr, ul, walk, type Block,
} from '@legendkeeper/sdk/blocks'
import { isBacklinksCollection } from '../src/core/clipper/blocks'
import type { ProjectIndex } from '../src/core/clipper/project-index'
import { ClipperClient, clipImageBlock, type UploadedImage } from '../src/server/clipper/lk-clipper'

function loadEnv() {
  if (!existsSync('.env.local')) return
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim()
  }
}
loadEnv()
if (process.env.LKC_CLIPPER_POC !== '1') {
  console.error('Refusing to run without LKC_CLIPPER_POC=1 (this creates pages in the configured project).')
  process.exit(2)
}
const apiKey = process.env.LEGENDKEEPER_API_KEY
if (!apiKey) {
  console.error('LEGENDKEEPER_API_KEY is not set.')
  process.exit(2)
}

const SANDBOX_NAME = 'LK Web Clipper Sandbox'
const IMAGE_URL = process.env.LKC_CLIPPER_IMAGE_URL || 'https://raw.githubusercontent.com/github/explore/main/topics/typescript/typescript.png'
const clipper = new ClipperClient({ apiKey, baseUrl: process.env.LEGENDKEEPER_BASE_URL || null })
const lk = clipper.lk

// ── Result recording ────────────────────────────────────────────────────────
type Outcome = 'pass' | 'fail' | 'info' | 'skip'
interface Result { area: string; check: string; outcome: Outcome; detail: string }
const results: Result[] = []
function record(area: string, check: string, outcome: Outcome, detail: unknown = '') {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ area, check, outcome, detail: text })
  console.log(`${outcome.toUpperCase().padEnd(4)} [${area}] ${check}${text ? ` — ${text}` : ''}`)
}
function describeError(e: unknown): string {
  if (e instanceof LegendKeeperError) return `${e.name} ${e.status ?? ''} ${e.code ?? ''}: ${e.message}${e.errors?.length ? ` ${JSON.stringify(e.errors)}` : ''}`
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
/** Runs one check; a thrown error or a returned `false`-y `ok` fails it. */
async function check<T>(area: string, name: string, fn: () => Promise<{ ok: boolean; detail: unknown; value?: T }>): Promise<T | undefined> {
  try {
    const { ok, detail, value } = await fn()
    record(area, name, ok ? 'pass' : 'fail', detail)
    return ok ? value : undefined
  } catch (e) {
    record(area, name, 'fail', describeError(e))
    return undefined
  }
}

const kinds = (blocks: Block[]) => blocks.map((b) => (b.kind === 'heading' ? `h${(b as { level: number }).level}` : b.kind))
type MentionRun = { resourceId: string; name?: string; text?: string }
/** Mention runs read back as `{ mention: { resourceId, name, text? } }`. */
function mentionsIn(blocks: Block[]): MentionRun[] {
  const found: MentionRun[] = []
  walk(blocks, (block) => {
    for (const run of ((block as { content?: unknown[] }).content ?? []) as { mention?: MentionRun }[]) {
      if (run?.mention?.resourceId) found.push(run.mention)
    }
  })
  return found
}
/** Blocks compared without server-assigned fields that a write may fill in. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── The clipped content (what Phase 2's converter will produce from a web page) ──
function clippedContent(refs: { dragonId?: string; greyhawkId?: string; image?: UploadedImage }): Block[] {
  const blocks: Block[] = [
    h(2, 'Red Dragons'),
    p(
      'Red dragons are the most ', bold('covetous'), ' of the chromatic dragons, ', italic('hoarding'), ' coins, art and relics in volcanic lairs. ',
      ...(refs.dragonId ? ['See ', mention({ resourceId: refs.dragonId }), ' for dragons in general.'] : []),
    ),
    p(
      'In the Flanaess, sages of ',
      ...(refs.greyhawkId ? [mention({ resourceId: refs.greyhawkId, text: 'Greyhawk' })] : ['Greyhawk']),
      ' record sightings near the Hellfurnaces. More reading: ', link('https://en.wikipedia.org/wiki/Dragon_(Dungeons_%26_Dragons)', 'dragons in D&D (Wikipedia)'), '.',
    ),
    h(3, 'Lair features'),
    ul('Magma pools and sulphurous vents', li('Hoard chambers', ul('Coins sorted by metal', 'Trophies of slain heroes')), 'Collapsed tunnels as traps'),
    h(3, 'Encounter steps'),
    ol(['Hear the rumble', 'Smell the sulphur', 'Roll initiative']),
    quote('“A red dragon never forgets a slight, and never forgives a theft.”'),
    table(
      tr(th(['Age']), th(['Challenge']), th(['Notes'])),
      tr(td(['Wyrmling']), td(['CR 4']), td(['Fits through a door'])),
      tr(td(['Adult']), td(['CR 17']), td([p('Lair actions, ', bold('legendary'), ' resistance')])),
    ),
    code('Fire Breath (Recharge 5–6): 30-ft cone, DC 21 Dex save, 63 (18d6) fire damage', 'text'),
  ]
  if (refs.image) blocks.push(h(3, 'Image'), clipImageBlock(refs.image, 'Clipped test image'))
  return blocks
}

async function findOrCreateSandbox(index: ProjectIndex): Promise<{ id: string; created: boolean }> {
  const existing = index.pages().filter((page) => page.name === SANDBOX_NAME && page.parentId === null)
  if (existing[0]) return { id: existing[0].id, created: false }
  const created = await clipper.createPage({
    name: SANDBOX_NAME,
    parentId: null, // top level (needs an ADMIN key)
    blocks: [
      p('Test pages made by the LK Web Clipper proof of concept (scripts/clipper-phase1.ts). Each run is one child page; open it for the results table.'),
      p('Safe to delete once checked.'),
    ],
  })
  return { id: created.resourceId, created: true }
}

async function main() {
  const startedAt = new Date()
  const stamp = startedAt.toISOString().slice(0, 16).replace('T', ' ')
  record('setup', 'SDK version', 'info', SDK_VERSION)

  // 1. Project details
  const project = await check('1 project', 'Load project details', async () => {
    const info = await clipper.project()
    return { ok: !!info.id, detail: info, value: info }
  })
  if (!project) throw new Error('Cannot continue without the project')
  await check('1 project', 'Key role (ADMIN needed for a top-level sandbox and for tags)', async () => {
    try {
      const tags = await lk.tags.list()
      return { ok: true, detail: `ADMIN or OWNER (tags.list allowed, ${tags.data.length} tags)` }
    } catch (e) {
      return { ok: true, detail: `MEMBER (${describeError(e)}): the clipper still works under an existing parent page` }
    }
  })

  // 2. Hierarchy
  let index = (await check('2 hierarchy', 'Retrieve every page (paged, 100 at a time) and build paths', async () => {
    const t = Date.now()
    const idx = await clipper.loadIndex()
    const deepest = idx.pages().reduce((max, page) => Math.max(max, page.path.length), 0)
    const sample = idx.pages().find((page) => page.path.length >= 1 && page.name.includes('Dragon'))
    return { ok: idx.size > 0, detail: { pages: idx.size, deepestLevel: deepest + 1, ms: Date.now() - t, samplePath: sample ? idx.displayPath(sample.id) : null }, value: idx }
  }))!
  if (!index) throw new Error('Cannot continue without the page index')
  await check('2 hierarchy', 'Page tabs: writable (page or blank) vs other tab types', async () => {
    const counts: Record<string, number> = {}
    for (const page of index.pages()) for (const doc of page.documents) counts[doc.type] = (counts[doc.type] ?? 0) + 1
    const multiPage = index.pages().filter((page) => page.documents.filter((d) => d.type === 'page').length > 1).length
    return { ok: true, detail: { tabTypes: counts, pagesWithSeveralPageTabs: multiPage } }
  })

  // 3. Search
  for (const query of ['Dragon', 'Greyhawk', 'Dragn']) {
    await check('3 search', `Clipper search "${query}" (local ranked names + LegendKeeper content hits)`, async () => {
      const ranked = await clipper.search(index, query, 8)
      return { ok: ranked.length > 0, detail: ranked.map((r) => `${index.displayPath(r.page.id)} (${r.match}${r.detail ? `: ${r.detail.slice(0, 40)}` : ''})`) }
    })
  }
  await check('3 search', 'LegendKeeper search.search "Dragon" as-is, for comparison', async () => {
    const remote = await clipper.remoteSearch('Dragon', 6)
    return { ok: remote.length > 0, detail: remote.map((r) => `${r.name}${r.inContent ? ' (content)' : ''}`) }
  })
  await check('3 search', 'Tag search "Monster"', async () => {
    const ranked = index.search('Monster', { limit: 5 })
    return { ok: ranked.some((r) => r.match === 'tag'), detail: ranked.map((r) => `${r.page.name} (${r.match}${r.detail ? `: ${r.detail}` : ''})`) }
  })
  const dragon = index.search('Dragon', { limit: 1 })[0]
  const greyhawk = index.search('World of Greyhawk', { limit: 1 })[0]
  const projectSources = process.env.LKC_CLIPPER_SOURCES_ID || index.pages().find((page) => page.name === 'Sources' && page.parentId === null)?.id || null
  const existingSource = await check('3 search', 'Website source "D&D Beyond" already exists under Sources → would prompt to reuse it', async () => {
    const found = index.findSourceByName('D&D Beyond', { sourcesRootId: projectSources, sourceTag: 'Source' })
    return { ok: found.length === 1, detail: found.map((f) => index.displayPath(f.id)), value: found[0] }
  })

  // 4. Sandbox and run page
  const sandbox = await check('4 create', `Find or create the top-level "${SANDBOX_NAME}" page`, async () => {
    const s = await findOrCreateSandbox(index)
    return { ok: true, detail: s, value: s }
  })
  if (!sandbox) throw new Error('Cannot continue without the sandbox')
  const run = await check('4 create', 'Create this run\'s page under the sandbox', async () => {
    const page = await clipper.createPage({ name: `Phase 1 run ${stamp}`, parentId: sandbox.id, blocks: [p('Running… the results table replaces this text when the run ends.')] })
    return { ok: true, detail: { id: page.resourceId }, value: page }
  })
  if (!run) throw new Error('Cannot continue without the run page')
  const sourcesFolder = await check('4 create', 'Create a "Sources" page for this run (stands in for the project\'s Sources page)', async () => {
    const page = await clipper.createPage({ name: 'Sources', parentId: run.resourceId, blocks: [p('Source pages created by this run.')] })
    return { ok: true, detail: { id: page.resourceId }, value: page }
  })

  // 5. Source page with Backlinks
  const newSource = sourcesFolder
    ? await check('5 source', 'Create Source page "Clipper Test Source" with a Backlinks collection', async () => {
        const page = await clipper.createSourcePage({ name: 'Clipper Test Source', sourcesParentId: sourcesFolder.resourceId })
        const collection = page.blocks.find(isBacklinksCollection)
        const reference = existingSource ? await lk.documents.getBlocks({ resourceId: existingSource.id, documentId: existingSource.documents[0]!.id }) : null
        const refCollection = reference?.blocks.find(isBacklinksCollection)
        // Same filter, title and title visibility (key order and an empty `items` list aside).
        const shape = (b: unknown) => {
          const c = b as { filter?: Record<string, unknown>; title?: string; isTitleHidden?: boolean }
          return { filter: Object.fromEntries(Object.entries(c.filter ?? {}).sort(([x], [y]) => x.localeCompare(y))), title: c.title, isTitleHidden: c.isTitleHidden }
        }
        const sameShape = refCollection ? same(shape(collection), shape(refCollection)) : null
        return {
          ok: !!collection && sameShape !== false,
          detail: { id: page.resourceId, blocks: kinds(page.blocks), sameAsExistingDnDBeyondSourcePage: sameShape ?? 'no reference page' },
          value: page,
        }
      })
    : undefined
  if (newSource) index.upsert({ id: newSource.resourceId, name: newSource.name, aliases: [], tags: [], parentId: sourcesFolder!.resourceId, documents: [{ id: newSource.documentId, name: 'Main', type: 'page' }] })
  await check('5 source', 'Index updated in place: the new source is found by the source search', async () => {
    const found = index.findSourceByName('clipper test source', { sourcesRootId: sourcesFolder?.resourceId ?? null })
    return { ok: found.length === 1, detail: found.map((f) => index.displayPath(f.id)) }
  })

  // 6. Image upload
  const uploaded = await check('6 image', `Download an image from the web and upload it as an asset (${IMAGE_URL})`, async () => {
    const img = await clipper.uploadImageFromUrl(IMAGE_URL, `Web Clipper test image ${stamp}`)
    return { ok: img.url.length > 0, detail: img, value: img }
  })
  await check('6 image', 'Refuse a download that is not an image (a web page)', async () => {
    try {
      await clipper.uploadImageFromUrl('https://www.legendkeeper.com/', 'not an image')
      return { ok: false, detail: 'was accepted' }
    } catch (e) {
      return { ok: true, detail: describeError(e) }
    }
  })

  // 7. New clipped page (source = the project's existing D&D Beyond source page)
  const sourceForNew = existingSource ? { resourceId: existingSource.id } : newSource ? { resourceId: newSource.resourceId } : null
  const clipped = sourceForNew
    ? await check('7 new page', 'Create a clipped page: H1 "From <Source>" + headings, marks, lists, quote, table, code, link, mentions, image', async () => {
        const page = await clipper.createClipPage({
          name: 'Clip test — Red Dragon notes (new page)',
          parentId: run.resourceId,
          source: sourceForNew,
          content: clippedContent({ dragonId: dragon?.page.id, greyhawkId: greyhawk?.page.id, image: uploaded }),
        })
        return { ok: page.blocks.length > 5, detail: { id: page.resourceId, blocks: kinds(page.blocks) }, value: page }
      })
    : undefined
  if (clipped) {
    await check('7 new page', 'Read back: the heading is "From " + a real mention of the Source page', async () => {
      const heading = clipped.blocks[0]!
      const m = mentionsIn([heading])[0]
      return { ok: heading.kind === 'heading' && m?.resourceId === sourceForNew!.resourceId, detail: { text: plainText(heading), mention: m } }
    })
    await check('7 new page', 'Read back: mentions of existing pages resolve to their names', async () => {
      const ms = mentionsIn(clipped.blocks)
      return { ok: ms.length >= 2 && ms.every((m) => m.name), detail: ms.map((m) => `${m.text ?? m.name} → ${index.displayPath(m.resourceId) || m.resourceId}`) }
    })
    await check('7 new page', 'Read back: the image block holds the uploaded asset url', async () => {
      let url: string | undefined
      walk(clipped.blocks, (b) => { if (b.kind === 'image') url = (b as { url?: string }).url })
      return { ok: !!uploaded && url === uploaded.url, detail: url ?? 'no image block' }
    })
    await check('7 new page', 'Read back: the external link keeps its href', async () => {
      const json = JSON.stringify(clipped.blocks)
      return { ok: json.includes('https://en.wikipedia.org/wiki/Dragon_(Dungeons_%26_Dragons)'), detail: 'link mark present' }
    })
  }

  // 8. Append to an existing page
  const target = await check('8 append', 'Create a stand-in "existing page" with its own content', async () => {
    const page = await clipper.createPage({
      name: 'Clip test — Dragon research (existing page)',
      parentId: run.resourceId,
      blocks: [h(2, 'My notes'), p('Notes I wrote before clipping anything. ', bold('This must not change.')), ul('Ask the sage', 'Check the map')],
    })
    return { ok: true, detail: { id: page.resourceId, blocks: kinds(page.blocks) }, value: page }
  })
  if (target && newSource) {
    await check('8 append', 'Append a clip from "Clipper Test Source": divider + H1 "From <Source>" + content at the bottom', async () => {
      const before = await lk.documents.getBlocks({ resourceId: target.resourceId, documentId: target.documentId })
      const result = await clipper.appendClip({
        resourceId: target.resourceId,
        source: { resourceId: newSource.resourceId },
        content: [p('Red dragons lair in volcanic peaks. ', ...(dragon ? ['Related: ', mention({ resourceId: dragon.page.id }), '.'] : [])), ul('Immune to fire', 'Vulnerable to nothing in particular')],
      })
      const after = await lk.documents.getBlocks({ resourceId: target.resourceId, documentId: target.documentId })
      const unchanged = same(after.blocks.slice(0, before.blocks.length), before.blocks)
      const added = kinds(after.blocks.slice(before.blocks.length))
      return { ok: unchanged && added[0] === 'rule' && added[1] === 'h1', detail: { ...result, existingBlocksUnchanged: unchanged, added } }
    })
  }
  if (target && sourceForNew) {
    await check('8 append', 'Append while the page is edited in LegendKeeper at the same moment: 412, re-read, re-apply, nothing lost', async () => {
      const ref = { resourceId: target.resourceId, documentId: target.documentId }
      const result = await clipper.appendClip({
        ...ref,
        source: sourceForNew,
        content: [p('A second clip from another source, written after a version conflict.')],
        beforeWrite: async (attempt) => {
          if (attempt !== 1) return
          const current = await lk.documents.getBlocks(ref)
          await lk.blocks.insert(ref, { block: p('Typed in LegendKeeper while the clipper was writing.'), ifMatch: current.version })
        },
      })
      const after = await lk.documents.getBlocks(ref)
      const text = after.text
      const kept = text.includes('Typed in LegendKeeper while the clipper was writing.')
      const clippedIn = text.includes('written after a version conflict')
      return { ok: result.attempts === 2 && kept && clippedIn, detail: { attempts: result.attempts, concurrentEditKept: kept, clipWritten: clippedIn, blocksAfter: after.blocks.length } }
    })
  }
  await check('8 append', 'Append to a page whose only tab is still "blank" (like folder pages): becomes a page, no divider', async () => {
    const resource = await lk.resources.create({ name: 'Clip test — blank folder page', parentId: run.resourceId })
    const docType = resource.documents[0]?.type
    const result = await clipper.appendClip({ resourceId: resource.id, source: { resourceId: (newSource ?? clipped)!.resourceId }, content: [p('First content on a blank page.')] })
    const doc = await lk.documents.get({ resourceId: resource.id, documentId: result.documentId })
    const after = await lk.documents.getBlocks({ resourceId: resource.id, documentId: result.documentId })
    return { ok: docType === 'blank' && doc.type === 'page' && kinds(after.blocks)[0] === 'h1', detail: { typeBefore: docType, typeAfter: doc.type, blocks: kinds(after.blocks) } }
  })
  await check('8 append', 'Refuse to append to a tab that is not a page (a map)', async () => {
    const resource = await lk.resources.create({ name: 'Clip test — map page (not appendable)', parentId: run.resourceId, documents: [{ type: 'map', name: 'Map' }] })
    try {
      await clipper.appendClip({ resourceId: resource.id, source: { resourceId: run.resourceId }, content: [p('x')] })
      return { ok: false, detail: 'was accepted' }
    } catch (e) {
      return { ok: true, detail: describeError(e) }
    }
  })

  // 9. Backlinks
  for (const [label, sourceId] of [['Clipper Test Source', newSource?.resourceId], ['D&D Beyond (existing)', existingSource?.id]] as const) {
    if (!sourceId) continue
    await check('9 backlinks', `Pages that now link to "${label}" (found by reading this run's pages)`, async () => {
      const linking: string[] = []
      for (const page of [clipped, target].filter(Boolean)) {
        const blocks = await lk.documents.getBlocks({ resourceId: page!.resourceId, documentId: page!.documentId })
        if (mentionsIn(blocks.blocks).some((m) => m.resourceId === sourceId)) linking.push(page!.name)
      }
      return { ok: linking.length > 0, detail: `${linking.join(', ')} — the Backlinks collection on the Source page is evaluated by the LegendKeeper app (open the page to see it); the API stores the filter only` }
    })
  }

  // Results table on the run page
  const finishedAt = new Date()
  const passed = results.filter((r) => r.outcome === 'pass').length
  const failed = results.filter((r) => r.outcome === 'fail').length
  await check('report', 'Write the results table onto the run page', async () => {
    const current = await lk.documents.getBlocks({ resourceId: run.resourceId, documentId: run.documentId })
    const rows = results.map((r) => tr(td([r.area]), td([r.check]), td([r.outcome.toUpperCase()]), td([r.detail.slice(0, 600) || '—'])))
    const blocks: Block[] = [
      h(1, 'Web Clipper Phase 1 — results'),
      p(`Project: ${project.name}. Started ${startedAt.toISOString()}, finished ${finishedAt.toISOString()}. SDK ${SDK_VERSION}.`),
      p(bold(`${passed} passed, ${failed} failed`), ` (the report row itself is not counted). Pages made by this run are the children of this page.`),
      rule(),
      table(tr(th(['Area']), th(['Check']), th(['Result']), th(['Detail'])), ...rows),
    ]
    const written = await lk.documents.replaceBlocks({ resourceId: run.resourceId, documentId: run.documentId }, { blocks, ifMatch: current.version })
    return { ok: true, detail: { version: written.version } }
  })

  mkdirSync('data', { recursive: true })
  const report = { project, sdk: SDK_VERSION, sandboxId: sandbox.id, runPageId: run.resourceId, startedAt, finishedAt, results }
  writeFileSync('data/clipper-phase1-report.json', JSON.stringify(report, null, 2))
  console.log(`\n${passed} passed, ${results.filter((r) => r.outcome === 'fail').length} failed. Run page: ${run.name} (${run.resourceId}). Report: data/clipper-phase1-report.json`)
  if (results.some((r) => r.outcome === 'fail')) process.exitCode = 1
}

main().catch((e) => {
  console.error(describeError(e))
  process.exit(1)
})
