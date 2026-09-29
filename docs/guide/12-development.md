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
  security.ts              URL checksums, password policy, security headers, throttling limits
  session.ts               sessions (hashed tokens), activity log, login throttling
  sso.ts                   OpenID Connect: discovery, sign-in flow, ID token checks, account linking
  api.ts                   REST API tokens for PostgREST, API role checks
  accounts.ts              account settings and the password policy
  i18n.ts                  pgapex's own texts (en, nl), translator, Accept-Language
  mail.ts                  mail queue delivery over SMTP (nodemailer), retries
  binds.ts                 :BIND scanner → escaped literals (unit tested)
  html.ts                  auto-escaping html`` templates
  metadata.ts              types + loaders for apps and pages
  icons.ts                 icon helper (sprite in public/icons.svg)
  runtime/
    routes.ts              HTTP handlers: show, submit, dynamic actions, cascading lists, login
    context.ts             PageContext, bind values, substitutions, public error messages
    authz.ts               authorization schemes, conditions, visibility
    engine.ts              form fetch, validations, processes, application processes
    render.ts              page chrome (nav, breadcrumb), dynamic action JSON, theme
    regions.ts             region shell + chart/cards/dynamic dispatch, buttons
    report.ts, grid.ts, charts.ts, calendar.ts, facets.ts, items.ts, links.ts
    account.ts             My account, forgot / reset password
    locale.ts              language, theme, text messages and translations of a request
    format.ts              date masks
  builder/
    components.ts          property spec of every component (drives the property editor)
    ui.ts                  shell, form helpers, CSRF check, app tab bar
    routes.ts              builder pages
    users.ts               user directory and identity providers
    api.ts                 per-app REST API page (API role, tokens)
    mail.ts                mail queue and log
    globalization.ts       translations, XLIFF/CSV, text messages
public/
  app.css                  theme (light/dark, responsive)
  app.js                   client runtime: dialogs, dynamic actions, grids, menus (no inline JS)
test/
  binds.test.ts            unit tests
  security.test.ts         security regression tests (in-process, against the database)
  sso.test.ts              single sign-on against an in-process mock identity provider
  api.test.ts              REST API: SQL as the API role; HTTP tests skip without PostgREST
  accounts.test.ts         own password, expiry, admin reset, forgot password, preferences
  mail.test.ts             send_mail, templates, attachments, delivery and retries (fake transport)
  i18n.test.ts             languages, translations, text messages, date masks, XLIFF/CSV
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
   uses event delegation, and the CSP forbids inline scripts.
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

CI (`.github/workflows/ci.yml`) runs the typecheck, the tests and the browser tests against
PostgreSQL 17, and uploads the screenshots as an artifact.

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
- `meta.export_app()` / `meta.import_app()` use `to_jsonb` / `jsonb_populate_record`, so new columns
  travel automatically. New *tables* need to be added to both functions.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Merge to `main`; CI must be green.
3. Tag: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
