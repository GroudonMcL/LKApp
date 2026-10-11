# LK Companion — Phase 1

A private web app, running on your own computer, that helps you **import, organise and
maintain your LegendKeeper project** with AI assistance — without losing information,
damaging pages, or inventing facts.

Screenshots from a rehearsal run: [dashboard](docs/screenshots/dashboard.png), [draft review](docs/screenshots/draft-review.png), [final preview](docs/screenshots/final-preview.png).

It complements LegendKeeper; it does not replace it. Everything it does goes through
LegendKeeper's official API and SDK (`@legendkeeper/sdk`).

## What Phase 1 does

| Area | What works now |
| --- | --- |
| **Connection** | Test your API key, see your project's name and ID, run a one-off *write check*. |
| **Page browser** (read-only) | Scan your project's page list into a local index (metadata only, resumable), filter by name/alias/tag/untagged, open any page to see its documents, sidebar properties, plain text, block structure and version. Live LegendKeeper search. |
| **Tag audit** (read-only) | All tags with usage counts; pages with no tags. |
| **Import studio** | Upload `.txt`, `.md` or `.json`, or paste text. Name the import, record the source (title, citation). Long sources are never cut short — split them into sections instead. |
| **Recipes & templates** | Reusable, versioned conversion recipes (page type, template, required fields, JSON mappings, tag and link policy, AI instructions, "allow creation"). Locally configured templates. |
| **AI transformation** | Claude turns a source into a structured draft. Missing values stay missing; every claimed fact is checked against the source text; anything unclear is marked uncertain. A **structural (no-AI)** mode works without any AI. |
| **Review** | Edit everything: name, aliases, parent, fields (with their status), sections, tags (existing vs new), links (choose between ambiguous matches or leave unresolved). Validation, preview, revision history. |
| **Guarded write** | Create **one** page per approval, after a final preview, with duplicate protection, read-back and an audit entry. |
| **History** | Audit log of every connection test, scan, import, transformation, approval and write. |

**Not in Phase 1** (by design): editing, moving, retagging or deleting existing pages; bulk
creation; template migration of old pages; timelines, maps and boards; PDF/DOCX/HTML/image
import; semantic search; multi-user or remote hosting. The architecture is built so these
can be added later (see [Architecture](#architecture)).

## Honest status

- Built against the official SDK **4.0.0**, its documentation and its OpenAPI schema, and
  **verified live** against a dedicated LegendKeeper test project: the capability probe
  (27/27 checks), the live integration tests (5/5), and the full browser workflow from
  connection test to a created, read-back page.
- Page creation still stays **disabled until you run the write check** against *your* project
  (see [First run](#first-run-step-by-step)) — each project is verified separately.
- The AI path has been tested with scripted (mocked) AI responses only. The first real AI
  transformation happens when you add your Anthropic key.

See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the full capability matrix: what the API
offers, what the SDK supports, what this app uses, and how each part was verified.

---

## Prerequisites

- **Node.js 22.13 or newer** (22 LTS or 24 LTS). Check with `node --version`. Download from <https://nodejs.org>.
  No compilers or Windows build tools are needed: the database is Node's built-in SQLite. On Node 22 you may see a one-line
  “SQLite is an experimental feature” warning when the app starts; it is harmless.
- **A LegendKeeper API key.** The project owner must be on a **paid plan** (a trial does not count).
- **Optional: an Anthropic API key** for AI transformations (<https://console.anthropic.com>). Without it, everything except AI transformation works.

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
| `LKC_ALLOW_WRITES` | no | Must be exactly `true` before the app can create anything. Default: off. |
| `LKC_SANDBOX_PARENT_ID` | for writes | The ID of a page that holds test pages (see below). |
| `ANTHROPIC_API_KEY` | for AI | Your Anthropic key (`sk-ant-…`). |
| `LKC_AI_ENABLED` | no | `false` switches AI off completely. Default: on. |
| `LKC_AI_MODEL` | no | Claude model. Default: `claude-opus-5-5`. |
| `LKC_AI_EFFORT` | no | `low`, `medium`, `high` (default), `xhigh` or `max`. Higher = more thorough and more expensive. |
| `LKC_DATABASE_PATH` | no | Local database file. Default: `./data/lk-companion.db`. |
| `LKC_MAX_UPLOAD_BYTES` | no | Largest upload. Default 2,000,000. |
| `LKC_MAX_SOURCE_CHARS` | no | Longest source per import. Default 150,000 characters (bigger sources are split, never truncated). |

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

**What is sent to the AI** — only when you click *Run AI transformation* on an import:
the source text of that import, the recipe's instructions and field list, the template's
section headings, and the **names** of your existing tags. Never your API keys, never other
pages' content, never anything automatically. Turn AI off on the Settings page or with
`LKC_AI_ENABLED=false`; browsing, tag audits and structural imports keep working.

## Running the app

```sh
npm run dev          # development mode, http://127.0.0.1:3000
# or
npm run build && npm start   # production mode, http://127.0.0.1:3000
```

Open <http://127.0.0.1:3000>. The app only accepts connections from your own computer.

## First run, step by step

1. **Connection** → *Test connection*. You should see your project name and ID.
2. **Page browser** → *Scan project*. This copies page names, parents, tags and aliases (no page content) into the local index. You can pause and resume it.
3. **Tag audit** — see tags and pages without tags.
4. **Prepare for writing** (optional, when you are ready):
   1. In LegendKeeper, create an empty page called e.g. *LK Companion Sandbox*. Open it in the page browser and copy its ID.
   2. In `.env.local` set `LKC_ALLOW_WRITES=true` and `LKC_SANDBOX_PARENT_ID=<that ID>`, then restart.
   3. **Connection → Write check**: tick the box and run it. It creates one page called "LK Companion write check …" under the sandbox and reads it back. Page creation is enabled only once this passes. The test page stays; delete it in LegendKeeper when you like.
5. **Recipes** — open an example recipe, adjust it, and (only if you want to write) tick *Allow creation after approval*. Set a *default parent* such as your sandbox page while testing.
6. **Import studio** → paste text or upload a file, choose the recipe, *Create import*.
7. *Run AI transformation* (or *Run structural*). Review the draft tab by tab; fix fields, choose links, accept or reject tags; *Save draft*.
8. *Open final preview* → check everything → tick the confirmation → *Create page*. The result links to the new page and the audit log records it.

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

## How the safety rules work

- **No write without approval.** A finished AI transformation only produces a draft. Creating a page needs: `LKC_ALLOW_WRITES=true`, a passed write check for this project and SDK version, a recipe that allows creation, a draft with no validation errors, a live connection to the expected project, a parent and links that still exist, and your explicit approval of the exact content in the final preview. Editing the draft afterwards cancels the approval.
- **No duplicates.** Each draft gets its page ID before the first attempt. LegendKeeper refuses a second page with the same ID, and each request carries an idempotency key.
- **No blind retries.** A write is never retried automatically. If the outcome is uncertain (timeout, lost connection, server error), the app only *reads* to find out whether the page exists, and shows *Check outcome*.
- **No invented facts.** The AI must mark missing values as missing. The app checks every value the AI calls a source fact: if its quote or its numbers are not in the source, it is marked *uncertain* and not written unless you confirm it. Suggestions are never written unless confirmed.
- **No fake links.** Links use only page IDs that come from LegendKeeper (the index or a confirmed lookup). Ambiguous names must be resolved by you; IDs are re-checked right before writing.
- **Untrusted sources.** Imported text is passed to the AI as data in a fenced block, after rules saying it can never act as instructions. The model has no tools, and its output must match a strict schema. Instruction-like text is flagged to you.
- **Never destructive.** Phase 1 has no code path that edits, moves or deletes existing LegendKeeper content.

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
- **`src/server/lk/`** — the only code that talks to LegendKeeper. `connector.ts` is the interface the rest of the app depends on; `sdk-connector.ts` implements it with the official SDK; `render.ts` turns a canonical draft into LegendKeeper blocks using the SDK's builders; `errors.ts` maps SDK errors to plain-English messages. Phase 1's interface has exactly one write (`createPage`).
- **`src/server/ai/`** — the AI provider interface, the Claude implementation (structured outputs, validated again in code), and the version-controlled prompt (`prompts/transform.ts`, with `PROMPT_VERSION`).
- **`src/server/services/`** — connection, discovery (scan/browse), tags, recipes/templates, imports, transform, drafts, write, settings, audit.
- **`src/server/db/`** — SQLite using Node's built-in `node:sqlite` module (no native add-on to install), with versioned migrations and repositories.
- **`src/app/`** — Next.js pages and `/api` routes. `src/proxy.ts` refuses non-localhost requests and cross-site writes.

The UI never imports the SDK; all LegendKeeper and AI calls happen on the server.

### What the database stores

Recipes (every version), local templates, import jobs, drafts and their revisions, validation
results, the audit log, created page IDs and versions, the write-check record, a
**metadata-only** index of your pages (names, parents, tags, aliases, document list — no
content), and non-secret preferences. The source text of an import is kept only while the
import is open and is deleted when it is completed or cancelled (its SHA-256 hash is kept).
**API keys are never stored in the database.** Delete `data/` to start fresh.

## Recipes in more detail

Most settings are on the recipe form. *Edit as JSON* exposes everything, including:

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
npm test               # 121 unit and contract tests; never touch LegendKeeper or Anthropic
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

### Optional integration tests (real LegendKeeper)

These never run with `npm test`. They need explicit opt-in:

```sh
# Read-only — changes nothing:
LKC_INTEGRATION=1 LEGENDKEEPER_API_KEY=lk_... npm run test:integration

# Plus one live write: creates one page "LK Companion integration test …" under your sandbox page
LKC_INTEGRATION=1 LKC_INTEGRATION_WRITE=1 LKC_SANDBOX_PARENT_ID=<sandbox id> LEGENDKEEPER_API_KEY=lk_... npm run test:integration

# Add LKC_INTEGRATION_CLEANUP=1 to delete that one test page afterwards
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
- Uploads are size-checked before processing, must be valid UTF-8 text, and file names are used only as labels.
- No telemetry or analytics. The npm scripts also switch off Next.js's own anonymous usage telemetry (`NEXT_TELEMETRY_DISABLED=1`, set by `scripts/next.mjs`).
- **Do not expose this app to the internet.** There is no login. Hosting it remotely would first need authentication, HTTPS and proper secret storage.

## Known limitations

- **Templates**: the API cannot read or apply LegendKeeper templates; templates here are configured locally.
- **Filtering**: the API cannot filter resources by name or tag, so browsing relies on the local index, which is as fresh as the last scan.
- **Tag list** needs an ADMIN key; otherwise tags are counted from the index.
- **Backlinks/relationships**: no API endpoint lists them; Phase 1 resolves links only for new drafts.
- **Formats**: PDF, Word, HTML and images are refused with an explanation — paste the text instead.
- **One page per import**: a JSON list or a multi-entry source produces one draft; split it first.
- **Rich text**: the importer understands paragraphs, line breaks, simple bullet lists and `**bold**`. Tables and other Markdown are kept as text.
- **Existing pages are never modified** in Phase 1, so pages with content the API cannot express (`unsupported` blocks) are always safe.
- SDK 4.0.0 is very new (version 1.0.0 appeared four days earlier). It is pinned exactly; read the SDK changelog before upgrading and re-run the write check afterwards (the app requires it per SDK version).

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
| Database problems | Stop the app and delete `data/` to start fresh (your LegendKeeper project is not affected). |
| `npm ci` fails while compiling something (`node-gyp`, `MSBuild`, Windows SDK) | You have an older copy of the project that used a compiled database add-on. Download the latest version; it needs no build tools. |
| *Next.js is not installed in this folder* | Run `npm ci` in the folder that contains `package.json` and wait until it finishes. |

## Project layout

```
src/app/            pages and /api route handlers
src/components/     UI components (draft review, write panel, preview)
src/core/           domain model and pure logic
src/server/         configuration, connector, AI, services, database
src/proxy.ts        localhost-only request guard
scripts/            db:migrate, rehearsal server
tests/unit/         unit and service tests (mock LegendKeeper, mock AI)
tests/contract/     real SDK against a local documented-API server
tests/integration/  optional live tests (opt-in)
docs/CAPABILITIES.md  API/SDK capability matrix
```
