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
> Not yet exercised live: the AI transformation (no Anthropic key was available).

## Roles, plans and limits (from the official guide)

- API keys require the **project owner to be on a paid plan** (a trial does not count) → `402 PAID_PLAN_REQUIRED`.
- Keys are created in **Project Settings → Developers → API Keys** (you need ADMIN to create one). The secret is shown once.
- A key is **MEMBER** (default) or **ADMIN**, and acts with the *lower* of that role and its creator's current role.
- Rate limits per key: 120 writes/min, 3,000 writes/h, 300 requests/min, 6,000/h, 60,000/day; 12,000/h per project.
  The SDK retries 429/502/503/504 (honouring `Retry-After` up to 8 s). This app's scan reads one page of 100 every 350 ms.
- Request bodies over 1 MB are refused (`413`); this app refuses drafts over ~900 KB.

## Matrix

Legend — **Verified**: *live* = against the real LegendKeeper test project; *spec* = validated against the OpenAPI schema; *contract* = real SDK against a local server following the docs; *rehearsal* = full UI run against the rehearsal server.

| Capability | API (v3) | SDK 4.0.0 | Role / plan | Used in Phase 1 | Verified | Limitations / notes |
| --- | --- | --- | --- | --- | --- | --- |
| Project identity & connection | `GET /projects`, `GET /projects/{id}` | `lk.project()`, `projects.list/get` | Paid plan | Yes — connection test (`project()` + fresh `projects.get`) | **live**, contract | `lk.project()` is cached per client, so the app pings with `projects.get` to prove the connection is live. |
| Resource listing & pagination | `GET /resources?limit&cursor&parentId` | `resources.list` → `Page` | Member (sees only reachable, non-hidden) | Yes — background scan, live browsing | **live** (235 pages, 3 pages of 100), contract | Max 100 per page; **no server-side filter by name or tag** → the app keeps a local metadata index. Cursor is opaque. |
| Resource retrieval & metadata | `GET /resources/{id}` | `resources.get` | Member | Yes — page detail, parent & link checks, read-back | **live**, contract | Returns documents and sidebar properties. |
| Document listing & reading | `GET …/docs`, `GET …/docs/{id}` | `documents.list/get` | Member (hidden docs: Admin) | Partly — documents come from `resources.get` | contract | |
| Page blocks: reading | `GET …/docs/{id}/blocks` | `documents.getBlocks`; readers `plainText`, `walk`, `findBlock` | Member | Yes — page browser, read-back | **live**, contract | Returns `version` and `text`. Content the API cannot express reads as `unsupported` (read-only). |
| Page blocks: writing | `PUT …/blocks` (replace), `POST/PUT/PATCH/DELETE …/blocks/{id}` | `documents.replaceBlocks`, `blocks.*`, builders in `@legendkeeper/sdk/blocks` | Member with edit rights | **No** (Phase 1 never edits existing pages) | **live** (probe only: `replaceBlocks` with `ifMatch`, stale version → 412, `blocks.insert`) | `ifMatch` versioned writes supported; replacing a page drops `unsupported` blocks unless echoed by id. Use single-block ops for later "migration" phases. |
| Resource creation | `POST /resources` (with `documents[].blocks`) | `resources.create` | Member under an editable parent; **Admin at the top level** | **Yes — the one write** | **live** (planned 24-char id accepted, idempotent replay returns the same page, reused id → 409), spec, contract | Accepts client-chosen `id` (cuid2, 8 or 24 chars) and `Idempotency-Key`. Duplicate id → `409 DUPLICATE_ID` (also for ids of deleted resources in the trash). |
| Resource updating | `PATCH /resources/{id}` | `resources.update` | Member with edit rights | No | **live** (probe) | `tags`/`aliases` replace the whole list. No `ifMatch` on resource fields — a later phase must re-read before updating. |
| Bulk creation | `POST /resources/batch` | `resources.createMany` (≤100) | as create | No (out of scope) | — | Counts as one write; 600 items/min budget. |
| Delete / restore | `DELETE /resources/{id}`, `…/restore` | `resources.delete/restore` | Edit rights; restore needs Admin | **No — never used by the app** | **live** (probe: delete, restore, `HAS_CHILDREN`, cascade cleanup) | Only the opt-in integration test cleanup deletes, and only its own test page. |
| Tags: listing | `GET /tags` | `tags.list` | **Admin** | Yes — tag audit, suggestions | **live** (24 tags), contract | Member keys get `403`; the app falls back to tags counted from the local index and says so. |
| Tags: updating | via `resources.update` / `resources.create` | yes | edit rights | Only on create | **live**, spec | No dedicated tag endpoint. Tags match **exactly, including case**. |
| Hierarchy / parents | `parentId` on list/create; `POST …/move` | `resources.move` | edit rights | Parent on create; tree in browser | **live** | Siblings ordered by `rank` (compare as plain strings). |
| Search | `GET /search?q&limit` | `search.search` | Member (reachable only) | Yes — live search, manual link lookup, duplicate check | **live**, contract | One page, ≤100 results; matches names, aliases and content. **A resource appears once per matching document** — the app de-duplicates. |
| References / backlinks | mention runs in blocks; `links`/collection blocks; collection filter `scope: 'edges'` | `mention()`, `links()`, `collection()` | — | Mentions + `links` property on create | **live** (mentions read back with the target's current `name`) | **No endpoint lists backlinks directly**; a relationship graph would need reading pages' blocks. |
| Sidebar properties | `…/properties[/{id}][/rows]` | `properties.*` | edit rights for writes | Read only (page detail) | **live** (probe: create + list) | Row writes take `ifMatch`. Style guide prefers an **infobox** over sidebar properties for single-page wikis. |
| Infobox / property blocks | infobox block + `…/blocks/{id}/properties` | `infobox()`, `property()`, `keyValue()`, `blocks.*Property*` | edit rights | Yes — facts infobox on created pages | **live**, spec | |
| Templates: discovery / application | **None** | **None** | — | Local templates only | — | **The v3 API has no template endpoints.** The only mention: collections never list templates. The app uses locally configured templates (section list + infobox fields), clearly labelled *example* or *local*. |
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
  Legendary Actions. Phase 1 writes one "Statistics" key-value block plus headed sections.
  Matching your house style exactly (grouped infobox rows, text fields) is a good Phase 2
  template feature.
- The project has a large rules glossary (135 pages tagged *Glossary*). The automatic name
  scan would link terms such as "Armor Class" everywhere; recipes can now exclude tags from
  the scan (`linkPolicy.scanExcludeTags`, e.g. `["Glossary"]`).
- Related names are separate pages (Iggwilv, Tasha, Natasha, Natalie, Nathalia), and there is
  a near-duplicate tag (*Entitiyy* next to *Entity*) — good material for Phase 2 tag clean-up.
- Server-generated resource ids are 8 characters; client-chosen 24-character ids are accepted.
