import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createImport } from '@/server/services/imports'
import { runTransform } from '@/server/services/transform'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { copyLayoutFromLegendKeeper, listLkTemplates } from '@/server/services/lk-templates'
import { approveSaveAsTemplate, prepareSaveAsTemplate } from '@/server/services/lk-save-template'
import { approveWrite, checkOutcome, finishTemplatePage, mergeLabels, planPlacement, prepareWrite } from '@/server/services/write'
import { comparableContent, planFill } from '@/core/template-fill'
import { validateAgainstSpec } from '../helpers/openapi-validator'
import { createTestContext, utf8, type TestContext } from '../helpers/test-context'

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const templateBlocks = (JSON.parse(fixture('lk-statblock-template.json')) as { blocks: unknown[] }).blocks
/** A built-in box the API cannot write (like LegendKeeper's Tags box), at the top of the template. */
const TAGS_BOX = { kind: 'unsupported', id: 'tagsbox1', title: 'TAGS' }

function setup() {
  return createTestContext({
    resources: [
      {
        id: 'l1ylm24t',
        name: 'Statblock Template',
        parentId: 'templates',
        tags: ['Creature'],
        aliases: [],
        properties: [{ kind: 'keyValue', rows: [] }],
        documents: [
          { id: 'rjemxmxe', name: 'Main', type: 'page', blocks: [TAGS_BOX, ...templateBlocks], version: 'v1', text: '' },
          { id: 'lore0001', name: 'Lore', type: 'page', blocks: [{ kind: 'paragraph', content: [{ text: 'Lore goes here.' }] }], version: 'v1', text: 'Lore goes here.' },
        ],
      },
      { id: 'sub00001', name: 'Subclass Template', parentId: 'l1ylm24t' },
      { id: 'bestiary', name: 'Bestiary' },
      { id: 'aboleth1', name: 'Aboleth', parentId: 'bestiary', rank: 'a1' },
      { id: 'zombie01', name: 'Zombie', parentId: 'bestiary', rank: 'a2' },
      { id: 'sandbox0001', name: 'LK Companion Sandbox' },
    ],
  })
}

/** Copies the template's layout (making a recipe) and transforms the goblin statblock without AI. */
async function goblinDraft(ctx: TestContext, recipePatch: Record<string, unknown> = {}) {
  await testConnection(ctx)
  const { template, recipe } = await copyLayoutFromLegendKeeper(ctx, { resource: 'l1ylm24t', pageType: 'creature' })
  const updated = ctx.repos.recipes.update(recipe!.id, { ...recipe!.definition, defaultParentId: 'bestiary', ...recipePatch }, recipe!.version)
  if (updated === null || updated === 'conflict') throw new Error('setup')
  const job = createImport(ctx, { bytes: utf8(fixture('statblock-2024.txt')), fileName: null, mimeType: 'text/plain', declaredFormat: 'text', sourceKind: 'paste', name: null, attributionTitle: null, citation: null, recipeId: updated.id })
  const view = await runTransform(ctx, job.id, { mode: 'structural' })
  return { view, template }
}

describe('LegendKeeper templates (SDK 4.1.0)', () => {
  it('lists templates at any depth, and the index treats nested templates as templates', async () => {
    const ctx = setup()
    const { templates } = await listLkTemplates(ctx)
    expect(templates.map((t) => t.name)).toEqual(['Statblock Template', 'Subclass Template'])
    expect(templates.find((t) => t.id === 'sub00001')?.parentTemplate).toEqual({ id: 'l1ylm24t', name: 'Statblock Template' })
    expect(templates.find((t) => t.id === 'l1ylm24t')?.documents.map((d) => d.name)).toEqual(['Main', 'Lore'])

    await testConnection(ctx)
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    const audit = ctx.repos.index.forAudit('proj_test').map((p) => p.id)
    expect(audit).not.toContain('l1ylm24t')
    expect(audit).not.toContain('sub00001') // nested: under a template, so a template too
    expect(audit).toContain('aboleth1')
    expect(ctx.repos.index.forReferences('proj_test').map((r) => r.id)).not.toContain('sub00001')
    expect(ctx.repos.index.stats('proj_test')).toMatchObject({ templates: 2, pages: 4 })
    expect(ctx.repos.index.query('proj_test', { untagged: true, offset: 0, limit: 50 }).items.map((i) => i.id)).not.toContain('sub00001')
  })

  it('recognises a nested template as a template when copying its layout', async () => {
    const ctx = setup()
    ctx.lk.resources.get('sub00001')!.documents = [{ id: 'subdoc01', name: 'Main', type: 'page', blocks: templateBlocks, version: 'v1', text: '' }]
    const { template } = await copyLayoutFromLegendKeeper(ctx, { resource: 'sub00001', pageType: 'creature', createRecipe: false })
    expect(template.definition.lkLayout?.sourceKind).toBe('template')
  })

  it('creates a page as a copy of the template, then fills its first tab, keeping built-in boxes', async () => {
    const ctx = setup()
    const { view } = await goblinDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    expect(preview.fromTemplate).toMatchObject({ id: 'l1ylm24t', filledTab: 'Main', sidebarProperties: 1, tags: ['Creature'] })
    expect(preview.fromTemplate?.keptBoxes).toEqual(['TAGS', 'the empty IMAGE slot', 'TAGS'])
    expect(preview.fromTemplate?.tabs.map((t) => t.name)).toEqual(['Main', 'Lore'])
    expect(ctx.lk.callCount('createFromTemplate')).toBe(0)

    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('created')
    expect(ctx.lk.callCount('createFromTemplate')).toBe(1)
    expect(ctx.lk.callCount('createPage')).toBe(0)
    const request = ctx.lk.fromTemplateRequests[0]!
    expect(request).toMatchObject({ templateId: 'l1ylm24t', resourceId: preview.plannedResourceId, name: preview.name, parentId: 'bestiary' })
    expect(request.idempotencyKey).toBeTruthy()

    const page = ctx.lk.resources.get(preview.plannedResourceId)!
    expect(page.documents.map((d) => d.name)).toEqual(['Main', 'Lore'])
    expect(page.documents[1]!.text).toBe('Lore goes here.') // other tabs stay as in the template
    const main = page.documents[0]!.blocks as { kind: string; id?: string; rows?: { kind: string; title?: string; url?: string; rows?: { key: string; content: { text?: string }[] }[] }[] }[]
    expect(main[0]).toEqual(TAGS_BOX) // never touched
    // The infobox, filled in place: same fields in the same order, the empty image slot and the
    // built-in Tags row untouched, fields without a value blank.
    const templateInfobox = (templateBlocks[0] as { rows: { kind: string; title?: string; rows?: { key: string }[] }[] }).rows
    expect(main[1]!.kind).toBe('infobox')
    expect(main[1]!.rows!.map((r) => `${r.kind}:${r.title ?? ''}`)).toEqual(templateInfobox.map((r) => `${r.kind}:${r.title ?? ''}`))
    expect(main[1]!.rows![0]).toMatchObject({ kind: 'image', url: '' })
    const keys = main[1]!.rows!.flatMap((r) => (r.kind === 'keyValue' ? r.rows!.map((row) => row.key) : []))
    const templateKeys = templateInfobox.flatMap((r) => (r.kind === 'keyValue' ? r.rows!.map((row) => row.key) : []))
    expect(keys.filter((key) => templateKeys.includes(key))).toEqual(templateKeys)
    const row = (key: string) => main[1]!.rows!.flatMap((r) => r.rows ?? []).find((x) => x.key === key)!
    expect(row('Armour Class').content.map((c) => c.text).join('')).toBe('17')
    expect(row('Resistances').content).toEqual([]) // blank, example value removed
    // Small edits only (the image slot cannot be written back); nothing of the template's own boxes deleted.
    expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(0)
    expect(ctx.lk.callCount('updateInfoboxProperty')).toBeGreaterThan(0)
    expect(page.documents[0]!.text).toContain('Goblin')
    expect(page.documents[0]!.text).not.toContain('Example Bite')
    expect(page.tags[0]).toBe('Creature') // the template's tags, plus the draft's
    expect(page.properties).toHaveLength(1)
    const draft = ctx.repos.drafts.get(view.draft.id)!
    expect(draft.status).toBe('created')
    expect(draft.createdDocumentId).toBe(page.documents[0]!.id)
  })

  it('a page whose filling fails is marked unfinished, and “Finish the page” never creates it again', async () => {
    const ctx = setup()
    const { view } = await goblinDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    // The third edit fails after the first two went through.
    ctx.lk.failBlockOp = { at: 3, behavior: 'validation_error' }
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('write_incomplete')
    expect(ctx.repos.drafts.get(view.draft.id)).toMatchObject({ status: 'write_incomplete', createdResourceId: preview.plannedResourceId })
    expect(ctx.repos.audit.list({ limit: 50, draftId: view.draft.id }).some((e) => e.operation === 'write.fill' && e.outcome === 'failure')).toBe(true)

    ctx.lk.failBlockOp = null
    const editsBefore = ctx.lk.blockOps.length
    const finished = await finishTemplatePage(ctx, view.draft.id)
    expect(finished.status).toBe('created')
    expect(ctx.lk.callCount('createFromTemplate')).toBe(1)
    // It carried on from the failed edit: the two done before were not repeated.
    const resumed = ctx.lk.blockOps.slice(editsBefore)
    expect(resumed[0]).toEqual(ctx.lk.blockOps[2])
    expect(ctx.lk.resources.get(preview.plannedResourceId)!.documents[0]!.text).toContain('Goblin')
    await expect(finishTemplatePage(ctx, view.draft.id)).rejects.toThrow(/no unfinished page/)
  })

  it('when the reply to the create is lost, it reads, finds the page, and fills it without creating again', async () => {
    const ctx = setup()
    const { view } = await goblinDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    ctx.lk.templateBehavior = 'apply_then_connection_error'
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('created')
    expect(ctx.lk.callCount('createFromTemplate')).toBe(1)
    expect(ctx.lk.resources.get(preview.plannedResourceId)!.documents[0]!.text).toContain('Goblin')
  })

  it('a later outcome check leaves filling to “Finish the page” (checking only reads)', async () => {
    const ctx = setup()
    const { view } = await goblinDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    // Simulate a crash between the create and reading back: the page exists, the draft is uncertain.
    await ctx.lk.createFromTemplate({ templateId: 'l1ylm24t', resourceId: preview.plannedResourceId, name: preview.name, parentId: 'bestiary', idempotencyKey: 'k' })
    ctx.repos.drafts.setStatus(view.draft.id, 'write_uncertain')
    const writesBefore = ctx.lk.callCount('replaceDocumentBlocks')
    const outcome = await checkOutcome(ctx, view.draft.id)
    expect(outcome.status).toBe('write_incomplete')
    expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(writesBefore)
    expect((await finishTemplatePage(ctx, view.draft.id)).status).toBe('created')
  })

  it('refuses at the preview when the template is no longer a template', async () => {
    const ctx = setup()
    const { view } = await goblinDraft(ctx)
    ctx.lk.resources.get('l1ylm24t')!.parentId = null
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toThrow(/no longer a LegendKeeper template/)
  })

  it('places pages alphabetically among their siblings when the recipe asks', async () => {
    const ctx = setup()
    expect(await planPlacement(ctx, { placement: 'alphabetical' }, 'bestiary', 'Goblin Underboss')).toMatchObject({ placement: { before: 'zombie01' } })
    expect(await planPlacement(ctx, { placement: 'alphabetical' }, 'bestiary', 'Zz Last')).toMatchObject({ placement: null })
    expect(await planPlacement(ctx, { placement: 'end' }, 'bestiary', 'Goblin')).toMatchObject({ placement: null })

    const { view } = await goblinDraft(ctx, { placement: 'alphabetical' })
    const preview = await prepareWrite(ctx, view.draft.id)
    expect(preview.placement).toMatch(/before “Zombie”/)
    await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(ctx.lk.fromTemplateRequests[0]!.placement).toEqual({ before: 'zombie01' })
  })

  it('writes a template without an image slot in one go, and only gives blocks ids when it must edit them one by one', async () => {
    const stripIds = (value: unknown): unknown => (Array.isArray(value) ? value.map(stripIds) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k, v]) => !(k === 'id' && typeof (value as { kind?: unknown }).kind === 'string' && (value as { kind?: unknown }).kind !== 'unsupported') || typeof v !== 'string').map(([k, v]) => [k, stripIds(v)])) : value)
    const legacy = stripIds(templateBlocks) as Record<string, unknown>[]
    const noImage = structuredClone(legacy)
    ;(noImage[0] as { rows: { kind: string }[] }).rows = (noImage[0] as { rows: { kind: string }[] }).rows.filter((row) => row.kind !== 'image')

    for (const [blocks, expected] of [[noImage, { ids: 0, whole: 1 }], [legacy, { ids: 1, whole: 0 }]] as const) {
      const ctx = setup()
      ctx.lk.resources.get('l1ylm24t')!.documents[0]!.blocks = [...(blocks as unknown[])]
      const { view } = await goblinDraft(ctx)
      const preview = await prepareWrite(ctx, view.draft.id)
      expect((await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })).status).toBe('created')
      expect(ctx.lk.callCount('assignBlockIds')).toBe(expected.ids)
      expect(ctx.lk.callCount('replaceDocumentBlocks')).toBe(expected.whole)
    }
  })

  it('merges labels without duplicates', () => {
    expect(mergeLabels(['Creature', 'NPC'], ['npc', 'Goblin'])).toEqual(['Creature', 'NPC', 'Goblin'])
  })

  it('refuses the approval, creating nothing, when the template changed after the preview', async () => {
    const ctx = setup()
    const { view } = await goblinDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    const main = ctx.lk.resources.get('l1ylm24t')!.documents[0]!
    main.blocks = [...main.blocks, { kind: 'paragraph', content: [{ text: 'New template note' }] }]
    await expect(approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })).rejects.toThrow(/changed in LegendKeeper after the final preview/)
    expect(ctx.lk.callCount('createFromTemplate')).toBe(0)
    // The next preview reads the template again and says so.
    const again = await prepareWrite(ctx, view.draft.id)
    expect(again.warnings.join(' ')).toMatch(/was changed in LegendKeeper since its layout was copied/)
    expect((await approveWrite(ctx, view.draft.id, { approvalToken: again.approvalToken, acknowledgeWarnings: true })).status).toBe('created')
  })

})

describe('saving a page as a LegendKeeper template', () => {
  it('previews, then saves once with the planned id, and reads it back', async () => {
    const ctx = setup()
    await testConnection(ctx)
    const preview = await prepareSaveAsTemplate(ctx, { resource: 'bestiary', includeChildren: true })
    expect(preview).toMatchObject({ name: 'Bestiary Template', descendants: 2, includeChildren: true })
    expect(ctx.lk.callCount('saveAsTemplate')).toBe(0)

    const result = await approveSaveAsTemplate(ctx, { approvalToken: preview.approvalToken })
    expect(result).toMatchObject({ status: 'created', mismatches: [] })
    const saved = ctx.lk.resources.get(preview.plannedTemplateId)!
    expect(saved.parentId).toBe('templates')
    expect([...ctx.lk.resources.values()].filter((r) => r.parentId === saved.id).map((r) => r.name).sort()).toEqual(['Aboleth', 'Zombie'])
    expect(ctx.lk.resources.get('bestiary')!.parentId).toBeNull() // the page itself is unchanged
    // The approval is single-use.
    await expect(approveSaveAsTemplate(ctx, { approvalToken: preview.approvalToken })).rejects.toThrow(/no matching preview/)
    expect(ctx.lk.callCount('saveAsTemplate')).toBe(1)
  })

  it('explains that an Admin key is needed, and creates nothing', async () => {
    const ctx = setup()
    ctx.lk.isAdmin = false
    await testConnection(ctx)
    const preview = await prepareSaveAsTemplate(ctx, { resource: 'aboleth1', name: 'Monster Template' })
    const result = await approveSaveAsTemplate(ctx, { approvalToken: preview.approvalToken })
    expect(result.status).toBe('failed')
    expect('message' in result && result.message).toMatch(/Admin role/)
    expect(ctx.lk.resources.has(preview.plannedTemplateId)).toBe(false)
  })

  it('warns when a template with the same name exists and when the page is already a template', async () => {
    const ctx = setup()
    await testConnection(ctx)
    const preview = await prepareSaveAsTemplate(ctx, { resource: 'l1ylm24t' })
    expect(preview.name).toBe('Statblock Template')
    expect(preview.warnings.join(' ')).toMatch(/already a template/)
    expect(preview.warnings.join(' ')).toMatch(/already exists/)
  })
})

describe('templates list fallback', () => {
  it('shows the templates from the last scan when LegendKeeper cannot be reached, and says so', async () => {
    const { ConnectorError } = await import('@/server/lk/errors')
    const ctx = setup()
    await testConnection(ctx)
    await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
    ctx.lk.listTemplates = async () => {
      throw new ConnectorError('server', 'LegendKeeper had an internal error.', { status: 502, outcome: 'not_applied' })
    }
    const { templates, note } = await listLkTemplates(ctx)
    expect(templates.map((t) => t.name).sort()).toEqual(['Statblock Template', 'Subclass Template'])
    expect(note).toMatch(/from the last scan/)
  })
})

describe('planning the edits that fill a template copy', () => {
  let n = 0
  const id = () => `new${n++}`
  const infobox = (rows: unknown[]) => ({ id: 'ib1', kind: 'infobox', rows })
  const kv = (rows: [string, string][]) => ({ id: 'kv1', kind: 'keyValue', title: 'PROPERTIES', rows: rows.map(([key, text], i) => ({ id: `r${i}`, rank: `a${i}`, key, content: text ? [{ text }] : [], text })) })

  it('writes the whole tab at once when nothing in it is unwritable', () => {
    const current = [{ id: 'p1', kind: 'paragraph', content: [{ text: 'Example' }] }]
    const desired = [{ kind: 'paragraph', content: [{ text: 'Real' }] }]
    expect(planFill(current, desired, id)).toEqual([{ op: 'replaceAll', blocks: desired }])
    expect(planFill(current, current, id)).toEqual([])
  })

  it('with an empty image slot, edits in place: infobox fields one by one, the rest replaced, deleted or inserted', () => {
    const image = { id: 'img', kind: 'image', title: 'IMAGE', url: '' }
    const current = [infobox([image, kv([['Armour Class', '15'], ['Speed', '30 ft.']])]), { id: 't1', kind: 'textField', title: 'Traits', children: [] }, { id: 't2', kind: 'textField', title: 'Legendary Actions', children: [] }, { id: 'p1', kind: 'paragraph', content: [{ text: 'Example' }] }]
    const desired = [
      infobox([image, { ...kv([['Armour Class', ''], ['Speed', '']]), rows: [{ id: 'r0', rank: 'a0', key: 'Armour Class', content: [{ text: '17' }] }, { id: 'r1', rank: 'a1', key: 'Speed', content: [] }] }]),
      { id: 't1', kind: 'textField', title: 'Traits', children: [{ kind: 'paragraph', content: [{ text: 'Nimble' }] }] },
      { kind: 'paragraph', content: [{ text: 'Description' }] },
    ]
    const ops = planFill(current, desired, id)
    // The new paragraph takes the place of the removed "Legendary Actions" box: 4 edits, not 5.
    expect(ops.map((op) => op.op)).toEqual(['delete', 'updateProperty', 'replace', 'replace'])
    expect(ops[0]).toMatchObject({ op: 'delete', blockId: 'p1' })
    expect(ops[1]).toMatchObject({ op: 'updateProperty', blockId: 'ib1', propertyId: 'kv1', patch: { rows: [{ id: 'r0', key: 'Armour Class', content: [{ text: '17' }] }, { id: 'r1', key: 'Speed', content: [] }] } })
    expect(ops[3]).toMatchObject({ op: 'replace', blockId: 't2', block: { id: 't2', kind: 'paragraph' } })
    // The image slot is never part of an edit.
    expect(JSON.stringify(ops)).not.toContain('"img"')
    // Bodies match LegendKeeper's schema.
    for (const op of ops) {
      if (op.op === 'updateProperty') expect(validateAgainstSpec('PropertyUpdateRequest', op.patch).errors).toEqual([])
      if (op.op === 'replace') expect(validateAgainstSpec('Block', op.block).errors).toEqual([])
      if (op.op === 'insert') expect(validateAgainstSpec('BlockInsertRequest', { block: op.block, after: op.after }).errors).toEqual([])
    }
    // Without a removed block in the way, a new block is inserted.
    const inserted = planFill([infobox([image]), { id: 'k', kind: 'paragraph', content: [{ text: 'Kept' }] }], [infobox([image]), { id: 'k', kind: 'paragraph', content: [{ text: 'Kept' }] }, { kind: 'paragraph', content: [{ text: 'New' }] }], id)
    expect(inserted).toEqual([expect.objectContaining({ op: 'insert', after: 'k' })])
  })

  it('steps into containers that hold an image slot (an infobox inside a column layout)', () => {
    const image = { id: 'img', kind: 'image', title: 'IMAGE', url: '' }
    const box = (rows: unknown[]) => ({ id: 'ib1', kind: 'infobox', rows })
    const layout = (box: unknown) => ({ id: 'lay', kind: 'layout', children: [{ id: 'c1', kind: 'layoutColumn', children: [{ id: 'p1', kind: 'paragraph', content: [{ text: 'Example' }] }] }, { id: 'c2', kind: 'layoutColumn', children: [box] }] })
    const current = [layout(box([image, kv([['Rarity', 'Example']])]))]
    const desired = [{ id: 'lay', kind: 'layout', children: [{ id: 'c1', kind: 'layoutColumn', children: [{ kind: 'paragraph', content: [] }] }, { id: 'c2', kind: 'layoutColumn', children: [box([image, { ...kv([['Rarity', '']]), rows: [{ id: 'r0', rank: 'a0', key: 'Rarity', content: [{ text: 'Rare' }] }] }])] }] }]
    const ops = planFill(current, desired, id)
    expect(ops.map((op) => op.op)).toEqual(['replace', 'updateProperty'])
    expect(ops[0]).toMatchObject({ op: 'replace', blockId: 'c1' }) // the column without the image, whole
    expect(ops[1]).toMatchObject({ op: 'updateProperty', blockId: 'ib1', propertyId: 'kv1' })
    expect(JSON.stringify(ops)).not.toContain('"img"')
  })

  it('compares content without ids, ranks, built-in boxes and empty image slots', () => {
    const a = [{ id: 'x', kind: 'infobox', rows: [{ kind: 'image', url: '' }, { kind: 'unsupported', id: 'u' }, { id: 'k', rank: 'b', kind: 'keyValue', rows: [{ id: 'r', key: 'A', content: [], text: '' }] }] }]
    const b = [{ kind: 'infobox', rows: [{ kind: 'keyValue', rows: [{ key: 'A', content: [] }] }] }]
    expect(comparableContent(a)).toBe(comparableContent(b))
  })
})
