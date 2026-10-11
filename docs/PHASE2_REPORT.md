# Phase 2 — starting report (inspection of Phase 1)

Written 11 October 2026 before any Phase 2 change, from the code in this repository, the
bundled documentation of `@legendkeeper/sdk` 4.0.0 (`GUIDE.md`, OpenAPI spec) and the test
results. Test run before starting: **149 / 149 passing** (`npm run check`: typecheck + Vitest).

## 1. What currently works

| Area | State |
| --- | --- |
| Connection | Server-side SDK client; automatic read-only connection test; project identity. |
| Discovery | Resumable, paused metadata scan into a local SQLite index (names, parents, tags, aliases, document list, `updatedAt`); page browser; live page view (blocks + preview). |
| Tag audit | Tag counts (live `tags.list` with ADMIN, else from the index), untagged pages, case variants. |
| Import (single source) | Upload/paste of `.txt`, `.md`, `.json`; size/encoding checks; "split source" helper that cuts a long text into sections (each imported separately, by hand). |
| Transformation | Two paths: AI (Claude, structured output validated with Zod, grounding checks that downgrade unquoted "source" values) and structural (no AI: labels/aliases, statblock reader, JSON path mappings). |
| Recipes | Versioned recipe definitions (page type, template, field mappings + labels, required fields, tag and link policy, AI instructions, allow-create, default parent). Templates: example, local, and **layouts copied from LegendKeeper templates**; template → recipe. |
| Drafts | Review/edit UI, revisions, validation (record + field level), tag matching, link resolution (exact name/alias/normalized against the index, plus live search), preview. |
| Writing | One page at a time: planned resource id + idempotency key, approval bound to a content hash with expiry, atomic claim, no automatic retry, read-only reconciliation of uncertain outcomes, read-back, audit log. |
| Audit log | Every operation with outcome, recipe version, model, request id; secret redaction. |

## 2. What is incomplete or mocked

- **AI transformation has never run against the real Anthropic API** (no key available); it is
  covered by tests with a mocked provider only.
- **Formats**: PDF, DOCX, HTML and images are refused with an explanation.
- **One import = one source = one draft.** There is no batch, no multi-record extraction; the
  database ties each draft to exactly one import job (`drafts.job_id UNIQUE`).
- **No updates of existing pages** of any kind (tags, content). Phase 1 only creates.
- **No audit of page content** (only metadata: tags, names).
- Recipes have no record-extraction rules, duplicate policy, or "update existing" option.

## 3. LegendKeeper operations tested live (AI Test Project, SDK 4.0.0)

`projects.list/get`, `resources.list` (pagination), `resources.get`, `documents.getBlocks`,
`resources.create` with a page document (incl. infobox, key-value groups with grid/inline
display, text fields, mentions), client-chosen ids, `DUPLICATE_ID` on a reused id,
idempotency keys, `search.search`, `tags.list`, `resources.delete` (test pages only, by the
probe/integration scripts with explicit opt-in), reading templates (observed: listed with
`parentId: "templates"`, undocumented). Also observed: an empty image `url` is rejected
("unsupported href").

## 4. Operations that are uncertain or unsupported

| Operation | Status (from the official docs) |
| --- | --- |
| Update tags | `resources.update` — documented. **Tags and aliases replace the whole list; no `ifMatch` (no version check) on resource updates.** The app must read the current tags immediately before writing and merge. A small race with an edit made in the app between that read and the write remains; the app re-reads afterwards to detect it. Not yet tested live. |
| "Create" a tag | There is no tag object. A tag exists when a resource carries it. "Approving a new tag" therefore means approving putting that new text on a page. |
| Replace page content | `documents.replaceBlocks` with `ifMatch` (412 on a stale version) — documented; not yet tested live. Blocks the API cannot express (`unsupported`) **must be echoed by id** to be kept; leaving them out deletes their content. |
| Sidebar properties | Separate from page content (`properties.*`); a content replacement does not touch them. |
| Restore after a content change | Possible in principle by writing the saved previous blocks back with `ifMatch` (unsupported blocks restored by echoing their ids, as long as they are still in the document). Not yet tested live. |
| Native templates | No template API; reading them works (undocumented `templates` parent). There is no way to know which template a page was created from. |
| Create LegendKeeper's built-in Tags/Aliases infobox boxes | Refused (`UNSUPPORTED_KIND`), documented. |
| Filtering resources by tag/name/type server-side | Not available (`resources.list` filters by `parentId` only). Local index needed. |
| Backlinks ("mentioned in") | No endpoint. Outgoing mentions can be read from each page's blocks. |
| Rate limits | 120 writes/min, 3,000 writes/h, 300 requests/min, 6,000/h, 60,000/day per key. |

## 5. What can be reused for Phase 2

- The connector interface (add `updateResource`, `replaceBlocks`), its error mapping
  (`not_applied` vs `unknown` outcome), the writer client without automatic retries.
- Import jobs + drafts + the whole guarded write flow: **a batch becomes a container of import
  jobs, one per extracted record**. Every record keeps its own draft, review screen and safe
  write path, so one bad record never blocks the others.
- Extraction registry (add HTML, DOCX, PDF, image extractors), `splitSource`, the structural
  statblock reader, field aliases and labels, the AI provider with schema-validated output.
- The metadata index and its resumable scan (add content fingerprints for the audit).
- Reference index (exact/alias/normalized) → extend for duplicate detection.
- Audit log, secret redaction, approval-token pattern, read-back pattern.
- `lk-layout` renderer → target layout for migrations.

## 6. Bugs and gaps to fix before extending

1. **Templates count as pages in the tag audit and page lists.** Resources under the
   `templates` parent show up as "untagged pages". Exclude them everywhere a page list is built
   (already excluded from link suggestions).
2. **Drafts are tied 1:1 to import jobs.** Kept as is (each record gets its own job), but the
   import list must group batch records instead of flooding the list.
3. The upload limit (2 MB) is right for text but too small for PDFs/DOCX/images — a separate
   limit is needed for binary documents.
4. No other functional bugs found; all tests pass.

## Implementation plan (milestones as requested)

1. **Batch import** — multi-file upload; HTML/DOCX/PDF extractors (deterministic, page numbers
   kept), images via AI transcription (opt-in, external); record extraction rules in recipes
   (by heading level, by JSON array, by separator, whole file); batch job with per-record
   jobs/drafts; duplicate matching per record; batch overview counts; batch create with
   per-item outcome, dry run and JSON/CSV report.
2. **Wiki Health** — read-only audit runs over the index (+ page content fetched with
   fingerprints `updatedAt`/document `version`), persistent findings with status
   (open/dismissed/intentional/queued), filters, dashboard.
3. **Tagging assistant** — taxonomy (existing / allow new / approved taxonomy + aliases),
   suggestions (rules + optional AI), per-tag approval, batch apply via `resources.update` with
   read-merge-write and stale-state detection.
4. **Template migration** — migration recipes (target template, mappings, unmapped content
   rules), single-page test, before/after diff by field and block, mechanics-change flags,
   approval, `replaceBlocks` with `ifMatch`, saved originals for restore.
5. **Batch engine and reporting** — shared item states, resume/cancel/retry, review queue,
   history and exports.
6. **Regression, docs.**

---

# Milestone reports

All milestones were implemented in order, each tested, committed and pushed before the next.
Live checks used only throwaway pages under the sandbox page of the test project, deleted
afterwards. Test count at the end: **200 unit/contract tests** (`npm run check`) and **6 live
integration tests** (opt-in).

## Milestone 1 — Batch import

**Implemented:** multi-file batches (Markdown, text, JSON, HTML, `.docx`, text PDFs; images and
scanned PDFs by AI transcription on request); per-file upload; record extraction rules in
recipes (whole, heading, statblock, separator, paragraph, JSON list) with source file, section
and page kept for attribution; one import job and draft per record; recipe version pinned per
batch; AI result cache by input fingerprint; duplicate matching (exact / strong / ambiguous /
none, plus duplicates inside the batch) with the recipe's duplicate policy; recipe defaults,
attribution rules, uncertain/unmapped handling; dry run, approve selected, paced run with a
freshness check before each write, reconciliation by reading, retry only after re-approval;
CSV/JSON results and dry-run reports.
**Verified live:** 4 files → 8 records, an exact duplicate detected and skipped, 6 pages
created from the copied Statblock layout and read back (then deleted).
**Limitations:** `.doc`/`.odt`/`.rtf`/spreadsheets refused with advice; AI drafting at most the
batch's AI limit per run (25 by default).

## Milestone 2 — Wiki Health

**Implemented:** resumable, read-only audits by scope (all, page types, folder, criteria, open
findings), optional content reading with version fingerprints (unchanged pages not re-read);
checks for untagged pages, similar/misspelt/plural tags, layout and expected fields per page
type, likely duplicates, broken links, naming, attribution and unreadable content; persistent
findings with severity and certainty, filters, dismiss / intentional (quiet until the page
changes), maintenance queue, resolution when no longer seen; dashboard; exports.
**Verified live:** full audit of 242 pages.
**Limitation:** no template is recorded on pages, so the layout check compares each page with
the layout chosen for its page type.

## Milestone 3 — Tagging assistant

**Implemented:** taxonomy settings with policies A (existing only), B (new tags with explicit
approval), C (approved taxonomy with aliases and page-type limits); rules; suggestions from
rules, page type, folder, siblings, links, page text and optional AI, each with source,
certainty and reason; only sure suggestions for existing allowed tags pre-ticked; per-page
review, filters, approval (new tags need a separate tick), dry run, paced apply with a fresh
read before each write (changed pages go back to review), merge that never drops tags unless
a removal is ticked, read-back, reconciliation, retry after re-approval, exports.
**Verified live:** on two temporary pages: new-tag gate, reconciliation of an unknown outcome,
re-approval, write and read-back, existing tag kept.
**Limitation:** `resources.update` has no version check (documented); the app narrows the window
with read-before and read-back.

## Milestone 4 — Template migration

**Implemented:** migration settings in recipes; jobs for one named page (test) or a selection;
target layouts clearly labelled (copied LegendKeeper template, example-page layout, app-defined);
page reader that turns readable text into Markdown and keeps everything else (images, secrets,
tables, embeds, unreadable blocks…) to send back by id; drafting with the recipe (structural, or
AI told to reorganise, not rewrite), editable in the draft editor; word-for-word comparison
(every sentence, number and link), relabelled/moved/split fields, unmapped text kept in a notes
section (or blocking, per recipe), lost links added back, number changes needing explicit
acknowledgement, reworded-text warning; side-by-side preview; approval tied to the exact
proposal and draft revision; recovery record saved before each write; `replaceBlocks` with
`ifMatch`; read-back; reconciliation; restore (only while unchanged, or with explicit overwrite);
original download; exports. Migration drafts can never be created as new pages.
**Verified live:** an old-style statblock page migrated in place and restored identical.
**Limitations:** underline/strikethrough/code formatting and dividers not carried over
(reported); tables kept as is; first page document only; text blocks get new block ids.

## Milestone 5 — Reliability, review queue, history, exports

**Implemented:** central review queue (uncertain writes, failures, possible duplicates, drafts,
tag suggestions, migration number changes and unmapped text, pages changed after an audit,
pages that no longer exist) with severity, reason, link and filters; dashboard count; job list
for all kinds with end-of-job summary, recipe version, AI models and times; history export;
switched-off writes reported by dry runs. Resumption after a restart (items in preparation back
to pending, writes in flight to *needs reconciliation*, checked first) was already part of M1.

## Milestone 6 — Regression, documentation, live checks

- `npm run check`: typecheck and 200 tests pass. Production build succeeds; all pages and
  APIs answer in the production server; cross-site writes are refused (403).
- Browser bundles scanned: no API key values and no server-only code (only the *name*
  `LEGENDKEEPER_API_KEY` in help text).
- Database upgrade from a Phase 1 database tested (recipes, versions and imports kept; new
  settings defaulted); the live test database was upgraded in place.
- Live integration tests: 6/6 (read-only checks, page creation with duplicate refusal, tag
  replacement, version-checked content replacement, stale-version refusal, exact restore).
- README and CAPABILITIES updated (features, AI data disclosure, batch statuses, recovery,
  exports, backups and upgrades, known SDK limitations, troubleshooting, tests).

# Definition of done — status

| Requirement | Status |
| --- | --- |
| Multiple files in one job; multiple records per document; recipes control the transformation | Done (live) |
| Drafts reviewable and editable; duplicates and ambiguous matches identified; results and errors recorded | Done (live) |
| Existing pages scanned; untagged pages found; template inconsistencies detected; findings filtered and kept | Done (live); layout check uses the chosen layout per page type (no template is recorded on pages) |
| Tag suggestions use the existing taxonomy; new tags distinguished; approved changes applied with verified SDK operations; existing tags kept; failures inspectable and safely retried | Done (live) |
| Migration configured and tested on one page; many pages selectable; before/after comparison; unmapped content kept or flagged; numbers protected; approved migrations applied safely | Done (live, including restore) |
| Dry runs; nothing without approval; interrupted jobs resumable; uncertain writes reconciled first; audit history | Done |
| Tests pass without modifying real campaign resources | Done (unit tests use mocks; live tests only touch their own sandbox pages) |
| Phase 1 intact; migrations keep data; no secrets exposed; README updated; unsupported functionality identified | Done |

# Manual steps for you

- **Revoke the test API key** used during development (Project Settings → Developers → API
  Keys) and create your own for daily use; put it in `.env.local`.
- Add an Anthropic key if you want the AI options; nothing AI-related has run against the real
  API yet.
- Back up the `data/` folder before upgrading the app (it is upgraded automatically on start).
- In the test project, the page *Goblin Underboss (layout test)* from Phase 1 is still in the
  sandbox; delete it whenever you like.

# What remains / possible next steps

- A first real AI run (drafting, transcription, AI tag suggestions) with your Anthropic key.
- Migration of tables into fields, and carrying underline/strikethrough formatting.
- Using `resources.createMany` for very large imports (would trade per-record outcomes for speed).
- Re-pointing links that target specific blocks, if you use those.
