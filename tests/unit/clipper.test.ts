import { describe, expect, it } from 'vitest'
import { h, p, rule, ul, type Block } from '@legendkeeper/sdk/blocks'
import { BACKLINKS_FILTER, appendedBlocks, isBacklinksCollection, newPageBlocks, pageAfterAppend, sourceHeading, sourcePageBlocks } from '@/core/clipper/blocks'
import { ProjectIndex, writableDocuments, type IndexEntry } from '@/core/clipper/project-index'
import { sniffImageType } from '@/server/clipper/lk-clipper'
import { validateAgainstSpec } from '../helpers/openapi-validator'

const SOURCE = { resourceId: 'srcaaaaaaaaaaaaaaaaaaaaa' }

function entry(id: string, name: string, parentId: string | null, extra: Partial<IndexEntry> = {}): IndexEntry {
  return { id, name, parentId, aliases: [], tags: [], documents: [{ id: `${id}-doc`, name: 'Main', type: 'page' }], ...extra }
}

describe('clipper blocks', () => {
  it('writes the source heading as "From " + a mention of the Source page', () => {
    const heading = sourceHeading(SOURCE) as { kind: string; level: number; content: unknown[] }
    expect(heading.kind).toBe('heading')
    expect(heading.level).toBe(1)
    expect(heading.content).toEqual([{ text: 'From ' }, { mention: { resourceId: SOURCE.resourceId } }])
    expect((sourceHeading({ ...SOURCE, label: 'DnD Beyond' }) as { content: unknown[] }).content[1]).toEqual({ mention: { resourceId: SOURCE.resourceId, text: 'DnD Beyond' } })
  })

  it('puts the heading first on a new page', () => {
    const blocks = newPageBlocks(SOURCE, [p('Clipped.')])
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph'])
  })

  it('appends divider, heading and content after the existing blocks, which stay exactly as read', () => {
    const existing = [{ id: 'a1', kind: 'paragraph', content: [{ text: 'Mine.' }] }, { id: 'u1', kind: 'unsupported' }] as unknown as Block[]
    const after = pageAfterAppend(existing, SOURCE, [ul('one', 'two')])
    // The same objects, not rebuilt copies.
    expect(after[0]).toBe(existing[0])
    expect(after[1]).toBe(existing[1])
    expect(after.slice(2).map((b) => b.kind)).toEqual(['rule', 'heading', 'bulletList'])
    expect(appendedBlocks(SOURCE, []).map((b) => b.kind)).toEqual(['rule', 'heading'])
  })

  it('leaves out the divider (and the lone empty paragraph) on an empty page', () => {
    expect(pageAfterAppend([], SOURCE, [p('x')]).map((b) => b.kind)).toEqual(['heading', 'paragraph'])
    const blankParagraph = [{ id: 'e1', kind: 'paragraph', content: [] }] as unknown as Block[]
    expect(pageAfterAppend(blankParagraph, SOURCE, [p('x')]).map((b) => b.kind)).toEqual(['heading', 'paragraph'])
  })

  it('builds a Source page with the same Backlinks collection LegendKeeper writes', () => {
    const [collection] = sourcePageBlocks()
    expect(collection).toMatchObject({ kind: 'resourceCollection', title: 'Backlinks', isTitleHidden: false, filter: BACKLINKS_FILTER })
    expect(isBacklinksCollection(collection!)).toBe(true)
    expect(isBacklinksCollection(h(1, 'x'))).toBe(false)
  })

  it('produces bodies the official OpenAPI schema accepts', () => {
    const create = {
      id: 'newpageaaaaaaaaaaaaaaaaa',
      name: 'Red Dragons',
      parentId: 'parent01',
      tags: [],
      aliases: [],
      documents: [{ type: 'page', name: 'Main', blocks: newPageBlocks(SOURCE, [h(2, 'Lair'), p('Hot.'), rule()]) }],
    }
    const source = { ...create, name: 'D&D Beyond', documents: [{ type: 'page', name: 'Main', blocks: sourcePageBlocks() }] }
    for (const body of [create, source]) {
      const result = validateAgainstSpec('ResourceCreateParams', body)
      expect(result.errors).toEqual([])
    }
    const replace = validateAgainstSpec('DocumentBlocksWrite', { blocks: pageAfterAppend([p('Mine.')], SOURCE, [p('Clipped.')]) })
    expect(replace.errors).toEqual([])
  })
})

describe('clipper project index', () => {
  const index = new ProjectIndex([
    entry('bestiary', 'Bestiary', null, { documents: [{ id: 'b', name: 'Main', type: 'blank' }] }),
    entry('dragon', 'Dragon', 'bestiary'),
    entry('reddragon', 'Adult Red Dragon', 'dragon', { tags: ['Monster', 'Dragon'] }),
    entry('copper', 'Copper Dragon', 'dragon'),
    entry('dragonborn', 'Dragonborn', null),
    entry('turtle', 'Dragon Turtle', 'bestiary'),
    entry('lore', 'Ancient Lore', null, { tags: ['Dragon'] }),
    entry('greyhawk', 'The Free City of Greyhawk', null, { aliases: ['Greyhawk City'] }),
    entry('sources', 'Sources', null),
    entry('ddb', 'D&D Beyond', 'sources'),
    entry('mm', 'Monster Manual', 'sources', { documents: [{ id: 'm1', name: 'Map', type: 'map' }, { id: 'm2', name: 'Notes', type: 'page' }] }),
    entry('tagged', 'Wikipedia', null, { tags: ['Source'] }),
  ])

  it('builds paths from the parent chain', () => {
    expect(index.displayPath('reddragon')).toBe('Bestiary / Dragon / Adult Red Dragon')
    expect(index.isDescendantOf('reddragon', 'bestiary')).toBe(true)
    expect(index.isDescendantOf('dragonborn', 'bestiary')).toBe(false)
  })

  it('ranks the exact name first, then prefixes, then words, then tags', () => {
    const ranked = index.search('Dragon').map((r) => `${r.page.name}:${r.match}`)
    expect(ranked).toEqual([
      'Dragon:exact_name',
      'Dragonborn:name_prefix',
      'Dragon Turtle:name_prefix',
      'Copper Dragon:name_word',
      'Adult Red Dragon:name_word',
      'Ancient Lore:tag',
    ])
  })

  it('finds aliases and near spellings, ignoring a leading "the"', () => {
    expect(index.search('greyhawk')[0]).toMatchObject({ page: { id: 'greyhawk' }, match: 'name_word' })
    expect(index.search('Free City')[0]?.page.id).toBe('greyhawk')
    expect(index.search('Greyhawk City')[0]).toMatchObject({ page: { id: 'greyhawk' }, match: 'alias', detail: 'Greyhawk City' })
    expect(index.search('Dragn')[0]).toMatchObject({ page: { id: 'dragon' }, match: 'fuzzy_name' })
    expect(index.search('xyz')).toEqual([])
  })

  it('adds LegendKeeper content hits after the name matches, once each', () => {
    const merged = index.mergeContentHits(index.search('Copper'), [{ resourceId: 'copper' }, { resourceId: 'lore', highlight: 'copper scales' }, { resourceId: 'unknown' }])
    expect(merged.map((r) => `${r.page.id}:${r.match}`)).toEqual(['copper:name_prefix', 'lore:content'])
  })

  it('finds Source pages under the Sources page or by tag, and matches names loosely', () => {
    const options = { sourcesRootId: 'sources', sourceTag: 'Source' }
    expect(index.sources(options).map((s) => s.id).sort()).toEqual(['ddb', 'mm', 'tagged'])
    expect(index.findSourceByName('d&d beyond', options).map((s) => s.id)).toEqual(['ddb'])
    expect(index.findSourceByName('Dragon', options)).toEqual([])
  })

  it('updates in place after the clipper creates a page', () => {
    const local = new ProjectIndex([entry('sources', 'Sources', null)])
    local.upsert(entry('new', 'Player’s Handbook', 'sources'))
    expect(local.displayPath('new')).toBe('Sources / Player’s Handbook')
    expect(local.findSourceByName("Player's Handbook", { sourcesRootId: 'sources' })).toHaveLength(1)
  })

  it('offers only page and blank tabs as append targets', () => {
    expect(writableDocuments(index.get('mm')!).map((d) => d.name)).toEqual(['Notes'])
    expect(writableDocuments(index.get('bestiary')!).map((d) => d.type)).toEqual(['blank'])
  })
})

describe('clipper image type sniffing', () => {
  it('reads the real type from the first bytes', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(sniffImageType(new TextEncoder().encode('<!doctype html>'))).toBeNull()
  })
})
