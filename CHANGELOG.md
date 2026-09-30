# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added (sprint 8)
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

### Added
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
