import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { plainText, walk, type Block } from '@legendkeeper/sdk/blocks'
import type { DraftContext } from '@/core/draft-common'
import { fieldsForLayoutKey, skeletonFromBlocks, summarizeLayout, type LkLayout } from '@/core/lk-layout'
import { CanonicalPage } from '@/core/page-model'
import { findBuiltInPageType } from '@/core/page-types'
import { RecipeDefinition } from '@/core/recipe'
import { resolveTemplate } from '@/core/resolve'
import { buildStructuralDraft } from '@/core/structural'
import { LAYOUT_PRESETS, TemplateDefinition } from '@/core/template'
import { buildCreatePayload, renderPageBlocks } from '@/server/lk/render'
import { renderFromLayout } from '@/server/lk/render-layout'
import { validateAgainstSpec } from '../helpers/openapi-validator'

const creature = findBuiltInPageType('creature')!
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const templateBlocks = (JSON.parse(fixture('lk-statblock-template.json')) as { blocks: unknown[] }).blocks

function layout(): LkLayout {
  const { blocks, droppedParts } = skeletonFromBlocks(templateBlocks)
  return { sourceProjectId: 'p', sourceResourceId: 'l1ylm24t', sourceName: 'Statblock', sourceKind: 'template', documentName: 'Main', blocks, droppedParts, fetchedAt: '2026-10-11T00:00:00Z' }
}

function goblinDraft() {
  const recipe = RecipeDefinition.parse({ name: 'Creature', targetPageType: 'creature' })
  const text = fixture('statblock-2024.txt')
  const ctx: DraftContext = {
    pageType: creature,
    template: resolveTemplate(creature, null),
    recipe,
    recipeId: 'r',
    recipeVersion: 1,
    templateId: null,
    jobId: 'j',
    sourceText: text,
    sourceTitle: 'Goblin Underboss',
    attribution: { title: 'Test', kind: 'paste', citation: null, jobId: 'j', importedAt: '2026-01-01T00:00:00Z' },
    now: '2026-01-01T00:00:00Z',
  }
  return buildStructuralDraft(ctx, 'text').page
}

const template = (includeSourcesSection = false) =>
  TemplateDefinition.parse({ name: 'Statblock', pageType: 'creature', sections: ['Traits'], includeSourcesSection, lkLayout: layout() })

function rowsOf(blocks: Block[]): Record<string, string> {
  const out: Record<string, string> = {}
  walk(blocks, (block) => {
    if (block.kind === 'keyValue') for (const row of block.rows) out[row.key] = plainText([{ kind: 'paragraph', content: row.content ?? [] }])
  })
  return out
}

describe('layouts copied from LegendKeeper', () => {
  it('strips ids, ranks and parts the API cannot write', () => {
    const { blocks, droppedParts } = skeletonFromBlocks(templateBlocks)
    expect(droppedParts).toEqual([expect.stringMatching(/^the empty image slot/), 'TAGS'])
    expect(JSON.stringify(blocks)).not.toMatch(/"(id|rank)":/)
    expect(JSON.stringify(blocks)).not.toContain('unsupported')
  })

  it('matches row keys to fields, including British spelling and combined rows', () => {
    expect(fieldsForLayoutKey('Armour Class', creature)).toEqual(['armorClass'])
    expect(fieldsForLayoutKey('Strength', creature)).toEqual(['str'])
    expect(fieldsForLayoutKey('Challenge Rating', creature)).toEqual(['challenge'])
    expect(fieldsForLayoutKey('Immunities', creature)).toEqual(['damageImmunities', 'conditionImmunities'])
    expect(fieldsForLayoutKey('Favourite Colour', creature)).toEqual([])
    const summary = summarizeLayout(layout().blocks, creature)
    expect(summary.sections).toEqual(['Traits', 'Actions', 'Bonus Actions', 'Legendary Actions'])
    expect(summary.hasDescriptionArea).toBe(true)
    expect(summary.rows.every((row) => row.fieldKeys.length > 0)).toBe(true)
  })

  it('fills the layout with the draft and never copies template text', () => {
    const page = goblinDraft()
    const blocks = renderPageBlocks(page, { pageType: creature, template: template() })
    const text = plainText(blocks)
    expect(text).not.toMatch(/Creature Name|Example|Placeholder|Creature Description Text|Size Type, Alignment/)

    // Name in the infobox heading, values in the template's rows.
    const infobox = blocks[0]!
    expect(infobox.kind).toBe('infobox')
    let heading = ''
    walk(blocks, (block) => {
      if (block.kind === 'heading' && block.level === 1 && !heading) heading = plainText(block)
    })
    expect(heading).toBe('Goblin Underboss')
    const rows = rowsOf(blocks)
    expect(rows).toMatchObject({
      'Armour Class': '17',
      Initiative: '+2 (12)',
      'Hit Points': '21 (6d6)',
      Speed: '30 ft.',
      Strength: '10 (+0)',
      Wisdom: '8 (−1)',
      Skills: 'Stealth +6',
      Senses: 'Darkvision 60 ft.; Passive Perception 9',
      Languages: 'Common, Goblin',
    })
    // Rows the source has nothing for stay, blank (the template's example value removed).
    expect(rows).toMatchObject({ Resistances: '', Immunities: '' })
    // The template's rows keep the template's order exactly; fields without a row of their own
    // come after them, at the end of the last group.
    const templateKeys: string[] = []
    walk(templateBlocks as Block[], (block) => {
      if (block.kind === 'keyValue') for (const row of block.rows) templateKeys.push(row.key)
    })
    const keys = Object.keys(rows)
    expect(keys.filter((key) => templateKeys.includes(key))).toEqual(templateKeys)
    // Extra fields in line, where they come in a statblock.
    expect(keys.slice(0, 4)).toEqual(['Size', 'Creature type', 'Alignment', 'Armour Class'])
    expect(keys.indexOf('Saving Throws')).toBe(keys.indexOf('Skills') - 1)
    expect(keys.indexOf('Gear')).toBe(keys.indexOf('Senses') - 1)

    // Grid and inline displays are kept.
    const displays: string[] = []
    walk(blocks, (block) => {
      if (block.kind === 'keyValue') displays.push(block.display ?? 'list')
    })
    expect(displays).toEqual(['list', 'grid', 'inline'])

    // Sections go into the matching text blocks; empty ones are left out; extra ones are added as text blocks.
    const titled = blocks.filter((block) => block.kind === 'textField').map((block) => (block as { title?: string }).title)
    expect(titled).toEqual(['Traits', 'Actions', 'Reactions'])
    expect(text).toContain('Nimble Feet. The underboss can take the Disengage action as a bonus action.')
    expect(text).toContain('Redirect Attack.')
  })

  it('places the description where the template has its placeholder', () => {
    const page = goblinDraft()
    page.sections.push({ id: 's-desc', heading: 'Description', kind: 'lore', paragraphs: ['Underbosses keep goblin war bands in line.'] })
    const blocks = renderPageBlocks(page, { pageType: creature, template: template() })
    const ruleAt = blocks.findIndex((block) => block.kind === 'rule')
    expect(ruleAt).toBeGreaterThan(0)
    expect(plainText(blocks[ruleAt + 1]!)).toBe('Underbosses keep goblin war bands in line.')
    expect(blocks.some((block) => block.kind === 'heading' && plainText(block) === 'Description')).toBe(false)
  })

  it('leaves out empty image slots even in layouts copied earlier', () => {
    const old = layout()
    old.blocks = templateBlocks.map((block) => skeletonFromBlocks([block]).blocks[0]!)
    ;(old.blocks[0]!.rows as Record<string, unknown>[]).unshift({ kind: 'image', title: 'IMAGE', isTitleHidden: true, url: '', fill: true })
    const blocks = renderPageBlocks(goblinDraft(), { pageType: creature, template: TemplateDefinition.parse({ name: 'S', pageType: 'creature', sections: ['Traits'], lkLayout: old }) })
    let images = 0
    walk(blocks, (block) => {
      if (block.kind === 'image') images++
    })
    expect(images).toBe(0)
  })

  it('fills a “Source” row that matches no field with where the content came from', () => {
    const page = goblinDraft()
    const withSource = TemplateDefinition.parse({ ...template(), lkLayout: { ...layout(), blocks: [{ kind: 'keyValue', rows: [{ key: 'Source:', content: [] }, { key: 'Armour Class', content: [] }] }] } })
    const rows = rowsOf(renderPageBlocks(page, { pageType: creature, template: withSource }))
    expect(rows['Source:']).toBe('Test')
    expect(Object.keys(rows).indexOf('Armour Class')).toBeGreaterThan(Object.keys(rows).indexOf('Source:'))
  })

  it('fitted to the page: empty fields and sections removed, extra fields in line', () => {
    const fitted = TemplateDefinition.parse({ ...template(), layoutRules: LAYOUT_PRESETS.fit })
    const blocks = renderPageBlocks(goblinDraft(), { pageType: creature, template: fitted })
    const rows = rowsOf(blocks)
    expect(rows).not.toHaveProperty('Resistances')
    expect(rows).not.toHaveProperty('Immunities')
    expect(Object.keys(rows).slice(0, 4)).toEqual(['Size', 'Creature type', 'Alignment', 'Armour Class'])
    const titled = blocks.filter((block) => block.kind === 'textField').map((block) => (block as { title?: string }).title)
    expect(titled).toEqual(['Traits', 'Actions', 'Reactions'])
  })

  it('exactly as the template: every field and section stays, nothing is added, and what has no place is reported', () => {
    const exact = TemplateDefinition.parse({ ...template(), layoutRules: LAYOUT_PRESETS.exact })
    const report = { leftOut: [] as string[] }
    const blocks = renderFromLayout(goblinDraft(), creature, exact.lkLayout!, false, { rules: exact.layoutRules, report })
    const rows = rowsOf(blocks)
    const templateKeys: string[] = []
    walk(templateBlocks as Block[], (block) => {
      if (block.kind === 'keyValue') for (const row of block.rows) templateKeys.push(row.key)
    })
    expect(Object.keys(rows)).toEqual(templateKeys) // no field added, none removed
    expect(rows.Resistances).toBe('')
    const titled = blocks.filter((block) => block.kind === 'textField').map((block) => (block as { title?: string }).title)
    expect(titled).toEqual(['Traits', 'Actions', 'Bonus Actions', 'Legendary Actions']) // empty ones kept, no new box
    expect(plainText(blocks)).toContain('Reactions') // in the description area, under a bold heading
    expect(report.leftOut).toEqual(expect.arrayContaining(['the field “Size”', 'the field “Gear”']))
  })

  it('exactly as the template: extra sections go into its Notes box', () => {
    const withNotes = { ...layout(), blocks: [...layout().blocks.filter((block) => block.kind !== 'paragraph' && block.kind !== 'heading' && block.kind !== 'rule'), { kind: 'textField', title: 'Notes', isTitleHidden: false, children: [{ kind: 'paragraph', content: [{ text: 'Example notes' }] }] }] }
    const report = { leftOut: [] as string[] }
    const blocks = renderFromLayout(goblinDraft(), creature, withNotes, false, { rules: LAYOUT_PRESETS.exact, report })
    const notes = blocks.find((block) => block.kind === 'textField' && (block as { title?: string }).title === 'Notes')!
    expect(plainText([notes])).toContain('Reactions')
    expect(plainText([notes])).not.toContain('Example notes')
    expect(report.leftOut.every((part) => part.startsWith('the field'))).toBe(true)
  })

  it('gives each field to the row that matches it best, never to several', () => {
    const npcType = findBuiltInPageType('npc')!
    const character: LkLayout = { ...layout(), blocks: [{ kind: 'infobox', rows: [{ kind: 'keyValue', rows: [{ key: 'Species', content: [] }, { key: 'Titles', content: [] }, { key: 'Professions', content: [] }, { key: 'Class', content: [] }] }] }] }
    const page = CanonicalPage.parse({ schemaVersion: 1, name: 'Elvera', pageType: 'npc', fields: [{ key: 'ancestry', label: 'Ancestry', group: 'lore', value: 'Half-elf', status: 'source' }, { key: 'occupation', label: 'Occupation', group: 'lore', value: 'Innkeeper', status: 'source' }] })
    const rows = rowsOf(renderFromLayout(page, npcType, character, false, { rules: LAYOUT_PRESETS.exact }))
    expect(rows).toEqual({ Species: 'Half-elf', Titles: '', Professions: 'Innkeeper', Class: '' })
  })

  it('exactly as the template: with a Notes box, extra sections go there, not into the description area', () => {
    const npcType = findBuiltInPageType('npc')!
    const character: LkLayout = {
      ...layout(),
      blocks: [
        { kind: 'textField', title: 'DESCRIPTION', isTitleHidden: false, children: [{ kind: 'paragraph', content: [{ text: 'Example' }] }] },
        { kind: 'textField', title: 'Notes', isTitleHidden: false, children: [{ kind: 'paragraph', content: [] }] },
        { kind: 'paragraph', content: [] },
      ],
    }
    const page = CanonicalPage.parse({ schemaVersion: 1, name: 'Elvera', pageType: 'npc', sections: [{ id: 'a', heading: 'Description', kind: 'lore', paragraphs: ['Runs the inn.'] }, { id: 'b', heading: 'Rumours', kind: 'lore', paragraphs: ['Hides a map.'] }] })
    const blocks = renderFromLayout(page, npcType, character, false, { rules: LAYOUT_PRESETS.exact })
    expect(blocks.map((block) => block.kind)).toEqual(['textField', 'textField', 'paragraph'])
    expect(plainText([blocks[0]!])).toBe('Runs the inn.')
    expect(plainText([blocks[1]!])).toContain('Hides a map.')
  })

  it('puts game-master sections inside the template\'s secret block, never in visible boxes', () => {
    const npcType = findBuiltInPageType('npc')!
    const character: LkLayout = {
      ...layout(),
      blocks: [
        { kind: 'textField', title: 'DESCRIPTION', isTitleHidden: false, children: [{ kind: 'paragraph', content: [{ text: 'Example' }] }] },
        { kind: 'textField', title: 'Notes', isTitleHidden: false, children: [{ kind: 'paragraph', content: [] }] },
        { kind: 'secret', children: [{ kind: 'paragraph', content: [] }] },
        { kind: 'paragraph', content: [] },
      ],
    }
    const page = CanonicalPage.parse({ schemaVersion: 1, name: 'Elvera', pageType: 'npc', sections: [{ id: 'b', heading: 'Secrets', kind: 'lore', paragraphs: ['Hides a map.'] }, { id: 'a', heading: 'Description', kind: 'lore', paragraphs: ['Runs the inn.'] }, { id: 'c', heading: 'GM Notes', kind: 'notes', paragraphs: ['Owes the thieves.'] }] })
    for (const rules of [LAYOUT_PRESETS.exact, LAYOUT_PRESETS.fit]) {
      const blocks = renderFromLayout(page, npcType, character, false, { rules })
      const secret = blocks.find((block) => block.kind === 'secret')!
      expect(plainText([secret])).toContain('Hides a map.')
      expect(plainText([secret])).toContain('Owes the thieves.')
      expect(plainText(blocks.filter((block) => block.kind !== 'secret'))).not.toMatch(/Hides a map|Owes the thieves/)
      expect(plainText([blocks[0]!])).toBe('Runs the inn.')
    }
    // Nothing secret: the secret block stays blank (exact) or goes (fitted).
    const plain = CanonicalPage.parse({ schemaVersion: 1, name: 'Elvera', pageType: 'npc', sections: [{ id: 'a', heading: 'Description', kind: 'lore', paragraphs: ['Runs the inn.'] }] })
    expect(renderFromLayout(plain, npcType, character, false, { rules: LAYOUT_PRESETS.exact }).find((block) => block.kind === 'secret')).toEqual({ kind: 'secret', children: [{ kind: 'paragraph', content: [] }] })
    expect(renderFromLayout(plain, npcType, character, false, { rules: LAYOUT_PRESETS.fit }).some((block) => block.kind === 'secret')).toBe(false)
    // No secret block in the template: a new one (fitted), or reported (exact), never the Notes box.
    const noSecret = { ...character, blocks: character.blocks.filter((block) => block.kind !== 'secret') }
    expect(renderFromLayout(page, npcType, noSecret, false, { rules: LAYOUT_PRESETS.fit }).some((block) => block.kind === 'secret')).toBe(true)
    const report = { leftOut: [] as string[] }
    const exact = renderFromLayout(page, npcType, noSecret, false, { rules: LAYOUT_PRESETS.exact, report })
    expect(plainText(exact)).not.toContain('Hides a map.')
    expect(report.leftOut.join(' ')).toContain('Secrets')
  })

  it('keeps empty spacer paragraphs as they are', () => {
    const spaced = { ...layout(), blocks: [...layout().blocks, { kind: 'paragraph', content: [] }] }
    const blocks = renderFromLayout(goblinDraft(), creature, spaced, false)
    expect(blocks.at(-1)).toEqual({ kind: 'paragraph', content: [] })
  })

  it('writes only confirmed values', () => {
    const page = goblinDraft()
    const ac = page.fields.find((field) => field.key === 'armorClass')!
    ac.status = 'uncertain'
    const rows = rowsOf(renderPageBlocks(page, { pageType: creature, template: template() }))
    expect(rows['Armour Class']).toBe('') // kept, blank
  })

  it('adds a Sources section only when the template asks for it', () => {
    const page = goblinDraft()
    expect(plainText(renderPageBlocks(page, { pageType: creature, template: template(false) }))).not.toContain('Sources')
    expect(plainText(renderPageBlocks(page, { pageType: creature, template: template(true) }))).toContain('Sources')
  })

  it('produces a create request that matches the official OpenAPI schema', () => {
    const payload = buildCreatePayload(goblinDraft(), { pageType: creature, template: template(true) }, 'a0000000000000000000000a', 'key')
    const body = { id: payload.resourceId, name: payload.name, tags: payload.tags, aliases: payload.aliases, documents: [{ type: 'page', name: payload.documentName, blocks: payload.blocks }] }
    const result = validateAgainstSpec('ResourceCreateParams', body)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })
})

describe('copying a layout from LegendKeeper (service)', async () => {
  const { createTestContext } = await import('../helpers/test-context')
  const { copyLayoutFromLegendKeeper, listLkTemplates, resourceIdFrom } = await import('@/server/services/lk-templates')

  const setup = () =>
    createTestContext({
      resources: [
        { id: 'l1ylm24t', name: 'Statblock', parentId: 'templates', documents: [{ id: 'rjemxmxe', name: 'Main', type: 'page', blocks: templateBlocks, version: 'v1', text: '' }] },
        { id: 'pg000001', name: 'Aboleth', parentId: null },
      ],
    })

  it('lists templates and copies one into a local template, reading only', async () => {
    const ctx = setup()
    const { templates } = await listLkTemplates(ctx)
    expect(templates.map((t) => t.name)).toEqual(['Statblock'])

    const { template, report } = await copyLayoutFromLegendKeeper(ctx, { resource: 'l1ylm24t', pageType: 'creature' })
    expect(ctx.lk.callCount('createPage')).toBe(0)
    expect(template.origin).toBe('local')
    expect(template.definition.lkLayout?.sourceKind).toBe('template')
    expect(template.definition.includeSourcesSection).toBe(false)
    expect(template.definition.sections.slice(0, 4)).toEqual(['Traits', 'Actions', 'Bonus Actions', 'Legendary Actions'])
    expect(report?.droppedParts).toHaveLength(2)
    expect(report?.rows.find((row) => row.key === 'Armour Class')?.fields).toEqual(['Armor Class'])

    // A matching recipe is made, based on the creature example, with creation switched on.
    const { recipe } = await copyLayoutFromLegendKeeper(ctx, { resource: 'l1ylm24t', pageType: 'creature', createRecipe: false })
    expect(recipe).toBeNull()
    const made = ctx.repos.recipes.list().filter((r) => r.definition.templateId === template.id)
    expect(made.map((r) => r.definition.name)).toEqual(['Statblock'])
    expect(made[0]!.definition).toMatchObject({ targetPageType: 'creature', allowCreate: true, requiredFields: ['armorClass', 'hitPoints'] })

    // Refreshing updates the same template and makes no second recipe.
    const again = await copyLayoutFromLegendKeeper(ctx, { resource: 'l1ylm24t', pageType: 'creature', templateId: template.id })
    expect(again.template.id).toBe(template.id)
    expect(again.recipe).toBeNull()
    expect(ctx.repos.recipes.list().filter((r) => r.definition.templateId === template.id)).toHaveLength(1)
  })

  it('lets an import choose its template, and the draft switch it later', async () => {
    const ctx = setup()
    const { template } = await copyLayoutFromLegendKeeper(ctx, { resource: 'l1ylm24t', pageType: 'creature', createRecipe: false })
    const { createImport } = await import('@/server/services/imports')
    const { runTransform } = await import('@/server/services/transform')
    const { saveDraft } = await import('@/server/services/drafts')
    const example = ctx.repos.recipes.list().find((r) => r.definition.name === 'Creature statblock')!
    expect(example.definition.templateId).toBe('example-creature')
    const job = createImport(ctx, { bytes: new TextEncoder().encode(fixture('statblock-2024.txt')), fileName: null, mimeType: 'text/plain', declaredFormat: 'text', sourceKind: 'paste', name: null, attributionTitle: null, citation: null, recipeId: example.id })

    const withLayout = await runTransform(ctx, job.id, { mode: 'structural', templateId: template.id })
    expect(withLayout.template?.id).toBe(template.id)
    expect(withLayout.templateChoices.map((t) => t.id)).toEqual(expect.arrayContaining([template.id, 'example-creature']))
    expect((withLayout.preview!.blocks[0] as { kind: string }).kind).toBe('infobox')

    const switched = await saveDraft(ctx, withLayout.draft.id, { ...withLayout.draft.page, templateId: 'example-creature' }, withLayout.draft.revision)
    expect(switched.template?.id).toBe('example-creature')

    await expect(runTransform(ctx, job.id, { mode: 'structural', templateId: 'example-npc' })).rejects.toThrow(/for “npc” pages/)
  })

  it('accepts a link to a page and explains empty pages', async () => {
    expect(resourceIdFrom('https://app.legendkeeper.com/a/proj/resources/l1ylm24t/documents/rjemxmxe')).toBe('l1ylm24t')
    expect(() => resourceIdFrom('not a page!')).toThrow(/page id/)
    const ctx = setup()
    await expect(copyLayoutFromLegendKeeper(ctx, { resource: 'pg000001', pageType: 'creature' })).rejects.toThrow(/empty/)
  })
})

describe('bold entry names in statblock sections', async () => {
  const { boldEntryName } = await import('@/server/lk/render-text')
  it('bolds the name at the start of each entry', () => {
    expect(boldEntryName('Nimble Feet. The underboss can take the Disengage action.')).toBe('**Nimble Feet.** The underboss can take the Disengage action.')
    expect(boldEntryName('Legendary Resistance (3/Day). If the creature fails a saving throw, it succeeds instead.')).toBe('**Legendary Resistance (3/Day).** If the creature fails a saving throw, it succeeds instead.')
    expect(boldEntryName('Fire Breath (Recharge 5–6). The dragon exhales fire.')).toBe('**Fire Breath (Recharge 5–6).** The dragon exhales fire.')
    expect(boldEntryName('Scimitar. Melee Attack Roll: +4, reach 5 ft.')).toBe('**Scimitar.** Melee Attack Roll: +4, reach 5 ft.')
    expect(boldEntryName('Wand of Webs. It casts Web.')).toBe('**Wand of Webs.** It casts Web.')
  })
  it('leaves ordinary sentences and already bold names alone', () => {
    expect(boldEntryName('If the creature fails a saving throw, it can choose to succeed instead.')).toBe('If the creature fails a saving throw, it can choose to succeed instead.')
    expect(boldEntryName('The goblin flees. It hides.')).toBe('The goblin flees. It hides.')
    expect(boldEntryName('**Multiattack.** The underboss attacks twice.')).toBe('**Multiattack.** The underboss attacks twice.')
    expect(boldEntryName('Multiattack')).toBe('Multiattack')
  })
  it('shows the names in bold in the filled layout, in mechanics sections only', () => {
    const page = goblinDraft()
    page.sections.push({ id: 's-d', heading: 'Description', kind: 'lore', paragraphs: ['Goblin Bosses. They lead war bands.'] })
    const blocks = renderPageBlocks(page, { pageType: creature, template: template() })
    const bolds: string[] = []
    walk(blocks, (block) => {
      if (block.kind === 'paragraph') for (const run of block.content ?? []) if ('bold' in run && run.bold) bolds.push(run.text)
    })
    expect(bolds).toEqual(['Nimble Feet.', 'Multiattack.', 'Scimitar.', 'Redirect Attack.'])
  })
})
