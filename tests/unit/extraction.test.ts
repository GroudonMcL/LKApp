import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ExtractionError, extractSource, getByPath, guessPageType, splitSource, detectSuspiciousInstructions } from '@/core/extraction'
import { BUILT_IN_PAGE_TYPES } from '@/core/page-types'
import { utf8 } from '../helpers/test-context'

const limits = { maxBytes: 100_000, maxChars: 50_000 }
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

describe('extraction', () => {
  it('extracts Markdown with its title and outline', () => {
    const result = extractSource({ bytes: utf8(fixture('ogre-statblock.md')), fileName: 'ogre.md', mimeType: 'text/markdown' }, limits)
    expect(result.format).toBe('markdown')
    expect(result.title).toBe('Hill Ogre of the Lortmils')
    expect(result.outline.map((e) => e.heading)).toEqual(['Hill Ogre of the Lortmils', 'Description', 'Actions'])
    expect(result.text).toContain('59 (7d10 + 21)')
  })

  it('parses JSON, keeps values unchanged and finds the title', () => {
    const result = extractSource({ bytes: utf8(fixture('location.json')), fileName: 'hardby.json', mimeType: 'application/json' }, limits)
    expect(result.format).toBe('json')
    expect(result.title).toBe('Hardby')
    expect(getByPath(result.json, 'population')).toBe('5,100')
    expect(getByPath(result.json, 'resources[1]')).toBe('copper')
    expect(getByPath(result.json, 'missing.path')).toBeUndefined()
  })

  it('reports invalid JSON clearly', () => {
    expect(() => extractSource({ bytes: utf8('{"name": '), fileName: 'x.json', mimeType: null }, limits)).toThrowError(/not valid JSON/)
  })

  it('sniffs pasted JSON and Markdown, and falls back to plain text', () => {
    expect(extractSource({ bytes: utf8('{"name":"A"}'), fileName: null, mimeType: null }, limits).format).toBe('json')
    expect(extractSource({ bytes: utf8('# Title\n\nBody'), fileName: null, mimeType: null }, limits).format).toBe('markdown')
    expect(extractSource({ bytes: utf8('Just some notes.'), fileName: null, mimeType: null }, limits).format).toBe('text')
  })

  it('refuses empty, binary, non-UTF-8 and unsupported inputs with explanations', () => {
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return (error as ExtractionError).code
      }
      return null
    }
    expect(code(() => extractSource({ bytes: new Uint8Array(), fileName: 'a.txt', mimeType: null }, limits))).toBe('EMPTY')
    expect(code(() => extractSource({ bytes: new Uint8Array([72, 0, 105]), fileName: 'a.txt', mimeType: null }, limits))).toBe('BINARY')
    expect(code(() => extractSource({ bytes: new Uint8Array([0xff, 0xfe, 0x41]), fileName: 'a.txt', mimeType: null }, limits))).toBe('NOT_UTF8')
    expect(code(() => extractSource({ bytes: utf8('%PDF-1.7'), fileName: 'book.pdf', mimeType: 'application/pdf' }, limits))).toBe('UNSUPPORTED_TYPE')
    expect(code(() => extractSource({ bytes: utf8('x'), fileName: 'notes.docx', mimeType: null }, limits))).toBe('UNSUPPORTED_TYPE')
    expect(code(() => extractSource({ bytes: utf8('x'), fileName: 'data.xyz', mimeType: null }, limits))).toBe('UNSUPPORTED_TYPE')
  })

  it('never truncates: oversize inputs are refused', () => {
    expect(() => extractSource({ bytes: utf8('a'.repeat(200)), fileName: 'a.txt', mimeType: null }, { maxBytes: 100, maxChars: 1000 })).toThrowError(/upload limit/)
    expect(() => extractSource({ bytes: utf8('a'.repeat(200)), fileName: 'a.txt', mimeType: null }, { maxBytes: 1000, maxChars: 100 })).toThrowError(/Split source/)
  })

  it('splits long sources at headings without losing any text', () => {
    const text = Array.from({ length: 12 }, (_, i) => `## Chapter ${i}\n\n${'Lorem ipsum dolor sit amet. '.repeat(30)}\n`).join('\n')
    const chunks = splitSource(text, 2000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.chars <= 2000)).toBe(true)
    expect(chunks.map((c) => c.text).join('')).toBe(text)
  })

  it('splits text with no headings, and hard-splits a single oversized line', () => {
    const text = `${'x'.repeat(5000)}\n\nshort paragraph`
    const chunks = splitSource(text, 1000)
    expect(chunks.map((c) => c.text).join('')).toBe(text)
    expect(chunks.every((c) => c.chars <= 1000)).toBe(true)
  })

  it('guesses page types as a hint only', () => {
    const guesses = guessPageType(fixture('ogre-statblock.md'), BUILT_IN_PAGE_TYPES)
    expect(guesses[0]!.pageType).toBe('creature')
  })

  it('flags text that looks like instructions to an AI', () => {
    expect(detectSuspiciousInstructions(fixture('npc-notes.txt'))).toHaveLength(1)
    expect(detectSuspiciousInstructions('An ordinary paragraph about an inn.')).toHaveLength(0)
  })
})
