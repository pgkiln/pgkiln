# Contributing to pgapex

Thanks for your interest! pgapex aims to be a practical, open alternative to Oracle APEX on
PostgreSQL. Bug reports, feature requests (especially "APEX has X"), documentation and code are
all welcome.

## Development setup

Requirements: Node.js 20+ (see `.nvmrc`), Docker (or your own PostgreSQL 15+).

```bash
npm install
cp .env.example .env
npm run setup     # starts Postgres on :5434, applies migrations and the HR sample
npm run dev       # http://127.0.0.1:3100 (auto-restarts on changes)
npm test          # unit + security tests (need the database)
npm run test:e2e  # browser tests on phone/tablet/desktop (run `npx playwright install chromium` once)
```

## How the code is organised

- `db/migrations/` holds the metadata repository (`meta` schema) and the SQL API. **Never edit a
  migration that has been released**; add `NNN_description.sql` instead.
- `src/runtime/` renders and processes application pages; `src/builder/` is the builder UI.
- `src/builder/components.ts` describes the editable properties of every component. Adding a column
  to a meta table usually means adding a field here.
- `public/` holds the theme (CSS), the client runtime (`app.js`, progressive enhancement only) and icons.

## Guidelines

- **Security first.** End-user input must never be concatenated into SQL: use `literal()` from
  `src/binds.ts`, `pg.escapeIdentifier` for identifiers from the result's own columns, or
  parameters. New features that accept input or change authorization need a regression test in
  `test/security.test.ts`.
- **Everything is metadata.** New features should be expressible as rows in `meta.*`, editable in
  the builder, exportable with `meta.export_app()`, and scriptable in SQL.
- **Works without JavaScript and without inline scripts** (the CSP forbids them). Put behaviour in
  `public/app.js` with event delegation.
- **Responsive.** Check phone (390px), tablet (768–1024px) and desktop widths; `npm run test:e2e`
  fails on horizontal overflow and checks navigation and dialogs at each size.
- **Accessible.** Labels on every control, keyboard operability, visible focus, and no information
  conveyed by colour alone.
- Match the surrounding code style; keep comments for *why*, not *what*.

## Pull requests

1. Fork, create a branch, and make focused commits with clear messages.
2. Run `npm run typecheck && npm test`.
3. Open a PR and fill in the checklist. CI runs the same checks against PostgreSQL 17.

By contributing you agree that your contributions are licensed under the Apache License 2.0.

## Reporting security issues

Please do **not** open a public issue. See [SECURITY.md](SECURITY.md#reporting-a-vulnerability).
