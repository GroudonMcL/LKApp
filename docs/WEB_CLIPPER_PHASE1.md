# LK Web Clipper — Phase 1: proving the LegendKeeper integration

Phase 1 of the Web Clipper brief: before building a Chrome extension, prove against a real
LegendKeeper test project that the API does everything the clipper needs. Run live on
**13 Oct 2026** against the **AI Test Project** (ADMIN key, ~300 pages) with `@legendkeeper/sdk`
**4.1.0**. Result: **29 of 29 checks passed** (runs *10:20* and *10:24*; the 10:24 run used the
final code, with automatic write retries switched off).

## What to look at in LegendKeeper

Everything is under the top-level page **LK Web Clipper Sandbox** and was left in place:

```
LK Web Clipper Sandbox
├─ Phase 1 run 2026-10-13 10:19   first run; 5 FAILs from bugs in the checking script (note at the top)
├─ Phase 1 run 2026-10-13 10:20   29/29, same pages as below
└─ Phase 1 run 2026-10-13 10:24   ← the latest results table (29/29), final code
   ├─ Sources
   │  └─ Clipper Test Source               a new Source page: a "Backlinks" collection only
   ├─ Clip test — Red Dragon notes (new page)
   │     H1 "From D&D Beyond" (a mention of your existing Sources / D&D Beyond page),
   │     then headings, bold/italic, lists (nested), numbered list, quote, table, code,
   │     an external link, mentions of Bestiary / Dragon and World of Greyhawk, an uploaded image
   ├─ Clip test — Dragon research (existing page)
   │     "My notes" (unchanged), then two appended clips, each after a divider with its own
   │     "From <Source>" heading; the second was written after a simulated edit in LegendKeeper
   │     ("Typed in LegendKeeper while the clipper was writing." is kept)
   ├─ Clip test — blank folder page          a page whose tab was still blank, appended to
   └─ Clip test — map page (not appendable)  a map tab, which the clipper refuses to append to
```

Open **Clipper Test Source** and **Sources / D&D Beyond** to see their Backlinks collections
list the clipped pages. That collection is worked out by the LegendKeeper app when the page is
shown; the API only stores its filter (see *Findings*).

## Phase 1 checklist (from the brief)

| Brief item | Result | How it was proved |
| --- | --- | --- |
| Load project details | ✅ | `project()` → name and id; key role detected (ADMIN: `tags.list` allowed). |
| Retrieve the resource hierarchy | ✅ | All pages read 100 at a time (3 calls, ~1 s for ~300 pages); paths built from parents, e.g. `Bestiary / Dragon / Adult Red Dragon`; templates left out. |
| Search for a resource by name | ✅ | Local ranked search + LegendKeeper's content search (see *Search* below). |
| Create a new page under a chosen parent | ✅ | Client-chosen id + Idempotency-Key, so a repeated request cannot make a second page. |
| Write basic formatted blocks | ✅ | H1–H3, bold, italic, bullet list with a nested list, numbered list, quote, table with header row, code block, external link; all read back. |
| Append formatted content to an existing page | ✅ | Divider + H1 "From <Source>" + content after the existing blocks; the existing blocks read back **identical**. |
| Insert a genuine mention of an existing resource | ✅ | Mentions read back as `{ mention: { resourceId, name } }` with the target's current name. A mention can carry its own label (`Greyhawk` → *World of Greyhawk*). |
| Create a Source resource with a dynamic backlink collection | ✅ | Same shape as your existing Source pages (titled "Backlinks", `scope: 'edges'`, `targetId equals $self`), checked against *D&D Beyond*. |
| Upload an image and create an image block | ✅ | Downloaded from the web, type checked from its bytes, uploaded with `assets.uploadImage`, used in an image block; a web page posing as an image is refused. |
| Permissions and versioned writes | ✅ | Append uses `replaceBlocks` with `ifMatch`; an edit made between read and write gets 412, the clipper re-reads and re-applies, nothing is lost (2 attempts). |

## Findings that shape Phases 2–5

1. **LK Companion is already the "small local Node.js service".** ChatGPT recommended an
   extension plus a local service that holds the API key and uses the official SDK. This app
   is exactly that (local-only, SDK-based, with a localhost request guard). The clipper's
   LegendKeeper code lives here (`src/server/clipper/`), and in Phase 2 the extension should
   call a few new local endpoints, never LegendKeeper directly. The key never reaches a web page.
2. **LegendKeeper's own search does not put the exact name first.** For "Dragon" it returned
   *Red Dragon Wyrmling*, *Adult Red Dragon*, then *Dragon*. The clipper's local ranking gives
   the order the brief asks for: exact name → names starting with it → names containing the
   word → aliases → near spellings ("Dragn" finds *Dragon*) → tags → content matches from
   LegendKeeper. The local index is cheap (one list call per 100 pages), so it can be refreshed
   whenever the side panel opens.
3. **Folder pages have a blank tab.** 17 pages (e.g. *Bestiary*, *Dragon*, *Sources*) have a
   tab that is still `blank`. Appending to one works: the first write turns it into a page
   (verified), and the clipper leaves out the divider on an empty page.
4. **Some pages have several page tabs** (11 here). The destination picker must offer a tab
   choice for those; maps and timelines are refused as append targets (verified).
5. **Appending is safe but replaces the whole tab.** The API's atomic option is a whole-tab
   replace with a version check; existing blocks are sent back exactly as read and come back
   identical. Blocks the API cannot express (`unsupported`) survive only if they carry an id,
   so the clipper gives them ids first when needed (no visible change). Inserting block by
   block would avoid touching existing content but is not atomic; the replace is used.
6. **Backlinks cannot be listed through the API.** The Backlinks collection is evaluated by
   the LegendKeeper app. The clipper can rely on it for display, but anything that needs the
   list (e.g. "this source is used by 12 pages") must read pages itself.
7. **Images must be uploaded; a URL is not enough.** Identical bytes uploaded twice got the
   same storage URL but two asset entries, so Phase 4 should put clips in a "Web Clipper" asset
   folder and avoid re-uploading. Uploads are limited to 50 a minute. **In Phase 2 the
   extension should fetch images in the browser** (it has your session for sites that need
   it) and send the bytes to the local service; Wikimedia, for example, refused downloads from the
   cloud machine this was run on; your browser would not have that problem.
8. **Website name vs. existing source.** "D&D Beyond" matched the existing source by name,
   but the hostname "dndbeyond" would not. Phase 4's site-name detection should read the page's
   declared site name (`og:site_name` is "D&D Beyond") and compare compacted names.
9. **Key roles.** An ADMIN key was used. A MEMBER key can do everything the clipper does
   under an existing parent page; only creating top-level pages (the sandbox) needs ADMIN.
10. **Rate limits are not a concern for single clips:** a new page is one write; an append is
    one write plus reads (two if the page changed meanwhile); each image is one upload.

## What was built

| File | What it is |
| --- | --- |
| `src/core/clipper/blocks.ts` | The blocks around a clip: source heading (with a mention), new-page layout, append layout, the Source page's Backlinks collection. Pure, no API calls. |
| `src/core/clipper/project-index.ts` | The local page index: paths, ranked search, Source pages (under Sources or tagged *Source*), duplicate-source lookup, writable tabs, in-place updates after a create. Pure. |
| `src/server/clipper/lk-clipper.ts` | `ClipperClient`: project, index loading, search, create page / clip page / Source page, version-checked append with re-try on conflict, image upload (bytes or URL, type sniffed, size limit). |
| `scripts/clipper-phase1.ts` | The live proof of concept that produced the results above. |
| `tests/unit/clipper.test.ts` | Offline tests, including the request bodies validated against the official OpenAPI schema. |

The conversion from web-page HTML to blocks is Phase 2's job; Phase 1 wrote the same kinds of
blocks with the SDK's builders to prove LegendKeeper accepts them.

## Running it again

Only against a test project:

```sh
LKC_CLIPPER_POC=1 npm run clipper:phase1
```

It reads `LEGENDKEEPER_API_KEY` from the environment or `.env.local`, reuses the sandbox page,
adds a new run page with its results table, and writes `data/clipper-phase1-report.json`.
Optional: `LKC_CLIPPER_IMAGE_URL` (another image to clip), `LKC_CLIPPER_SOURCES_ID` (your
Sources page, if it is not a top-level page called "Sources"). It deletes nothing.

## Suggested next step (Phase 2)

A Manifest V3 Chrome extension with a context-menu item and a side panel, talking to new
localhost endpoints in LK Companion (project list, page search, Source search, preview, import),
plus an HTML-to-blocks converter for selected text (headings, paragraphs, marks, links, lists),
images sent as bytes from the browser, and the preview-and-confirm step before any write.
