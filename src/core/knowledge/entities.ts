import { normalizeName, normalizeTag } from '../text'

/**
 * What kind of thing a page is about, for chronology and knowledge analysis.
 *
 * Read from what the project itself says, in this order: the page's tags, its page type
 * (when the app knows it), then the names of the folders (parent pages) it sits in. Nothing
 * is read from the page's wording here, so the same page always gets the same kind.
 */
export type EntityKind = 'person' | 'deity' | 'faction' | 'place' | 'event' | 'creature' | 'item' | 'rule' | 'other'

export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  person: 'Person',
  deity: 'Deity',
  faction: 'Faction',
  place: 'Place',
  event: 'Event',
  creature: 'Creature',
  item: 'Item',
  rule: 'Rules',
  other: 'Other',
}

const KEYWORDS: [EntityKind, string[]][] = [
  ['deity', ['god', 'gods', 'goddess', 'deity', 'deities', 'demigod', 'demigods', 'power', 'powers', 'pantheon', 'hero deity', 'quasi deity']],
  ['person', ['npc', 'npcs', 'character', 'characters', 'person', 'people', 'pc', 'pcs', 'player character', 'villain', 'villains', 'ruler', 'rulers']],
  ['faction', ['faction', 'factions', 'organization', 'organizations', 'organisation', 'organisations', 'guild', 'guilds', 'order', 'orders', 'group', 'groups', 'society', 'cult', 'cults', 'church', 'house', 'houses', 'clan', 'clans']],
  ['place', ['location', 'locations', 'place', 'places', 'city', 'cities', 'town', 'towns', 'village', 'region', 'regions', 'settlement', 'settlements', 'kingdom', 'kingdoms', 'nation', 'nations', 'realm', 'realms', 'country', 'dungeon', 'dungeons', 'geography', 'site', 'sites', 'landmark', 'plane', 'planes']],
  ['event', ['event', 'events', 'history', 'historical event', 'historical events', 'battle', 'battles', 'war', 'wars', 'timeline', 'chronology', 'story events', 'session', 'sessions']],
  ['creature', ['creature', 'creatures', 'monster', 'monsters', 'bestiary', 'beast', 'beasts', 'statblock', 'statblocks', 'aberration', 'fiend', 'dragon', 'humanoid', 'undead']],
  ['item', ['item', 'items', 'magic item', 'magic items', 'artifact', 'artifacts', 'artefact', 'equipment', 'treasure']],
  ['rule', ['rule', 'rules', 'spell', 'spells', 'glossary', 'class', 'classes', 'feat', 'feats', 'background', 'backgrounds', 'reference']],
]

const PAGE_TYPE_KINDS: Record<string, EntityKind> = {
  npc: 'person',
  location: 'place',
  historical_event: 'event',
  creature: 'creature',
  magic_item: 'item',
  rule: 'rule',
  faction: 'faction',
  deity: 'deity',
  god: 'deity',
}

function kindOfWord(word: string): EntityKind | null {
  const key = normalizeTag(word)
  for (const [kind, words] of KEYWORDS) if (words.includes(key)) return kind
  return null
}

export function entityKindFor(page: { tags: string[]; pageTypeId?: string | null; ancestors?: string[] }): EntityKind {
  for (const tag of page.tags) {
    const kind = kindOfWord(tag)
    if (kind) return kind
  }
  if (page.pageTypeId && PAGE_TYPE_KINDS[page.pageTypeId]) return PAGE_TYPE_KINDS[page.pageTypeId]!
  // Nearest folder first: "Gods / Greater Gods / Pelor" is a deity.
  for (const ancestor of [...(page.ancestors ?? [])].reverse()) {
    const kind = kindOfWord(ancestor)
    if (kind) return kind
  }
  return 'other'
}

/** Words that make a capitalised phrase look like a kind of thing (for names without a page). */
export function kindFromNameShape(name: string, context: string): EntityKind | null {
  const n = normalizeName(name)
  const first = n.split(' ')[0] ?? ''
  const last = n.split(' ').at(-1) ?? ''
  if (['battle', 'siege', 'war', 'wars', 'sack', 'fall', 'treaty', 'massacre', 'founding', 'rebellion', 'uprising', 'invasion', 'plague', 'crusade', 'raid'].includes(first) || ['war', 'wars', 'treaty', 'massacre', 'rebellion', 'uprising', 'invasion', 'plague', 'crusade'].includes(last)) return 'event'
  if (['king', 'queen', 'prince', 'princess', 'lord', 'lady', 'sir', 'dame', 'duke', 'duchess', 'baron', 'baroness', 'count', 'countess', 'archmage', 'brother', 'sister', 'father', 'mother', 'captain', 'general', 'high priest', 'high priestess', 'warden', 'archbishop', 'bishop', 'emperor', 'empress', 'overking'].includes(first)) return 'person'
  if (['order', 'guild', 'brotherhood', 'circle', 'church', 'cult', 'company', 'league', 'house', 'council', 'knights', 'society', 'band', 'clan', 'tribe', 'host', 'army', 'legion', 'fellowship', 'hand', 'eye'].includes(first) || ['order', 'guild', 'brotherhood', 'circle', 'company', 'league', 'council', 'knights', 'society', 'clan', 'tribe', 'army', 'legion', 'fellowship', 'wardens', 'guard', 'watch'].includes(last)) return 'faction'
  if (['river', 'mount', 'mountains', 'lake', 'sea', 'bay', 'isle', 'isles', 'forest', 'wood', 'woods', 'hills', 'marsh', 'keep', 'castle', 'tower', 'abbey', 'temple', 'city', 'town', 'port', 'fort', 'vale', 'valley', 'plains', 'desert', 'march', 'barony', 'duchy', 'county', 'kingdom', 'empire', 'reach', 'ruins', 'caves', 'pass'].includes(first) || ['river', 'mountains', 'lake', 'sea', 'bay', 'isle', 'isles', 'forest', 'wood', 'woods', 'hills', 'marsh', 'keep', 'castle', 'tower', 'abbey', 'temple', 'city', 'town', 'port', 'fort', 'vale', 'valley', 'plains', 'desert', 'march', 'barony', 'duchy', 'county', 'kingdom', 'empire', 'reach', 'ruins', 'caves', 'pass', 'peaks', 'highlands', 'lowlands'].includes(last)) return 'place'
  if (/\b(worship(?:ped|s)?|god(?:dess)?|deity|faithful|clergy|priest(?:ess)?s? of|temple of|shrine (?:of|to))\b/i.test(context)) return 'deity'
  return null
}
