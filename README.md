# pgkiln

[![CI](https://github.com/NickVrgr/Postgresql_APEX/actions/workflows/ci.yml/badge.svg)](https://github.com/NickVrgr/Postgresql_APEX/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A low-code, SQL-driven application builder for PostgreSQL, modeled on
Oracle APEX. Applications are **data**: pages, regions, items, buttons,
dynamic actions, validations and processes are rows in the `meta` schema. A
runtime turns those rows into web pages, and the builder is an editor for
them.

> pgkiln (called *pgapex* until 0.31) is an independent open source project and is not affiliated with Oracle. Oracle and APEX are trademarks of Oracle.
> Website: [pgkiln.vargar.eu](https://pgkiln.vargar.eu)

<p align="center">
  <img src="docs/images/builder-page-designer.png" alt="The page designer: component tree, layout and property editor" width="100%">
</p>

## Screenshots

Everything below is the HR example application (`npm run example:hr`) and the builder. The
screenshots are made by `npm run screenshots`.

| | |
|---|---|
| ![Dashboard with metric cards and charts](docs/images/app-dashboard.png) | ![Interactive report with search and filters](docs/images/app-interactive-report.png) |
| **Dashboard**: metric cards and charts, all of it SQL | **Interactive report**: search, filters, sort, download |
| ![Faceted search with suggested filters](docs/images/app-faceted-search.png) | ![Map and cards regions](docs/images/app-cards-map.png) |
| **Smart filters and faceted search** | **Map and cards** regions on the same table |
| ![Charts in dark mode](docs/images/app-charts-dark.png) | ![Calendar region](docs/images/app-calendar.png) |
| **Charts**, in dark mode | **Calendar** of leave requests |
| ![App Builder home](docs/images/builder-home.png) | ![SQL Workshop object browser](docs/images/builder-object-browser.png) |
| **App Builder** home | **SQL Workshop**: object browser with RLS and grants |

<p align="center">
  <img src="docs/images/app-phone.png" alt="The dashboard on a phone" width="260"><br>
  <em>Responsive on phones and tablets, and installable as a Progressive Web App</em>
</p>

## Quick start

With Docker (no Node.js needed):

```bash
cd deploy
cp .env.example .env   # fill in the four secrets
docker compose up -d   # http://127.0.0.1:3100/builder (admin / the password from .env)
```

Or from the source, for developing:

```bash
npm install
cp .env.example .env
npm run setup        # Postgres 17 on localhost:5434 + the pgkiln schema (migrations)
npm run dev          # http://127.0.0.1:3100/builder (admin / admin)
```

Then build an application on your own tables: *Create application* in the builder generates
report and form pages from a table, and everything else (regions, items, processes, security,
translations, documents, approvals) is added in the page designer and Shared Components. The
[tutorial](docs/guide/10-tutorial.md) walks through one.

### The example application

pgkiln itself contains no application. The repository ships an example built on it, **HR**
(`examples/hr/`): employees and departments, leave requests with approvals, a dashboard, a REST API,
translations, documents, automations and row level security, all of it ordinary pgkiln metadata
and PostgreSQL code, the way you would build your own.

```bash
npm run example:hr   # http://127.0.0.1:3100/a/hr
```

Users (password = username): `king` is admin and manager (the president), `blake` and `jones` are
managers, `allen` and `scott` are employees, and `demo` is an admin who is not an employee. Sign
in as different users to see authorization schemes and row level security at work.

### Developing pgkiln

```bash
npm test             # unit + security regression tests (installs the HR example as their fixture)
npm run test:e2e     # browser tests on phone/tablet/desktop (npx playwright install chromium first)
```

`npm run db:reset` recreates the database (pgkiln only). Schema changes go in a new
`db/migrations/NNN_*.sql` file; `npm run db:migrate` applies pending ones.

## Working with AI coding agents

pgkiln ships an **MCP server** (`pgkiln mcp`), so Claude Code, Cursor and other agents can find an
application, read and explain its pages, look at the tables and RLS policies behind them, search
this documentation, and change the application: export it as files (one YAML file per component,
SQL inline), edit them, show the diff, and import them again in one transaction. In a checkout,
`.mcp.json` starts it for Claude Code; for your own project:

```bash
claude mcp add pgkiln -- /path/to/pgkiln/bin/pgkiln.js mcp
```

Then ask things like *"explain what happens when I press Save on page 3 of hr"* or *"add a hire
date column to the employee report and show me the diff"*. Queries it runs are read-only. See
[AI coding agents](docs/guide/20-ai-agents.md).

Without an agent, the same export and import is on the command line (`pgkiln export hr --format text`,
`pgkiln diff`, `pgkiln import --replace`, see [the CLI](docs/guide/18-cli.md)) and in the builder
(*Export* / *Import*).

## Documentation

The **[user guide](docs/README.md)** explains how everything works: installation and
configuration, concepts, the builder, every region and item type, processing, dynamic actions,
security, the SQL reference, a step-by-step tutorial, a guide for Oracle APEX developers, and
developing pgkiln itself.

## What's in the box

For a full comparison with Oracle APEX 26.1, including what's missing, see
**[docs/apex-feature-parity.md](docs/apex-feature-parity.md)**.

**Runtime (Universal Theme-style UI, responsive on phone, tablet and desktop)**
- Side or top navigation (a drawer on tablets and phones), breadcrumbs, user menu, dark mode, theme colours
- 12-column region grid; region templates *standard*, *plain*, *collapsible*
- Regions:
  - **Interactive report**: search, column filters, sort, rows per page, CSV download, reflow on phones
  - **Interactive grid**: inline edit, add and delete rows
  - **Form**: automatic row fetch and DML, in a page or a **modal dialog**
  - **Charts**: bar, column, line, area and donut
  - **Cards and metric cards**, **calendar**, **faceted search**
  - **Static and dynamic content**
- **Items**: text, textarea, number, date, datetime, select, popup LOV (searchable), radio, checkbox, switch, checkbox group, multi-select, email, phone, URL, colour, display, hidden, password. Lists of values come from SQL, `STATIC:` or shared lists; items can be required or read-only (by condition), and select lists can cascade.
- **Dynamic actions**:
  - Client-side: show, hide, enable, disable, alert, submit
  - Server-side: set value from SQL, execute SQL, refresh a region, refresh an item
- Validations, processes (form DML, grid DML, any SQL/PL/pgSQL), branches, application items and processes

**Builder**
- App Builder home, app dashboard, and create page wizards from any table: *Report and form*, *Interactive grid*, *Form*, *Cards*, *Calendar*, *Chart*, *Map*, *Faceted search* and *Master detail*, with defaults from the catalog
- A **page designer** with a component tree and a grouped property editor
- **Shared components**: navigation menu, authorization schemes, lists of values, application items and processes, users
- Settings with theme and a security checklist, and an **activity monitor**
- **SQL Workshop**: SQL commands, plus an object browser with RLS policies and grants
- Export and import of apps as JSON, and developer accounts
- A `pgkiln` command line: migrations, export/import, and apps as one file per component for git
  (diff, update in place)
- An MCP server for AI coding agents (`pgkiln mcp`): read, explain, change, diff and import applications

**Security** is covered in [SECURITY.md](SECURITY.md): least-privilege runtime role, per-app database roles, authorization schemes, checksummed URLs and grid rows, CSRF protection, login throttling, a strict CSP, and 28 security regression tests.

## PL/pgSQL examples in the HR example application

The example ([`examples/hr/hr.sql`](examples/hr/hr.sql)) keeps its business rules in
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
| `meta.generate_page('app', 'calendar', 'schema.table', 4)` | The other page wizards (form, cards, calendar, chart, map, facets, master_detail) |
| `meta.export_app('alias')` / `meta.import_app(json)` | Deployment (or `pgkiln export` / `pgkiln import`, [chapter 18](docs/guide/18-cli.md)) |

## Project layout

```
db/migrations/     pgkiln: versioned schema (metadata repository, roles, SQL API)
examples/hr/       an example application built on pgkiln (not part of it): schema, PL/pgSQL, RLS, app definition
src/runtime/       context, authz, items, report, grid, charts, calendar, facets, regions, render, engine, routes
src/builder/       builder UI; components.ts is the spec the property editor is generated from
src/security.ts    checksums, headers, password policy
src/cli/           the `pgkiln` command line (bin/pgkiln.js; docs/guide/18-cli.md)
public/            theme (CSS), app.js, icon sprite
test/              bind scanner unit tests, security regression tests, e2e/ browser tests
```

## Roadmap

See the prioritised roadmap at the end of [docs/apex-feature-parity.md](docs/apex-feature-parity.md#roadmap-proposed-priority).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md), and report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Vargar. Licensed under the [Apache License, Version 2.0](LICENSE).
