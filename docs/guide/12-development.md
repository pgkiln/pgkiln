# 12. Developing pgapex

This chapter is for people who work on pgapex itself. See also [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Code map

```
db/
  migrations/NNN_*.sql     the meta schema, roles and SQL API; applied once each, in order
  seed/*.sql               the HR sample (not for production)
examples/                  example applications as SQL (the tutorial)
scripts/migrate.ts         migration/seed runner
src/
  env.ts                   .env loader (imported first)
  app.ts / server.ts       Fastify setup / entry point
  db.ts                    the two pools, appTx() (SET LOCAL ROLE + pgapex.* settings), savepoints
  security.ts              URL checksums, password policy, security headers (CSP nonce), throttling limits
  session.ts               sessions (hashed tokens), activity log, login throttling
  sso.ts                   OpenID Connect: discovery, sign-in flow, ID token checks, account linking
  saml.ts                  SAML 2.0 sign-in (node-saml): AuthnRequest, response checks, SP metadata
  ldap.ts                  LDAP directories: search + bind, groups, account linking (ldapts)
  remember.ts              "Keep me signed in": rotating persistent sign-in tokens
  workflow.ts              workflows: step checks, the runner with parallel branches (NOTIFY + polling), the diagram
  api.ts                   REST API tokens for PostgREST, API role checks
  accounts.ts              account settings and the password policy
  i18n.ts                  pgapex's own texts (en, nl), translator, Accept-Language
  binds.ts                 :BIND scanner → escaped literals, splitStatements (unit tested)
  dataload.ts              CSV/XLSX parsing, type inference, batched loading with row errors
  xlsx.ts                  Excel writer for report downloads (typed cells, via fflate)
  automations.ts           cron parser, next run in a time zone, scheduler, running automations
  html.ts                  auto-escaping html`` templates
  css.ts                   PageCss: data-dependent styles as classes in the page's nonce'd <style> (CSP)
  metadata.ts              types + loaders for apps and pages
  maptiles.ts              map tile server URL, attribution and CSP origin
  icons.ts                 icon helper (sprite in public/icons.svg)
  runtime/
    routes.ts              HTTP handlers: show, submit, dynamic actions, cascading lists, login
    context.ts             PageContext, bind values, substitutions, public error messages
    authz.ts               authorization schemes, conditions, visibility
    engine.ts              form fetch, validations, processes, application processes
    render.ts              page chrome (nav, breadcrumb), dynamic action JSON, theme
    regions.ts             region shell + chart/cards/dynamic dispatch, buttons
    report.ts, report-views.ts (group by, pivot, chart), compute.ts (computed column expressions), grid.ts, charts.ts, calendar.ts, facets.ts, items.ts, links.ts
    account.ts             My account (details, own password, preferences)
    locale.ts              language, theme, text messages and translations of a request
    format.ts              date masks
    files.ts               file items: multipart parsing, temporary files, signed downloads
    document.ts            document templates: tag language, HTML subset, PDF layout (pdfkit)
    documents.ts           ?doc=NAME: a template filled with the page's values
    maps.ts                map region (data for Leaflet: markers or heat, report filter; list fallback, head assets)
    pwa.ts                 Progressive Web App: manifest, service worker route, icons (PNG encoder), offline page
    rest.ts                REST modules: handler checks, matching, bearer tokens, execution, OpenAPI
    tree.ts                tree region
    tasks.ts               task list region and task actions (approvals)
    workflows.ts           workflow console region and its actions
    pdf.ts                 report PDFs with report layouts (pdfkit)
  builder/
    components.ts          property spec of every component (drives the property editor)
    ui.ts                  shell, form helpers, CSRF check, app tab bar
    routes.ts              sign-in, workspace and app home, settings, activity, developers
    forms.ts               generic component property form (lookups, render, save)
    shared.ts              Shared Components and access control
    designer.ts            page designer
    sql.ts                 SQL Workshop: SQL commands, object browser
    users.ts               user directory and identity providers
    api.ts                 per-app REST API page (API role, tokens)
    globalization.ts       translations, XLIFF/CSV, text messages
    dataload.ts            SQL Workshop → Load Data
    layouts.ts             report layouts: logo upload, PDF preview
    automations.ts         automations: next run, Run now, run history
    report-settings.ts     page designer: report settings form (columns, link, selection, PDF)
    region-settings.ts     page designer: settings forms for grid, chart, cards, calendar, facets
    search.ts              app search, "where used" (appEntries, search, whereUsed, usedInPanel)
    advisor.ts             Advisor: EXPLAIN every SQL fragment, reference checks, plpgsql_check
    top-sql.ts             Top SQL per app role from pg_stat_statements
    ldap.ts                Users → LDAP directories
    documents.ts           document template preview (Shared Components)
    pwa.ts                 Settings → Progressive Web App (icon upload)
    rest.ts                REST module endpoints list and curl example (Shared Components)
    workflows.ts           workflow versions, diagram and instances (Shared Components)
public/
  app.css                  theme (light/dark, responsive)
  app.js                   client runtime: dialogs, dynamic actions, grids, menus (no inline JS)
test/
  binds.test.ts            unit tests
  security.test.ts         security regression tests (in-process, against the database)
  sso.test.ts              single sign-on against an in-process mock identity provider
  api.test.ts              REST API: SQL as the API role; HTTP tests skip without PostgREST
  accounts.test.ts         own password, expiry, admin reset, preferences
  i18n.test.ts             languages, translations, text messages, date masks, XLIFF/CSV
  files.test.ts            file items: storage, limits, downloads, temporary files
  dataload.test.ts         parsing, Load Data, the data_load process
  printing.test.ts         report PDFs
  fixtures/                test files (employees.xlsx)
  helpers.ts               a cookie-keeping test browser
  e2e/responsive.test.ts   browser tests at phone/tablet/desktop widths (Playwright)
```

## Principles

- **User-facing texts go through the translator**: `ctx.locale.t('key')` for pgapex's own texts (add the key to `en` and `nl` in `src/i18n.ts`; TypeScript checks that `nl` has every key), `ctx.locale.tr(text)` for texts derived from application metadata.

1. **Metadata first.** A feature is a column or row in `meta.*`, rendered by the runtime, editable
   in the builder, included in export/import and usable from SQL.
2. **User input never becomes SQL text.** Use `literal()` (binds.ts) for values,
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
- **upgrade**: installs older releases (`v0.6.0` … `v0.15.0`) with their sample data, upgrades to the
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
differently.

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

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Merge to `main`; CI must be green (all three jobs). The `main` branch should be protected on
   GitHub (Settings → Branches → rule for `main`: require the `test`, `e2e` and `upgrade` checks).
3. Tag: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
4. Add the new tag to the `upgrade` job's matrix in `.github/workflows/ci.yml`.
