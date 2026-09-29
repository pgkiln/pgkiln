# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-09-29

### Added
- **My account** in every application: change your own password, choose light or dark and the language.
- Password policy and APEX-style account controls:
  - change of password on first use;
  - password lifetime (expiry);
  - expire/unexpire and admin reset (also as `meta.set_password()`, `meta.expire_password()`);
  - minimum length, letters and digits;
  - unlock after failed sign-ins (Builder → Users).
- **Forgot password** (opt-in per application): one-time reset links by e-mail, valid 30 minutes.
- **Light/dark switch**: an app theme style (automatic, light, dark) and "users may choose", saved on the account.
- **Globalization**:
  - a primary language and translated languages per app, chosen from the browser, the user's preference or `?lang=`;
  - translations of all app texts in the builder, with XLIFF 1.2 and CSV export/import;
  - text messages (`meta.message()`, `&APP_TEXT$NAME.`);
  - pgapex's own texts in English and Dutch;
  - date and timestamp masks;
  - right-to-left languages.
- **E-mail**:
  - `meta.send_mail()`, `meta.send_mail_template()` and `meta.add_attachment()`;
  - e-mail templates (Shared Components);
  - a *Send e-mail* page process;
  - SMTP delivery with retries;
  - Builder → Mail (queue, log, test mail, send now);
  - a Mailpit container for development (`docker compose --profile mail`).
- The HR sample in Dutch, with e-mail when leave is decided.
- New chapter 14, *Globalization and e-mail*.

### Changed
- Settings: `SMTP_*`, `MAIL_FROM`, `MAIL_POLL_SECONDS`, `MAIL_MAX_ATTEMPTS`.
- Page processes have a `config` column; process type `send_email`.
- Upgrade note: migrations 006–008 add the new tables. Existing passwords count as changed at upgrade time for the password lifetime.

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
