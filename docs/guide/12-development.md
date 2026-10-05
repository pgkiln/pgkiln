# 12. Developing pgapex

This chapter is for people who work on pgapex itself. See also [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Code map

```
db/
  migrations/NNN_*.sql     the meta schema, roles and SQL API; applied once each, in order
  seed/*.sql               the HR sample (not for production)
examples/                  example applications as SQL (the tutorial)
examples/plugins/          plug-in files (template components) to import
scripts/migrate.ts         migration/seed runner (src/migrate.ts does the work)
bin/pgapex.js              the `pgapex` command line (runs src/cli/main.ts with tsx)
src/
  env.ts                   .env loader (imported first)
  migrate.ts               applies db/migrations and examples (scripts/migrate.ts, pgapex migrate); logs each run that applies
                           or fails a file in public.pgapex_install_log
  appfiles.ts              application export as one file per component (dir layout, static ids) and back
  subscriptions.ts         application types and subscriptions (migration 056): offers, subscribe, refresh, publish, in sync
  workingcopy.ts           working copies (migration 055): create, three-way compare per component (base, main, copy),
                           merge into the main application or refresh the copy, both through cli/replace.ts
  cli/                     the command line: main.ts (commands, help, exit codes), files.ts (directories,
                           zip), diff.ts, replace.ts (import --replace in place)
  app.ts / server.ts       Fastify setup / entry point
  db.ts                    the two pools, appTx() (SET LOCAL ROLE + pgapex.* settings, NOTICEs to the debug log), savepoints
  security.ts              URL checksums, password policy, security headers (CSP nonce), throttling limits
  session.ts               sessions (hashed tokens), activity log, login throttling
  sso.ts                   OpenID Connect: discovery, sign-in flow, ID token checks, account linking
  saml.ts                  SAML 2.0 sign-in (node-saml): AuthnRequest, response checks, SP metadata
  ldap.ts                  LDAP directories: search + bind, groups, account linking (ldapts)
  headerauth.ts            HTTP-header authentication: trusted proxies (PGAPEX_AUTH_HEADER_PROXIES), header checks, accounts
  dbauth.ts                database-account authentication: role lists, a short connection as the role (DATABASE_URL target), membership/superuser checks
  customauth.ts            custom authentication: the app's function or PL/pgSQL body (a pg_temp function) and post-authentication code, as the app's role
  remember.ts              "Keep me signed in": rotating persistent sign-in tokens
  workflow.ts              workflows: step checks, the runner with parallel branches (NOTIFY + polling), invoke_api steps
                           (the call between two transactions, with a lease), Advisor references, the diagram
  process-jobs.ts          background execution chains: the job queue (SKIP LOCKED, NOTIFY + polling), running a job as the app role
  api.ts                   REST API tokens for PostgREST, API role checks
  accounts.ts              account settings and the password policy
  i18n.ts                  pgapex's own texts (en, nl), translator, Accept-Language
  i18n/                    de.ts, fr.ts, es.ts: the built-in texts in German, French and Spanish
  numformat.ts             number format masks (999G990D00): format, parse, language separators
  binds.ts                 :BIND scanner → escaped literals, splitStatements, SqlParams (query parameters) (unit tested)
  dataload.ts              CSV/XLSX/JSON/XML parsing, type inference, batched loading with row errors, data load definitions (mapping, transformations, format masks)
  unload.ts                Unload Data: unloadStatement() (one SELECT), openUnload() (cursor, batches, CSV/JSON/XLSX/XML encoders on Postgres text values)
  xml.ts                   safe XML reader (no DTDs or entities, limits) and xmlTable(): rows from a repeating element (unit tested)
  sqlscript.ts             SQL scripts: splitScript() (statements, line numbers, psql commands), runScript() (stop/continue, transaction, savepoints)
  quicksql.ts              Quick SQL: shorthand parser and PostgreSQL DDL generator (unit tested)
  xlsx.ts                  Excel writer for report downloads and Unload Data (typed cells, streamed through fflate's Zip)
  automations.ts           cron parser, next run in a time zone, scheduler, running automations (the actions run
                           in PL/pgSQL: meta.automation_execute, shared with meta.run_automation; migration 044)
  html.ts                  auto-escaping html`` templates
  richtext.ts              rich text and Markdown items: allow-list HTML sanitiser, Markdown renderer
  qrcode.ts                QR code encoder (byte mode, versions 1–40) and SVG output for the qrcode item
  css.ts                   PageCss: data-dependent styles as classes in the page's nonce'd <style> (CSP)
  metadata.ts              types + loaders for apps and pages (components of excluded build options are left out here)
  maptiles.ts              map tile server URL, attribution and CSP origin
  webclient.ts             outgoing HTTP to web services: allow-list, address checks at connect time (SSRF), redirects, limits
  secrets.ts               secrets at rest (web credentials): AES-256-GCM with PGAPEX_SECRET_KEY
  websources.ts            web credentials (OAuth2 client credentials/password/refresh token grants, token cache, stored refresh
                           tokens) and REST data sources: requests, JSON paths, typed rows, response cache, write-back operations
                           (callOperation); invoke(): the invoke API call shared by the invoke_api process and workflow step
  restsync.ts              REST data source synchronisation into a local table (merge/replace/append as the app role), run log,
                           syncTick() (scheduled and SQL-queued runs, called by the automations scheduler)
  webrequests.ts           web requests from SQL (meta.web_request, migration 052): runPending() after each sql page process
                           (same transaction), webRequestTick() for committed ones (automations scheduler), retention purge;
                           calls go through websources.ts call()/invoke() (allow-list, SSRF checks, credentials)
  debug.ts                 debug messages: DebugLog (levels, timed steps, NOTICEs of meta.debug from appTx), started in
                           loadContext, stored after the response (onResponse hook → meta.debug_save), hourly purge
  icons.ts                 icon helper (sprite in public/icons.svg)
  runtime/
    routes.ts              HTTP handlers: show, submit, dynamic actions, cascading lists, login
    context.ts             PageContext, dbg()/timed() debug helpers, bind values, substitutions, public error messages, writeOut (streamed responses with back pressure)
    authz.ts               authorization schemes, conditions, visibility (menu requests count as buttons)
    engine.ts              form fetch, validations, processes (conditions, execution chains, queueing background chains; web requests queued by an sql process are made right after it), application processes
    processes.ts           download (file or zip from a query, safe headers), workflow processes, configuration checks of chains
    logic.ts               computations, branches (page, URL, function returning a URL, another application) and their conditions
    render.ts              page chrome (nav, breadcrumb), dynamic action JSON, theme (the page's nonce'd <style>, light/dark and style switches)
    styles.ts              Theme Roller style variants: fixed lists (fonts, sizes, corners), parseStyle/appStyles checks, the request's
                           style (user choice, default), themeCss() (only hex values and constants reach the CSS)
    template-options.ts    template options: the fixed CSS class list per region and button, templateClasses() (unknown values ignored)
    regions.ts             region shell + chart (drill-down links, gauge settings)/cards/dynamic dispatch with row limits, lazy placeholder and cache, buttons (menu buttons, badges)
    report.ts, report-views.ts (group by, pivot, chart), compute.ts (computed column expressions), grid.ts (aggregates, row actions, Actions menu, layoutFromForm), grid-layout.ts (column layouts: clean, arrange, per user), master-detail.ts (signed master row selection, details), facets.ts, items.ts
                           (report.ts: paging with row ranges and max_rows, keyset paging (keysetPlan, seekCondition, signed r<id>_k), pagerNav, streamed CSV/Excel downloads with a cursor;
                           items.ts: lovOptions, searchLov/lovLookup for popup LOVs, served by POST /a/:alias/:page/lov/:item/search in routes.ts)
    region-cache.ts        region caching (keys per scope, CSRF placeholder, invalidation on submit) and lazy regions (GET …/region/:id is in routes.ts)
    charts.ts              server-rendered charts (SVG and CSS classes): bar … radar, gauges, Gantt (time axis, dependencies), pyramid, polar, drill-down marks, data table
    calendar.ts            calendar region: month/week/day/list views, create links, drag and drop (moveEvent, moveCalendarEvent;
                           the route POST …/calendar/:id/move is in routes.ts)
    links.ts               page links with checksums; fillItems() fills #column# in link items
    facet-state.ts         facet definitions (checkbox, range, star; exclude, custom range), filters read from the URL, their SQL as query parameters
    smart-filters.ts       smart_filters region: search field, filter chips, suggestions
    display-selector.ts    display_selector region: tabs / select list over the page's regions (app.js makes them ARIA tabs)
    account.ts             My account (details, own password, preferences), the light/dark and style switches (POST …/account/theme, …/account/style)
    locale.ts              language, theme, text messages, translations, number symbols and time zone of a request
    format.ts              date masks; maskedFormatter() applies a column's or item's number or date mask
    files.ts               file items: multipart parsing, temporary files, signed downloads
    document.ts            document templates: tag language, HTML subset, PDF layout (pdfkit)
    documents.ts           ?doc=NAME: a template filled with the page's values
    maps.ts                map region (data for Leaflet: layers with a query each, markers, clusters or heat, PostGIS geometry as GeoJSON, report filter by area or distance; list fallback, head assets)
    spatial.ts             spatial filtering on the server: map area and distance parsing, PostGIS detection and SQL (ST_Intersects, ST_DWithin), lat/lng fallback (bounding box, haversine)
    pwa.ts                 Progressive Web App: manifest, service worker route, icons (PNG encoder), offline page
    rest.ts                REST modules: handler checks, matching, bearer tokens, execution (collections stream from a cursor), OpenAPI
    rest-sources.ts        REST data sources in apps: regions and LOVs as SQL over "rest", the invoke_api process (items; the call is websources.ts invoke()),
                           write-back of forms (fetch, form_dml) and grids (grid_dml) through the source's operations
    tree.ts                tree region
    lists.ts               lists: static entries or a query, visibility (authorization, conditions, page access), safe URLs; list regions, navigation menu and bar
    template-components.ts template components: template language (allow-list, directives, escaping), plug-in files, report column templates
    template-region.ts     template_component region
    tasks.ts               task list region and task actions (approvals)
    workflows.ts           workflow console region and its actions
    pdf.ts                 report PDFs with report layouts (pdfkit); rows from a cursor in batches (tablePdf takes batches)
  builder/
    components.ts          property spec of every component (drives the property editor)
    ui.ts                  IDE shell (icon rail, toolbar, breadcrumb, status bar), builder theme, form helpers, CSRF check, app tabs
    routes.ts              sign-in, app home, settings, activity, developers, create (POST, via newapp.ts)/import (POST)
    wizards.ts             create page wizards: step 2 forms per page type (defaults from meta.wizard_defaults), POST → meta.generate_page
                           (the generators are PL/pgSQL in migration 047: catalog, defaults, form/cards/calendar/chart/map/facets/master-detail)
    home.ts                App Builder home (tiles, applications report/cards, Recent), Create, Import, Dashboard, Utilities
    newapp.ts              creating an application (schema, role app_<alias>, Home page, first user): blank app and from a file
    appfromfile.ts         Create → From a file: upload (src/dataload.ts parsing), proposed table/columns, one transaction:
                           app + table + rows (loadRows) + pages (meta.generate_page: report and form, chart, facets)
    forms.ts               generic component property form (lookups, render, save)
    shared.ts              Shared Components and access control
    designer.ts            page designer: component tree (with computations and branches), layout canvas and gallery, property editor, toolbar
    arrange.ts             page designer layout changes: move, column span, create from the gallery, undo / redo
    sql.ts                 SQL Workshop: SQL commands, object browser
    scripts.ts             SQL Workshop → SQL Scripts: editor, upload/download, run, results per statement, run history
    quicksql.ts            SQL Workshop → Quick SQL page (preview, save as script, run)
    querybuilder.ts        SQL Workshop → Query Builder: catalog, joins by foreign key, buildQuery() from the URL
    users.ts               user directory and identity providers
    api.ts                 per-app REST API page (API role, tokens)
    globalization.ts       translations, XLIFF/CSV, text messages
    dataload.ts            SQL Workshop → Load Data (with definitions, save a mapping as one); data load definition spec (Shared Components)
    unload.ts              SQL Workshop → Unload Data: table/view (columns, where, order) or query form, streamed download (read-only transaction, own connection)
    layouts.ts             report layouts: logo upload, PDF preview
    automations.ts         automations: actions (add, reorder), next run, Run now, run history with errors per row
    report-settings.ts     page designer: report settings form (columns, link, selection, PDF)
    region-settings.ts     page designer: settings forms for grid, chart (gauge, drill-down), cards, calendar (views, create, drag and drop), facets, smart filters, display selector, list
    search.ts              app search, "where used" (appEntries, search, whereUsed, usedInPanel)
    advisor.ts             Advisor: EXPLAIN every SQL fragment, reference checks, plpgsql_check
    top-sql.ts             Top SQL per app role from pg_stat_statements
    diagnostics.ts         Activity → Debug messages (level, list, one request's entries, purge); Workspace utilities →
                           Installation (version, install/upgrade runs, applied and missing migrations; administrators)
    ldap.ts                Users → LDAP directories
    documents.ts           document template preview (Shared Components)
    pwa.ts                 Settings → Progressive Web App (icon upload)
    themeroller.ts         Settings → Theme Roller: style variants (add, edit, rename, delete), default style, users may choose
    subscriptions.ts       Shared Components → Subscriptions: subscribe, refresh, unsubscribe, subscribers and publish; the note under a component
    workingcopies.ts       Working copies: list and create, compare with differences, merge or refresh with conflict choices, delete
    rest.ts                REST module endpoints list and curl example (Shared Components)
    workflows.ts           workflow versions, diagram and instances (Shared Components)
    process-jobs.ts        page designer: the Jobs tab of a background chain process
    template-spec.ts       template component property form (Shared Components)
    websources.ts          web credentials and REST data sources: property specs, secret status, Test, suggested columns,
                           write-back operations, synchronisation settings, Synchronise now and run history
    templates.ts           template components: preview, plug-in export/import, region settings, report column templates
    code-editor.ts         code fields (data-code marks), /builder/code/completions (scoped to the app's role), /builder/code/check
    locks.ts               page and application locks (blockingLock, checked in ui.ts developer() for every builder POST), developer comments, administrators
    supporting.ts          supporting objects: review page, running the install/upgrade/deinstall scripts as the app's role in one transaction
public/
  app.css                  theme (light/dark, responsive; --font, --font-size, --radius for style variants; template option classes to-*)
  app.js                   client runtime: dialogs (dialog_closed actions), popup LOVs, dynamic actions (focus, classes, messages), grids (add/duplicate rows, master-detail refresh, move/resize columns, copy/paste of cell ranges), menus, lazy regions, maps (Leaflet layers, marker clusters, heat layer, layer legend, area/distance filter) (no inline JS)
  code-editor.js, .css     builder code editor: enhances <textarea data-code>, highlighting, suggestions (no dependencies)
  builder.css              builder only: IDE look (dark chrome, icon rail, panes), builder light/dark tokens
  builder.js               builder only: tabs, component tree, property filter, drag and drop on the layout
  builder-icons.svg        builder only: icons of the rail, toolbar and designer (b-*)
test/
  binds.test.ts            unit tests
  security.test.ts         security regression tests (in-process, against the database)
  sso.test.ts              single sign-on against an in-process mock identity provider
  api.test.ts              REST API: SQL as the API role; HTTP tests skip without PostgREST
  accounts.test.ts         own password, expiry, admin reset, preferences
  i18n.test.ts             languages, translations, text messages, date masks, XLIFF/CSV
  numformat.test.ts        number format masks: every element, rounding, parsing, separators
  globalization.test.ts    masks on HR page 29, time zones, the de/fr/es texts
  files.test.ts            file items: storage, limits, downloads, temporary files
  items.test.ts            rich text, Markdown, rating, combobox, date range, password reveal and QR code items
  dataload.test.ts         parsing, Load Data, the data_load process
  unload.test.ts           Unload Data: CSV/JSON/XLSX/XML output, read back with Load Data, read-only and one-statement checks, streaming
  app-from-file.test.ts    Create → From a file: proposed names and types, app + table + rows + pages, row errors, login, validation
  workshop.test.ts         SQL scripts, Quick SQL pages, query builder, data load definitions (Load Data, the process, export)
  quicksql.test.ts         Quick SQL parser and DDL generator
  xml.test.ts              XML reader: rows, attributes, paths, refused DTDs and entities, limits
  printing.test.ts         report PDFs
  fixtures/                test files (employees.xlsx)
  template-components.test.ts  template language, escaping, plug-ins, regions and column templates
  logic.test.ts            computations, branches, menu buttons and badges, new dynamic actions, build options, export
  page-logic.test.ts       download, chain (background jobs) and workflow processes, function/app branches, dialog_closed (HR page 28)
  code-editor.test.ts      code editor: completions scoped to the app's role, the check, marked fields
  builder-home.test.ts     App Builder home: search, sort, views, Recent, Create/Import pages, dashboard, utilities
  charts.test.ts           chart markup per kind (geometry as classes), gauges, Gantt time axis and dependencies, pyramid, polar, drill-down links
  calendar.test.ts         calendar views, create links, moving events (pure and over HTTP)
  rest-sources.test.ts     REST data sources, web credentials, SSRF checks, invoke_api (mock service + HR page 23)
  workflow-invoke.test.ts  workflow invoke_api steps: the call between transactions, faults, retry, lease, Advisor, export (mock service)
  large-tables.test.ts     row ranges, max_rows, row limits, lazy regions, region caching, streamed downloads (HR page 25)
  grid.test.ts             interactive grid: aggregates, layouts per user, saved grid reports, master-detail, row actions (HR page 27)
  custom-auth.test.ts      custom authentication: function body, named function, post-authentication code, builder settings
  debug.test.ts            debug messages: levels, meta.debug, timings, password values, rollbacks, retention, the viewer, the install log
  web-request.test.ts      meta.web_request (scheduler pass, page process path, sources, credentials, limits, retention) and
                           meta.parse_data compared with the data loader (src/dataload.ts); HR page 35
  builder-parity.test.ts   lists (HR page 31), page and application locks, comments, developers, supporting objects
  page-wizards.test.ts     create page wizards: catalog defaults, every page type generated and rendered, refusals, the builder steps
  theme-styles.test.ts     Theme Roller style variants (checks, CSS, user choice per app, builder page) and template options
  helpers.ts               a cookie-keeping test browser
  e2e/responsive.test.ts   browser tests at phone/tablet/desktop widths (Playwright)
  e2e/code-editor.test.ts  the code editor in a browser: highlighting, keys, suggestions, touch, screen readers
  e2e/items.test.ts        sprint 26 item types in a browser: editors, tags, stars, dates, reveal; without JavaScript
  e2e/designer.test.ts     page designer: panes per width, drag and drop, keyboard, Arrange buttons, builder theme
  e2e/calendar.test.ts     calendar drag and drop and create on click, view switching, chart drill-down
  e2e/globalization.test.ts the browser's time zone (sign-in, app.js), no-JavaScript fallback, a masked number item
  e2e/grid.test.ts         interactive grid in a browser: master-detail refresh, move/resize columns, row menu, copy/paste; without JavaScript
  e2e/page-logic.test.ts   dialog_closed refreshes a region without a reload, download process in a browser, dialog link without JavaScript
```

## Principles

- **User-facing texts go through the translator**: `ctx.locale.t('key')` for pgapex's own texts (add the key to `en` and `nl` in `src/i18n.ts` and to `src/i18n/de.ts`, `fr.ts`, `es.ts`; TypeScript checks that every language has every key), `ctx.locale.tr(text)` for texts derived from application metadata.

1. **Metadata first.** A feature is a column or row in `meta.*`, rendered by the runtime, editable
   in the builder, included in export/import and usable from SQL.
2. **User input never becomes SQL text.** Use query parameters (`SqlParams`, binds.ts) or `literal()` for values,
   `pg.escapeIdentifier` only for identifiers checked against a known list, whitelists for
   operators and keywords, and integers for positions.
3. **Visibility is authority.** Anything a user can trigger (buttons, items, dynamic actions, grid
   saves) must be checked against `computeVisibility()` on the server.
4. **Server-rendered HTML, progressive enhancement.** Every page works without JavaScript; `app.js`
   uses event delegation, and the CSP forbids inline scripts. Styles: no `style="…"` attributes
   either (`style-src 'self' 'nonce-…'`). Use a class in `app.css` (the `u-*` utilities for
   one-off spacing); for values that depend on data (chart geometry) call `ctx.css.cls('width:34%')`
   (`src/css.ts`), which returns a class whose rule goes into the page's nonce'd `<style>`. A
   refreshed region sends its rules along and `app.js` adds them through the CSSOM. The e2e test
   fails on any CSP violation in the browser.
5. **Escape by default.** Build HTML only with `html```; use `raw()` only for markup you generated.
6. **Responsive and accessible.** Labels, keyboard support, focus rings, and layouts that pass
   the e2e overflow checks.

## Running and testing

```bash
npm run dev          # auto-restart
npm run typecheck
npm test             # binds + security tests (needs the database with the sample)
npm run test:e2e     # needs `npx playwright install chromium`; SCREENSHOTS=1 saves PNGs to test-results/
npm run db:reset     # fresh database
```

CI (`.github/workflows/ci.yml`) runs three jobs against PostgreSQL 17:

- **test**: typecheck and `npm test` on a fresh database;
- **e2e**: the browser tests, uploading the screenshots as an artifact;
- **upgrade**: installs older releases (`v0.6.0` … `v0.25.0`) with their sample data, upgrades to the
  commit and runs `npm test` on the result. Add each new release to its matrix.

CI has **no `.env`** and no PostgREST: only the variables in the workflow are set, and the
PostgREST HTTP tests skip. To reproduce a CI failure, run the tests in a clean checkout
(`git worktree add`) against a throwaway database with only those variables, and
`API_URL=http://127.0.0.1:1`. A new required environment variable must be added to the workflow.

To try the upgrade locally:

```bash
mkdir -p /tmp/old && git archive v0.8.0 | tar -x -C /tmp/old
DATABASE_URL=<empty database> npx tsx scripts/migrate.ts --seed --root /tmp/old
DATABASE_URL=<same database> npm run example:hr && npm test
```

## Adding a region type (example)

1. **Migration**: allow the type in `meta.region`'s check constraint (new file `db/migrations/NNN_…sql`).
2. **Types**: add it to `Region['type']` in `src/metadata.ts`.
3. **Renderer**: write `renderX(ctx, region)` in `src/runtime/x.ts` returning `html```, and add a
   `case` in `renderRegion()` (`src/runtime/regions.ts`). Run developer SQL through `savepoint()`
   and turn errors into messages with `publicError()`.
4. **Builder**: add the type to the `type` options and describe its attributes in the `config`
   help (`src/builder/components.ts`).
5. **CSS**: in `public/app.css`, including the phone breakpoint (`max-width: 640px`).
6. **Tests**: input-handling tests in `test/security.test.ts`, and a page in the sample so the e2e
   test covers it at every width.
7. **Docs**: [chapter 4](04-pages-and-regions.md) and the [parity matrix](../apex-feature-parity.md).

Adding an item type follows the same path through `meta.item`'s constraint, `ItemType`,
`renderItem()` in `items.ts`, and `applyPostedItems()` in `routes.ts` if it posts values
differently; server-side format checks go in `validate()` (`engine.ts`), the builder's lists in
`components.ts` (type options, attribute help) and `ITEM_LABELS` in `arrange.ts` (gallery), and
browser enhancements at the end of `public/app.js` (the item must work without them).

## Migrations

- Never change a migration that has been released (tagged). Add a new numbered file.
- Each file runs in one transaction. Prefer idempotent statements for roles and extensions
  (`do $$ … if not exists … $$`).
- `meta.export_app()` / `meta.import_app()` (migration 013) use `to_jsonb` / `jsonb_populate_record`,
  so new columns travel automatically. A new *table* that references `meta.app` or `meta.page`
  must be added to both functions as a new top-level section (read it with
  `coalesce(p_doc->'section', '[]')`), or to `NOT_EXPORTED` in `test/export.test.ts` with a reason;
  that test fails until you do. Redefine the functions with `create or replace` in the new
  migration; don't wrap them.
- Never rename or remove a section of the `pgapex/2` format (see [chapter 3](03-builder.md#export-format)).
- A new table that belongs to an application or references a component must also be listed in
  `src/cli/replace.ts` (replaced with the application's definition, or kept as installation data);
  `test/cli.test.ts` fails until it is. The directory format ([chapter 18](18-cli.md)) needs no
  change: unknown sections and columns travel along.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Merge to `main`; CI must be green (all three jobs). The `main` branch should be protected on
   GitHub (Settings → Branches → rule for `main`: require the `test`, `e2e` and `upgrade` checks).
3. Tag: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
4. Add the new tag to the `upgrade` job's matrix in `.github/workflows/ci.yml`.
