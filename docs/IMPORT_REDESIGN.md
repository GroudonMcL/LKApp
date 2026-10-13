# The new import, dashboard and relationship map (13 Oct 2026)

What changed, why, and what was checked.

## Import

**Before:** one source → one page with a recipe you picked, or a batch split by fixed rules
(headings, statblocks) with one recipe for every record. A web page full of menus and comments,
or a source mixing creatures and characters, needed hand work.

**Now:** *Import* takes files, saved web pages or text and needs no recipe.

| Step | Who does it | Safeguards |
| --- | --- | --- |
| Page kinds | Set up once from your LegendKeeper templates (reads only) | Matched to a built-in type by name and fields; other rows become fields; templates unlike any type get their own; your earlier copies and layout rules are reused |
| Sort | AI, answering with line numbers only | The app cuts the text itself (nothing reworded); clutter and unplaced lines are listed; headings the AI skipped stay with their page; empty answers retried once, then split without AI; instructions in the source reported and ignored |
| Draft | AI per page, with the page kind's recipe | Same checks as before (values traced to the source, uncertain values never written); any edition mapped to the fields as written, unmatched statistics kept; no required fields |
| Secrets | App, after the AI | Text under a secret heading always goes to Secrets and the template's secret block; copies elsewhere are moved; fields repeating it are not written |
| Check | App (reads only) | Duplicate matching, then every final-preview check |
| Create | You: one button for the ticked pages | Pages with warnings only when ticked; each page re-checked just before writing; written with the established guarded write |

## Dashboard and pages

The dashboard has the Task Assistant (left) and Search (right) on top, AI and LegendKeeper status
icons in the corner, a grid linking every tool, and the review queue in a column on the right
(with *Expand* and *History & audit*). Project figures, write status and recent activity are
under *Project at a glance*. Most pages now open with one line; the full explanation, extra
filters and options are behind *More information*, *More filters*, *Audit options* and similar.

## Relationship map

*Relationships → Map*: the whole project, or the pages around one, up to 3000 pages, laid out
with d3-force on a canvas (drag, zoom, find, click for details). Same relationships as the
one-page view.

## Verified live (test project, sandbox only, free OpenRouter models)

- Page kinds set up from all 7 templates (Character, Class Details, God, Magic Item, Spell,
  Statblock, Subclass); nothing written to LegendKeeper.
- A made-up blog page (navigation, cookie notice, advert, byline, a 1st-edition AD&D monster,
  an NPC with a *Secrets* subsection, share buttons, reader comments including an "ignore all
  previous instructions" line, related posts, footer): 2 pages found (Bog Hag → Statblock,
  Mother Sallow → Character), 12 pieces of clutter left out, the injected instruction reported.
- Bog Hag: AC, move, alignment and size in the Statblock fields; Hit Dice, Frequency, Treasure
  Type etc. kept word for word under *Other Statistics*; nothing converted.
- Mother Sallow: the Character template's boxes and fields unchanged (blank where unknown); the
  secret **inside the template's secret block**, nowhere else (read back from LegendKeeper).
- Problems found on the way and fixed: one free model returned no entries (now retried, then
  split without AI); another put the secret into Background and Relationships and a visible
  field (now moved by the app); the sort dropped the "Secrets" heading line (headings now stay
  with their page); 1st-edition monsters were blocked by a required Hit Points field (import
  recipes require none).
- Test pages left in the sandbox: *Bog Hag*, *Mother Sallow*.
