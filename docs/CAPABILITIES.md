# LegendKeeper integration: capability matrix

Investigated against **`@legendkeeper/sdk` 4.0.0** (published 2026-10-10), updated for
**4.1.0** (published 2026-10-12 with LegendKeeper's *Foundations Vol. 3*; its only change is
templates, see *Templates (SDK 4.1.0)* below), its bundled
`GUIDE.md`, `STYLE.md`, `README.md`, `CHANGELOG.md` and **OpenAPI 3.1 spec (API v3)**, plus the
SDK's TypeScript declarations. These ship inside the npm package and are the same official
documentation as <https://www.legendkeeper.com/developers/>.

> **Verification status (11 Oct 2026).** Verified **live** against a dedicated LegendKeeper
> test project ("AI Test Project", ADMIN key, 234 pages) with SDK 4.0.0:
>
> - `scripts/probe-legendkeeper.ts` — 27/27 checks passed (see the table below).
> - `npm run test:integration` with the write test and cleanup — 5/5 passed.
> - The full app workflow in a browser: connection test, scan (235 pages), page browser,
>   tag audit, write check, import → structural draft → links → final preview → create →
>   read-back. The created page had the expected parent, tag, infobox, mentions and sources.
>
> Additionally: request bodies are validated against the official OpenAPI schema
> (*spec*) and the real SDK is tested against a local documented-API server (*contract*).
> AI: the OpenRouter free-model provider was exercised live on 12 Oct 2026 (see *AI provider:
> OpenRouter* below); the Claude provider has not been (no Anthropic key was available).
>
> **Templates, SDK 4.1.0 (12 Oct 2026)**: templates listed live (7, one nested); a page created
> through the app as a copy of the *Statblock* template under the sandbox, filled, and read back
> (sidebar Tags box, icon, infobox Tags/Aliases rows kept; placed alphabetically); duplicate copy
> refused; placement before a sibling confirmed. A page saved as a template through the app
> (with permission; outside the sandbox by necessity) and read back.
>
> **Phase 3 (12 Oct 2026)**: timelines and calendars read live; one timeline event added in
> the sandbox and read back; integration tests 8/8. See *Phase 3* below.
>
> **Phase 2 (11 Oct 2026)**, same test project, all on throwaway pages under the sandbox page,
> deleted afterwards:
>
> - Batch import of 4 files (Markdown, Word, HTML, PDF) → 8 records; an exact duplicate was
>   detected and skipped; 6 pages created from the copied *Statblock* layout and read back.
> - Wiki Health: a full read-only audit of 242 pages (content read with version fingerprints).
> - Tagging: tags replaced through the app (including a new tag after explicit approval), an
>   uncertain outcome reconciled by reading, existing tags kept, read back.
> - Template migration: an older-style statblock page migrated in place into the *Statblock*
>   layout (same id, name, parent and tags; a secret block kept by id), then restored; the
>   restored page read back **identical** to the original, block ids included.
> - `npm run test:integration` with writes and cleanup — **6/6** passed (adds tag replacement,
>   version-checked content replacement, stale-version refusal and exact restore).

## Roles, plans and limits (from the official guide)

- API keys require the **project owner to be on a paid plan** (a trial does not count) → `402 PAID_PLAN_REQUIRED`.
- Keys are created in **Project Settings → Developers → API Keys** (you need ADMIN to create one). The secret is shown once.
- A key is **MEMBER** (default) or **ADMIN**, and acts with the *lower* of that role and its creator's current role.
- Rate limits per key: 120 writes/min, 3,000 writes/h, 300 requests/min, 6,000/h, 60,000/day; 12,000/h per project.
  The SDK retries 429/502/503/504 (honouring `Retry-After` up to 8 s). This app's scan reads one page of 100 every 350 ms.
- Request bodies over 1 MB are refused (`413`); this app refuses drafts over ~900 KB.

## Matrix

Legend — **Verified**: *live* = against the real LegendKeeper test project; *spec* = validated against the OpenAPI schema; *contract* = real SDK against a local server following the docs; *rehearsal* = full UI run against the rehearsal server.

| Capability | API (v3) | SDK 4.1.0 | Role / plan | Used by the app | Verified | Limitations / notes |
| --- | --- | --- | --- | --- | --- | --- |
| Project identity & connection | `GET /projects`, `GET /projects/{id}` | `lk.project()`, `projects.list/get` | Paid plan | Yes — connection test (`project()` + fresh `projects.get`) | **live**, contract | `lk.project()` is cached per client, so the app pings with `projects.get` to prove the connection is live. |
| Resource listing & pagination | `GET /resources?limit&cursor&parentId` | `resources.list` → `Page` | Member (sees only reachable, non-hidden) | Yes — background scan, live browsing | **live** (235 pages, 3 pages of 100), contract | Max 100 per page; **no server-side filter by name or tag** → the app keeps a local metadata index. Cursor is opaque. |
| Resource retrieval & metadata | `GET /resources/{id}` | `resources.get` | Member | Yes — page detail, parent & link checks, read-back | **live**, contract | Returns documents and sidebar properties. |
| Document listing & reading | `GET …/docs`, `GET …/docs/{id}` | `documents.list/get` | Member (hidden docs: Admin) | Partly — documents come from `resources.get` | contract | |
| Page blocks: reading | `GET …/docs/{id}/blocks` | `documents.getBlocks`; readers `plainText`, `walk`, `findBlock` | Member | Yes — page browser, read-back | **live**, contract | Returns `version` and `text`. Content the API cannot express reads as `unsupported` (read-only). |
| Page blocks: writing | `PUT …/blocks` (replace), `POST/PUT/PATCH/DELETE …/blocks/{id}` | `documents.replaceBlocks`, `blocks.*`, builders in `@legendkeeper/sdk/blocks` | Member with edit rights | **Yes — template migration and restore**, always `replaceBlocks` with `ifMatch` | **live** (probe; Phase 2 app run; integration test: stale version → 412 `VersionMismatchError`, blocks written back exactly as read come back identical, a block moved into a new container keeps its id) | Replacing a page drops `unsupported` blocks unless echoed by id; the migration echoes them. Single-block operations are not used. |
| Resource creation | `POST /resources` (with `documents[].blocks`) | `resources.create` | Member under an editable parent; **Admin at the top level** | **Yes — the one write** | **live** (planned 24-char id accepted, idempotent replay returns the same page, reused id → 409), spec, contract | Accepts client-chosen `id` (cuid2, 8 or 24 chars) and `Idempotency-Key`. Duplicate id → `409 DUPLICATE_ID` (also for ids of deleted resources in the trash). |
| Resource updating | `PATCH /resources/{id}` | `resources.update` | Member with edit rights | **Yes — tags only** (tagging assistant; migration only if the recipe adds tags, and restore) | **live** (probe; Phase 2 app run; integration test) | `tags`/`aliases` replace the whole list and there is **no `ifMatch`**: the app reads right before, merges, writes, and reads back. A tag update changes the resource's `updatedAt`. |
| Bulk creation | `POST /resources/batch` | `resources.createMany` (≤100) | as create | **No** — batch imports create one page per approved record | — | Counts as one write; not used so that every record keeps its own approval, duplicate protection, outcome and retry. |
| Delete / restore | `DELETE /resources/{id}`, `…/restore` | `resources.delete/restore` | Edit rights; restore needs Admin | **No — never used by the app** | **live** (probe: delete, restore, `HAS_CHILDREN`, cascade cleanup) | Only the opt-in integration test cleanup deletes, and only its own test page. |
| Tags: listing | `GET /tags` | `tags.list` | **Admin** | Yes — tag audit, suggestions | **live** (24 tags), contract | Member keys get `403`; the app falls back to tags counted from the local index and says so. |
| Tags: updating | via `resources.update` / `resources.create` | yes | edit rights | On create, and the tagging assistant | **live**, spec | No dedicated tag endpoint. Tags match **exactly, including case**. A tag exists only while a page carries it, so “approving a new tag” means approving that text on a page. |
| Hierarchy / parents | `parentId` on list/create; `POST …/move` | `resources.move` | edit rights | Parent on create; tree in browser; **position on create** (`after`/`before`: recipe option “alphabetical”) | **live** | Siblings ordered by `rank` (compare as plain strings). |
| Search | `GET /search?q&limit` | `search.search` | Member (reachable only) | Yes — live search, manual link lookup, duplicate check | **live**, contract | One page, ≤100 results; matches names, aliases and content. **A resource appears once per matching document** — the app de-duplicates. |
| References / backlinks | mention runs in blocks; `links`/collection blocks; collection filter `scope: 'edges'` | `mention()`, `links()`, `collection()` | — | Mentions + `links` property on create; outgoing links read for the audit (broken links) and kept by migrations; **Phase 3:** relationship browser, references report, unlinked mentions | **live** (mentions read back with the target's current `name`; the audit found links to pages missing from the project) | **No endpoint lists backlinks directly**; incoming links are derived by reading every page's outgoing links (only as complete as the audits), and the app says so wherever it shows them. |
| Sidebar properties | `…/properties[/{id}][/rows]` | `properties.*` | edit rights for writes | Read only (page detail) | **live** (probe: create + list) | Row writes take `ifMatch`. Style guide prefers an **infobox** over sidebar properties for single-page wikis. |
| Infobox / property blocks | infobox block + `…/blocks/{id}/properties` | `infobox()`, `property()`, `keyValue()`, `blocks.*Property*` | edit rights | Yes — facts infobox on created pages | **live**, spec | |
| Templates: listing | `GET /templates` | `templates.list` (paged, every depth) | Member | **Yes** — Copy from LegendKeeper; preview checks | **live** (7 templates, one nested), contract | Documented since 4.1.0. A template is a resource under the virtual root `templates`; a resource under a template is a template too. `resources.list` without `parentId` returns templates with the other resources, so the index marks them (at any depth) and leaves them out of audits, tagging, links and analysis. Search and collection blocks do not return templates. |
| Templates: create a page from one | `POST /resources/from-template` | `resources.createFromTemplate` | Member under an editable parent; Admin at the top level | **Yes** — every page whose local template was copied from a LegendKeeper template (option on by default) | **live** (app import → *Statblock* copy in the sandbox; duplicate id refused), spec, contract | Copies fields, sidebar properties and tabs with content under new ids; takes `id`, `name`, `parentId`, `after`/`before`, `includeChildren` and an Idempotency-Key, but **no tags, aliases or content**, so the app then replaces the first page tab (`ifMatch`) and updates tags and aliases: up to 3 writes, not atomic (unfinished pages are finished with “Finish the page”). Built-in `unsupported` items (infobox Tags/Aliases rows) survive the replace when sent back by id (**live**). `includeChildren` is not used. |
| Templates: save a page as one | `POST /resources/{id}/save-as-template` | `resources.saveAsTemplate` | **Admin** | **Yes** — “Save a page as a LegendKeeper template”, with preview and approval | **live** (once, with permission: a sandbox page saved as “LK Companion test template (safe to delete)”, read back), spec, contract | Copies the page (and optionally up to 99 descendants) into a new top-level template; the page does not change. Client-chosen `id` + Idempotency-Key; read back (parent must be `templates`). |
| Templates: other | `parentId: 'templates'` on create/createMany/move | `resources.create/move` | Admin | **No** | — | Making or moving templates directly is not offered. |
| Timelines: reading | `GET …/docs/{id}`, `…/lanes`, `…/events[/{id}]` | `documents.get`, `timelines.listLanes/listEvents/getEvent` | Member | **Yes (Phase 3)** — Chronology reads every timeline the scan found | **live** (2 timelines, 17 events; integration test) | Events of chained timelines are listed too; the app keeps each with the timeline that holds it. |
| Timelines: adding an event | `POST …/events` | `timelines.createEvent` | edit rights | **Yes (Phase 3)** — one event at a time, with preview and approval | **live** (sandbox probe, app write, integration test) | Client-chosen `id`; a second create with it → `409 DUPLICATE_ID`. `uri` must point at a readable resource (else `400`). No `ifMatch`. See *Phase 3* below. |
| Timelines: other writes | lanes, `PATCH/DELETE …/events/{id}`, `documents.update` (`calendarId`, `sources`) | `timelines.*`, `documents.update` | edit rights | **No** — timelines and lanes are created, events changed or removed, in LegendKeeper | **live** (probe: create lane, update event) | Deliberately not used: an event update has no version check. |
| Calendars | `/calendars` | `calendars.*` | Admin for custom | **Read (Phase 3)** — to read event dates and check eras before a write | **live** (one custom “Greyhawk (Use This)” + 6 built-in incl. `greyhawk`) | Built-ins cannot change. Calendar writes take `ifMatch`; the app does not write calendars. |
| Images & assets | `/assets`, uploads | `assets.*`, `assets.uploadImage` | Member upload; Admin manage | No | — | Image fields accept only this project's asset URLs. |
| Maps & features | `…/features` | `features.*`, `pixelToPos` | edit rights | No | — | |
| Boards | `…/board[/shapes]` | `boards.*` | edit rights | No | — | tldraw 3.9 records; the developer notes shape creation support is still maturing. |
| Members & invites | `/members`, `/invites` | `members.*`, `invites.*` | Admin | No | — | |
| Escape hatch | any path | `lk.request()` | — | No | — | No generated idempotency key — avoid for POSTs unless a key is passed. |

## Content model notes (style guide)

- Facts at a glance → an **infobox** at the top (floats right at 40 %); long text in the body.
- Links → `mention` runs in text, `links` properties in infoboxes, `uri` on pins/events.
- Collections: hide the title unless it names the collection.
- Tags: reuse existing spellings exactly; facets such as Type / Place / Status; Title Case, singular.
- Every `id`, version and idempotency rule above is applied by `src/server/lk/render.ts` and `src/server/services/write.ts`.

## Observations from the live test project

- Existing statblock pages (e.g. *Aboleth*) use an **infobox with several key-value groups**
  (Overview, Ability Scores, Details) followed by `textField` blocks for Traits, Actions and
  Legendary Actions. The project's *Statblock* template has the same shape. With a layout
  copied from that template the app writes exactly this structure (verified live: a page
  created in the sandbox from the 2024 goblin fixture).
- Writing an image property with an empty `url` fails with `VALIDATION_ERROR … unsupported
  href`, so empty image slots in a template are left out. `rank` is rejected in create
  bodies, so ids and ranks are stripped from copied layouts. Documents cannot be created
  full-width through `resources.create`.
- The project has a large rules glossary (135 pages tagged *Glossary*). The automatic name
  scan would link terms such as "Armor Class" everywhere; recipes can now exclude tags from
  the scan (`linkPolicy.scanExcludeTags`, e.g. `["Glossary"]`).
- Related names are separate pages (Iggwilv, Tasha, Natasha, Natalie, Nathalia), and there is
  a near-duplicate tag (*Entitiyy* next to *Entity*) — good material for Phase 2 tag clean-up.
- Server-generated resource ids are 8 characters; client-chosen 24-character ids are accepted.

## Phase 2 observations (live, Oct 2026)

- **Content edits do not change `updatedAt`** on the resource or the document; only the
  document `version` changes. The audit and migrations therefore use the document version as
  the content fingerprint. Tag updates do change the resource's `updatedAt`.
- `replaceBlocks` with a stale `ifMatch` is refused with 412 and writes nothing. Blocks written
  back exactly as `getBlocks` returned them (ids, row ranks, mention names included) are
  accepted, and the page reads back byte-for-byte identical — this is what makes migration
  restore possible. A block sent with its id inside a new parent (e.g. an infobox row moved into
  a new infobox) keeps its id.
- `unsupported` blocks cannot be created (`UNSUPPORTED_KIND`); they survive a replacement only
  when echoed by id while the document still holds them.
- A full audit of the test project found many links pointing at pages that do not exist in it
  (pages copied from another project keep their old link targets); these are reported as
  broken links, never “fixed” automatically.
- Batch writes are paced at ~100/min and audit reads at ~4/s, below the 120 writes and 300
  requests per minute limits; no rate-limit errors were seen.

## AI provider: OpenRouter (live, 12 Oct 2026)

Checked against OpenRouter's public API and documentation
(<https://openrouter.ai/docs/api/reference/limits>), with the owner's key:

| Operation | Used for | Verified |
| --- | --- | --- |
| `GET /api/v1/models` (public) | The free check: a model is used only if listed with every price 0 | live |
| `GET /api/v1/key` | Settings page: credit limit ($0 on the owner's key), `is_free_tier`, free requests used/left today (50 a day) | live |
| `POST /api/v1/chat/completions` with `provider.max_price` all 0 | Every AI request; a paid model is refused by OpenRouter (404 “No endpoints found that satisfy the max price”) | live |
| `response_format: json_schema` | Structured drafts, tag suggestions, transcription (validated again in code) | live |
| `usage.cost`, `model` in the reply | Reply check: cost must be 0 (or absent with a `:free` model) | live (cost 0, served by a `:free` model) |

- `openrouter/free` routes to an available free model; free model ids end in `:free`.
- Live AI import: prose NPC → Character template draft in about 60 s
  (`nvidia/nemotron-3-super-120b-a12b:free`), page created and read back. Quality notes: an
  inferred value was marked as from the source, and one section was duplicated under two
  headings; both were caught in review.
- Scanned-PDF reading on OpenRouter is a paid plugin, so the app does not send PDFs there.

## Phase 3: timelines, calendars and chronology (live, 12 Oct 2026)

Checked against the SDK's `GUIDE.md` (*timelines and calendars*, *Chaining timelines*,
*Calendars*), its OpenAPI schema (`Event`, `EventCreateParams`, `EventDate`, `Lane`, `Calendar`)
and live in the test project.

| Question | Documented | In SDK 4.0.0/4.1.0 | Verified | Answer |
| --- | --- | --- | --- | --- |
| Read timeline resources | yes | `documents.get` (type `time`, `calendarId`, `sources`) | **live** | Yes. Timelines are documents of type `time` on any resource; the scan's document list finds them. |
| Read timeline events | yes | `timelines.listEvents` (paged), `getEvent`, `listLanes` | **live** | Yes, with `formattedStart/End`, `startDate/endDate` (`year`, `monthName`, `day`, `era.abbr`), `detail` (1 year, 2 month, 3 day, 4 time) and `uri`. |
| Create timelines | yes | `resources.create` with a `time` document; `timelines.createLane` | **live** (probe page “LK Companion timeline probe” in the sandbox, kept) | Possible, **not used by the app**: you create timelines and lanes in LegendKeeper. |
| Create events | yes | `timelines.createEvent` | **live** (probe, app write “Disappearance of Iuz”, integration test) | **Used**: one event per approval, client-chosen id (duplicates refused with `409`), read back and compared. |
| Update existing events | yes | `timelines.updateEvent` (fields sent; `laneId` moves) | **live** (probe rename) | Possible, **not used**: no version check (`ifMatch`), so a change could overwrite an edit made in LegendKeeper. |
| Associate events with calendars | yes | the timeline document's `calendarId`; `calendars.list/create/update` | **live** | A timeline has one calendar; events are minutes on it. Changing the calendar moves no event. Built-ins: `gregorian`, `harptos`, `eberron`, `exandria`, `greyhawk`, `elder-scrolls`. |
| Represent uncertain dates | partly | `detail` (precision only) and `end` (ranges) | **live** | **No approximation, no relative dates, no “unknown”.** `formattedStart` is fuzzy-parsed: “c. 576” became Coldeven 576, “-50” became 50 CY, “the 590s” became 590 CY. The app keeps uncertain events local and sends only plain forms it builds (`576`, `Fireseek 576`, `Fireseek 12th, 576`, `50 BCY` on a calendar with a negative era). |
| Link events to other resources | yes | event `uri` (`lk://resources/<id>`, `lk://documents/<id>`) | **live** | Yes; a `uri` to a resource the key cannot read → `400 VALIDATION_ERROR`. The app links only to pages in the last scan. |

**Local chronology versus native timeline.** The Chronology page is the app's own view built
from verified page data (event pages, dated fields), timelines as last read, and events you
accepted; it is never presented as a LegendKeeper timeline. A LegendKeeper timeline changes only
when you approve adding a specific event. To build a native timeline: create a resource with a
timeline tab (choose your Greyhawk calendar) and at least one lane in LegendKeeper, read the
timelines in the app, then add accepted, exactly dated events to it one at a time.

**AI analysis tasks (Phase 3).** Event extraction, page comparison and task planning use the
existing provider abstraction with fixed prompts and schemas (`src/server/ai/prompts/analysis.ts`).
With OpenRouter all three went through the free-only checks live: one event-extraction request
(10 proposals, all quotes verified), one plan request, served by
`nvidia/nemotron-3-super-120b-a12b:free` at a reported cost of 0.

## Dependencies added in Phase 2

`unpdf` 1.8.1 (PDF text, page by page), `mammoth` 1.13.0 (Word `.docx`, with external file
access switched off), `node-html-parser` 9.0.4 (HTML) — all pinned exactly and run on your
computer only. `npm audit` reports a moderate advisory in `sprintf-js` (via `argparse`), which
mammoth uses only for its command-line tool; the app never runs that tool, so it is not reachable.
