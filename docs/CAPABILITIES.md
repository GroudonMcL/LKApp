# LegendKeeper integration: capability matrix

Investigated against **`@legendkeeper/sdk` 4.0.0** (published 2026-10-10), its bundled
`GUIDE.md`, `STYLE.md`, `README.md`, `CHANGELOG.md` and **OpenAPI 3.1 spec (API v3)**, plus the
SDK's TypeScript declarations. These ship inside the npm package and are the same official
documentation as <https://www.legendkeeper.com/developers/>.

> **Important caveat about verification.** The environment this app was built in could not
> reach `legendkeeper.com` (its network policy blocked it). So **no call has been verified
> against the live LegendKeeper service yet.** What *has* been verified:
>
> - **Spec**: request bodies the app generates are validated against the official OpenAPI
>   schema (`tests/unit/render.test.ts`, `tests/contract/…`).
> - **Contract**: the real SDK client, through our connector, talks HTTP to a local server
>   that follows the documented paths, envelopes and error bodies
>   (`tests/contract/sdk-connector.test.ts`).
> - **Rehearsal**: the full UI workflow was driven in a browser against the rehearsal server
>   (`npm run mock:lk`).
>
> Live verification happens on your machine: the in-app **write check** and the optional
> `npm run test:integration`. Until the write check passes for your project, page creation
> stays disabled.

## Roles, plans and limits (from the official guide)

- API keys require the **project owner to be on a paid plan** (a trial does not count) → `402 PAID_PLAN_REQUIRED`.
- Keys are created in **Project Settings → Developers → API Keys** (you need ADMIN to create one). The secret is shown once.
- A key is **MEMBER** (default) or **ADMIN**, and acts with the *lower* of that role and its creator's current role.
- Rate limits per key: 120 writes/min, 3,000 writes/h, 300 requests/min, 6,000/h, 60,000/day; 12,000/h per project.
  The SDK retries 429/502/503/504 (honouring `Retry-After` up to 8 s). This app's scan reads one page of 100 every 350 ms.
- Request bodies over 1 MB are refused (`413`); this app refuses drafts over ~900 KB.

## Matrix

Legend — **Verified**: *spec* = validated against the OpenAPI schema; *contract* = real SDK against a local server following the docs; *rehearsal* = full UI run against the rehearsal server; *live* = against real LegendKeeper (not yet possible from the build environment).

| Capability | API (v3) | SDK 4.0.0 | Role / plan | Used in Phase 1 | Verified | Limitations / notes |
| --- | --- | --- | --- | --- | --- | --- |
| Project identity & connection | `GET /projects`, `GET /projects/{id}` | `lk.project()`, `projects.list/get` | Paid plan | Yes — connection test (`project()` + fresh `projects.get`) | contract, rehearsal | `lk.project()` is cached per client, so the app pings with `projects.get` to prove the connection is live. |
| Resource listing & pagination | `GET /resources?limit&cursor&parentId` | `resources.list` → `Page` | Member (sees only reachable, non-hidden) | Yes — background scan, live browsing | contract, rehearsal | Max 100 per page; **no server-side filter by name or tag** → the app keeps a local metadata index. Cursor is opaque. |
| Resource retrieval & metadata | `GET /resources/{id}` | `resources.get` | Member | Yes — page detail, parent & link checks, read-back | contract, rehearsal | Returns documents and sidebar properties. |
| Document listing & reading | `GET …/docs`, `GET …/docs/{id}` | `documents.list/get` | Member (hidden docs: Admin) | Partly — documents come from `resources.get` | contract | |
| Page blocks: reading | `GET …/docs/{id}/blocks` | `documents.getBlocks`; readers `plainText`, `walk`, `findBlock` | Member | Yes — page browser, read-back | contract, rehearsal | Returns `version` and `text`. Content the API cannot express reads as `unsupported` (read-only). |
| Page blocks: writing | `PUT …/blocks` (replace), `POST/PUT/PATCH/DELETE …/blocks/{id}` | `documents.replaceBlocks`, `blocks.*`, builders in `@legendkeeper/sdk/blocks` | Member with edit rights | **No** (Phase 1 never edits existing pages) | — | `ifMatch` versioned writes supported; replacing a page drops `unsupported` blocks unless echoed by id. Use single-block ops for later "migration" phases. |
| Resource creation | `POST /resources` (with `documents[].blocks`) | `resources.create` | Member under an editable parent; **Admin at the top level** | **Yes — the one write** | spec, contract, rehearsal | Accepts client-chosen `id` (cuid2, 8 or 24 chars) and `Idempotency-Key`. Duplicate id → `409 DUPLICATE_ID` (also for ids of deleted resources in the trash). |
| Resource updating | `PATCH /resources/{id}` | `resources.update` | Member with edit rights | No | — | `tags`/`aliases` replace the whole list. No `ifMatch` on resource fields — a later phase must re-read before updating. |
| Bulk creation | `POST /resources/batch` | `resources.createMany` (≤100) | as create | No (out of scope) | — | Counts as one write; 600 items/min budget. |
| Delete / restore | `DELETE /resources/{id}`, `…/restore` | `resources.delete/restore` | Edit rights; restore needs Admin | **No — never used by the app** | — | Only the opt-in integration test cleanup deletes, and only its own test page. |
| Tags: listing | `GET /tags` | `tags.list` | **Admin** | Yes — tag audit, suggestions | contract, rehearsal | Member keys get `403`; the app falls back to tags counted from the local index and says so. |
| Tags: updating | via `resources.update` / `resources.create` | yes | edit rights | Only on create | spec, rehearsal | No dedicated tag endpoint. Tags match **exactly, including case**. |
| Hierarchy / parents | `parentId` on list/create; `POST …/move` | `resources.move` | edit rights | Parent on create; tree in browser | contract | Siblings ordered by `rank` (compare as plain strings). |
| Search | `GET /search?q&limit` | `search.search` | Member (reachable only) | Yes — live search, manual link lookup, duplicate check | contract, rehearsal | One page, ≤100 results; matches names, aliases and content. |
| References / backlinks | mention runs in blocks; `links`/collection blocks; collection filter `scope: 'edges'` | `mention()`, `links()`, `collection()` | — | Mentions + `links` property on create | spec, rehearsal | **No endpoint lists backlinks directly**; a relationship graph would need reading pages' blocks. |
| Sidebar properties | `…/properties[/{id}][/rows]` | `properties.*` | edit rights for writes | Read only (page detail) | contract | Row writes take `ifMatch`. Style guide prefers an **infobox** over sidebar properties for single-page wikis. |
| Infobox / property blocks | infobox block + `…/blocks/{id}/properties` | `infobox()`, `property()`, `keyValue()`, `blocks.*Property*` | edit rights | Yes — facts infobox on created pages | spec, rehearsal | |
| Templates: discovery / application | **None** | **None** | — | Local templates only | — | **The v3 API has no template endpoints.** The only mention: collections never list templates. The app uses locally configured templates (section list + infobox fields), clearly labelled *example* or *local*. |
| Timelines & events | `…/lanes`, `…/events` | `timelines.*` | edit rights | No (out of scope) | — | Events have only a name (no description); dates via `formattedStart` in the timeline's calendar. |
| Calendars | `/calendars` | `calendars.*` | Admin for custom | No | — | Built-ins include `greyhawk`. Calendar writes take `ifMatch`. |
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
