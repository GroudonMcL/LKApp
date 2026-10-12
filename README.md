# LK Companion — Phase 3

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
| **Chronology** *(Phase 3)* | A local chronology from your event pages, dated fields (Born, Died, Founded, Destroyed), the LegendKeeper timelines as last read and the events you accept. Dates are kept as written, with their uncertainty (approximate, ranges, decades, centuries, relative, unknown) and configurable calendars (Greyhawk CY/BCY by default). Filters, events per period, conflicting dates and impossible sequences, and adding an exactly dated event to an existing LegendKeeper timeline with preview and approval. |
| **Event discovery** *(Phase 3)* | Finds events described in ordinary pages (rule-based; the AI optionally), each citing its sentence. Accept, edit, reject or defer; accepted events join the chronology and can become drafts with your event recipe. |
| **Knowledge analysis** *(Phase 3)* | Relationships (page tree, links, fields, wording), pages that name another page without linking it, names used across pages that have no page, contradictions, naming variants and near-duplicate pages, each with its evidence. Optional AI comparison of 2–5 pages. |
| **Relationship browser & search** *(Phase 3)* | One page and its neighbours as a graph and a table, with how each connection is supported. A combined search (name, kind, tags, folder, text, fields, dates, links, findings) with saved searches. |
| **Task Assistant** *(Phase 3)* | Plain-English maintenance requests turned into a checked plan of the app's own operations, run read-only; changes are handed to the tool that makes them with approval. |

**Out of scope** (by design): changes without approval, automatic deletion or merging of pages,
map and board editing, changing or deleting timeline events (the app only adds events, one at
a time, with approval), semantic search, multi-user use or remote hosting, and free-form “do
anything” commands. The app constructs every LegendKeeper operation itself; the AI only ever
returns data that is checked against a schema.

## Honest status

- Built against the official SDK **4.0.0**, its documentation and its OpenAPI schema, and
  **verified live** against a dedicated LegendKeeper test project (see
  [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for each operation and how it was verified).
- Phase 2 writes were verified live on throwaway pages under a sandbox page, which were
  deleted afterwards: creating pages from a batch, replacing a page's tags, replacing page
  content with a version check (and the refusal of a stale version), and restoring a page
  to its saved original (it reads back identical, block ids included). The live integration
  tests repeat these checks on demand (6/6 passing).
- AI features use **OpenRouter's free models by default**, or Claude with an Anthropic key.
  OpenRouter was verified live: an AI import of a prose NPC through the free router created
  the page “Brother Hessan Tull” in the sandbox, at a reported cost of 0. The Claude
  provider has been tested with scripted (mocked) AI responses only.
- With OpenRouter the app only ever uses free models (see *Configuring the AI provider*).
  With Claude, cost estimates use list prices as of the date shown on screen; your
  Anthropic bill is authoritative.
- Phase 3 was verified live (12 Oct 2026, test project): LegendKeeper timelines and calendars
  read (2 timelines, 17 events; the project's own Greyhawk calendar linked automatically);
  event discovery over 184 read pages, plus AI discovery and AI planning through free
  OpenRouter models; an accepted event made into a page and added to a sandbox timeline
  (read back as approved); knowledge analysis of 248 pages in about 10 seconds; the Task
  Assistant's example requests. The live integration tests now include timeline reading and
  a sandbox timeline-event write (8/8 passing). Details in [docs/PHASE3_REPORT.md](docs/PHASE3_REPORT.md).

---

## Installing on Windows (recommended)

The Windows package needs nothing else installed: it brings its own copy of Node.js.

1. **Download** the latest package: on GitHub, open the repository → **Actions** → **Windows
   package** → the newest run with a green tick → under **Artifacts**, click
   **LK-Companion-Windows** (you need to be signed in to GitHub). If a release has been
   published, you can download the zip from **Releases** instead.
2. **Unblock** it: right-click the downloaded zip → **Properties** → tick **Unblock** → **OK**.
   (Windows marks files from the internet; this avoids security prompts for every file.)
3. **Unzip** it somewhere permanent, e.g. `Documents\LK Companion`.
4. **Start** it: double-click **Start LK Companion**. A small window says when the app is
   running, and the app opens in its own window (Microsoft Edge's app mode; Chrome or your
   default browser if Edge is missing). If Windows asks whether to run the file, choose **Run**
   (or **More info → Run anyway**).
5. The first time, the dashboard asks for your **LegendKeeper API key** and, optionally, a free
   **OpenRouter key**; they are saved on this computer. That's all.

Keep the small window open while you use the app; close it to stop the app. Double-click
*Start LK Companion* again to reopen the app window. **Create desktop shortcut** puts an
*LK Companion* icon on your desktop (it starts the small window minimised).

**Your data** (settings with your API keys, the database, backups of migrated pages, logs) is in
`%LOCALAPPDATA%\LK Companion` (paste that into the Explorer address bar), not in the app folder.
**To update**, close the app, delete the old app folder, and unzip the new package in its place;
your data stays. Settings → *Where your data is kept* shows the exact folders.

The package is built automatically on GitHub from the source code (`.github/workflows/windows-package.yml`):
on a Windows machine, from a fresh checkout with no keys, after all tests pass, and it is
started and checked there before it is published. To build it yourself:
`npm ci && npm run package:windows` (output in `dist/`).

## Running from the source folder

This is for development, or for macOS and Linux.

### Prerequisites

- **Node.js 22.13 or newer** (22 LTS or 24 LTS). Check with `node --version`. Download from <https://nodejs.org>.
  No compilers or Windows build tools are needed: the database is Node's built-in SQLite. On Node 22 you may see a one-line
  “SQLite is an experimental feature” warning when the app starts; it is harmless.
- **A LegendKeeper API key.** The project owner must be on a **paid plan** (a trial does not count).
- **Optional: an AI key** for AI drafting, transcribing images, and AI tag suggestions. Either an **OpenRouter key** (<https://openrouter.ai/settings/keys>; the default, free models only, no payment needed) or an **Anthropic key** (<https://console.anthropic.com>; paid, and also transcribes scanned PDFs). Without one, everything else works: structural drafting, audits, rule-based tagging and structural template migration need no AI.

### Installation

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

### Configuration (settings file)

When running from the source folder, settings live in `.env.local` (ignored by Git, so your keys
never get committed). In the Windows package the same settings live in
`%LOCALAPPDATA%\LK Companion\settings.env` (or `<LKC_HOME>/settings.env` when `LKC_HOME` is
set). Keys and the AI choice saved from the app's Settings page are written to that file and
apply at once; for other changes, restart the app.

| Variable | Required | Meaning |
| --- | --- | --- |
| `LEGENDKEEPER_API_KEY` | yes | Your LegendKeeper key (`lk_…`). |
| `LEGENDKEEPER_BASE_URL` | no | Leave empty for the real LegendKeeper. Set to `http://127.0.0.1:4010` to use the rehearsal server. |
| `LKC_ALLOW_WRITES` | no | Creating pages (after your approval) is on by default. Set to `false` to make the app read-only. |
| `LKC_SANDBOX_PARENT_ID` | no | The ID of a page for the optional throwaway write check. |
| `OPENROUTER_API_KEY` | for AI | Your OpenRouter key (`sk-or-…`). Only free models are ever used with it. |
| `ANTHROPIC_API_KEY` | for AI | Your Anthropic key (`sk-ant-…`). |
| `LKC_AI_PROVIDER` | no | `openrouter` or `anthropic`. Default: OpenRouter when its key is set (or when neither key is set), otherwise Anthropic. The Settings page can override it until restart. |
| `LKC_OPENROUTER_MODEL` | no | The free OpenRouter model. Default: `openrouter/free` (OpenRouter picks an available free model). Any other value must end in `:free`; anything else is refused. |
| `LKC_AI_ENABLED` | no | `false` switches AI off completely. Default: on. |
| `LKC_AI_MODEL` | no | Claude model. Default: `claude-opus-5-5`. |
| `LKC_AI_EFFORT` | no | Claude only: `low`, `medium`, `high` (default), `xhigh` or `max`. Higher = more thorough and more expensive. |
| `LKC_DATABASE_PATH` | no | Local database file. Default: `./data/lk-companion.db`, or `<LKC_HOME>/lk-companion.db`. |
| `LKC_HOME` | no | A folder for the settings file, database and logs (the Windows package sets it to `%LOCALAPPDATA%\LK Companion`). |
| `LKC_PORT` | no | Port used by the launcher (`npm run app`, *Start LK Companion*). Default 3127 for the package, 3000 for the source folder. |
| `LKC_MAX_UPLOAD_BYTES` | no | Largest upload. Default 2,000,000. |
| `LKC_MAX_SOURCE_CHARS` | no | Longest source per import. Default 150,000 characters (bigger sources are split, never truncated). |
| `LKC_MAX_DOCUMENT_BYTES` | no | Largest file in a batch import (PDF, Word, HTML, images). Default 25,000,000. Each file is uploaded separately, so a batch can hold many such files. |

You can also enter API keys on the **Settings** page: **Save on this computer** writes them to
the settings file above; **Use for this session only** keeps them in memory until the app
stops. Either way they are never stored in the database, never shown again, and never logged.
Anyone who can read the settings file can read your keys, so keep it on your own computer.

## Creating a LegendKeeper API key

1. In LegendKeeper, open your project → **Project Settings → Developers → API Keys**. You need the ADMIN role to create keys.
2. Name it (e.g. "LK Companion"), choose a role, create it, and **copy the secret now** — it is shown only once.
3. Paste it into the app (dashboard on first start, or **Settings → API keys → Save on this computer**). From the source folder you can instead put it in `.env.local` as `LEGENDKEEPER_API_KEY=lk_…`.

**Which role?** A key acts as you, with the *lower* of the key's role and your role in the project.

- **MEMBER** is enough for reading pages, and for creating pages *under a parent page you can edit*.
- **ADMIN** is additionally needed for the live **tag list** (with a MEMBER key the app counts tags from its own scan instead) and for creating pages at the **top level** of the tree.

Choose the lowest role that does what you need. Revoke the key in the same place if it ever leaks.

## Configuring the AI provider

The app can use either of two AI providers. Choose on the **Settings** page (until restart)
or with `LKC_AI_PROVIDER` in `.env.local`.

### OpenRouter, free models only (the default)

1. Create a key at <https://openrouter.ai/settings/keys>. Leave its credit limit at **$0**.
2. Paste it into **Settings → API keys → Save on this computer** (or the first-start screen). From the source folder you can instead put it in `.env.local` as `OPENROUTER_API_KEY=sk-or-…` and restart.

The app uses only free models, and checks this three times for every request:

1. **Before sending**: the model must be `openrouter/free` or end in `:free`, *and*
   OpenRouter's live model list must show it with every price at 0. Otherwise nothing is sent.
2. **In the request**: every request tells OpenRouter the most it may cost is 0
   (`provider.max_price`), so OpenRouter refuses rather than route to a paid provider.
3. **In the reply**: a reply that reports any cost, or comes from a model not marked free, is
   discarded and the job stops with an error.

On your account's side, a key with a **$0 credit limit** and an account with **no purchased
credits** cannot pay for anything anyway. The Settings page shows the key's limit, account
tier and free requests left today (read from OpenRouter; the key itself is never shown).

Things to know about free models:

- **Limits**: OpenRouter allows 20 free requests a minute and **50 a day** on accounts that
  have never bought credits (1,000 a day after buying at least $10 of credits, which the app
  still would not spend). One AI draft is usually 1 request (2 if the reply needs a retry), so
  keep a batch's AI limit (25 by default) within what is left today.
- **Privacy**: free model providers may log prompts and use them for training. Only send
  material you are happy to share. If you turn off free endpoints that log or train in
  OpenRouter → Settings → Privacy, there may be no free model left to answer.
- **Quality**: free models are smaller and slower than Claude (a single NPC took about a
  minute). Review drafts carefully: in testing, a free model marked an inferred value
  (gender from “he”) as stated in the source and repeated a section under two headings.
- **Images**: transcribed with `openrouter/free`, which picks a free model that reads images.
  **Scanned PDFs** are not transcribed (OpenRouter's PDF reading for scans is paid); export
  the pages as images, or use an Anthropic key.
- Which free model answered is recorded on each draft and job.

### Anthropic (Claude)

Add `ANTHROPIC_API_KEY` to `.env.local` and set `LKC_AI_PROVIDER=anthropic` (or choose
Anthropic on the Settings page; with only an Anthropic key it is used automatically). The
default model is Claude Opus 5.5 at "high" effort. This is paid per use. The app enables
Anthropic's server-side refusal fallback, so if a request is declined by a safety filter it
can be answered by a fallback model; the draft records which model actually answered.

**What is sent to the AI** — only when you choose an AI option, and only for that job:

| You choose | What is sent |
| --- | --- |
| *Run AI transformation* (import) or AI drafting (batch) | The record's source text, the recipe's instructions and field list, the template's section headings, and the **names** of your existing tags. At most the batch's AI limit per run (25 by default). |
| *Transcribe with AI* on an image or scanned PDF in a batch | That file (images only with OpenRouter). |
| AI tag suggestions (switched on in the tagging settings) | Each selected page's name, place in the tree, current tags and up to 6,000 characters of its text, with your allowed tag names. |
| AI drafting in a template migration | Each selected page's readable text, the recipe's instructions and a rule to reorganise, not rewrite. |
| Event discovery with *Also ask the AI* | Each listed page's name and text (up to 8,000 characters), for at most the number of pages you set. One request per page. |
| *Compare with AI* (Knowledge analysis, or a Task Assistant comparison) | The names and text (up to 6,000 characters each) of the 2–5 pages you chose. One request. |
| *Plan with AI* (Task Assistant) | Your request, the list of the assistant's operations, entity kinds and your tag names. No page text. One request. |

Everything else in Phase 3 (chronology, date reading, rule-based event discovery, knowledge
analysis, the relationship browser, search, and planning common requests) needs no AI.

It goes to the provider chosen on the Settings page: OpenRouter (which passes it to the free
model's provider) or Anthropic. Never your API keys, never anything automatically, and never pages you did not select. Results
are cached by content fingerprint, so an unchanged input is not sent twice. Turn AI off on
the Settings page or with `LKC_AI_ENABLED=false`; everything that does not need AI keeps working.

## Running the app (source folder)

```sh
npm run app          # installs and builds when needed, starts the app, and opens it in its own window
# or
npm run dev          # development mode, http://127.0.0.1:3000
npm run build && npm start   # production mode, http://127.0.0.1:3000
```

On Windows, double-clicking **Start LK Companion.cmd** in the source folder does the same as
`npm run app` (Node.js must be installed). The app only accepts connections from your own computer.

## First run, step by step

1. Open the app. If no LegendKeeper key is set yet, the dashboard asks for it (and optionally an OpenRouter key) and saves it on this computer. The connection is tested automatically; the dashboard and **Connection** page show your project name and ID.
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

## Chronology

**Chronology** builds a local history of your world from what the project already holds. It
reads nothing from LegendKeeper except, on request, its timelines (read-only), and it is not a
LegendKeeper timeline itself.

- **What it is built from:** event pages (tagged Event, History, Battle… or of the historical
  event type), dated by their Date / When / Year field or the first date in their opening
  text; dated fields on other pages (Born, Died, Founded, Destroyed); events on LegendKeeper
  timelines (press *Read LegendKeeper timelines*); and events you accepted in event discovery.
  Page content comes from the last Wiki Health audit that read each page, so **run an audit
  first** (pages read before Phase 3 must be audited again to include their infobox fields).
- **Dates** are kept exactly as written and read without losing uncertainty: `576 CY`,
  `Fireseek 12th, 576 CY`, `c. 576 CY`, `576–585 CY`, `from 582 to 584 CY`, `the 590s CY`,
  `the 400s CY` (read as 400–499, with a note), `late 6th century CY`, `50 BCY`, `shortly after
  576 CY`, `before the Greyhawk Wars`, `unknown`. A bare year in a Date field is read in the
  default era and marked “era assumed”. Each entry shows the wording, how it was read, and any
  notes.
- **Calendars** (Calendars tab, JSON): each calendar lists its eras, months and the LegendKeeper
  calendars that use it. The default is Greyhawk's Common Year (CY, with BCY before it) with its
  twelve months and four festivals, plus Gregorian. An era converts to the primary era only with
  a configured `offset`; other reckonings are recognised but not placed in order (the app does
  not invent conversions). A LegendKeeper calendar with exactly the same months and eras is
  linked automatically (your “Greyhawk (Use This)” calendar is); a timeline on any other
  calendar (e.g. the Iggwilv timeline, which uses Gregorian) shows under that calendar until you
  link it.
- **Browse:** filter by calendar, year range, text, who or what an event involves (or any
  person/faction/place/deity), tag or lane, and source. *Events per period* groups dense
  periods into bars (by year, decade or century); click one to show that period.
- **Uncertain & undated** lists approximate, relative, unplaced and undated entries.
- **Conflicts** lists events whose sources disagree on the date (allowing ±5 years for
  approximate dates; configurable), deaths before births, and events dated after someone's
  recorded death (marked *possible*). *Check for conflicts* records them in the review queue,
  where you mark them intentional, resolved or needing research. Nothing is resolved for you.
- **Add to a LegendKeeper timeline** (on an entry or an accepted event): choose a timeline and
  lane you created in LegendKeeper, see the final preview (the exact date sent, the event id
  chosen now, the linked page), tick and approve. The event is sent once and read back.
  Approximate, relative and undated events are refused, because LegendKeeper cannot record
  uncertainty and reads loose wording wrongly (it read “c. 576” as Coldeven 576 in a test).
  To change or remove an event, use LegendKeeper.

## Event discovery

**Chronology → event discovery** finds historical events described in ordinary pages: named
events (“the Greyhawk Wars”, “the Battle of Emridy Meadows”) and sentences with a date and an
event word (founded, sacked, crowned, born, died, raided, signed…).

1. Choose pages (all read pages, a folder, a tag, or a list) and press *Check what will be
   read*. Optionally tick *Also ask the AI to read up to N pages*: the preview lists exactly
   which pages' text (up to 8,000 characters each) goes to which provider.
2. *Find events.* Each candidate cites its sentence, proposes a title, date (as written),
   people/factions/places (linked only when a name matches exactly one page), a summary, and
   says whether it is a single source and whether a record may already exist.
3. Accept, edit (title, date, summary), reject, or mark *needs research*. Accepted events join
   the chronology. *Make a draft page* turns one into an ordinary import draft with your event
   recipe; it is written only after its own final preview and approval.

The same passage never produces a second candidate. Candidates that cite the same sentence
(the rule-based reader and the AI may name an event differently) are merged; candidates whose
dates disagree stay separate, so the disagreement is kept. Your decisions stay unless the cited
wording changes. AI proposals must quote the page word for word and their date must be words
from that quote; anything else is dropped, and AI proposals are never marked “stated”.

## Knowledge analysis

**Knowledge analysis** works only from the local index and the content audits read; running it
changes nothing in LegendKeeper. Choose pages and checks, press *Analyse*:

| Check | Finds | Your options |
| --- | --- | --- |
| Suggested relationships | Relationships the wording states (“…is worshipped by…”, “…lies in…”, “…a member of…”) where neither page links to the other or names it in a field. | Accept or reject (recorded in the app; add the link or field in LegendKeeper if you want it there). |
| Unlinked mentions | A page names another page exactly without linking it (names shared by several pages, rules/glossary pages and folder pages are skipped). | Accept or reject; links can be added with a template migration, which adds links and changes nothing else. |
| Missing pages | Names used on several pages with no page or alias (generic words, rules terms, sentence-opening words and parts of existing names are filtered), grouped by likely kind. | Accept, then *Make a draft page* with any recipe. |
| Contradictions | The same field with different values on same-named pages; a title used for a person elsewhere that their page does not give (*possible*); and AI comparisons you ran. | Intentional, resolved, needs research, reject. |
| Naming | Spellings that differ from a page's name only in spacing, hyphens or capitals (“Sea-Princes”, “WeeJas”), and pages with near-identical names. | Intentional (add an alias), resolved, reject. Nothing is renamed or merged. |

**Compare a few pages with the AI** (optional, one request) lists contradictions between 2–5
pages; each finding must quote at least two pages word for word or it is dropped, and its
explanation is shown as a suggestion. Date disagreements are on the Chronology page.

## Relationship browser and search

**Relationships** shows one page in the middle and the pages connected to it, as a graph (line
style shows the support: link or field, wording, page tree, accepted AI suggestion) and a table
with the evidence. Filter by relationship, support and kind; click a neighbour to move to it.
LegendKeeper has no backlinks endpoint, so incoming links are found by reading the pages audits
have read; the page says how many are not read yet.

**Search** combines name/alias, kind, tags, folder, page text, a field and its value, chronology
dates, links to or from a page, open findings, and read/unread, and shows why each page
matched. Save searches by name. It searches the local copy; for LegendKeeper's own full-text
search use the Page browser. Semantic (embedding) search was considered and not added: names,
tags, fields and links already locate pages well, and embeddings would need an external service
or a large local model.

## Task Assistant

Describe a task in ordinary words, e.g. *Find all untagged NPC pages in Saltreach*, *Find
historical events involving Iuz that have no confirmed date*, *Identify pages mentioning the
Lanternwardens that are not linked to it*, *Find creatures that appear to use the old statblock
layout*, *Suggest a chronology of events mentioned in these pages: Iuz, Iggwilv, Tasha*, *Find
inconsistencies between "Iuz" and "The Soul Husks of the Old One"*, *Prepare a report of all
references to Wee Jas*.

*Make a plan* shows how the request was understood, the steps (each one of the app's own
operations, marked *reads only*, *records findings in the app* or *opens another tool*), which
pages the names refer to, what (if anything) would go to the AI, and the limitations. Names that
match several pages, or none, are asked about rather than guessed. Read-only plans run straight
away; a step that sends page text to the AI needs a tick first. The assistant never writes to
LegendKeeper: “add tags…”, “fix the links…” and similar requests are handed to the Tagging
assistant, Template migration, Import studio or Chronology, which show their own final preview.

*Plan with AI* (optional) sends only your request, the list of operations and your tag names (no
page text) to the selected provider; its plan is checked against the same list, and anything
outside it is rejected. Common requests need no AI.

## The review queue

**Review queue** lists everything waiting for you, highest severity first: writes with an
unknown outcome, failures, possible duplicates and drafts to review, tag suggestions (new tags
first), migrations that change numbers or have text that did not fit, pages changed after an
audit, pages in open jobs that no longer exist, and (Phase 3) proposed events, conflicting
historical claims, unresolved chronology, missing pages, suggested relationships, naming
inconsistencies, contradictions and suggested links. Each Phase 3 entry quotes its evidence and
the decisions available; decided entries leave the queue and come back only if the cited
wording changes. Each entry says why and links to where you
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
- **Chronology:** CSV or JSON, with each date as written, how it was read (kind, precision,
  approximate, calendar, sort range, notes), the source page ids, fields and passages, and
  conflicts.
- **Knowledge findings** (and event candidates): CSV or JSON, with whether each is explicitly
  stated, inferred or an AI suggestion, your decision, and the cited page ids and passages.
- **Relationships:** CSV or JSON for the whole project or one page, each marked explicitly
  supported (page tree, link, field) or suggested (wording, accepted AI).

Phase 3 exports quote at most 300 characters of each cited passage, never whole pages.

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
- **`src/server/ai/`** — the AI provider interface, the OpenRouter implementation (free models only, `openrouter.ts`), the Claude implementation (structured outputs, validated again in code), and the version-controlled prompt (`prompts/transform.ts`, with `PROMPT_VERSION`).
- **`src/server/services/`** — connection, discovery (scan/browse), tags, recipes/templates, imports, transform, drafts, write, settings, audit; Phase 2: `batch-engine` (background work per job, pacing, cancel), `import-batches`, `wiki-health`, `tagging-batches`, `migrations`, `page-scope` (page selection), `review-queue`.
- **`src/server/lk/page-reader.ts`** — reads an existing page for migration (text → Markdown; everything else kept as is). **`src/core/migration-check.ts`** — the word-for-word, number and link comparisons. **`src/core/audit-checks.ts`**, **`src/core/tag-assistant.ts`**, **`src/core/matching.ts`**, **`src/core/records.ts`** — the pure logic of audits, tag suggestions, duplicate matching and record extraction.
- **`src/server/extraction/`** — reading PDF (unpdf), Word `.docx` (mammoth, no external file access) and HTML on your computer.
- **`src/server/db/`** — SQLite using Node's built-in `node:sqlite` module (no native add-on to install), with versioned migrations and repositories.
- **`src/app/`** — Next.js pages and `/api` routes. `src/proxy.ts` refuses non-localhost requests and cross-site writes.

- **Phase 3:** `src/core/chronology/` (calendars, date reading, chronology entries, event discovery), `src/core/knowledge/` (entity kinds, relationships, missing pages, contradictions, naming), `src/core/assistant/plan.ts` (the plan schema, the allowed operations and the rule-based interpreter); services `chronology`, `event-discovery`, `timeline-writes`, `knowledge-base`, `knowledge-analysis`, `knowledge-items`, `knowledge-drafts`, `task-assistant`, `advanced-search`, `phase3-exports`; AI analysis prompts in `src/server/ai/prompts/analysis.ts` (event extraction, page comparison, task planning: fixed prompts and schemas). The connector gains read operations for calendars, timelines, lanes and events, and one write: `createTimelineEvent` (with an event id chosen before the write, never retried).

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
automatically). Phase 3 adds: labelled fields and link texts in the per-page summary, copies of
LegendKeeper timelines and their events as last read, chronology and analysis findings and
event candidates with your decisions (each citing short passages), analysis runs, saved
searches, timeline-event write records, and the calendar settings. The source text of an import is kept only while the
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
npm test               # 278 unit and contract tests; never touch LegendKeeper, OpenRouter or Anthropic
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

Phase 3 adds (on a small fictional Greyhawk wiki held by the mock connector): date reading and
preservation of approximate, ranged, relative, unknown and unconvertible dates; calendar
settings; chronology built from event pages, fields and timelines; conflicting dates and
impossible sequences with their sources; event extraction across several pages, merging,
disagreeing dates kept apart, duplicate prevention and reconsidering decisions when wording
changes; AI proposals checked against the page (invented quotes dropped, dates outside the
quote ignored, free daily limit); accepting, editing and drafting candidates; timeline writes
(preview, approval token, pre-chosen id, refusal of uncertain dates, writes switched off, lost
reply resolved by reading, no duplicates); entity matching and ambiguous names; explicit versus
inferred relationships; missing pages; contradictions and naming variants; review queue entries
and persisted decisions; Task Assistant plans, clarification, the allowed operation set, AI
confirmation and AI plan validation; combined and saved searches; and every export.

### Optional integration tests (real LegendKeeper)

These never run with `npm test`. They need explicit opt-in:

```sh
# Read-only — changes nothing:
LKC_INTEGRATION=1 LEGENDKEEPER_API_KEY=lk_... npm run test:integration

# Plus live writes: creates test pages "LK Companion integration test …" under your sandbox page
# (one to test creation; one to test tag replacement, version-checked content replacement and restore;
#  and a throwaway timeline with one test event, to check the timeline event write)
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
- **Timelines** *(Phase 3)*: the API can read timelines, lanes, events and calendars, and create, change and delete them. The app reads them, and **adds** single events to an existing lane with approval; it does not create timelines, lanes or calendars, and never changes or deletes an event (do that in LegendKeeper). LegendKeeper stores a date's precision (year, month, day) but **not whether it is approximate**, and has no way to say an event is only known relative to another, so such events stay in the local chronology only. `formattedStart` is parsed loosely by LegendKeeper (live test: “c. 576” → Coldeven 576, “-50” → 50 CY, “the 590s” → 590), so the app sends only plain forms it builds itself and checks the result on read-back. Events have a name and an optional page link, but no description field.
- **Chronology and analysis** work from the page content the last audit read (the first 20,000 characters of each page's text, plus its fields and links); pages not yet read are left out and counted on screen. Rule-based reading finds events and relationships stated in common wording; unusual phrasing needs the optional AI or your own review. Names shorter than three letters are not matched in running text.
- **Relationships** cannot be written as such: LegendKeeper has no relationship objects. Links can be added to existing pages with a template migration; fields with the page editor in LegendKeeper.
- **Deleting** pages is deliberately not offered. The tests and probes that create test pages delete only their own pages, and only when explicitly asked.
- SDK 4.0.0 is new. It is pinned exactly; read the SDK changelog before upgrading.

## Troubleshooting

| Message | What to do |
| --- | --- |
| *No LegendKeeper API key is configured* | Enter it on the dashboard or under Settings → API keys (*Save on this computer*). |
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
| *No OpenRouter API key is configured* | Add `OPENROUTER_API_KEY`, choose Anthropic on the Settings page, or use *Run structural (no AI)*. |
| *The free-model limit was reached* (OpenRouter 429) | You have used today's free requests (50 a day) or sent too many in a minute. Wait and try later; the Settings page shows how many are left today. Or use the structural option. |
| *…is not a free OpenRouter model* / *…lists … with a price* | `LKC_OPENROUTER_MODEL` names a paid model. Use `openrouter/free` or a model ending in `:free`. |
| *No free provider is available for this model right now* | Every free provider for it is busy or gone. Try later, or use `openrouter/free`. |
| *OpenRouter has no free endpoint that matches your privacy settings* | OpenRouter → Settings → Privacy blocks the free endpoints. Allow them (they may log prompts) or use Anthropic. |
| *OpenRouter refused the request for lack of credit* (402) | Your OpenRouter balance is negative. Check the account; the app never buys anything. |
| *OpenRouter reported a cost…* / *…not marked free* | The safety check discarded the reply and stopped the job. Check your OpenRouter activity page and keep the key's credit limit at $0. |
| A request ID is shown | Quote it to LegendKeeper support; it identifies their server log entry. |
| A batch says *interrupted* | The app stopped mid-job. Open the job and continue; writes that were in flight are checked first. |
| *The page changed in LegendKeeper after the analysis / since the suggestion* | Someone edited the page. Compare (or suggest) again, check, and approve again. |
| *Tick every change you have checked first* (migration) | Open the page's comparison and tick each number change after checking it. |
| *The draft was edited after this comparison* (migration) | Press *Refresh comparison*, check it, then approve. |
| *The page was edited after the migration* (restore refused) | Use *Restore, overwriting later edits* if you are sure, or *Download original*. |
| *Writes are switched off* in a dry run | Remove `LKC_ALLOW_WRITES=false` from the settings file (`.env.local`, or `settings.env` in your data folder) and restart. |
| A PDF says *needs transcription* | It has no text layer (scanned). Use *Transcribe with AI*, or export a text PDF. |
| *…is larger than the … byte limit* when adding a file | Files are uploaded one at a time up to `LKC_MAX_DOCUMENT_BYTES` (25 MB by default); split larger files or raise the limit. |
| Database problems | Restore your backup of `data/` (see *Backups*), or stop the app and delete `data/` to start fresh (your LegendKeeper project is not affected, but the app's history and recovery records are lost). |
| `npm ci` fails while compiling something (`node-gyp`, `MSBuild`, Windows SDK) | You have an older copy of the project that used a compiled database add-on. Download the latest version; it needs no build tools. |
| Chronology is empty, or misses infobox dates | Run a Wiki Health audit (it reads the pages). Pages read before Phase 3 need one more audit to record their fields. |
| Timeline events show under another calendar, or “not linked to a calendar setting” | Link the LegendKeeper calendar to one of your calendars on Chronology → Calendars (`lkCalendarIds`), or choose that calendar in the filter. |
| *The date is approximate … LegendKeeper cannot record that a date is uncertain* | Edit the accepted event to the exact date you have decided on, or keep it in the local chronology only. |
| A timeline write says *uncertain* | Press *Check outcome*: it looks for the event by its planned id; nothing is sent again. |
| *“…” matches N pages. Which one?* (Task Assistant) | Choose the page in the plan, or write the page id or link in your request. |
| *This plan sends page text to the AI provider. Confirm that first.* | Tick the confirmation under the plan after reading what will be sent, or rephrase the request to avoid the comparison. |
| *The AI proposed a plan the app does not allow* | The AI planner used an operation outside the list; rephrase, or use *Make a plan* without AI. |
| Windows says it protected your PC / asks whether to run *Start LK Companion* | The files came from the internet. Choose *More info → Run anyway*, or unblock the zip before unzipping (right-click → Properties → Unblock). |
| The small window says *The app did not start within a minute* | Look at `%LOCALAPPDATA%\LK Companion\logs\server.log`. Another program may be using port 3127: close it, or set `LKC_PORT` (e.g. 3130) in the settings file. |
| Nothing opens after *LK Companion is running* | Open <http://127.0.0.1:3127> in any browser. |
| *Could not find a production build* or *This copy of LK Companion is incomplete* | The download is missing the `app\.next` folder (packages built before 12 October 2026 had this fault). Download the latest package again and unzip all of it. Your settings and data are kept. |
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
docs/PHASE3_REPORT.md Phase 3 plan, milestone reports and definition of done
```
