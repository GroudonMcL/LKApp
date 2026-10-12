# LegendKeeper integration: capability matrix

Investigated against **`@legendkeeper/sdk` 4.0.0** (published 2026-10-10), its bundled
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

| Capability | API (v3) | SDK 4.0.0 | Role / plan | Used by the app | Verified | Limitations / notes |
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
| Hierarchy / parents | `parentId` on list/create; `POST …/move` | `resources.move` | edit rights | Parent on create; tree in browser | **live** | Siblings ordered by `rank` (compare as plain strings). |
| Search | `GET /search?q&limit` | `search.search` | Member (reachable only) | Yes — live search, manual link lookup, duplicate check | **live**, contract | One page, ≤100 results; matches names, aliases and content. **A resource appears once per matching document** — the app de-duplicates. |
| References / backlinks | mention runs in blocks; `links`/collection blocks; collection filter `scope: 'edges'` | `mention()`, `links()`, `collection()` | — | Mentions + `links` property on create; outgoing links read for the audit (broken links) and kept by migrations | **live** (mentions read back with the target's current `name`; the audit found links to pages missing from the project) | **No endpoint lists backlinks directly**; outgoing links are read from each page's blocks. |
| Sidebar properties | `…/properties[/{id}][/rows]` | `properties.*` | edit rights for writes | Read only (page detail) | **live** (probe: create + list) | Row writes take `ifMatch`. Style guide prefers an **infobox** over sidebar properties for single-page wikis. |
| Infobox / property blocks | infobox block + `…/blocks/{id}/properties` | `infobox()`, `property()`, `keyValue()`, `blocks.*Property*` | edit rights | Yes — facts infobox on created pages | **live**, spec | |
| Templates: discovery / application | **Undocumented** (read) / **None** (apply) | Read: yes (live, Oct 2026) | — | Copy layout, fill locally | — | No template endpoints. Observed: `resources.list` returns templates with `parentId: "templates"` (e.g. *Statblock*), and `resources.get` / `documents.getBlocks` read them like pages. There is no "create from template"; the app copies the block layout and fills it in. Undocumented, so the app only uses it to *suggest* templates; any page can serve as the example instead. |
| Timelines & events | `…/lanes`, `…/events` | `timelines.*` | edit rights | No (out of scope) | — | Events have only a name (no description); dates via `formattedStart` in the timeline's calendar. |
| Calendars | `/calendars` | `calendars.*` | Admin for custom | No | **live** (list: one custom + 6 built-in incl. `greyhawk`) | Built-ins include `greyhawk`. Calendar writes take `ifMatch`. |
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

## Dependencies added in Phase 2

`unpdf` 1.8.1 (PDF text, page by page), `mammoth` 1.13.0 (Word `.docx`, with external file
access switched off), `node-html-parser` 9.0.4 (HTML) — all pinned exactly and run on your
computer only. `npm audit` reports a moderate advisory in `sprintf-js` (via `argparse`), which
mammoth uses only for its command-line tool; the app never runs that tool, so it is not reachable.
