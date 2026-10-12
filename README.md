# LK Companion — Phase 2

A private web app, running on your own computer, that helps you **import, organise and
maintain your LegendKeeper project** with AI assistance — without losing information,
damaging pages, or inventing facts.

Screenshots from a rehearsal run: [dashboard](docs/screenshots/dashboard.png), [draft review](docs/screenshots/draft-review.png), [final preview](docs/screenshots/final-preview.png).

It complements LegendKeeper; it does not replace it. Everything it does goes through
LegendKeeper's official API and SDK (`@legendkeeper/sdk`). Nothing is written to LegendKeeper
without your explicit approval of the exact change.

## What it does

| Area | What works now |
| --- | --- |
| **Connection** | Tested automatically (read-only) when you open the app; shows your project's name and ID and whether writing is on. |
| **Page browser** (read-only) | Scan your project's page list into a local index (metadata only, resumable), filter by name/alias/tag/untagged, open any page to see its documents, sidebar properties, text, block structure and version. Live LegendKeeper search. |
| **Import studio** | One source → one page: upload or paste, choose a recipe, draft (AI or structural), review, approve, create. |
| **Batch import** *(Phase 2)* | Several files in one job (Markdown, text, JSON, HTML, Word `.docx`, PDF with a text layer; images and scanned PDFs by AI transcription on request). Many records per document (by heading, statblock, separator, paragraph or JSON list). One draft per record, duplicate matching against your project and within the batch, dry run, approval of selected records, run, per-record results and CSV/JSON reports. |
| **Recipes & templates** | Reusable, versioned recipes (page type, template, field labels, required fields, defaults, tag/link policy, AI instructions, batch and migration settings). Templates **copied from your LegendKeeper templates** (or any example page), or configured locally. |
| **Wiki Health** *(Phase 2)* | Read-only audit of existing pages: untagged pages, similar or misspelt tags, pages that do not match their type's layout, missing expected fields, likely duplicates, broken links, naming problems, missing attribution, unreadable content. Findings are kept, can be filtered, dismissed or marked intentional, and are revisited by later audits. |
| **Tagging assistant** *(Phase 2)* | Suggests tags for existing pages from your rules, page type, folder, neighbouring pages, links, text and (optionally) the AI, under a policy you choose: existing tags only, new tags with explicit approval, or an approved taxonomy. You tick what to apply; existing tags are never removed unless you tick a removal. |
| **Template migration** *(Phase 2)* | Moves older pages into a newer template's layout **in place** (same page, id, links). A word-for-word before-and-after comparison; every changed number must be ticked off; text that does not fit is kept in a notes section; images, secrets and other special blocks are kept exactly as they are. The original is saved first and can be restored. |
| **Review queue** *(Phase 2)* | Everything waiting for a decision from you, across all of the above, with severity, a plain reason and a link. |
| **Batch jobs & history** | Every job with its summary (done, failed, skipped, to review, remaining), recipe version, AI model and times; the full history as CSV/JSON; the audit log of every operation. |

**Out of scope** (by design): changes without approval, automatic deletion or merging of pages,
map/board/timeline editing, semantic search, multi-user use or remote hosting, and free-form
“do anything” commands. The app constructs every LegendKeeper operation itself; the AI only
ever returns data that is checked against a schema.

## Honest status

- Built against the official SDK **4.0.0**, its documentation and its OpenAPI schema, and
  **verified live** against a dedicated LegendKeeper test project (see
  [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for each operation and how it was verified).
- Phase 2 writes were verified live on throwaway pages under a sandbox page, which were
  deleted afterwards: creating pages from a batch, replacing a page's tags, replacing page
  content with a version check (and the refusal of a stale version), and restoring a page
  to its saved original (it reads back identical, block ids included). The live integration
  tests repeat these checks on demand (6/6 passing).
- AI features (AI drafting, image transcription, AI tag suggestions) have been tested with
  scripted (mocked) AI responses only. The first real AI call happens when you add your
  Anthropic key and choose an AI option; each screen says what will be sent.
- Cost estimates use list prices as of the date shown on screen; your Anthropic bill is
  authoritative.

---

## Prerequisites

- **Node.js 22.13 or newer** (22 LTS or 24 LTS). Check with `node --version`. Download from <https://nodejs.org>.
  No compilers or Windows build tools are needed: the database is Node's built-in SQLite. On Node 22 you may see a one-line
  “SQLite is an experimental feature” warning when the app starts; it is harmless.
- **A LegendKeeper API key.** The project owner must be on a **paid plan** (a trial does not count).
- **Optional: an Anthropic API key** (<https://console.anthropic.com>) for AI drafting, transcribing images and scanned PDFs, and AI tag suggestions. Without it, everything else works: structural drafting, audits, rule-based tagging and structural template migration need no AI.

## Installation

```sh
git clone <your repository URL> lk-companion
cd lk-companion
npm ci               # installs the exact versions in package-lock.json
npm run setup        # creates .env.local from .env.example (any operating system)
```

`npm run setup` never overwrites an existing `.env.local`. If you prefer to copy the file
yourself: `copy .env.example .env.local` (Windows Command Prompt),
`Copy-Item .env.example .env.local` (Windows PowerShell) or `cp .env.example .env.local`
(macOS/Linux). On Windows, `.env.local` may not show in Explorer as a normal file name —
open it from your editor (e.g. VS Code: *File → Open File*) or with `notepad .env.local`.

Then edit `.env.local` (next section). The database is created automatically on first start;
you can also create or upgrade it explicitly with `npm run db:migrate`.

## Configuration (`.env.local`)

`.env.local` is ignored by Git, so your keys never get committed. Restart the app after changing it.

| Variable | Required | Meaning |
| --- | --- | --- |
| `LEGENDKEEPER_API_KEY` | yes | Your LegendKeeper key (`lk_…`). |
| `LEGENDKEEPER_BASE_URL` | no | Leave empty for the real LegendKeeper. Set to `http://127.0.0.1:4010` to use the rehearsal server. |
| `LKC_ALLOW_WRITES` | no | Creating pages (after your approval) is on by default. Set to `false` to make the app read-only. |
| `LKC_SANDBOX_PARENT_ID` | no | The ID of a page for the optional throwaway write check. |
| `ANTHROPIC_API_KEY` | for AI | Your Anthropic key (`sk-ant-…`). |
| `LKC_AI_ENABLED` | no | `false` switches AI off completely. Default: on. |
| `LKC_AI_MODEL` | no | Claude model. Default: `claude-opus-5-5`. |
| `LKC_AI_EFFORT` | no | `low`, `medium`, `high` (default), `xhigh` or `max`. Higher = more thorough and more expensive. |
| `LKC_DATABASE_PATH` | no | Local database file. Default: `./data/lk-companion.db`. |
| `LKC_MAX_UPLOAD_BYTES` | no | Largest upload. Default 2,000,000. |
| `LKC_MAX_SOURCE_CHARS` | no | Longest source per import. Default 150,000 characters (bigger sources are split, never truncated). |
| `LKC_MAX_DOCUMENT_BYTES` | no | Largest file in a batch import (PDF, Word, HTML, images). Default 25,000,000. Each file is uploaded separately, so a batch can hold many such files. |

You can also enter API keys on the **Settings** page. Those are kept **in memory only**: not
written to disk or the database, never shown again, and forgotten on restart. `.env.local`
is the permanent option; anyone who can read that file can read your keys, so keep it on
your own computer.

## Creating a LegendKeeper API key

1. In LegendKeeper, open your project → **Project Settings → Developers → API Keys**. You need the ADMIN role to create keys.
2. Name it (e.g. "LK Companion"), choose a role, create it, and **copy the secret now** — it is shown only once.
3. Put it in `.env.local` as `LEGENDKEEPER_API_KEY=lk_…`.

**Which role?** A key acts as you, with the *lower* of the key's role and your role in the project.

- **MEMBER** is enough for reading pages, and for creating pages *under a parent page you can edit*.
- **ADMIN** is additionally needed for the live **tag list** (with a MEMBER key the app counts tags from its own scan instead) and for creating pages at the **top level** of the tree.

Choose the lowest role that does what you need. Revoke the key in the same place if it ever leaks.

## Configuring the AI provider

Add `ANTHROPIC_API_KEY` to `.env.local`. The default model is Claude Opus 5.5 at "high"
effort. The app enables Anthropic's server-side refusal fallback, so if a request is declined
by a safety filter it can be answered by a fallback model; the draft records which model
actually answered.

**What is sent to the AI** — only when you choose an AI option, and only for that job:

| You choose | What is sent |
| --- | --- |
| *Run AI transformation* (import) or AI drafting (batch) | The record's source text, the recipe's instructions and field list, the template's section headings, and the **names** of your existing tags. At most the batch's AI limit per run (25 by default). |
| *Transcribe with AI* on an image or scanned PDF in a batch | That file. |
| AI tag suggestions (switched on in the tagging settings) | Each selected page's name, place in the tree, current tags and up to 6,000 characters of its text, with your allowed tag names. |
| AI drafting in a template migration | Each selected page's readable text, the recipe's instructions and a rule to reorganise, not rewrite. |

Never your API keys, never anything automatically, and never pages you did not select. Results
are cached by content fingerprint, so an unchanged input is not sent twice. Turn AI off on
the Settings page or with `LKC_AI_ENABLED=false`; everything that does not need AI keeps working.

## Running the app

```sh
npm run dev          # development mode, http://127.0.0.1:3000
# or
npm run build && npm start   # production mode, http://127.0.0.1:3000
```

Open <http://127.0.0.1:3000>. The app only accepts connections from your own computer.

## First run, step by step

1. Open the app. The connection is tested automatically; the dashboard and **Connection** page show your project name and ID.
2. **Page browser** → *Scan project*. This copies page names, parents, tags and aliases (no page content) into the local index. You can pause and resume it.
3. **Tag audit** — see tags and pages without tags.
4. **Recipes & templates → Copy from LegendKeeper** — copy your template (e.g. *Statblock*). This also makes a recipe of the same name. Open the recipe and set a *default parent* (where new pages go), e.g. a sandbox page while testing. *Allow creation after approval* is on by default.
5. **Import studio** → paste text or upload a file, choose the recipe, *Create import*. On the import you can pick a different template (*Lay the page out with*), and you can switch it again while reviewing the draft.
6. *Run AI transformation* (or *Run structural*). Review the draft tab by tab; fix fields, choose links, accept or reject tags; *Save draft*.
7. *Open final preview* → check everything → tick the confirmation → *Create page*. The result links to the new page and the audit log records it.

### Rehearsing safely first

A local **rehearsal server** imitates the parts of the LegendKeeper API this app uses, with
sample Greyhawk data in memory. It lets you try every step — including page creation —
without touching your real project:

```sh
npm run mock:lk      # in one terminal; prints "Rehearsal LegendKeeper server (NOT the real LegendKeeper)"
```

In `.env.local` set `LEGENDKEEPER_BASE_URL=http://127.0.0.1:4010`, any key starting with
`lk_`, `LKC_ALLOW_WRITES=true` and `LKC_SANDBOX_PARENT_ID=sandbox1`; restart the app. Use a
separate `LKC_DATABASE_PATH` (e.g. `./data/rehearsal.db`) so rehearsal data stays apart. Remove
`LEGENDKEEPER_BASE_URL` to go back to the real LegendKeeper.

## Importing many files (batch import)

**Batch jobs → New batch import.**

1. **Recipe.** Choose the recipe. Its *record rules* say how one file is split into records:
   whole file, by heading level, statblock (a heading followed by statblock labels), a separator
   line such as `---`, paragraphs, or a JSON list (with the paths of each record's name and id).
   You can change the rules for this batch only.
2. **Files and text.** Add files (each is uploaded on its own, up to `LKC_MAX_DOCUMENT_BYTES`)
   or paste text. Supported: `.md`, `.txt`, `.json`, `.html`, `.docx`, and PDFs with a text
   layer (page numbers are kept for attribution). Images and scanned PDFs are marked *needs
   transcription*; *Transcribe with AI* sends that file to the AI provider, only when you click
   it. Old Word `.doc`, `.odt`, `.rtf` and spreadsheets are refused with advice (save as `.docx`,
   PDF or CSV-as-text). A file that cannot be read does not stop the others.
3. **Records.** *Create batch and read the files* extracts the records. Each one shows its source
   file, section and page, and flags such as *very short*, *very long*, *none of the expected labels* or *same title
   twice*.
4. **Drafts.** *Draft pending records (no AI)* or *with AI* (at most the AI limit per run, 25 by
   default). Every record becomes a normal draft you can open and edit in the draft editor.
   The app then matches each record against your project (exact name or alias **plus** a second
   signal such as type tag or parent counts as *exact*; otherwise *strong*, *ambiguous* or
   *none*) and against the other records of the batch.
5. **Check, approve and run.** Filter the table (to review, possible duplicates, errors, missing
   required fields, failed…), select records, run a **dry run** (reads, checks, writes nothing;
   exportable), approve, and run. Records are created one at a time (about 100 a minute, under
   LegendKeeper's limit), each with its own duplicate protection and read-back. Just before each
   write the app checks again that the parent exists and that no page with the same name has
   appeared.

The recipe's *duplicate policy* decides what happens with matches: *ask me* (default), *skip
exact matches*, or *create anyway*. Existing pages are never merged or overwritten by an import.

## Running a wiki audit (Wiki Health)

**Wiki Health → Run an audit.** Choose what to check (all pages, some page types, a folder, pages
with a tag or name, or only pages with open findings), whether to read page content (needed for
layout, field, link and attribution checks; about 4 pages a second) and which checks to run.
The audit only reads. You can stop it and resume later; unchanged pages are not read again
(their document version is remembered).

Each finding has a **severity** (problem, suggestion, info), a **certainty** (definite, likely,
possible), an explanation and a suggested remedy. Filter by category, severity, status or page.
*Dismiss* or *Mark intentional* keeps a finding quiet until that page changes; *Add to
maintenance queue* collects things you want to fix. Findings that a later audit no longer sees
are marked resolved. Nothing is ever changed in LegendKeeper from here.

## Tagging existing pages (Tagging assistant)

1. **Tagging settings.** Choose a policy:
   **A — existing tags only**; **B — new tags may be suggested** (marked NEW, each needs
   explicit approval); **C — approved taxonomy** (only the tags in your list, optionally limited
   to page types). Add aliases (“Monsters” → “Monster”), rules (“pages under Saltmarsh get
   *Saltmarsh*”), and decide whether to also ask the AI (the screen says what is sent).
   *Start from my existing tags* fills the taxonomy from your project.
2. **New tagging job.** Choose pages (untagged, some types, a folder, a tag or name, all) and
   *Create job and suggest tags*. Each page is read once; suggestions come with their source,
   certainty and reason. Only *definite* or *likely* suggestions for tags you already use are
   ticked for you.
3. **Review.** Tick or untick per page; filter by untagged, high confidence, needs manual
   review, page type or folder.
4. **Approve.** Select pages and approve. Pages adding a new tag need *Approve new tags* ticked.
5. **Dry run** (optional) and **Apply**. Right before each write the app reads the page's
   current tags. If they changed since the suggestion, that page goes back for review instead of
   being written. What is written is: the current tags, plus the approved additions, minus only
   the removals you ticked. The tags are then read back.

LegendKeeper has no version check for tag updates, so a change made in LegendKeeper in the same
second as the app's write could be overwritten; the read-back reports it if so.

## Migrating pages to a newer template (Template migration)

1. **Prepare the target.** Copy your current template on **Recipes & templates** (or copy the
   layout of a finished example page). Copying makes a recipe; open it and check *Template
   migration (existing pages)*: the heading for text that does not fit, whether tags are kept
   or extended, and what happens with links the new layout would lose.
2. **Test on one page.** **Template migration → New migration**: choose the recipe and target
   layout, *Pages I name*, type one representative page, *Create and compare*.
3. **Review the comparison.** For each page you see: field by field (same, new label, value
   changed, moved into the text, split, kept in notes), sections kept/added/removed, links
   (lost, added back, new), metadata (what stays unchanged), blocks kept exactly as they are
   and where they go, text kept in notes, sentences that are not word for word from the old
   page, and the old and proposed page side by side.
   **Every changed number must be ticked off** before the page can be approved. To correct the
   result, *Edit the draft* (the normal draft editor), save, then *Refresh comparison*.
4. **Approve, dry run, apply.** Applying saves the original in the app, then replaces the
   page's content only if the page is still at the version that was compared. A page edited in
   the meantime is not written; it goes back to be compared again.
5. **Then do more pages** with the same recipe (by type, folder, tag or name).

**What is kept:** the page id (so every link to it keeps working), name, parent, aliases,
sidebar properties, tags (unless the recipe adds some), and all content the text pipeline does
not handle — images, secrets (GM-only text stays secret), tables, quotes, callouts, collapsible
sections, embeds, maps, link lists, collections and anything the API cannot read — which is
sent back by id so LegendKeeper keeps it unchanged.
**What is not carried over (and reported):** divider lines, and underline, strikethrough and
code formatting.

**Restoring.** On a migrated page, *Restore original* writes the saved original back. This is
only done while the page is unchanged since the migration; if it was edited afterwards you can
choose *Restore, overwriting later edits*, or *Download original* (JSON exactly as LegendKeeper
returned it) and decide yourself. Restoring was verified live: the page reads back identical.

## The review queue

**Review queue** lists everything waiting for you, highest severity first: writes with an
unknown outcome, failures, possible duplicates and drafts to review, tag suggestions (new tags
first), migrations that change numbers or have text that did not fit, pages changed after an
audit, and pages in open jobs that no longer exist. Each entry says why and links to where you
deal with it. Filter by type, severity, or page name/id/job. The dashboard shows the count.

## Batch job statuses

| Status | Meaning |
| --- | --- |
| pending | Waiting to be processed (read, drafted, suggested or compared). |
| processing | Being processed now. |
| awaiting review | Ready for you. Nothing is written until you approve it. |
| approved | Will be written when you run the job. |
| running | Being written now. |
| succeeded | Done (and read back). |
| failed | Failed; the error says why. Nothing was written, or the app confirmed nothing was. |
| skipped / cancelled | Left out; nothing written. |
| needs reconciliation | A write was sent but the reply was lost: the outcome is unknown. |

A failed item never spoils the rest of its job. The Batch jobs page shows each job's summary
(done, failed or unresolved, skipped, to review, remaining). A job with nothing left is shown as
*finished*; *Close* files it away (unwritten items are cancelled, stored source text deleted).

## Recovering from failures

- **Unknown outcome** (*needs reconciliation*): use *Check unknown outcomes* / *Check unresolved*.
  The app only **reads** LegendKeeper to find out what happened, then marks the item succeeded or
  failed. Nothing is retried until the outcome is known.
- **Failed:** fix the cause (the message says what), then *Retry failed*. A failed write is
  never re-sent on its own: imports and tags need approving again; migrations are compared again
  first.
- **The app stopped mid-job** (closed window, crash, restart): the job shows *interrupted*.
  Items being prepared go back to *pending*; items being written become *needs reconciliation*
  and are checked first when you run the job again. Just open the job and continue.
- **A page changed in LegendKeeper** after you approved something: the app notices before
  writing (tag check, version check, name check) and asks you to review again.
- **Undo a migration:** *Restore original* (see above).

## Exporting reports

- Each batch import, tagging job and migration: *Export CSV / JSON* (results) and, after a dry
  run, *Dry run CSV / JSON*.
- **Batch jobs → History CSV / JSON:** one row per job with its summary, recipe version and AI
  model.
- **Wiki Health:** findings as CSV or JSON.
- **Migration:** *Download original* per page.

Exports never contain API keys (they are scrubbed of secrets even if one appeared in an error
message). CSV cells that start with `=`, `+`, `-` or `@` are prefixed so spreadsheet programs
do not run them as formulas.

## Backups and database upgrades

All of the app's own data is one SQLite file (`LKC_DATABASE_PATH`, default
`./data/lk-companion.db`). **To back it up, stop the app and copy the `data` folder.** To restore,
stop the app and put the copy back.

When a new version adds tables or columns, the database is upgraded automatically on start
(or with `npm run db:migrate`). Upgrades only add; they never delete or recreate your data.
Phase 1 recipes, imports and drafts carry over, and new recipe settings get sensible defaults.
Take a backup before upgrading anyway.

## How the safety rules work

- **No write without approval.** A finished AI transformation only produces a draft. Creating a page needs: writes not switched off (`LKC_ALLOW_WRITES`, on by default), a recipe that allows creation (on by default), a draft with no validation errors, a live connection to the expected project, a parent and links that still exist, and your explicit approval of the exact content in the final preview. Editing the draft afterwards cancels the approval.
- **No duplicates.** Each draft gets its page ID before the first attempt. LegendKeeper refuses a second page with the same ID, and each request carries an idempotency key.
- **No blind retries.** A write is never retried automatically. If the outcome is uncertain (timeout, lost connection, server error), the app only *reads* to find out whether the page exists, and shows *Check outcome*.
- **No invented facts.** The AI must mark missing values as missing. The app checks every value the AI calls a source fact: if its quote or its numbers are not in the source, it is marked *uncertain* and not written unless you confirm it. Suggestions are never written unless confirmed.
- **No fake links.** Links use only page IDs that come from LegendKeeper (the index or a confirmed lookup). Ambiguous names must be resolved by you; IDs are re-checked right before writing.
- **Untrusted sources.** Imported text is passed to the AI as data in a fenced block, after rules saying it can never act as instructions. The model has no tools, and its output must match a strict schema. Instruction-like text is flagged to you.
- **Changes to existing pages are narrow and checked.** The app can change an existing page in exactly two ways, both after your approval: replace its tag list (tagging assistant; read, merge, write, read back) and replace its page content (template migration; only at the version you compared, original saved first). There is no code path that moves, merges or deletes LegendKeeper pages.
- **The same plan from review to write.** What you approved is what is written. Before each write the app checks that the page has not changed since; if it has, the approval is withdrawn and you review again. Batches keep the recipe version they started with.
- **Batches are paced.** Writes are spaced to about 100 a minute and reads to a few a second, under LegendKeeper's limits.

## Architecture

```
Browser (React pages)  ──fetch──▶  /api/* route handlers  (thin: validate input, call a service)
                                          │
                                          ▼
                                  Application services   src/server/services/
                     ┌──────────────┬─────┴───────┬────────────────┬──────────────┐
                     ▼              ▼             ▼                ▼              ▼
             LegendKeeper     AI provider     Core domain       Database        Audit log
              connector       (Claude)       (pure TS)         (SQLite)       (redacted)
           src/server/lk/   src/server/ai/   src/core/       src/server/db/
                 │
           @legendkeeper/sdk ──▶ LegendKeeper API
```

- **`src/core/`** — the canonical page model, page types, recipes, templates, extraction (text/Markdown/JSON, with a registry for future PDF/DOCX/HTML/OCR extractors), tagging, reference resolution, validation, structural transformer, AI output schema and grounding checks. No network, no database: easy to test.
- **`src/server/lk/`** — the only code that talks to LegendKeeper. `connector.ts` is the interface the rest of the app depends on; `sdk-connector.ts` implements it with the official SDK; `render.ts` turns a canonical draft into LegendKeeper blocks using the SDK's builders; `errors.ts` maps SDK errors to plain-English messages. The interface has exactly three writes: `createPage`, `updateResourceTags` and `replaceDocumentBlocks` (always with a version check).
- **`src/server/ai/`** — the AI provider interface, the Claude implementation (structured outputs, validated again in code), and the version-controlled prompt (`prompts/transform.ts`, with `PROMPT_VERSION`).
- **`src/server/services/`** — connection, discovery (scan/browse), tags, recipes/templates, imports, transform, drafts, write, settings, audit; Phase 2: `batch-engine` (background work per job, pacing, cancel), `import-batches`, `wiki-health`, `tagging-batches`, `migrations`, `page-scope` (page selection), `review-queue`.
- **`src/server/lk/page-reader.ts`** — reads an existing page for migration (text → Markdown; everything else kept as is). **`src/core/migration-check.ts`** — the word-for-word, number and link comparisons. **`src/core/audit-checks.ts`**, **`src/core/tag-assistant.ts`**, **`src/core/matching.ts`**, **`src/core/records.ts`** — the pure logic of audits, tag suggestions, duplicate matching and record extraction.
- **`src/server/extraction/`** — reading PDF (unpdf), Word `.docx` (mammoth, no external file access) and HTML on your computer.
- **`src/server/db/`** — SQLite using Node's built-in `node:sqlite` module (no native add-on to install), with versioned migrations and repositories.
- **`src/app/`** — Next.js pages and `/api` routes. `src/proxy.ts` refuses non-localhost requests and cross-site writes.

The UI never imports the SDK; all LegendKeeper and AI calls happen on the server.

### What the database stores

Recipes (every version), local templates, import jobs, drafts and their revisions, validation
results, the audit log, created page IDs and versions, the write-check record, a
**metadata-only** index of your pages (names, parents, tags, aliases, document list — no
content), and non-secret preferences. Phase 2 adds: batch jobs, their items and uploaded files
(kept while the batch is open), cached AI results (keyed by a fingerprint of their input), audit
runs and findings, a small per-page summary from the last audit (document version, structure,
the first 20,000 characters of text), the tagging taxonomy, and the **migration recovery
records** (the original and proposed content of each migrated page; never deleted
automatically). The source text of an import is kept only while the
import is open and is deleted when it is completed or cancelled (its SHA-256 hash is kept).
**API keys are never stored in the database.** Delete `data/` to start fresh.

## Using your LegendKeeper templates

On **Recipes & templates → Copy from LegendKeeper**, the app lists your project's templates
(for example *Statblock*). Pick the page type it is for and press **Copy layout**. The app
reads the template (it never changes it) and saves its layout as a local template. Then open
your recipe and choose that template. New pages are built from the same blocks:

- the first big heading becomes the page name;
- each infobox row is filled from the field with the same name or alias (“Armour Class” → Armor
  Class, “Strength” → STR, “Immunities” → damage and condition immunities, …); rows the
  source has no value for are left out (and a group with no values at all is left out);
- each titled text block (“Traits”, “Actions”, …) gets the section with the same heading, and
  is left out when the source has none; extra sections (e.g. “Reactions”) become new text
  blocks in the same style;
- in statblock sections, each entry's name is bold (“**Nimble Feet.** The goblin …”); only title-like names are bolded, and the wording itself is never changed;
- the description goes where the template has its placeholder text;
- fields without a row (e.g. Size, Alignment, Gear) are added to the first or last row group;
- template conventions are followed: `[Spell] Name`-style headings become the page name, other
  `[Class]`-style placeholders are replaced with it (“Becoming a [Class]” → “Becoming a Tidecaller”),
  a hidden box whose example text is “Description text” receives the description, a box whose
  example text starts with a field name (“Holy symbol description”) receives that field, the
  template's quote slot receives the source's first `> quotation`, and an empty tag-index collection
  is filled as the template's own note says (e.g. the class name and “Subclass”);
- example tables and boxes that would be left empty are left out instead of copied as empty frames.

Template rows the built-in page types have no field for (e.g. a god's *Portfolio* or a spell's
*Casting Time*) are filled once you add those fields to the recipe (*Extra fields*); the
*What goes where* view shows which rows are matched.

The template's own example text is never copied. **What goes where** on the template row shows
the mapping and a preview. After you change the template in LegendKeeper, press **Refresh**.
You can also copy the layout of any existing page (paste its id or link), e.g. a finished
statblock page.

Copying a template also makes a **recipe** with the same name (untick *Also make a recipe* if you
don't want one), and every template has a **Make recipe** button. The new recipe starts from the
built-in example for that page type (field aliases, tag and link rules, AI instructions,
required fields) and uses your template. On each import you can still pick another template for
the same page type, and switch it while reviewing the draft; the preview updates straight away.

LegendKeeper lists templates as resources whose parent is `templates`; that is
observed, not documented, so if it ever stops working, use the page-as-example option.

## Recipes in more detail

Most settings are on the recipe form. *Edit as JSON* exposes everything, including:

- **Field labels and aliases.** Without AI, the importer recognises each field by its name and its built-in aliases (e.g. Armor Class = `AC`/`Armour Class`, Hit Points = `HP`, Challenge = `CR`, Ancestry = `Race`/`Species`). Statblock fields may be written without a colon (`AC 17`, `HP 21 (6d6)`), several to a line, and ability scores in the 2014 (`STR 19 (+4)`) or 2024 (`Str 10 +0 +0`) layouts. Add your own labels in the recipe's **Also written as** column (stored as `fieldMappings[].labels`). The AI is told the same aliases.
- `extraFields` — add fields to a built-in page type for this recipe.
- `linkPolicy.scanExcludeTags` — pages with these tags are never linked by the automatic name scan (e.g. `["Glossary"]` so rules terms like “Armor Class” are not linked everywhere). Also on the form.
- `customPageType` — define your own page type, e.g.:

```json
{
  "name": "Deity",
  "targetPageType": "deity",
  "customPageType": {
    "id": "deity",
    "label": "Deity",
    "suggestedTag": "Deity",
    "fields": [
      { "key": "portfolio", "label": "Portfolio", "group": "lore" },
      { "key": "alignment", "label": "Alignment", "group": "lore" },
      { "key": "symbol", "label": "Holy symbol", "group": "lore" }
    ],
    "sections": ["Description", "Worship", "Clergy", "Notes"]
  },
  "requiredFields": ["portfolio"],
  "tagPolicy": { "mode": "existing_only" },
  "allowCreate": false
}
```

Built-in page types: NPC, Creature/statblock, Location, Magic item, Rule/reference entry,
Historical event. Each keeps game mechanics separate from lore.

## Tests

```sh
npm test               # 206 unit and contract tests; never touch LegendKeeper or Anthropic
npm run typecheck      # TypeScript
npm run check          # both
```

What they cover: canonical schemas; JSON/Markdown/text extraction, limits and lossless
splitting; recipe validation and versioning; AI output validation with mocked responses
(missing and invented values, unknown fields, injected instructions); tag suggestions;
reference resolution (exact, ambiguous, near matches, no invented IDs); rendering to
LegendKeeper blocks **validated against the official OpenAPI schema** for every page type;
permission and validation errors; audit logging and secret redaction; writes blocked without
configuration, verification, recipe permission or approval; approval invalidated by edits;
double-click protection; lost replies and uncertain outcomes; duplicate prevention; no
automatic retries; and the real SDK client against a local server that follows the docs.

Phase 2 adds: several files and formats in one batch (Markdown, HTML, real `.docx` and PDF files
built in the tests), many records per document, malformed JSON, unsupported formats, empty and
very short records, missing fields, large inputs, partial failures, source attribution; duplicate
matching (exact, aliases, similar names, different pages with the same name, duplicates inside a
batch); dry runs, approval, runs with partial failures, cancellation, unknown outcomes and
reconciliation; Wiki Health checks and finding lifecycle; tag suggestions (existing vs new tags,
policies, ambiguous types, stale page state, preservation of existing tags, approval of new
tags); template migration (field mapping, kept unmapped content, number protection, kept rich
content and secrets, invalid target templates, pages changed after comparison, failure
recovery, restore); the review queue; job summaries and exports; and upgrading a Phase 1
database.

### Optional integration tests (real LegendKeeper)

These never run with `npm test`. They need explicit opt-in:

```sh
# Read-only — changes nothing:
LKC_INTEGRATION=1 LEGENDKEEPER_API_KEY=lk_... npm run test:integration

# Plus live writes: creates test pages "LK Companion integration test …" under your sandbox page
# (one to test creation; one to test tag replacement, version-checked content replacement and restore)
LKC_INTEGRATION=1 LKC_INTEGRATION_WRITE=1 LKC_SANDBOX_PARENT_ID=<sandbox id> LEGENDKEEPER_API_KEY=lk_... npm run test:integration

# Add LKC_INTEGRATION_CLEANUP=1 to delete those test pages afterwards
# (it double-checks the ID and name first). Without it, delete the page yourself.
```

Use a test project or a sandbox page. Never point it at pages you care about.

### Capability probe (test projects only)

`scripts/probe-legendkeeper.ts` checks, against the live API, everything this app relies on
(project identity, paging, tags, search, creating a page from the app's renderer with a planned
ID, idempotent replay, duplicate-ID refusal, versioned edits and stale-version refusal,
single-block insert, tag/alias updates, properties, extra document tabs, delete/restore and
`HAS_CHILDREN`). It works inside one new top-level "LK Companion Dev Sandbox …" page and deletes
it afterwards (`LKC_PROBE_KEEP=1` keeps it). **Only run it against a test project** — it needs
an ADMIN key and explicit opt-in:

```sh
LKC_PROBE=1 npx tsx scripts/probe-legendkeeper.ts   # report in data/probe-report.json
```

## Security and privacy

- The app listens on **127.0.0.1 only** and refuses requests addressed to any other host name (protection against DNS rebinding). Changing requests must come from the app's own pages.
- Keys are read on the server only; they are never sent to the browser, put in URLs, returned in responses, logged, or stored in the database. Logs and audit entries pass through secret redaction.
- Uploads are size-checked before processing; documents are read on your computer (Word files without fetching anything they link to; scripts and images in HTML are ignored); file names are used only as labels.
- Source documents are treated as data: their text goes to the AI only inside a fenced block after rules that it can never act as instructions, the AI has no tools, and every operation is built by the app, never by the model. When the AI notices text that reads like instructions, it reports it and the draft shows a warning.
- No telemetry or analytics. The npm scripts also switch off Next.js's own anonymous usage telemetry (`NEXT_TELEMETRY_DISABLED=1`, set by `scripts/next.mjs`).
- **Do not expose this app to the internet.** There is no login. Hosting it remotely would first need authentication, HTTPS and proper secret storage.

## Known limitations

These come from the documented LegendKeeper API and SDK 4.0.0. Each is handled by doing the
supported part and saying so on screen.

- **Templates**: the API has no “create from template” operation and does not document templates. The app copies a template's *layout* (read with the normal read operations) and fills it; pages are not linked to the template in LegendKeeper, and **LegendKeeper does not record which template a page came from**, so the audit's layout check compares pages with the layout you chose for their page type. Empty image slots and LegendKeeper's built-in Tags and Aliases boxes cannot be created through the API (`UNSUPPORTED_KIND`, as documented), so they are left out; add those boxes in LegendKeeper if you want them. Templates are found as resources whose parent is `templates` (observed, not documented); if that stops working, use the example-page option.
- **Tag updates have no version check** (`resources.update` replaces the whole list and takes no `ifMatch`). The app reads right before writing and reads back afterwards, which narrows but cannot fully close the window for a simultaneous edit.
- **Page content edits do not change a page's `updatedAt`.** Changes are detected with the document's version instead, which needs reading the page; the audit and the review queue's “changed after an audit” therefore notice name, tag and position changes from the index, and content changes at the next audit.
- **Blocks the API cannot express** (`unsupported`) cannot be read or created; migrations keep them by sending them back by id, and restore relies on them still being in the page.
- **Migration**: underline, strikethrough and code formatting and divider lines are not carried over (reported per page); tables are kept as they are rather than turned into fields; only a page's first page document is migrated; text blocks get new block ids (links to a specific block inside the page, if you use them, would need re-pointing).
- **Links to pages created later**: a page can only link to pages that exist when it is drafted. After importing related pages in several batches, run a template migration on the earlier pages with the same recipe: it adds the new links and changes nothing else (verified live).
- **Filtering**: the API cannot filter resources by name or tag, and has no backlinks endpoint, so selection, audits and the review queue rely on the local index, which is as fresh as the last scan.
- **Tag list** needs an ADMIN key; otherwise tags are counted from the index.
- **Formats**: old Word `.doc`, `.odt`, `.rtf` and spreadsheets are refused with advice. Images and scanned PDFs need AI transcription (on request).
- **Rate limits**: 120 writes and 300 requests a minute per key. Batches are paced below that, so very large jobs take time (about 100 pages a minute to write, about 4 a second to audit).
- **Deleting** pages is deliberately not offered. The tests and probes that create test pages delete only their own pages, and only when explicitly asked.
- SDK 4.0.0 is new. It is pinned exactly; read the SDK changelog before upgrading.

## Troubleshooting

| Message | What to do |
| --- | --- |
| *No LegendKeeper API key is configured* | Add `LEGENDKEEPER_API_KEY` to `.env.local` and restart. |
| *LegendKeeper rejected the API key* (401) | The key is wrong, revoked or expired. Create a new one. |
| *API keys need the project owner to be on a paid plan* (402) | The owner's plan must be paid (not a trial). |
| *…refused the request because the key's role…* (403) | Use an ADMIN key for tags or top-level pages, or create under a parent you can edit. |
| *Could not reach LegendKeeper* | Check your internet connection, firewall, and `LEGENDKEEPER_BASE_URL` (empty for the real service). Behind a corporate proxy, Node.js ignores `HTTPS_PROXY` unless you also set `NODE_USE_ENV_PROXY=1` (Node 22.21 or newer). |
| *rate limit was reached* (429) | Wait the indicated time. Pause a running scan if needed. |
| *The outcome is uncertain* | Click *Check outcome*. The app looks for the page by its planned ID. Never re-create it manually first. |
| *A resource with this draft's ID already exists, but this key cannot read it* | Possibly a deleted page in the trash. Check LegendKeeper; if the page is not there, use *Assign a new page ID*. |
| *The draft changed after the final preview* | Open the final preview again and re-approve. |
| *The AI reply did not match the expected structure* / *was cut off* | Run it again; for long sources, split them. Or use the structural transformation. |
| *No Anthropic API key is configured* | Add `ANTHROPIC_API_KEY`, or use *Run structural (no AI)*. |
| A request ID is shown | Quote it to LegendKeeper support; it identifies their server log entry. |
| A batch says *interrupted* | The app stopped mid-job. Open the job and continue; writes that were in flight are checked first. |
| *The page changed in LegendKeeper after the analysis / since the suggestion* | Someone edited the page. Compare (or suggest) again, check, and approve again. |
| *Tick every change you have checked first* (migration) | Open the page's comparison and tick each number change after checking it. |
| *The draft was edited after this comparison* (migration) | Press *Refresh comparison*, check it, then approve. |
| *The page was edited after the migration* (restore refused) | Use *Restore, overwriting later edits* if you are sure, or *Download original*. |
| *Writes are switched off* in a dry run | Remove `LKC_ALLOW_WRITES=false` from `.env.local` and restart. |
| A PDF says *needs transcription* | It has no text layer (scanned). Use *Transcribe with AI*, or export a text PDF. |
| *…is larger than the … byte limit* when adding a file | Files are uploaded one at a time up to `LKC_MAX_DOCUMENT_BYTES` (25 MB by default); split larger files or raise the limit. |
| Database problems | Restore your backup of `data/` (see *Backups*), or stop the app and delete `data/` to start fresh (your LegendKeeper project is not affected, but the app's history and recovery records are lost). |
| `npm ci` fails while compiling something (`node-gyp`, `MSBuild`, Windows SDK) | You have an older copy of the project that used a compiled database add-on. Download the latest version; it needs no build tools. |
| *Next.js is not installed in this folder* | Run `npm ci` in the folder that contains `package.json` and wait until it finishes. |

## Project layout

```
src/app/              pages and /api route handlers
src/components/       UI components (draft review, write panel, preview)
src/core/             domain model and pure logic (records, matching, audits, tags, migration checks)
src/server/           configuration, connector, AI, extraction, services, database
src/proxy.ts          localhost-only request guard
scripts/              db:migrate, rehearsal server, capability probe
tests/unit/           unit and service tests (mock LegendKeeper, mock AI)
tests/contract/       real SDK against a local documented-API server
tests/integration/    optional live tests (opt-in)
docs/CAPABILITIES.md  API/SDK capability matrix and what was verified live
docs/PHASE2_REPORT.md Phase 2 starting report, plan and milestone reports
```
