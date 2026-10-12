# Phase 3 — Chronology, knowledge intelligence and natural-language workflows

Implementation report, 12 October 2026. Branch `claude/great-cerf-w2p8qk`.

Test results at the end of the phase: **278 / 278** unit and contract tests (`npm run check`:
typecheck and Vitest), and **8 / 8** live integration tests (read-only, plus the sandbox writes).
Phase 2 ended with 216 tests; all of them still pass.

## 1. Starting point and plan

Inspected first: the README, `docs/CAPABILITIES.md`, `docs/PHASE2_REPORT.md`, the services and
tests (216 passing), and the SDK's documentation for timelines, calendars and search.

Findings that shaped the plan:

- Wiki Health audits already store, per page, the document version, a structure summary and the
  first 20,000 characters of text. That is the verified page data the new analyses can use
  without new reads. It lacked infobox content (LegendKeeper's plain text leaves it out) and
  link texts, so the summary was extended (older entries are refreshed by the next audit).
- The SDK documents a full timelines and calendars API. A live probe in the sandbox showed what
  it can and cannot represent (section 3), so native timeline writes could be supported safely
  instead of being left out.
- The review queue is computed from where items live; a single new table of findings and
  candidates with decisions fits it without a second queue.

Plan, as implemented: a calendar and date model in pure code; a local chronology built from
existing data; event discovery producing persisted candidates; cross-page analysis producing
persisted findings; a Task Assistant mapping plans onto an allowlist of these services; a
relationship browser, combined search and exports; tests and documentation. No new dependencies
or infrastructure: SQLite (one migration, v5), the existing provider abstraction, the existing
import and write flows.

## 2. Milestone reports

### M1 — Chronology data model, date handling and chronological list
- `src/core/chronology/calendar.ts`: calendar settings (eras with optional conversions, months
  and festivals, year 0, linked LegendKeeper calendars); Greyhawk CY/BCY and Gregorian by default;
  automatic linking of LegendKeeper calendars with the same months and eras.
- `src/core/chronology/dates.ts`: reads exact dates, eras either side, months and days,
  approximations, ranges, decades, centuries, early/mid/late, relative and unknown dates, always
  keeping the original wording and notes; finds dates in running text (bare numbers are not
  taken as years); compares dates allowing for approximation; builds LegendKeeper-safe date strings.
- `src/core/chronology/entries.ts`: entries from event pages, dated fields, timelines and
  accepted events; grouping of the same event; date conflicts, deaths before births, events after
  a death.
- Chronology page with filters, events per period, uncertain/undated list, conflicts, timelines,
  calendar settings; CSV/JSON export.
- Live: 248 pages audited, 2 timelines and 17 events read, the project's custom Greyhawk
  calendar linked automatically; the three event pages from the Phase 2 test run placed in order.

### M2 — Event discovery and reviewable event drafts
- Rule-based reader (named events; dates with event words), optional AI reading through a fixed
  prompt with quote and date checks; merging by name and by cited passage; disagreeing dates
  kept apart; single sources flagged; possible existing records shown.
- Accept, edit, reject, defer; accepted events join the chronology; drafts via your event recipe
  through the normal import, review and approval flow.
- Native timeline writes: final preview, approval token, event id chosen before the write,
  refusal of approximate/relative/undated events, read-back comparison, audit records,
  read-only resolution of a lost reply.
- Live: 184 pages searched; one AI page (10 proposals, all verified); “Disappearance of Iuz”
  accepted, drafted with the *Story events* recipe, created under the sandbox, and added to the
  sandbox probe timeline (read back exactly as approved). Fixed on the way: a subject heuristic
  that named the wrong page, “the 400s” read as a decade, and rule-only runs that would have
  resolved AI candidates.

### M3 — Cross-page entity, relationship and contradiction analysis
- Relationships with their support (page tree, link, field, wording, accepted AI); unlinked
  mentions; missing pages; contradictions (same-named pages' fields, titles used elsewhere);
  naming variants and near-duplicate names; optional AI comparison of 2–5 pages with quote checks.
- Live: 248 pages in about 10 seconds. The first run produced 438 findings, mostly noise from
  rules glossary pages; after tuning (rules and folder pages excluded, sentence-opening and common
  words filtered, ALL-CAPS and possessive “variants” ignored) it produces 13 unlinked mentions,
  50 missing pages (e.g. Yatil Mountains, Vesve Forest, Nyr Dyv, Dorakaa, Mordenkainen) and 7
  naming findings (e.g. “W'ee Jas”, “WeeJas”, “Obadhai”). No relationships were inferred from
  wording in this project; its links and fields carry the explicit ones.

### M4 — Natural-language Task Assistant
- Plan schema with ten operations; rule-based interpreter for common requests; optional AI
  planning (request, operations and tag names only; placeholder values removed; unknown
  operations rejected); name resolution with clarifying questions; AI confirmation gate;
  hand-off for any change.
- Live: the seven example requests planned and run without AI (e.g. 6 creature pages not
  matching their template; references to Wee Jas; relationships of Saltreach); one AI plan through
  a free OpenRouter model (after removing placeholder values the model filled in).

### M5 — Relationship browser, search improvements and reporting
- Relationship browser with a one-page graph, filters and evidence table; combined search with
  saved searches; relationship export; links from page details.
- Semantic search assessed and not added (see README, *Relationship browser and search*).

### M6 — Testing, regression fixes and documentation
- New tests: `chronology-dates`, `chronology`, `event-discovery`, `knowledge-analysis`,
  `task-assistant`, `search-relationships` (62 tests), on a fictional Greyhawk fixture with
  built-in disagreements.
- Live integration tests extended with timeline reading and a sandbox timeline-event write.
- README, CAPABILITIES and this report updated.

## 3. LegendKeeper timeline capabilities (summary)

| Capability | Documented | SDK | Verified live | Used |
| --- | --- | --- | --- | --- |
| Read timelines, lanes, events | yes | yes | yes | yes |
| Read calendars | yes | yes | yes | yes |
| Create timelines and lanes | yes | yes | yes (probe) | no — you create them |
| Create events | yes | yes | yes | yes, one per approval |
| Update or delete events | yes | yes | update: yes (probe) | no — no version check |
| Uncertain dates | precision only | `detail` | yes | approximations, relative and unknown dates stay local |
| Link events to pages | yes | `uri` | yes | yes, pages from the last scan only |

Full detail, including the fuzzy-parsing results, in `docs/CAPABILITIES.md`, *Phase 3*.

Pages kept in the sandbox from Phase 3 testing: “LK Companion timeline probe” (a timeline with
probe events and the approved “Disappearance of Iuz” event), the page “Disappearance of Iuz”,
and the integration test's timeline page. Nothing was deleted.

## 4. Definition of done

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Chronology shows events from verified source data | Done: event pages, fields and timelines from audited content and live reads (live). |
| 2 | Event candidates discovered from selected pages and reviewed as drafts | Done (live, with and without AI). |
| 3 | Dates and uncertainty preserved | Done: original wording always kept; uncertainty never turned into an exact date; tested. |
| 4 | Relationships, missing entities, contradictions | Done (live; contradictions found in tests, none in the live project without AI). |
| 5 | Traceable evidence | Done: every finding cites page id, field or passage; exports include them. |
| 6 | Knowledge Analysis without modifying LegendKeeper | Done: no API calls at all; tested. |
| 7 | Task Assistant converts supported requests into validated plans | Done (rule-based and AI, live). |
| 8 | Writes follow the approval and recovery process | Done: drafts use the existing write flow; timeline events have their own preview, approval, pre-chosen id, read-back and audit. |
| 9 | Review queue integration | Done: eight new entry types with evidence; decisions persist and re-open on changed wording. |
| 10 | Tests pass, existing functionality intact | 278/278 unit, 8/8 live integration. |
| 11 | Documentation reflects tested behaviour | README, CAPABILITIES, this report. |

## 5. Limitations and suggestions

- Analyses see what audits have read (first 20,000 characters per page). Run an audit after
  editing pages in LegendKeeper.
- Rule-based reading covers common phrasing; the AI options help with unusual prose but cost
  free-tier requests (50 a day on OpenRouter without credits).
- Relationship and link suggestions are recorded in the app; adding links to existing pages is
  done with a template migration or in LegendKeeper.
- The Iggwilv timeline uses LegendKeeper's Gregorian calendar for Greyhawk years; link
  `gregorian` to the Greyhawk calendar setting if that is intended, or move the timeline to your
  Greyhawk calendar in LegendKeeper.
