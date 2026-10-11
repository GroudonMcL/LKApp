import { describe, expect, it } from 'vitest'
import { walk, type Block } from '@legendkeeper/sdk/blocks'
import { CanonicalPage, type CanonicalPageInput } from '@/core/page-model'
import { BUILT_IN_PAGE_TYPES, findBuiltInPageType } from '@/core/page-types'
import { resolveTemplate } from '@/core/resolve'
import { buildCreatePayload, renderPageBlocks } from '@/server/lk/render'
import { validateAgainstSpec } from '../helpers/openapi-validator'

const IUZ = 'iuzaaaaaaaaaaaaaaaaaaaaa'
const CITY = 'cityaaaaaaaaaaaaaaaaaaaa'

function samplePage(pageType: string, overrides: Partial<CanonicalPageInput> = {}) {
  const type = findBuiltInPageType(pageType)!
  return CanonicalPage.parse({
    schemaVersion: 1,
    name: `Sample ${type.label}`,
    pageType,
    parentId: 'parent01',
    fields: type.fields.map((field, i) => ({
      key: field.key,
      label: field.label,
      group: field.group,
      value: i % 2 === 0 ? `${field.label} value ${i}` : null,
      status: i % 2 === 0 ? 'source' : 'missing',
    })),
    sections: [
      { id: 'a', heading: type.sections[0]!, kind: 'lore', paragraphs: ['Serves Iuz from the Free City of Greyhawk.\nSecond line.', '- one\n- two'] },
      { id: 'b', heading: 'Actions', kind: 'mechanics', paragraphs: ['**Greatclub.** Melee Weapon Attack: +6 to hit.'] },
      { id: 'c', heading: 'Unsorted source material', kind: 'unmapped', paragraphs: ['Odd leftover text mentioning Iuz.'] },
    ],
    references: [
      { id: 'r1', mention: 'Iuz', status: 'resolved', resourceId: IUZ, candidates: [{ resourceId: IUZ, name: 'Iuz', matchType: 'exact_name' }] },
      { id: 'r2', mention: 'Free City of Greyhawk', status: 'unresolved', candidates: [{ resourceId: CITY, name: 'Free City of Greyhawk', matchType: 'case_insensitive' }] },
    ],
    tags: [
      { value: 'NPC', status: 'existing', existingMatch: 'NPC', origin: 'page_type', accepted: true },
      { value: 'npc', status: 'case_variant', existingMatch: 'NPC', origin: 'ai', accepted: true },
      { value: 'Villain', status: 'rejected', origin: 'ai', accepted: false },
    ],
    sources: [{ title: 'World of Greyhawk Gazetteer', kind: 'upload', citation: 'p. 40', importedAt: '2026-10-11T00:00:00Z' }],
    ...overrides,
  })
}

function render(pageType: string, page = samplePage(pageType)) {
  const type = findBuiltInPageType(pageType)!
  return renderPageBlocks(page, { pageType: type, template: resolveTemplate(type, null) })
}

function mentions(blocks: Block[]) {
  const ids: string[] = []
  walk(blocks, (block) => {
    const content = (block as { content?: unknown[] }).content
    for (const run of content ?? []) {
      const m = (run as { mention?: { resourceId: string } }).mention
      if (m) ids.push(m.resourceId)
    }
  })
  return ids
}

describe('rendering canonical drafts to LegendKeeper blocks', () => {
  it.each(BUILT_IN_PAGE_TYPES.map((t) => t.id))('produces a create request that matches the official OpenAPI schema (%s)', (pageType) => {
    const type = findBuiltInPageType(pageType)!
    const payload = buildCreatePayload(samplePage(pageType), { pageType: type, template: resolveTemplate(type, null) }, 'abcdefghijklmnopqrstuvwx', 'lkc.key')
    const body = { id: payload.resourceId, name: payload.name, parentId: payload.parentId, tags: payload.tags, aliases: payload.aliases, documents: [{ type: 'page', name: payload.documentName, blocks: payload.blocks }] }
    const result = validateAgainstSpec('ResourceCreateParams', body)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('the schema check really rejects malformed blocks', () => {
    const result = validateAgainstSpec('ResourceCreateParams', { name: 'x', documents: [{ type: 'page', blocks: [{ kind: 'paragraph', content: [{ text: 'x', glitter: true }] }] }] })
    expect(result.valid).toBe(false)
  })

  it('writes only confirmed field values', () => {
    const json = JSON.stringify(render('npc'))
    expect(json).toContain('Ancestry value 0')
    expect(json).not.toContain('Occupation value')
  })

  it('puts lore in an infobox and mechanics in a separate statistics block', () => {
    const blocks = render('creature')
    expect(blocks[0]!.kind).toBe('infobox')
    const infobox = JSON.stringify(blocks[0])
    expect(infobox).toContain('Edition')
    expect(infobox).not.toContain('Armor Class')
    const stats = blocks.find((b) => b.kind === 'keyValue') as { title?: string } | undefined
    expect(stats?.title).toBe('Statistics')
    expect(JSON.stringify(stats)).toContain('Size value 0')
  })

  it('links only resolved references, and never inside unsorted material', () => {
    const blocks = render('npc')
    expect(mentions(blocks)).toEqual([IUZ])
    expect(JSON.stringify(blocks)).not.toContain(CITY)
    const related = JSON.stringify(blocks[0])
    expect(related).toContain(IUZ)
  })

  it('renders no links at all when nothing is resolved', () => {
    const page = samplePage('npc', { references: [] })
    expect(mentions(render('npc', page))).toEqual([])
  })

  it('uses the existing spelling for tags and drops rejected ones', () => {
    const type = findBuiltInPageType('npc')!
    const payload = buildCreatePayload(samplePage('npc'), { pageType: type, template: resolveTemplate(type, null) }, 'abcdefghijklmnopqrstuvwx', 'k')
    expect(payload.tags).toEqual(['NPC'])
  })

  it('preserves list structure, line breaks and bold lead-ins', () => {
    const blocks = render('creature')
    expect(blocks.some((b) => b.kind === 'bulletList')).toBe(true)
    const json = JSON.stringify(blocks)
    expect(json).toContain('"break":true')
    expect(json).toContain('{"text":"Greatclub.","bold":true}')
  })

  it('ends with a Sources section', () => {
    const json = JSON.stringify(render('location'))
    expect(json).toContain('World of Greyhawk Gazetteer — p. 40')
  })
})
