# LegendKeeper Foundations Vol. 3 — what changed and what the app does with it

12 October 2026. LegendKeeper 0.20.0 (*Foundations Vol. 3*) officially released the public API
(v3) and `@legendkeeper/sdk`. The app was already built on API v3 with SDK 4.0.0; the official
release is SDK **4.1.0**.

## What changed in the API

Compared with 4.0.0 (the SDK's `CHANGELOG.md`, and a comparison of the two OpenAPI documents;
the 4.1.0 document is identical to the one served at `/api/v3/openapi.json`):

| Change | Operation |
| --- | --- |
| New: list every template, at any depth, paginated | `GET /templates` — `templates.list` |
| New: create a resource as a copy of a template | `POST /resources/from-template` — `resources.createFromTemplate` |
| New: save a resource (optionally with its descendants) as a new top-level template | `POST /resources/{id}/save-as-template` — `resources.saveAsTemplate` (Admin) |
| Changed: `parentId: 'templates'` accepted by create, createMany and move, and as a list filter | `resources.create/createMany/move/list` |
| Documented: templates are resources under the virtual root `templates`; a resource under a template is a template too | — |

Nothing was removed and no other operation or schema changed. The description's sections on
resource order (`rank`, `after`/`before`), identifiers, idempotency and rate limits are the same
as in 4.0.0.

## What the app does now

1. **SDK 4.1.0**, pinned exactly.
2. **Templates are listed with the documented operation**, including templates inside other
   templates, with their tabs and tags. (Before: an undocumented observation.)
3. **Templates at any depth are recognised in the local index** and kept out of Wiki Health,
   tagging, link suggestions, chronology and analysis, and labelled in the page browser. Before,
   only top-level templates were; the test project's *Subclass Template* (inside *Class Details
   Template*) was being treated as an ordinary page. Database migration 6 adds the flag.
4. **Pages are created from the LegendKeeper template itself** when the local template was copied
   from one (option on by default, per template). Each new page is a real copy of the template —
   sidebar properties (e.g. the Tags box), icon, banner, colour and other tabs — and the app fills
   its first page tab, keeping the built-in boxes the API cannot write (the infobox's Tags and
   Aliases rows), then adds the draft's tags and aliases to the template's. Same guarantees as
   before: final preview, explicit approval, an id chosen in advance plus an Idempotency-Key (a
   second copy is impossible), no automatic retry, read-back and audit. If filling fails after the
   copy exists, the draft is marked *unfinished* and **Finish the page** repeats only the filling.
5. **Save a page as a LegendKeeper template** (Admin key), with preview, approval, a planned id,
   Idempotency-Key and read-back.
6. **Position of new pages**: a recipe can place new pages alphabetically among their siblings
   (`before` the first sibling, in LegendKeeper's `rank` order, whose name sorts after the new one)
   instead of last.
7. Batches space records created from templates (three writes each) to stay under 120 writes a
   minute.

## Verified

- Unit and contract tests: 302 passing; request bodies for the three new operations
  validated against the official schema (`ResourceFromTemplateParams`,
  `ResourceSaveAsTemplateParams`, `ResourceCreateParams` with `before`/`after`).
- **Live, test project "AI Test Project", sandbox page only** (new API key):
  - `templates.list`: 7 templates, one nested.
  - Integration test: a copy of the *Statblock Template* created under the sandbox with a planned
    id; the same id refused (`409 DUPLICATE_ID`); its first tab filled with the built-in Tags and
    Aliases rows sent back by id — **both kept**; tags and aliases updated; a second page placed
    directly before it with `before`.
  - Through the app's own API: *Statblock Template* copied, a goblin statblock imported, final
    preview (template, kept boxes, alphabetical position), approved. LegendKeeper read back: the
    template's icon and sidebar Tags box, the infobox filled with the statblock and its Tags and
    Aliases rows, Traits/Actions/Reactions filled, tag *Monster*, placed alphabetically. No
    differences on read-back.
- Test pages were left in the sandbox, as asked.

## Not yet verified live

- **Saving a page as a template.** It always creates a template at the top of the project's
  templates list, which is outside the sandbox page, so it was not run without permission. It is
  covered by schema and contract tests; its first real use reads the template back and reports
  any difference.
