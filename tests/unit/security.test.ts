import { describe, expect, it } from 'vitest'
import { redactSecrets, redactString } from '@/server/redact'
import { recordAudit } from '@/server/services/audit'
import { connectionSummary } from '@/server/services/connection'
import { getConfig } from '@/server/config'
import { createRecipe, updateRecipe } from '@/server/services/recipes'
import { createTestContext } from '../helpers/test-context'

describe('secret handling', () => {
  it('redacts keys by name and by pattern', () => {
    const redacted = redactSecrets({
      apiKey: 'lk_live_abcdef123456',
      nested: { authorization: 'Bearer abc.def.ghi.jkl', note: 'used key lk_live_abcdef123456 and sk-ant-api03-zzzzzzzz' },
      idempotencyKey: 'lkc.abc.123',
    })
    expect(JSON.stringify(redacted)).not.toMatch(/lk_live|sk-ant-api03|abc\.def/)
    expect(redacted.idempotencyKey).toBe('lkc.abc.123')
    expect(redactString('token=supersecretvalue', ['supersecretvalue'])).toBe('token=[redacted]')
  })

  it('never stores secrets in audit entries, even when a caller passes one', () => {
    const ctx = createTestContext()
    recordAudit(ctx, { operation: 'test', outcome: 'info', message: 'oops lk_live_abcdef123456', details: { apiKey: 'sk-ant-api03-secret-secret' } })
    const [event] = ctx.repos.audit.list({ limit: 1 })
    expect(JSON.stringify(event)).not.toMatch(/lk_live_abcdef|sk-ant-api03/)
  })

  it('the connection summary returned to the browser contains no key values', () => {
    const ctx = createTestContext()
    const summary = JSON.stringify(connectionSummary(ctx))
    expect(summary).not.toContain(ctx.settings.lk.apiKey!)
    expect(summary).not.toContain(ctx.settings.ai.apiKey!)
    expect(summary).toContain('"keyConfigured":true')
  })

  it('reads configuration safely: writes default to off, AI effort is validated', () => {
    const config = getConfig({ LEGENDKEEPER_API_KEY: 'lk_x', LKC_AI_EFFORT: 'turbo' } as unknown as NodeJS.ProcessEnv)
    expect(config.lk.allowWrites).toBe(false)
    expect(config.ai.effort).toBe('high')
    expect(config.ai.model).toBe('claude-opus-5-5')
    expect(getConfig({ LKC_ALLOW_WRITES: 'TRUE' } as unknown as NodeJS.ProcessEnv).lk.allowWrites).toBe(true)
    expect(getConfig({ LKC_ALLOW_WRITES: 'yes' } as unknown as NodeJS.ProcessEnv).lk.allowWrites).toBe(false)
  })
})

describe('recipe service', () => {
  it('validates references to page types, fields and templates', () => {
    const ctx = createTestContext()
    expect(() => createRecipe(ctx, { name: 'x', targetPageType: 'dragon' })).toThrow(/not valid/)
    try {
      createRecipe(ctx, { name: 'x', targetPageType: 'npc', requiredFields: ['armorClass'], templateId: 'example-creature' })
    } catch (error) {
      expect((error as { issues: string[] }).issues.join(' ')).toMatch(/armorClass.*not a field[\s\S]*creature/)
    }
  })

  it('supports custom page types and versioned updates with conflict detection', () => {
    const ctx = createTestContext()
    const recipe = createRecipe(ctx, {
      name: 'Deity',
      targetPageType: 'deity',
      customPageType: { id: 'deity', label: 'Deity', fields: [{ key: 'portfolio', label: 'Portfolio', group: 'lore' }], sections: ['Description', 'Worship'] },
      requiredFields: ['portfolio'],
    })
    expect(recipe.version).toBe(1)
    const updated = updateRecipe(ctx, recipe.id, { ...recipe.definition, description: 'Gods of the Flanaess' }, 1)
    expect(updated.version).toBe(2)
    expect(ctx.repos.recipes.getVersion(recipe.id, 1)!.description).toBe('')
    expect(() => updateRecipe(ctx, recipe.id, recipe.definition, 1)).toThrow(/changed elsewhere/)
  })
})
