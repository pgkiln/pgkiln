# pgapex

[![CI](https://github.com/NickVrgr/Postgresql_APEX/actions/workflows/ci.yml/badge.svg)](https://github.com/NickVrgr/Postgresql_APEX/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A low-code, SQL-driven application builder for PostgreSQL, modeled on
Oracle APEX. Applications are **data**: pages, regions, items, buttons,
dynamic actions, validations and processes are rows in the `meta` schema. A
runtime turns those rows into web pages, and the builder is an editor for
them.

> pgapex is an independent open source project and is not affiliated with Oracle. Oracle and APEX are trademarks of Oracle; the name is provisional.

## Quick start

```bash
npm install
cp .env.example .env
npm run setup        # Postgres 17 on localhost:5434, migrations + HR sample
npm run dev          # http://127.0.0.1:3100
npm test             # unit + security regression tests (needs the database)
```

| URL | Login | What |
|---|---|---|
| http://127.0.0.1:3100/builder | `admin` / `admin` | Builder: apps, page designer, shared components, SQL Workshop |
| http://127.0.0.1:3100/a/hr | `demo`, `king`, `blake`, `jones`, `allen`, `scott` (password = username) | HR sample app |

HR sample users: `king` is admin and manager (the president), `blake` and
`jones` are managers, `allen` and `scott` are employees, and `demo` is an
admin who is not an employee. Sign in as different users to see
authorization schemes and row level security at work.

`npm run db:reset` recreates the database. Schema changes go in a new
`db/migrations/NNN_*.sql` file; `npm run db:migrate` applies pending ones.

## What's in the box (APEX → pgapex)

**Runtime (Universal Theme-style UI)**
- Side navigation menu (hierarchical, icons, per-entry authorization), breadcrumbs, user menu, collapsible nav, mobile layout, dark mode
- 12-column region grid; region templates *standard*, *plain*, *collapsible*
- Regions:
  - **Interactive report**: search, column filters, sort, rows per page, CSV download, and an Actions menu
  - **Form**: automatic row fetch and DML
  - **Cards**, including KPI "metric" cards
  - **Bar chart**
  - **Static HTML**
- **Modal dialog pages**: forms open over the report; they close and refresh the report on success
- **Items**: text, textarea, number, date, datetime, select, radio, checkbox, switch, display, hidden, password. Lists of values come from SQL or `STATIC:`; items can be required or read-only (by condition), and select lists can cascade.
- **Dynamic actions** (client events: change, click, load):
  - Client-side: show, hide, enable, disable, alert, submit
  - Server-side: set value from SQL, execute SQL, refresh a region, refresh an item
- Validations (not-null, SQL expression, regex), processes (automatic form DML, or any SQL/PL/pgSQL), branches, success messages
- Application items, application processes (after login, before every page), and `&ITEM.` substitutions

**Builder**
- App Builder home, app dashboard, and a "Create pages from a table" wizard (interactive report plus a modal form)
- A **page designer** with a component tree (regions → items and buttons, dynamic actions, validations, processes) and a grouped property editor
- **Shared components**: navigation menu, authorization schemes, application items, application processes, users
- Per-app settings with a security checklist, and an **activity monitor** (page views, timings, sign-ins, denials, errors)
- **SQL Workshop**: SQL commands, plus an object browser showing columns, **RLS policies**, grants, data and function source
- Export and import of apps as JSON, and developer accounts

**Security** is covered in [SECURITY.md](SECURITY.md): least-privilege runtime role, per-app database roles, authorization schemes, checksummed URLs, CSRF protection, login throttling, CSP, and 23 security regression tests.

## PL/pgSQL examples in the HR app

The sample ([`db/seed/hr.sql`](db/seed/hr.sql)) keeps its business rules in
the database and calls them from the app:

| Where in the app | Database object | Shows |
|---|---|---|
| Leave requests → *Submit request* | `hr.request_leave()` | Validation in PL/pgSQL (dates, overlaps, a 25-day balance). `raise exception … using column = 'end_date'` puts the message on the matching form field. |
| Leave request → *Approve* / *Reject* | `hr.decide_leave()` | Authorization in the database: a recursive CTE checks the management chain (`hr.is_manager_of`). |
| Manager's dashboard, employee's dashboard | `hr.notify_leave_requested()`, `hr.notify_leave_decided()` | Triggers creating notifications for *other* users (SECURITY DEFINER past RLS) |
| Employee form → *Give 10% raise* | `hr.give_raise()` | Role check via `meta.has_role()`; the returned salary is written back into the item |
| Employee form, salary field | trigger `hr.check_salary()` | A BEFORE trigger rule whose error appears on the Salary field |
| Employee form, *Job* | `hr.suggest_salary()` | Dynamic action: set a value from SQL as you type |
| Leave form, dates | `hr.business_days()` | Dynamic action computing working days live |
| Administration → Audit trail | trigger `hr.audit()` | A generic jsonb-diff audit trail recording the **application user** |
| Leave requests, notifications, audit | RLS policies | Each user sees only their own and their team's rows |
| Sign in | after-login application process | Maps the app user to an employee (`AI_EMPNO`, `AI_ENAME`) |

## How it works

```
Browser ── HTML + /static/app.js (dialogs, dynamic actions; no inline JS)
   │
Runtime (Fastify, server-rendered)            Builder (/builder)
   │ per request: BEGIN                          │ owner connection
   │   set pgapex.app_user / app_id / session    │ edits meta.* rows
   │   SET LOCAL ROLE <app db_role>              │ SQL Workshop
   │   authorization → visibility → render/process
   │ COMMIT
   │ connects as pgapex_runtime (least privilege)
Postgres
   meta.*        app definitions, sessions (hashed tokens), activity log
   your schemas  tables, PL/pgSQL, RLS policies
```

### Bind variables

`:NAME` in developer SQL is replaced by the item's value as an **escaped,
untyped string literal**. Postgres then resolves the literal's type from its
context, the way Oracle converts types implicitly. APEX patterns like
`where :P2_DEPTNO is null or deptno = :P2_DEPTNO` therefore work. With `$1`
parameters they fail with *could not determine data type of parameter*.
Empty strings are `NULL`, as in APEX. The scanner skips literals,
identifiers, comments, dollar quotes and `::` casts (see `test/binds.test.ts`).
Inside functions and `DO` blocks, use `meta.v('P1_X')`.

### SQL API for developers

| Function | Purpose |
|---|---|
| `meta.app_user()` | Signed-in application user (`nobody` when anonymous) |
| `meta.has_role('admin')` | Role check; use it in RLS policies |
| `meta.v('P1_ITEM')` | Session state value |
| `meta.page_url(3, '{"P3_ID": 7}')` | Link with a valid checksum |
| `meta.generate_crud('app', 'schema.table', 2, 3)` | The page wizard |
| `meta.export_app('alias')` / `meta.import_app(json)` | Deployment |

## Project layout

```
db/migrations/     versioned schema (metadata repository, roles, SQL API)
db/seed/hr.sql     HR sample: schema, PL/pgSQL, RLS, and the app definition
src/runtime/       context, authz, items, report, regions, render, engine, routes
src/builder/       builder UI; components.ts is the spec the property editor is generated from
src/security.ts    checksums, headers, password policy
public/            theme (CSS), app.js, icon sprite
test/              bind scanner unit tests, security regression tests
```

## Roadmap

- Interactive grid (inline editable report)
- More charts (line, pie), plus "control break" and aggregates in reports
- Shared lists of values, templates/theme roller, a drag-and-drop layout editor
- File upload items (bytea / object storage) and rich text
- Automations (scheduled PL/pgSQL through `pg_cron`), email, REST data sources
- Authentication schemes: OpenID Connect / SAML, LDAP
- MFA for developers, and an audit trail of builder changes

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md), and report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Vargar. Licensed under the [Apache License, Version 2.0](LICENSE).
