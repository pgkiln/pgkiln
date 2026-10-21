# App Gallery

The builder's **App Gallery** (`/builder/gallery`) lists what `gallery.json` names, in four tabs:

- `samples`: applications shipped with pgkiln, installed by an administrator: `example` names a directory of
  `examples/` (installed like `pgkiln migrate --example <name>`), `file` a single SQL file, in `examples/` (the
  tutorial, `tasks-app.sql`) or in `samples/` here (`samples/sample-charts.sql`). A file runs in one transaction as the
  owner, so a failing script leaves nothing behind. `alias` is the application it creates (an installed one shows Run
  and Edit).
- `starters`: [blueprints](../../docs/guide/03-builder.md#creating-an-application-from-a-blueprint) in `starters/`.
  Install opens the blueprint's review; the developer creates the application from it.
- `utilities`: blueprints in `utilities/` of applications a workspace uses (lookup lists, release notes,
  announcements), installed like starters.
- Custom apps are not listed here: they are the workspace's boilerplate applications.

## The sample apps in `samples/`

| File | Application | Shows |
|---|---|---|
| `sample-charts.sql` | Sample Charts (`/a/sample-charts`) | the 22 chart types, a page per question, a drill-down to a report |
| `sample-cards.sql` | Sample Cards | cards with a form, KPI tiles, lists as cards, built-in template components |
| `sample-calendar.sql` | Sample Calendar | month, week, day and list views, create on click, drag and drop through a function |
| `sample-grids.sql` | Sample Interactive Grids | an editable grid, select lists, totals, frozen column, row menu, master-detail, views |
| `sample-dynamic-actions.sql` | Sample Dynamic Actions | show/hide/enable, set value, refresh, messages, wait popup, classes, inline dialog |
| `sample-reporting.sql` | Sample Reporting | interactive report, faceted search, smart filters, a classic report with column options |
| `sample-maps.sql` | Sample Maps | markers and clusters, layers with GeoJSON and a heat map, a map filtering a list by distance, a location item |
| `sample-approvals.sql` | Sample Approvals | a workflow started by a form, an approval task and the task list, the workflow console (accounts demo and approver) |
| `sample-data-loading.sql` | Sample Data Loading | `data_load` processes: by column name and merged, through a data load definition, skipping rows with errors |
| `sample-files.sql` | Sample Files | a file in the record's columns, several files in a child table, a photo cropped before upload |
| `ux-patterns.sql` | UX Pattern Catalog | region templates and options, buttons, items and form layouts, content and page patterns |

Each script creates its own schema (`sample_charts`, …), a role (`app_sample_charts`, …) granted to the runtime, the
application and one account, **demo** / **demo**. Without the builder:
`psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-charts.sql`. To remove one, delete the application in the
App Builder, then `drop schema sample_charts cascade; drop role app_sample_charts;`.

A sample script follows the pattern of the HR example: plain SQL that inserts `meta.*` rows, using
`meta.generate_page()` for wizard-made pages and two temporary helpers (`pg_temp.page_id`, `pg_temp.region_id`).
Every page starts with a text that says how it is made.

## Adding an entry

Add a starter or utility by writing a blueprint file in `starters/` or `utilities/` and an entry in `gallery.json` (a
key of lower-case letters, digits and `-`, a title, an [icon name](../../docs/guide/09-reference.md#icons) and a
description). Add a sample by writing a script in `samples/` (no `begin`/`commit`: the gallery runs it in a
transaction) and an entry with its `alias` and `file`. `test/gallery.test.ts` creates every starter and utility,
installs every sample and opens all their pages; `test/e2e/gallery.test.ts` checks the samples' pages at four widths,
for CSP violations and with axe-core.
