import { beforeEach, describe, expect, it } from 'vitest'
import { createImport } from '@/server/services/imports'
import { runTransform } from '@/server/services/transform'
import { saveDraft } from '@/server/services/drafts'
import { testConnection } from '@/server/services/connection'
import { startOrResumeScan } from '@/server/services/discovery'
import { approveWrite, assignNewPlannedId, checkOutcome, prepareWrite, verifyWriteCapability } from '@/server/services/write'
import { aiOutput } from '../helpers/mock-ai'
import { createTestContext, utf8, type TestContext } from '../helpers/test-context'

const SOURCE = 'Elvera Tallowmere is a half-elf innkeeper who runs the Green Dragon Inn.'

async function readyDraft(ctx: TestContext, options: { allowCreate?: boolean } = {}) {
  const base = ctx.repos.recipes.list().find((r) => r.definition.name === 'NPC from notes')!
  const recipe = ctx.repos.recipes.update(base.id, { ...base.definition, allowCreate: options.allowCreate ?? true, defaultParentId: 'npcsaaaa' }, base.version)
  if (recipe === 'conflict' || recipe === null) throw new Error('setup')
  const job = createImport(ctx, { bytes: utf8(SOURCE), fileName: null, mimeType: null, declaredFormat: 'text', sourceKind: 'paste', name: 'Elvera', attributionTitle: 'Notes', citation: null, recipeId: recipe.id })
  ctx.aiMock.next = aiOutput({
    pageName: 'Elvera Tallowmere',
    fields: [
      { key: 'ancestry', value: 'half-elf', status: 'source', sourceQuote: 'is a half-elf innkeeper', note: null },
      { key: 'occupation', value: 'innkeeper', status: 'source', sourceQuote: 'half-elf innkeeper', note: null },
      { key: 'alignment', value: 'Neutral good', status: 'suggested', sourceQuote: null, note: 'Seems kind' },
    ],
    sections: [{ heading: 'Description', kind: 'lore', paragraphs: ['Elvera runs the Green Dragon Inn.'] }],
    entityMentions: [{ name: 'Green Dragon Inn', relation: 'runs' }],
    tagSuggestions: [{ tag: 'NPC', reason: 'type' }],
  })
  return runTransform(ctx, job.id, { mode: 'ai' })
}

async function verified(ctx: TestContext) {
  await testConnection(ctx)
  await startOrResumeScan(ctx, { wait: true, delayMs: 0 })
  await verifyWriteCapability(ctx, { confirm: true })
}

/** createPage calls for real pages (excluding the write check's own test page). */
function pageWrites(ctx: TestContext) {
  return ctx.lk.createRequests.filter((request) => !request.name.startsWith('LK Companion write check')).length
}

describe('guarded single-page creation', () => {
  let ctx: TestContext
  beforeEach(async () => {
    ctx = createTestContext({ resources: [{ id: 'sandbox0001', name: 'LK Companion Sandbox' }, { id: 'npcsaaaa', name: 'NPCs' }, { id: 'innaaaaa', name: 'Green Dragon Inn', tags: ['Location'] }, { id: 'npctagged', name: 'Someone', tags: ['NPC'] }] })
  })

  it('does nothing while writes are switched off', async () => {
    ctx.settings.lk.allowWrites = false
    await testConnection(ctx)
    await expect(verifyWriteCapability(ctx, { confirm: true })).rejects.toThrow(/cannot run yet/)
    const view = await readyDraft(ctx)
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toMatchObject({ issues: expect.arrayContaining([expect.stringMatching(/LKC_ALLOW_WRITES/)]) })
    expect(pageWrites(ctx)).toBe(0)
  })

  it('needs no separate write check: the first approved page confirms writing works', async () => {
    await testConnection(ctx)
    expect(ctx.repos.verifications.latest('proj_test', ctx.sdkVersion)).toBeNull()
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('created')
    expect(pageWrites(ctx)).toBe(1)
    const verification = ctx.repos.verifications.latest('proj_test', ctx.sdkVersion)
    expect(verification?.resourceId).toBe(result.status === 'created' ? result.resourceId : null)
  })

  it('refuses to write when writes are switched off in configuration', async () => {
    ctx.settings.lk.allowWrites = false
    await testConnection(ctx)
    const view = await readyDraft(ctx)
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toMatchObject({ issues: expect.arrayContaining([expect.stringMatching(/switched off/)]) })
  })

  it('the write check creates one clearly named page under the sandbox and reads it back', async () => {
    await testConnection(ctx)
    const result = await verifyWriteCapability(ctx, { confirm: true })
    expect(result.name).toMatch(/^LK Companion write check/)
    expect(ctx.lk.resources.get(result.resourceId)!.parentId).toBe('sandbox0001')
    expect(ctx.repos.verifications.latest('proj_test', '4.0.0')).not.toBeNull()
    await expect(verifyWriteCapability(ctx, { confirm: false })).rejects.toThrow(/Confirm/)
  })

  it('respects the recipe: creation must be explicitly allowed', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx, { allowCreate: false })
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toMatchObject({ issues: expect.arrayContaining([expect.stringMatching(/does not allow creating/)]) })
  })

  it('creates exactly one page after explicit approval, reads it back and audits it', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const before = ctx.lk.resources.size
    const preview = await prepareWrite(ctx, view.draft.id)
    expect(ctx.lk.resources.size).toBe(before) // the preview writes nothing
    expect(preview).toMatchObject({ name: 'Elvera Tallowmere', parent: { id: 'npcsaaaa', name: 'NPCs' }, project: { id: 'proj_test' } })
    expect(preview.links).toEqual([{ mention: 'Green Dragon Inn', resourceId: 'innaaaaa', name: 'Green Dragon Inn' }])
    expect(preview.tags).toEqual([{ value: 'NPC', status: 'existing' }])

    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('created')
    expect(ctx.lk.resources.size).toBe(before + 1)
    const created = ctx.lk.resources.get(preview.plannedResourceId)!
    expect(created).toMatchObject({ name: 'Elvera Tallowmere', parentId: 'npcsaaaa', tags: ['NPC'] })
    expect(ctx.lk.createRequests.at(-1)!.idempotencyKey).toMatch(new RegExp(`^lkc\\.${preview.plannedResourceId}\\.`))

    const draft = ctx.repos.drafts.get(view.draft.id)!
    expect(draft).toMatchObject({ status: 'created', createdResourceId: preview.plannedResourceId, createdVersion: 'v1' })
    const job = ctx.repos.jobs.get(view.draft.jobId)!
    expect(job.status).toBe('completed')
    expect(job.sourceText).toBeNull() // source deleted once the job is complete

    const events = ctx.repos.audit.list({ limit: 50, draftId: view.draft.id }).map((e) => `${e.operation}:${e.outcome}:${e.approval}`)
    expect(events).toEqual(expect.arrayContaining(['write.prepare:success:not_approved', 'write.approve:info:approved', 'write.create:success:approved']))
  })

  it('cannot write twice: a used approval and a double click both fail', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    const [first, second] = await Promise.allSettled([
      approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true }),
      approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true }),
    ])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(pageWrites(ctx)).toBe(1)
    await expect(approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })).rejects.toThrow(/no pending approval/)
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toThrow(/not possible/)
  })

  it('invalidates the approval when the draft changes after the preview', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    const current = ctx.repos.drafts.get(view.draft.id)!
    await saveDraft(ctx, view.draft.id, { ...current.page, name: 'Elvera the Bold' }, current.revision)
    await expect(approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })).rejects.toThrow(/no pending approval/)
    expect(pageWrites(ctx)).toBe(0)
  })

  it('rejects a wrong or expired approval token, and unacknowledged warnings', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    await expect(approveWrite(ctx, view.draft.id, { approvalToken: 'forged', acknowledgeWarnings: true })).rejects.toThrow(/not valid/)
    await expect(approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: false })).rejects.toThrow(/Acknowledge/)
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 60 * 60 * 1000)
    await expect(approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })).rejects.toThrow(/expired/)
    expect(pageWrites(ctx)).toBe(0)
  })

  it('blocks writing when a linked page no longer exists', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    ctx.lk.resources.delete('innaaaaa')
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toThrow(/could not be confirmed/)
  })

  it('when the reply is lost, it confirms by reading — and does not create a second page', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    ctx.lk.createBehavior = 'apply_then_connection_error'
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('created')
    expect(pageWrites(ctx)).toBe(1) // no retry
    expect([...ctx.lk.resources.values()].filter((r) => r.name === 'Elvera Tallowmere')).toHaveLength(1)
    const audit = ctx.repos.audit.list({ limit: 5, operation: 'write.create' })[0]!
    expect(audit.message).toMatch(/confirmed after an uncertain reply/)
  })

  it('when the connection fails before anything is written, it says so and allows a safe re-approval with the same ID', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    ctx.lk.createBehavior = 'connection_error_before_apply'
    const failed = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(failed.status).toBe('write_failed')
    expect(pageWrites(ctx)).toBe(1)

    ctx.lk.createBehavior = 'ok'
    const again = await prepareWrite(ctx, view.draft.id)
    expect(again.plannedResourceId).toBe(preview.plannedResourceId)
    const ok = await approveWrite(ctx, view.draft.id, { approvalToken: again.approvalToken, acknowledgeWarnings: true })
    expect(ok.status).toBe('created')
    expect([...ctx.lk.resources.values()].filter((r) => r.name === 'Elvera Tallowmere')).toHaveLength(1)
  })

  it('keeps an uncertain outcome uncertain when LegendKeeper cannot be reached, until checked', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    ctx.lk.createBehavior = 'apply_then_connection_error'
    // The existence check also fails (LegendKeeper unreachable).
    const originalGet = ctx.lk.getResource.bind(ctx.lk)
    let down = true
    ctx.lk.getResource = async (id: string) => {
      if (down) throw new (await import('@/server/lk/errors')).ConnectorError('connection', 'down', { outcome: 'unknown' })
      return originalGet(id)
    }
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('write_uncertain')
    expect(ctx.repos.drafts.get(view.draft.id)!.status).toBe('write_uncertain')
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toThrow(/not possible/) // cannot re-approve while uncertain

    down = false
    const checked = await checkOutcome(ctx, view.draft.id)
    expect(checked.status).toBe('created')
    expect(pageWrites(ctx)).toBe(1)
  })

  it('reports permission and validation refusals without retrying', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    let preview = await prepareWrite(ctx, view.draft.id)
    ctx.lk.createBehavior = 'permission_error'
    const denied = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    if (denied.status !== 'write_failed') throw new Error(`expected write_failed, got ${denied.status}`)
    expect(denied.message).toMatch(/Nothing was created/)
    expect(ctx.repos.audit.list({ limit: 1, operation: 'write.create' })[0]).toMatchObject({ outcome: 'failure', errorCode: 'FORBIDDEN', requestId: 'req_mock_403' })

    ctx.lk.createBehavior = 'validation_error'
    preview = await prepareWrite(ctx, view.draft.id)
    const invalid = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    if (invalid.status !== 'write_failed') throw new Error(`expected write_failed, got ${invalid.status}`)
    expect(invalid.issues).toEqual([{ path: 'documents[0].blocks[0]', message: 'bad block' }])
    expect(pageWrites(ctx)).toBe(2)
  })

  it('a duplicate-ID refusal for an unreadable page needs an explicit, audited new ID', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    const preview = await prepareWrite(ctx, view.draft.id)
    // Simulate an ID taken by a page this key cannot read (e.g. in the trash).
    ctx.lk.createPage = async () => {
      throw new (await import('@/server/lk/errors')).ConnectorError('duplicate_id', 'dup', { status: 409, code: 'DUPLICATE_ID', outcome: 'not_applied' })
    }
    const result = await approveWrite(ctx, view.draft.id, { approvalToken: preview.approvalToken, acknowledgeWarnings: true })
    expect(result.status).toBe('write_uncertain')
    expect(() => assignNewPlannedId(ctx, view.draft.id, { confirmCheckedLegendKeeper: false })).toThrow(/Confirm/)
    const { plannedResourceId } = assignNewPlannedId(ctx, view.draft.id, { confirmCheckedLegendKeeper: true })
    expect(plannedResourceId).not.toBe(preview.plannedResourceId)
    expect(ctx.repos.audit.list({ limit: 1, operation: 'write.new_planned_id' })).toHaveLength(1)
  })

  it('never lets the project switch silently', async () => {
    await verified(ctx)
    const view = await readyDraft(ctx)
    ctx.lk.project = { ...ctx.lk.project, id: 'proj_other', name: 'Other' }
    await expect(prepareWrite(ctx, view.draft.id)).rejects.toThrow(/different project/)
  })
})
