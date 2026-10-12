import { describe, expect, it } from 'vitest'
import type { DraftContext } from '@/core/draft-common'
import { findBuiltInPageType } from '@/core/page-types'
import { RecipeDefinition } from '@/core/recipe'
import { resolveTemplate } from '@/core/resolve'
import { buildStructuralDraft } from '@/core/structural'

const location = findBuiltInPageType('location')!
const draft = (sourceText: string, sourceTitle: string, format: 'markdown' | 'text' = 'markdown') => {
  const ctx: DraftContext = {
    pageType: location,
    template: resolveTemplate(location, null),
    recipe: RecipeDefinition.parse({ name: 'Location', targetPageType: 'location' }),
    recipeId: 'r',
    recipeVersion: 1,
    templateId: null,
    jobId: 'j',
    sourceText,
    sourceTitle,
    attribution: { title: 'Test', kind: 'upload', citation: null, jobId: 'j', importedAt: '2026-01-01T00:00:00Z' },
    now: '2026-01-01T00:00:00Z',
  }
  return buildStructuralDraft(ctx, format).page
}

describe('structural drafting of records cut from a longer document', () => {
  it('treats the record’s own “## Name” heading as the title, so its “###” headings become sections', () => {
    const page = draft('## Saltreach\n\nType: Fishing town\n\n### Overview\n\nA town on a chalk headland.\n\n### History\n\nFounded in 412 CY.', 'Saltreach')
    expect(page.name).toBe('Saltreach')
    expect(page.sections.map((s) => s.heading)).toEqual(['Overview', 'History'])
    expect(page.sections[1]!.paragraphs).toEqual(['Founded in 412 CY.'])
    expect(page.fields.find((f) => f.key === 'locationType')).toMatchObject({ value: 'Fishing town', status: 'source' })
  })

  it('keeps a first heading that is not the record’s name as a section', () => {
    const page = draft('## Overview\n\nA town.\n\n## History\n\nOld.', 'Saltreach')
    expect(page.sections.map((s) => s.heading)).toEqual(['Overview', 'History'])
  })
})

describe('plain text headings', () => {
  it('reads a short title-like line between blank lines as a heading, but not sentences or labels', () => {
    const page = draft('Saltreach\n\nType: Fishing town\n\nOverview\n\nA town on a chalk headland.\n\nThe end of the road\nis here.\n\nNotable Places\n\nThe Tallow Stair.', 'Saltreach', 'text')
    expect(page.sections.map((s) => s.heading)).toEqual(['Overview', 'Notable Places'])
    expect(page.sections[0]!.paragraphs.join(' ')).toContain('The end of the road')
  })
})

describe('statblock labels', () => {
  it('reads “Languages the languages it knew in life” as the Languages value', async () => {
    const { matchLabel } = await import('@/core/statblock')
    expect(matchLabel('Languages the languages it knew in life', [{ fieldKey: 'languages', label: 'Languages', allowBare: true }])).toMatchObject({ fieldKey: 'languages', value: 'the languages it knew in life' })
    expect(matchLabel('Speed the creature moves slowly', [{ fieldKey: 'speed', label: 'Speed', allowBare: true }])).toBeNull()
  })
})

describe('copied layouts', () => {
  it('keep the required id of a collection filter while dropping block ids', async () => {
    const { skeletonFromBlocks } = await import('@/core/lk-layout')
    const { blocks } = skeletonFromBlocks([{ id: 'b1', kind: 'resourceCollection', title: 'Subclasses', filter: { type: 'filter', filterType: 'tag', id: 'tags', operator: 'has_all', tags: [] } }])
    expect(blocks[0]).toEqual({ kind: 'resourceCollection', title: 'Subclasses', filter: { type: 'filter', filterType: 'tag', id: 'tags', operator: 'has_all', tags: [] } })
  })
})
