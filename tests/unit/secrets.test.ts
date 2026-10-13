import { describe, expect, it } from 'vitest'
import { CanonicalPage, isSecretHeading } from '@/core/page-model'
import { protectSecrets, secretPassages } from '@/core/secrets'

const SOURCE = `## Mother Sallow

Mother Sallow is an elderly human herbalist who lives in a stilt house at the edge of the Mirefen.

She is kind to children and rude to priests.

### Secrets

Mother Sallow was once a member of the bog hags' coven and fled it forty years ago. She sends adventurers into the fen hoping they will kill the coven mother before the coven finds her.

## Next subject

Not secret.`

describe('secret headings', () => {
  it('recognises game-master headings', () => {
    for (const h of ['Secrets', 'Secret', 'GM Notes', 'DM only', "Game Master's notes", 'For the GM', 'Hidden information', 'Spoilers', 'Secrets and Rumours', 'Dark Secrets'])
      expect(isSecretHeading(h), h).toBe(true)
    for (const h of ['Description', 'The Secret Garden of Hommlet', 'History', 'Notes', 'Relationships']) expect(isSecretHeading(h), h).toBe(false)
  })

  it('finds the passages under a secret heading, until the next heading of its level or higher', () => {
    expect(secretPassages(SOURCE)).toEqual([expect.stringMatching(/^Mother Sallow was once a member/)])
    expect(secretPassages('Intro\n\n**GM notes:**\nThe mayor is a vampire.\n\n# Next\nOpen.')).toEqual(['The mayor is a vampire.'])
    expect(secretPassages('Nothing hidden here.')).toEqual([])
  })
})

describe('keeping secrets out of what players read', () => {
  it('moves reworded secrets out of visible sections, keeps the source passage word for word, and withholds fields', () => {
    // What a free model actually returned in a live run: the secret spread over Background and Relationships.
    const page = CanonicalPage.parse({
      schemaVersion: 1,
      name: 'Mother Sallow',
      pageType: 'npc',
      fields: [
        { key: 'affiliations', label: 'Affiliations', group: 'lore', value: "Former member of the bog hags' coven", status: 'source' },
        { key: 'occupation', label: 'Occupation', group: 'lore', value: 'herbalist', status: 'source' },
      ],
      sections: [
        { id: 'a', heading: 'Description', kind: 'lore', paragraphs: ['Mother Sallow is an elderly human herbalist who lives in a stilt house at the edge of the Mirefen.'] },
        { id: 'b', heading: 'Background', kind: 'lore', paragraphs: ["Mother Sallow was once a member of the bog hags' coven and fled it forty years ago. She sends adventurers into the fen hoping they will kill the coven mother before the coven finds her."] },
        { id: 'c', heading: 'Relationships', kind: 'lore', paragraphs: ["Having fled the bog hags' coven forty years ago, she sends adventurers into the fen hoping they will kill the coven mother."] },
      ],
    })
    const { page: safe, moved, withheld } = protectSecrets(page, SOURCE)
    expect(moved).toBe(2)
    expect(withheld).toEqual(['Affiliations'])
    expect(safe.sections.map((s) => s.heading)).toEqual(['Description', 'Secrets'])
    const secrets = safe.sections.find((s) => s.heading === 'Secrets')!
    expect(secrets.paragraphs[0]).toMatch(/^Mother Sallow was once a member of the bog hags' coven/)
    // The reworded copy adds nothing to the source passage, so it is not repeated.
    expect(secrets.paragraphs).toHaveLength(1)
    expect(safe.fields.find((f) => f.key === 'affiliations')!.status).toBe('uncertain')
    expect(safe.fields.find((f) => f.key === 'occupation')!.status).toBe('source')
    expect(safe.reviewerNotes.join(' ')).toMatch(/moved into the Secrets section/)
  })

  it('changes nothing when the source has no secret heading', () => {
    const page = CanonicalPage.parse({ schemaVersion: 1, name: 'X', pageType: 'npc', sections: [{ id: 'a', heading: 'Description', kind: 'lore', paragraphs: ['Open text.'] }] })
    expect(protectSecrets(page, 'Open text.').page).toBe(page)
  })
})
