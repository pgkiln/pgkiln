# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
