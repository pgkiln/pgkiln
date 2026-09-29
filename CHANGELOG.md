# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- User directory (Builder → Users): one account per person for all applications, with per-application access control ("only listed accounts" or "any active account") and roles per application, like APEX workspace accounts with Application Access Control.
- Single sign-on with OpenID Connect: identity providers (Builder → Users → Identity providers), sign-in methods per application, identity-provider groups mapped to application roles, account linking by subject, optional automatic account creation. A Keycloak demo is included (`docker compose --profile sso`, `examples/keycloak-sso.sql`).
- `PUBLIC_URL` setting.

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
