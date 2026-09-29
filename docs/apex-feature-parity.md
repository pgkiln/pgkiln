# Oracle APEX feature parity

This page compares pgapex with **Oracle APEX 26.1** (May 2026), area by area. It is meant to be
honest: it shows what a team moving from APEX can use today and what is still missing. Pick an
open item and open an issue or pull request; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Legend: ✅ available · 🟡 partial (see notes) · ❌ not yet · ➖ out of scope (use the PostgreSQL ecosystem instead)

Last reviewed: 2026-09-29 (pgapex 0.3.0).

## Summary

| Area | Status |
|---|---|
| Core runtime (pages, regions, items, session state, processes) | ✅ solid |
| Reports, forms, grids, charts, cards, calendar, faceted search | ✅ / 🟡 core features in place, power-user features missing |
| Security (authn, authz, session state protection, CSP) | ✅ for local accounts; 🟡 no SSO yet |
| Builder (page designer, shared components, SQL Workshop) | 🟡 property editor, no drag-and-drop |
| Responsive UI, dark mode, theming | ✅ / 🟡 basic theme roller |
| Integration (REST, email, printing, data loading) | ❌ next priorities |
| Workflow, approvals, automations | ❌ (hand-built in PL/pgSQL for now, see the HR sample) |
| AI features (assistant, NL2IR, AI agents) | ❌ |
| Globalization (translations, formats) | ❌ |

## App Builder and development

| APEX | pgapex | Notes |
|---|---|---|
| App Builder, create / edit / delete apps | ✅ | Builder at `/builder` |
| Create application wizard | 🟡 | Blank app with a dedicated DB role and schema; no "from spreadsheet" or blueprint |
| Create page wizards | 🟡 | *Report and form* and *Interactive grid* from any table; other page types start blank |
| Page Designer | 🟡 | Component tree and grouped property editor; no drag-and-drop layout grid, no code editor with autocomplete |
| Shared components | 🟡 | Navigation menu, authorization schemes, lists of values, application items and processes, users. No lists (other than nav), templates, plug-ins or build options |
| Export / import | ✅ | `meta.export_app()` / `meta.import_app()`: portable JSON |
| APEXlang (human-readable, diffable files) | 🟡 | JSON export is diffable, but there's no per-component file layout or CLI yet |
| Working copies, merge, team development | ❌ | Use git on exports |
| Application lock, page locks, comments | ❌ | |
| Supporting objects (install scripts) | ❌ | Use `db/migrations` in your project |
| Theme / library / boilerplate application types | ❌ | |
| Advisor (lint), security checklist | 🟡 | Per-app security checklist in Settings |
| Builder search, "where used" | ❌ | |
| AI assistant, create pages from natural language, blueprints | ❌ | |

## Regions

| APEX | pgapex | Notes |
|---|---|---|
| Classic report | ✅ | `report` with `interactive: false` |
| Interactive report | 🟡 | Search, column filters, sort, rows per page, CSV download, reset, mobile reflow. **Missing:** saved/public reports, control break, highlight, aggregates, group by, pivot, chart view, flashback, XLSX/PDF download, row selection, NL2IR |
| Interactive grid | 🟡 | Inline edit, add and delete rows, lists of values, required columns, per-row errors, all-or-nothing save, signed row keys, search and paging. **Missing:** copy/paste, column reorder/resize/freeze, master-detail, aggregates, row actions menu, saved reports |
| Form (automatic row processing) | ✅ | Fetch, insert, update, delete, modal dialogs. Detects rows deleted meanwhile, but no optimistic locking of concurrent edits yet |
| Charts | 🟡 | Bar, column, line, area, donut; multi-series, tooltips, data table, CVD-safe palette. **Missing:** scatter, bubble, stacked, combination, gauge, Gantt, drill-down links |
| Cards / metric cards | ✅ | Plus KPI "metric" style |
| Calendar | 🟡 | Month view with links; agenda list on phones. **Missing:** week/day/list views, drag-and-drop, create on click |
| Faceted search | 🟡 | Checkbox facets with live counts. **Missing:** range, search and star facets; facet charts |
| Smart filters | ❌ | |
| Static content / dynamic content (PL/SQL) | ✅ | `static`, and `dynamic` (a SELECT returning HTML) |
| Breadcrumb | ✅ | Automatic from the page's breadcrumb parent |
| List / navigation menu | ✅ | Side (collapsible) or top navigation; drawer on tablets and phones |
| Region display selector, tabs | ❌ | |
| Tree, map, timeline, comments, media list, avatar templates | ❌ | |
| Template components | ❌ | |
| Data Reporter (self-service reporting) | ❌ | |

## Items

| APEX | pgapex | Notes |
|---|---|---|
| Text field, textarea, number, date picker, password, hidden, display only | ✅ | Native inputs (phone keyboards via `inputmode`) |
| Select list, radio group, checkbox, switch | ✅ | |
| Checkbox group, shuttle / multi-select | ✅ | Colon-separated values, as in APEX |
| Popup LOV | 🟡 | Searchable select list; no modal popup with columns |
| Cascading LOVs, shared LOVs, static LOVs | ✅ | `cascade_parents`, `LOV:NAME`, `STATIC:` |
| Email, phone, URL, colour picker | ✅ | |
| File browse / image upload | ❌ | Top priority for the next sprint |
| Rich text / markdown editor | ❌ | |
| Star rating, QR code, combobox (tags), date range | ❌ | |
| Password reveal toggle | ❌ | |
| BOOLEAN session state | 🟡 | Stored as `true` / `false` text, which Postgres casts to boolean |
| Read-only condition, required, help text, default | ✅ | |

## Logic and processing

| APEX | pgapex | Notes |
|---|---|---|
| Session state, page items, `:BIND` and `&SUBST.` syntax | ✅ | Binds become escaped untyped literals, so `:X is null` patterns work |
| Application items, application processes | ✅ | `after_login`, `before_page` |
| Computations | 🟡 | Use processes (returned columns set items) |
| Validations | ✅ | Not null, SQL expression, regex, required items; PL/pgSQL `RAISE … USING COLUMN` targets a field |
| Page processes | 🟡 | SQL / PL/pgSQL, form DML, grid DML. **Missing:** send e-mail, invoke API, data loading, download, workflow, execution chains |
| Branches | 🟡 | Per-button target page; no conditional branches |
| Conditions, authorization on components | ✅ | Pages, regions, items, buttons, processes, dynamic actions, nav entries |
| Dynamic actions | 🟡 | Show, hide, enable, disable, set value (SQL), execute SQL, refresh region/item, alert, submit. **Missing:** custom JavaScript, set focus/class, dialog events, show success/error message, plug-ins |
| APEX PL/SQL APIs | 🟡 | `meta.app_user()`, `meta.has_role()`, `meta.v()`, `meta.page_url()`, `meta.html_escape()`. No `APEX_MAIL`, `APEX_WEB_SERVICE`, `APEX_DATA_PARSER`, … |
| Collections (`APEX_COLLECTION`) | ➖ | Use temporary/unlogged tables or jsonb in session state |
| Plug-ins | ❌ | |
| Build options | ❌ | |

## Security

| APEX | pgapex | Notes |
|---|---|---|
| APEX accounts authentication | ✅ | bcrypt, lockout, session rotation, idle and absolute timeouts |
| Database accounts, LDAP, SAML, social sign-in / OpenID Connect, HTTP header | ❌ | OIDC is the top authentication priority |
| Custom authentication | ❌ | |
| Multi-factor authentication | ❌ | |
| Authorization schemes | ✅ | Role or SQL based, negation, fail closed |
| Session state protection (checksums) | ✅ | HMAC per app, page and user; `meta.page_url()` in SQL |
| Parsing schema | ✅ | Per-app database role (`SET LOCAL ROLE`) |
| VPD / row level security | ✅ | Native PostgreSQL RLS with `meta.app_user()` / `meta.has_role()` |
| CSRF protection, CSP without unsafe-inline scripts | ✅ | Strict script policy by default (APEX 26.1 is moving there) |
| Activity monitoring / audit | ✅ | Page views, sign-ins, denials, errors per app |
| Error handling (hide internals) | ✅ | Reference numbers, debug mode per app |

## User interface

| APEX | pgapex | Notes |
|---|---|---|
| Universal Theme look and layout | ✅ | Header, side/top navigation, breadcrumbs, 12-column grid, region templates |
| Responsive (phone, tablet, desktop) | ✅ | Tested at 390/768/1024/1440px in CI (`npm run test:e2e`) |
| Modal dialogs, drawers | ✅ / ❌ | Modal dialog pages (full screen on phones); no drawer pages |
| Dark mode | ✅ | Follows the OS setting |
| Theme Roller | 🟡 | Accent and header colours, navigation position; no style variants or template options |
| Icons (Font APEX) | 🟡 | 31 line icons |
| Accessibility | 🟡 | Labels, keyboard, focus rings, reduced motion, table alternatives for charts; no formal audit yet |
| Progressive Web App | ❌ | |
| Translations, multi-language apps, number/date format masks | ❌ | |

## Data and integration

| APEX | pgapex | Notes |
|---|---|---|
| SQL Workshop: SQL commands, object browser | ✅ | Object browser shows columns, RLS policies, grants, data, function source |
| SQL scripts, query builder, Quick SQL | ❌ | |
| Data Workshop (load CSV/XLSX/JSON) | ❌ | |
| RESTful services (ORDS) | ➖ | Use [PostgREST](https://postgrest.org) next to pgapex |
| REST data sources, remote servers, web credentials | ❌ | |
| Sending e-mail (`APEX_MAIL`) | ❌ | |
| Printing / document generator (PDF) | ❌ | |
| JSON sources / duality views | ➖ | Postgres `jsonb` works in any SQL region |

## Workflow, automation and AI

| APEX | pgapex | Notes |
|---|---|---|
| Approvals and task list | ❌ | The HR sample builds an approval flow in PL/pgSQL + RLS |
| Workflow | ❌ | |
| Automations (scheduled) | ❌ | Planned on `pg_cron` |
| AI assistant, NL2IR, AI agents, Generate Text process | ❌ | |

## Administration

| APEX | pgapex | Notes |
|---|---|---|
| Developer accounts | ✅ | |
| Workspaces (multi-tenant) | ❌ | One instance = one workspace |
| Instance administration, install/upgrade logs | 🟡 | Versioned migrations (`npm run db:migrate`) |
| Debug messages | 🟡 | Per-app debug mode; server logs |

## Roadmap (proposed priority)

1. **File upload items** (bytea or object storage) and download links.
2. **Authentication schemes:** OpenID Connect (Microsoft Entra, Google, Keycloak), then LDAP.
3. **E-mail and automations:** a mail queue and scheduled PL/pgSQL on `pg_cron`.
4. **Interactive report power features:** saved reports, control break, aggregates, highlight, XLSX download.
5. **Globalization:** translatable text, date/number formats per user.
6. **REST data sources and printing** (PDF documents).
7. **Approvals / workflow** built on the metadata model.
8. **Builder:** drag-and-drop layout, a code editor with SQL autocomplete, a file-per-component export and CLI.
9. **Template components and plug-ins.**
10. **AI features.**

Sources: [APEX 26.1 new features](https://docs.oracle.com/en/database/oracle/apex/26.1/htmrn/new-features.html),
[What's new in APEX 24.2](https://apex.oracle.com/en/platform/features/whats-new-242/).
