import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createImport } from '@/server/services/imports'
import { runTransform } from '@/server/services/transform'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { copyLayoutFromLegendKeeper, listLkTemplates } from '@/server/services/lk-templates'
import { approveSaveAsTemplate, prepareSaveAsTemplate } from '@/server/services/lk-save-template'
import { approveWrite, checkOutcome, finishTemplatePage, keepTemplateBoxes, mergeLabels, planPlacement, prepareWrite } from '@/server/services/write'
import { updateTemplate } from '@/server/services/recipes'
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
    expect(template.definition.createFromLkTemplate).toBe(true)
  })

  it('creates a page as a copy of the template, then fills its first tab, keeping built-in boxes', async () => {
    const ctx = setup()
    const { view } = await goblinDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    expect(preview.fromTemplate).toMatchObject({ id: 'l1ylm24t', filledTab: 'Main', sidebarProperties: 1, tags: ['Creature'], lostBoxes: [] })
    expect(preview.fromTemplate?.keptBoxes).toEqual(['TAGS', 'TAGS']) // the top-level box and the infobox's Tags row
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
    const main = page.documents[0]!.blocks as { kind: string; id?: string; rows?: { kind: string; title?: string }[] }[]
    expect(main[0]).toEqual(TAGS_BOX) // sent back by id, so LegendKeeper keeps it
    // The infobox's built-in Tags row too, in the infobox.
    expect(main[1]!.kind).toBe('infobox')
    expect(main[1]!.rows!.filter((r) => r.kind === 'unsupported').map((r) => r.title)).toEqual(['TAGS'])
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
    ctx.lk.replaceBehavior.set(preview.plannedResourceId, 'validation_error')
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('write_incomplete')
    expect(ctx.repos.drafts.get(view.draft.id)).toMatchObject({ status: 'write_incomplete', createdResourceId: preview.plannedResourceId })
    expect(ctx.repos.audit.list({ limit: 50, draftId: view.draft.id }).some((e) => e.operation === 'write.fill' && e.outcome === 'failure')).toBe(true)

    ctx.lk.replaceBehavior.delete(preview.plannedResourceId)
    const finished = await finishTemplatePage(ctx, view.draft.id)
    expect(finished.status).toBe('created')
    expect(ctx.lk.callCount('createFromTemplate')).toBe(1)
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

  it('with “create from the template itself” off, makes a plain page with the copied layout', async () => {
    const ctx = setup()
    const { view, template } = await goblinDraft(ctx)
    updateTemplate(ctx, template.id, { ...template.definition, createFromLkTemplate: false })
    const preview = await prepareWrite(ctx, view.draft.id)
    expect(preview.fromTemplate).toBeNull()
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('created')
    expect(ctx.lk.callCount('createFromTemplate')).toBe(0)
    expect(ctx.lk.callCount('createPage')).toBe(1)
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

  it('merges labels without duplicates and puts boxes back at their positions', () => {
    expect(mergeLabels(['Creature', 'NPC'], ['npc', 'Goblin'])).toEqual(['Creature', 'NPC', 'Goblin'])
    expect(keepTemplateBoxes([{ kind: 'paragraph' }], [{ kind: 'paragraph' }, TAGS_BOX]).blocks).toEqual([{ kind: 'paragraph' }, TAGS_BOX])
    // Nested: into the infobox at the same position; when the layout has no infobox, reported as lost.
    const row = { kind: 'unsupported', id: 'r1', title: 'ALIASES' }
    const current = [{ kind: 'infobox', rows: [{ key: 'A' }, row] }]
    expect(keepTemplateBoxes([{ kind: 'infobox', rows: [{ key: 'B' }, { key: 'C' }] }], current).blocks).toEqual([{ kind: 'infobox', rows: [{ key: 'B' }, row, { key: 'C' }] }])
    expect(keepTemplateBoxes([{ kind: 'paragraph' }], current)).toMatchObject({ kept: [], lost: ['ALIASES'] })
    expect(keepTemplateBoxes([{ kind: 'paragraph' }], [{ kind: 'unsupported', title: 'NO ID' }]).lost).toEqual(['NO ID'])
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
