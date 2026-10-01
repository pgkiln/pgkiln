# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Drop and paste files** (APEX 26.1: paste files): file items are drop zones, and a pasted file
  (a screenshot, a copied file) goes into the focused file item, or the page's only one. Text
  fields keep their normal paste; a file dropped next to a zone doesn't open in the browser.
- **Heat maps** (`"layer": "heat"` on a map region): places drawn as a heat map, weighted by a
  `weight` column, with a legend.
- **Filter a report by the map area** (`"report": <id>` on a map region; APEX: map bounding box):
  after moving the map, "Show this area in the list" filters the report on the same page to the
  visible area (its lat/lng or location columns), with a "Map area" chip. Migration 026 keeps the
  link when an application is imported. Both are in the builder's map settings.
- HR example: page 16 "Locations" (a payroll heat map, and an offices map that filters the
  employee list).

### Changed
- Report column headings set in the region's configuration are translated like generated ones.

## [0.14.0] - 2026-10-01

### Added
- **More chart types** (APEX: stacked, combination, scatter and pie charts): `stacked` columns
  (negative values stack downwards), `combo` (the first series as columns, the others as lines),
  `scatter` (a numeric first column as the x axis) and `pie`, next to bar, column, line, area and
  donut. The interactive report's chart view also offers pie. The HR example has an "Analytics"
  page with one chart of each new kind.
- **Several files per upload item** (`"multiple": true`; APEX: Allow Multiple Files): users choose
  several files at once. In a form region each file becomes a row of a child table (`table`,
  `parent_column`, `key_column`), listed with signed download links and a remove box per file;
  without one the item holds a list of temporary files for a process. `max_files` (at most 10)
  limits the number. The HR employee form has a "Documents" item (`hr.emp_document`, with row
  level security). With `max_px`, every chosen photo is made smaller before upload.

## [0.13.0] - 2026-10-01

### Added
- **Map region** (`map`, migration 025; APEX: Map region): markers from `lat`/`lng` columns or
  `location` text, GeoJSON lines and areas, popups with links, sized small/medium/large. Leaflet
  1.9 ships with pgapex and loads only on pages with a map; tiles come from OpenStreetMap or the
  server in `MAP_TILE_URL`, the only image origin added to the Content-Security-Policy.
- **Tree region** (`tree`; APEX: Tree): id/parent id/label rows as an expandable tree with icons
  and links, drawn on the server (works without JavaScript).
- Builder settings forms for both; the Advisor checks their SQL. The HR example maps its offices
  and shows its reporting lines as a tree.

## [0.12.0] - 2026-10-01

### Added
- **REST modules** (Shared Components → REST modules, migration 024; APEX: RESTful Services):
  handlers with a method, a path with parameters and SQL (a paged collection, one item, or
  statements), roles and public endpoints, served by pgapex under `/a/<alias>/rest/<module>/` with
  bearer tokens, as the application's role (RLS applies), and an OpenAPI description per module.
  The HR example has a `v1` module.

### Changed
- Tokens and OAuth clients no longer need an API role: without one they are valid for the REST
  modules pgapex serves (PostgREST treats them as anonymous).
- Builder property groups (fieldsets) no longer grow wider than the screen with long content.

## [0.11.0] - 2026-10-01

### Added
- **Progressive Web Apps** for mobile and field work (App → Settings, migration 023): installable
  (manifest, icon, service worker per application), offline pages (opt-in; wiped at sign-in and
  sign-out), an offline page, and **forms sent offline** kept on the device (files included) and
  sent when the connection is back, under the same user, at most once. New chapter 17.
- **Field items**: `location` (*Use my location*, `latitude,longitude`, checked on the server), camera
  capture and photos made smaller before upload on file items, a barcode/QR *Scan* button on text items.
- Page forms carry a submission id (a resend is never processed twice) and their form's record key,
  signed, so a form sent later updates the record it was opened for.
- **Workflows** (Shared Components → Workflows, migration 022): definitions of task, SQL, switch,
  wait and end steps with variables, started from application SQL with `meta.start_workflow(…)`,
  run by the pgapex server (on `NOTIFY` and every few seconds; `WORKFLOWS=off` to disable) one step
  per transaction as the application's role. A `workflows` region is the console (terminate, retry
  a faulted step); the builder checks the steps and draws them. The HR example starts an onboarding
  workflow from its employee form.

### Changed
- `Permissions-Policy` allows the camera and geolocation for the application itself
  (`camera=(self), geolocation=(self)`); the microphone stays off.

## [0.10.0] - 2026-10-01

### Changed
- **pgapex installs no application.** The HR sample moved from `db/seed/` to `examples/hr/` as an
  example application built on pgapex: `npm run setup` and `npm run db:reset` install the framework
  only, `npm run example:hr` adds the example, and `npm test` / `npm run test:e2e` install it first
  as their fixture. `npm run db:seed` is gone; `migrate.ts --seed` still reads an older release's
  `db/seed/` (upgrade test). Databases that have the sample carry on: files are recorded by name.
- Builder defaults, placeholders and help texts use neutral examples instead of HR tables, and the
  report-layout preview shows made-up order rows.

### Added
- **Approvals and the task list** (migration 021): task definitions (Shared Components), tasks created
  from application SQL with `meta.create_task(…)`, a `tasks` region type (claim, approve / reject /
  complete with a comment, release, delegate, cancel, comments and history) and completion SQL that
  runs as the application's role in the same transaction. Rights are checked by the `meta.*_task`
  functions and the `meta.tasks` view. The HR example's leave requests use it (*My tasks*, page 14).
- **Document templates** (Shared Components → Document templates, migration 020; APEX: Document
  Generator): a query fills an HTML template with Mustache-style tags (values always escaped;
  lists from JSON columns; number and date filters), drawn as a PDF with a report layout. Buttons
  with action *document* and `?doc=NAME` links download them; the builder previews them. The HR
  sample's employee form has a *Print* button (employee sheet).
- Data loading reads **JSON**: an array of objects, an object holding one, or JSON Lines.
- **"Keep me signed in"** (APEX: persistent authentication), per application for 1–365 days: a
  rotating one-time token in a long-lived cookie starts a new session when the old one has ended.
  Signing out, a new password, deactivation or removed access ends it; My account has *Sign out on
  all devices*. Migration 017.
- **LDAP and Active Directory** sign-in (Users → LDAP directories, migration 018): the password form
  checks local accounts, then the app's directories (search, bind as the user, groups → roles,
  StartTLS/LDAPS). Demo directory: `docker compose --profile ldap`, `examples/ldap-directory.sql`.
- **SAML 2.0** single sign-on next to OpenID Connect (migration 019): signed assertions, issuer,
  audience and one-time `InResponseTo` checks, SP metadata at `/sso/saml/<name>/metadata`. The
  development Keycloak realm has a SAML client (`examples/keycloak-saml.sql`).

## [0.9.0] - 2026-10-01

### Added
- App Builder **Search** over every page and component of an application, and a **Used in** list
  under items, pages, lists of values, authorization schemes and report layouts.
- **Advisor**: plans every SQL fragment of an application with EXPLAIN as its database role
  (rolled back, nothing runs), compiles PL/pgSQL blocks, finds references to missing pages,
  items, lists of values, schemes and layouts, and checks PL/pgSQL functions with `plpgsql_check`
  when that extension is installed.
- **Top SQL** per application (Activity → Top SQL) from `pg_stat_statements`. Migration 016
  creates the extension when possible; `docker-compose.yml` and CI load the module.
- **Region settings** in the page designer for grid, chart, cards, calendar and faceted search
  regions, like the report settings: grid columns (heading, shown, read-only, required, list of
  values) and add/change/delete switches; chart type; cards style and link; calendar link; the
  facets' report and per facet its label, values shown and order. Saving keeps unknown keys and
  leaves defaults out; links, lists of values and the report are checked server-side.
- Interactive reports: **computed columns** (Actions → Compute, e.g. `sal * 12`; a small
  expression language that is parsed, never pasted into SQL), **group by** (up to three columns
  with row counts and functions), **pivot** (values of a column as columns, with row totals) and
  a **chart view** (bar, column, line, area or donut), with Report / Group by / Pivot / Chart links
  once set up. All of them are kept in saved reports.
- **Row selection** for report regions: `"selection": {"column": …, "item": …}` (also in the
  Report settings form) adds a checkbox per row and a *select all*; on submit the checked values
  reach the item, colon separated.

### Security
- The Content-Security-Policy no longer allows inline styles: `style-src 'self' 'nonce-…'` with a
  new nonce per response. Chart geometry and theme colours go into the page's one nonce'd
  `<style>` as classes (`src/css.ts`); a refreshed region sends its rules along and `app.js` adds
  them through the CSSOM. The builder uses CSS classes instead of `style` attributes.
  **Upgrade note:** `style="…"` attributes and `<style>` blocks in your own static or dynamic
  region HTML are now ignored by browsers; use the classes in `/static/app.css`.

### Fixed
- Chart legend swatches were grey since 0.8.0 (the highlight chip's swatch rule applied to them).

## [0.8.0] - 2026-09-30

### Changed
- Long help texts (JSON examples) wrap instead of widening the builder on phones.
- Application export and import are one pair of functions again (migration 013 replaces the
  wrapped `export_app_base`/`import_app_base` chain). The format stays `pgapex/2` and is now
  documented, with a compatibility promise: sections are only added, and missing sections import
  as empty.
- The builder's route file is split into `routes.ts`, `shared.ts`, `designer.ts`, `sql.ts` and
  `forms.ts` (no behaviour change).

### Added
- Interactive reports: **control break** (group rows by a column), **aggregates** (sum,
  average, count, minimum, maximum over all filtered rows, with subtotals per group and a
  total), **highlights** (color matching rows) and **saved reports** (private per user; public
  ones for users who pass the region's `public_reports` scheme). Migration 014 adds
  `meta.saved_report`, reached through `meta.saved_reports`, `meta.save_report()` and
  `meta.delete_saved_report()`.
- **Automations** (Shared Components → Automations, migration 015): SQL or PL/pgSQL on a cron
  schedule with a time zone, once or for each row of a query, as the application's database role
  with the automation's roles for `meta.has_role()`. Run now, next run and run history in the
  builder. The pgapex server schedules them (no extension needed); several servers never run
  one twice; `AUTOMATIONS=off` switches the scheduler off. Exported with the app; imported
  copies start switched off. HR sample: *Remind managers*.
- **Report settings** in the page designer: a form for a report region's rows per page,
  search/sort/Actions switches, saved and public reports, per-column heading, visibility, printing
  and PDF width, the link and the PDF layout. Columns are read from the query. It writes the
  region's JSON attributes and keeps other keys.
- CI: an `upgrade` job installs v0.6.0 and v0.7.0 with sample data, upgrades and runs the tests;
  `scripts/migrate.ts --root` applies another release's `db/` folder.
- `test/export.test.ts`: export → import → export round trip, older files, and a check that every
  table of an app or page is exported (or deliberately left out).

## [0.7.0] - 2026-09-30

### Added
- OAuth clients for the REST API, like ORDS's `oauth.create_client`: client credentials
  (`POST /oauth/token`, HTTP Basic or form fields) give short-lived tokens that PostgREST accepts,
  so tokens never need rotating by hand. Clients act as `client:<name>` with roles that are read
  live; revoking works at once. Secret rotation with a grace period. Managed under Builder → REST
  API → OAuth clients or with `meta.oauth_create_client()`, `oauth_rotate_secret()`,
  `oauth_revoke_client()`, `oauth_grant_role()` and `oauth_revoke_role()` (migration 011).
- **Download Excel** for interactive reports: an `.xlsx` with the rows, filters and headings
  of the report; numbers, dates and booleans keep their type, text never becomes a formula.
- **Report layouts** (Shared Components → Report layouts, migration 012): paper size (A3, A4,
  A5, Letter, Legal), orientation, font size, margins, table width, title/header/footer texts
  with substitutions, colors and a PNG/JPEG logo, with a PDF preview. Reports pick one in their
  settings (`"pdf": {"layout": …, "columns": […], "widths": {…}, "align": {…}}`), or use the
  application's default layout. Layouts are included in exports. HR sample: the Directory
  prints with `HR_DIRECTORY`.
- Printing: interactive reports get **Download PDF** (A4, landscape when wide; title, active
  filters, repeated headings, page numbers; same query, filters and access checks as the
  screen) and **Print** in the Actions menu; every page has a print stylesheet without
  navigation and toolbars. `PDF_FONT` / `PDF_FONT_BOLD` embed a TrueType font for scripts
  beyond Western European; `PDF_MAX_ROWS` (default 5000) limits the rows.
- Data loading (CSV, TSV, Excel .xlsx):
  - SQL Workshop → **Load Data**: upload, preview, then load into a new table (column names
    and types inferred) or an existing one (columns mapped by name; append, merge by primary
    key, or replace), with a per-row error report. Nothing is loaded when a row fails unless
    "skip rows with errors" is ticked.
  - Page process type `data_load` loads a file item's file into a table as the application's
    role (grants, RLS, triggers apply); row errors are shown on the file item. HR sample:
    page 13 *Import employees*.
- File upload items (APEX *File Browse*): item type `file` saves into a form's bytea column
  (with file name and MIME type columns) or into the session's temporary files
  (`meta.temp_files`, like `APEX_APPLICATION_TEMP_FILES`). Image previews, remove option,
  size (`max_mb`, `MAX_UPLOAD_MB`) and type (`accept`) limits, and signed downloads that run
  as the application's role (row level security applies). Uploads survive validation errors.
  HR sample: employee photo.
- Role suggestions in the builder: roles fields (Users → account, and the app's Access control)
  list the roles the application checks (authorization schemes, `meta.has_role()` in SQL, group
  mappings, roles in use); click to add, hover to see where each role is checked.

## [0.6.0] - 2026-09-30

### Added
- Chapter 15, *Useful PostgreSQL extensions*: contrib and third-party extensions mapped to APEX
  features (scheduling, web services, maps, AI search, auditing, Oracle compatibility), with
  security notes and tested examples (`test/extensions.test.ts`).
- Exclusion-constraint violations (e.g. overlapping date ranges with `btree_gist`) get a friendly
  message, like check constraints.

### Changed
- The APEX 26.1 parity matrix was re-reviewed: 116 features compared, with counts per area and
  sections on deliberate differences and gaps that extensions close. The CSP row is now partial
  (inline styles are still allowed).

### Removed
- **E-mail and "forgot password"** (they were in the unreleased 0.5.0 development builds): the mail
  queue, `meta.send_mail()`/`send_mail_template()`/`add_attachment()`, e-mail templates, the *Send
  e-mail* process, Builder → Mail, the SMTP settings, the Mailpit container, and the forgot/reset
  password pages. pgapex doesn't send mail; administrators set temporary passwords (with change on
  first use) instead. Migration `008_drop_mail.sql` removes the objects from databases that ran the
  development builds; fresh installs never create them.

## [0.5.0] - 2026-09-29

Not tagged as a release: its development builds included e-mail, which 0.6.0 removed again.

### Added
- **My account** in every application: change your own password, choose light or dark and the language.
- Password policy and APEX-style account controls:
  - change of password on first use;
  - password lifetime (expiry);
  - expire/unexpire and admin reset (also as `meta.set_password()`, `meta.expire_password()`);
  - minimum length, letters and digits;
  - unlock after failed sign-ins (Builder → Users).
- **Light/dark switch**: an app theme style (automatic, light, dark) and "users may choose", saved on the account.
- **Globalization**:
  - a primary language and translated languages per app, chosen from the browser, the user's preference or `?lang=`;
  - translations of all app texts in the builder, with XLIFF 1.2 and CSV export/import;
  - text messages (`meta.message()`, `&APP_TEXT$NAME.`);
  - pgapex's own texts in English and Dutch;
  - date and timestamp masks;
  - right-to-left languages.
- The HR sample in Dutch.
- New chapter 14, *Globalization*.

### Changed
- Upgrade note: migrations 006–007 add the new tables. Existing passwords count as changed at upgrade time for the password lifetime.

## [0.4.0] - 2026-09-29

### Added
- User directory (Builder → Users): one account per person for all applications, with per-application access control ("only listed accounts" or "any active account") and roles per application, like APEX workspace accounts with Application Access Control.
- Single sign-on with OpenID Connect: identity providers (Builder → Users → Identity providers), sign-in methods per application, identity-provider groups mapped to application roles, account linking by subject, optional automatic account creation. A Keycloak demo is included (`docker compose --profile sso`, `examples/keycloak-sso.sql`).
- REST APIs with PostgREST running next to pgapex (`docker compose --profile api`): `meta.app_user()`, `meta.app_id()` and `meta.has_role()` understand PostgREST's JWT claims, so the same RLS policies protect the UI and the API; a per-application API role; the pre-request check `meta.api_check()` (inactive accounts and revoked access are refused at once); Builder → App → REST API with endpoints, token issuing and curl examples. The HR sample has an `api` schema (`db/seed/hr_03_api.sql`). New chapter 13.
- `PUBLIC_URL`, `API_URL` and `API_JWT_SECRET` settings.

### Changed
- Roles are resolved at sign-in and stored with the session; `meta.has_role()` reads them.
- `meta.app_user` is now a compatibility view over `meta.account` and `meta.app_access`.
- **Upgrade note:** migration 003 moves existing per-application users into the directory. A username that existed in several applications is kept for the first application and renamed `username@alias` for the others (they can't be assumed to be the same person). Existing application sessions end.

## [0.3.0] - 2026-09-29

### Added
- Responsive layout for phones, tablets and desktops: navigation drawer, reflowing reports and grids, full-screen dialogs, bottom-sheet menus, touch-sized controls; browser tests at four viewport sizes (`npm run test:e2e`).
- Interactive grid region with inline editing, adding and deleting rows (signed row keys, per-row errors).
- Charts: column, line, area and donut, with multi-series support, tooltips and data tables.
- Calendar, faceted search and dynamic content regions.
- Item types: checkbox group, multi-select, searchable popup list of values, email, phone, URL, colour.
- Shared lists of values, theme colours and top navigation.
- "Interactive grid" page wizard.
- APEX feature parity matrix (`docs/apex-feature-parity.md`).
- Open source packaging: Apache-2.0 license, contributing guide, code of conduct, CI, issue templates.

## [0.2.0] - 2026-09-29

### Added
- Universal Theme-style UI: side navigation, breadcrumbs, user menu, 12-column grid, dark mode.
- Interactive report actions (column filters, rows per page, CSV download), cards and metric cards, modal dialog pages.
- Dynamic actions, cascading lists of values, radio/switch items, read-only conditions, static lists of values.
- Shared components: navigation menu, authorization schemes, application items, application processes.
- Builder: tree-based page designer, shared components, activity monitor, SQL Workshop object browser, developer accounts.
- HR sample with PL/pgSQL workflows, triggers and row level security.
- Security hardening (see SECURITY.md) and a security regression test suite.
- Versioned migrations (`npm run db:migrate`).

## [0.1.0] - 2026-09-29

### Added
- First version: metadata repository, runtime (reports, forms, charts, static regions), bind variables, validations, processes, login, builder, CRUD wizard, export/import.
