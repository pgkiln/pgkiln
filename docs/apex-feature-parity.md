# Oracle APEX feature parity

This page compares pgapex with **Oracle APEX 26.1** (May 2026), area by area. It's meant to be
honest: it shows what a team moving from APEX can use today and what is still missing. Pick an
open item and open an issue or pull request; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Legend: ✅ available · 🟡 partial (see notes) · ❌ not yet · ➖ not planned (a deliberate choice,
or better served by the PostgreSQL ecosystem; see the notes and [extensions](guide/15-extensions.md))

Last reviewed: 2026-09-30 (pgapex 0.7.0: file upload, data loading, printing, OAuth clients, report layouts, Excel download).

## At a glance

| Area | ✅ | 🟡 | ❌ | ➖ | In short |
|---|---:|---:|---:|---:|---|
| App Builder and development | 2 | 6 | 7 | 0 | Solid builder and wizards; no drag-and-drop, no team/AI tooling |
| Regions | 6 | 5 | 6 | 0 | All everyday regions; power-user report features and maps missing |
| Items | 6 | 3 | 3 | 0 | All common items and file upload; no rich text editor yet |
| Logic and processing | 4 | 5 | 3 | 1 | Core APEX model complete; fewer declarative process types |
| Security | 14 | 2 | 3 | 2 | On par or stricter; no LDAP/SAML, no "remember me" |
| User interface | 4 | 4 | 2 | 0 | Universal Theme-like and responsive; smaller theme roller and icon set |
| Globalization | 4 | 2 | 0 | 0 | One translated app like 26.1; two built-in languages |
| Data and integration | 2 | 3 | 3 | 3 | REST APIs via PostgREST, CSV/XLSX loading, report PDFs; no document templates or REST data sources |
| Workflow, automation and AI | 0 | 0 | 6 | 0 | Not started; approvals are hand-built in PL/pgSQL (see the HR sample) |
| Administration | 1 | 3 | 1 | 0 | Single workspace |
| **Total** | **43** | **33** | **34** | **6** | 116 APEX features compared: 37% available, 28% partial |

(Counts are of the rows in the tables below.)

## App Builder and development

| APEX | pgapex | Notes |
|---|---|---|
| App Builder: create, edit, delete, run apps | ✅ | Builder at `/builder` |
| Create application wizard | 🟡 | Blank app with a dedicated database role and schema. No "from a spreadsheet", no blueprints (26.1) |
| Create page wizards | 🟡 | *Report and form* and *Interactive grid* from any table; other page types start blank |
| Page Designer | 🟡 | Component tree and grouped property editor. No drag-and-drop layout grid; no code editor with autocomplete |
| Shared components | 🟡 | Navigation menu, authorization schemes, lists of values, application items and processes, access control, globalization. No generic lists, templates, plug-ins or build options |
| Export / import | ✅ | `meta.export_app()` / `meta.import_app()`: portable JSON, also in the builder |
| APEXlang: human-readable, diffable app files; static IDs (26.1) | 🟡 | The JSON export is diffable, but there's no file-per-component layout, CLI or static IDs |
| Working copies, merge, team development | ❌ | Use git on exports |
| Application lock (26.1), page locks, comments | ❌ | |
| Supporting objects (install scripts) | ❌ | Put your schema in versioned SQL migrations next to the export |
| Theme, library and boilerplate application types (26.1) | ❌ | |
| Advisor | 🟡 | Security checklist per app. A PL/pgSQL linter can come from `plpgsql_check` ([extensions](guide/15-extensions.md)) |
| Builder search, "where used" | ❌ | |
| AI assistant, pages from natural language, describe tables for LLMs (26.1) | ❌ | |
| Sample data source for development (26.1) | ❌ | |

## Regions

| APEX | pgapex | Notes |
|---|---|---|
| Classic report | ✅ | `report` with `interactive: false` |
| Interactive report | 🟡 | Search, column filters, sort, rows per page, CSV, Excel (typed cells) and PDF download, print, reset, reflow on phones. **Missing:** saved/public reports, control break, highlight, aggregates, group by, pivot, chart view, flashback, row selection and maximum rows (26.1), natural-language control (26.1) |
| Interactive grid | 🟡 | Inline edit, add and delete rows, lists of values, required columns, per-row errors, all-or-nothing save, signed row keys, search and paging. **Missing:** copy/paste (26.1), column reorder/resize/freeze, master-detail, aggregates, row actions menu, saved reports |
| Form (automatic row processing) | ✅ | Fetch, insert, update, delete, in a page or a modal dialog. Detects rows deleted meanwhile, but no optimistic locking of concurrent edits yet |
| Charts | 🟡 | Bar, column, line, area, donut; multi-series, tooltips, data table, palette checked for colour-vision deficiency. **Missing:** scatter, bubble, stacked, combination, gauge, Gantt, drill-down links |
| Cards and metric cards (26.1 metric card template) | ✅ | Cards from SQL, with a KPI "metric" style |
| Calendar | 🟡 | Month view with links; agenda list on phones. **Missing:** week/day/list views, drag-and-drop, create on click |
| Faceted search | 🟡 | Checkbox facets with live counts. **Missing:** range, search and star facets, facet charts, exclude option (26.1) |
| Smart filters | ❌ | |
| Static content, dynamic content | ✅ | `static` (HTML with substitutions) and `dynamic` (a SELECT returning HTML) |
| Breadcrumb | ✅ | Automatic, from the page's breadcrumb parent |
| Navigation menu (side or top) | ✅ | Collapsible side menu or top bar; a drawer on tablets and phones |
| Region display selector, tabs | ❌ | |
| Tree | ❌ | Recursive CTEs or `ltree` work in a report (see the org chart in the HR sample) |
| Map region (26.1: vector tiles, bounding box) | ❌ | PostGIS provides the data side ([extensions](guide/15-extensions.md)) |
| Timeline, comments, media list, avatar template components | ❌ | Cards cover simple cases |
| Template components and template directives | ❌ | `dynamic` regions can produce any HTML from SQL in the meantime |

## Items

| APEX | pgapex | Notes |
|---|---|---|
| Text field, textarea, number, date picker, password, hidden, display only | ✅ | Native inputs, with the right phone keyboard (`inputmode`) |
| Select list, radio group, checkbox, switch | ✅ | |
| Checkbox group, shuttle / multi-select | ✅ | Colon-separated values, as in APEX |
| Popup LOV | 🟡 | Searchable select list; no modal popup with several columns |
| Cascading, shared and static lists of values | ✅ | `cascade_parents`, `LOV:NAME`, `STATIC:` |
| E-mail, phone, URL, colour picker | ✅ | Typed inputs |
| Read-only condition, required, help text, default | ✅ | |
| BOOLEAN session state (26.1) | 🟡 | Stored as `true` / `false` text, which PostgreSQL casts to boolean; boolean columns map to switches |
| File browse / image upload, paste files (26.1) | 🟡 | Item type `file`: into a bytea column (with name and type) or a session temporary file (`meta.temp_files`), image preview, signed downloads through RLS ([chapter 16](guide/16-files.md)). **Missing:** several files per item, drag-and-drop/paste, object storage, image cropping |
| Rich text / markdown editor | ❌ | |
| Star rating, QR code, combobox (tags), date range | ❌ | |
| Password reveal toggle (24.2) | ❌ | |

## Logic and processing

| APEX | pgapex | Notes |
|---|---|---|
| Session state, page items, `:BIND` and `&SUBST.` syntax | ✅ | Binds become escaped untyped literals, so APEX patterns like `:X is null or col = :X` work |
| Application items and processes | ✅ | `after_login`, `before_page` |
| Validations | ✅ | Not null, SQL expression, regex, required items; `RAISE … USING COLUMN` in PL/pgSQL targets a field |
| Conditions and authorization on components | ✅ | Pages, regions, items, buttons, processes, dynamic actions, navigation entries; re-checked on submit |
| Computations | 🟡 | Use processes (returned columns set items) |
| Page processes | 🟡 | SQL / PL/pgSQL, form DML, grid DML, data loading (`data_load`). **Missing:** invoke API, download, workflow, execution chains, *Generate Text with AI* (26.1) |
| Branches | 🟡 | Per-button target page; no conditional branches |
| Dynamic actions | 🟡 | Show, hide, enable, disable, set value (SQL), execute SQL, refresh region or item, alert, submit. **Missing:** custom JavaScript, set focus/class, dialog events, show success/error message and clear errors (26.1), plug-ins |
| APEX PL/SQL APIs | 🟡 | `meta.app_user()`, `meta.has_role()`, `meta.v()`, `meta.page_url()`, `meta.message()`, `meta.html_escape()`, password functions. No equivalents of `APEX_WEB_SERVICE`, `APEX_DATA_PARSER`, `APEX_ZIP`, … |
| Declarative menu buttons, button badges (26.1) | ❌ | |
| Plug-ins | ❌ | |
| Build options | ❌ | |
| Collections (`APEX_COLLECTION`) | ➖ | Temporary or unlogged tables, or `jsonb` in session state |

## Security

| APEX | pgapex | Notes |
|---|---|---|
| APEX accounts | ✅ | Instance-wide user directory, bcrypt, session rotation, idle and absolute timeouts |
| Application Access Control (roles per app, any-user switch) | ✅ | Access control per application |
| Social sign-in / OpenID Connect | ✅ | Any OIDC provider (Entra ID, Google, Okta, Keycloak, …): PKCE, group → role mapping, account linking, automatic accounts |
| Multi-factor authentication | ✅ | As in APEX: through the identity provider (OpenID Connect) |
| Change own password | ✅ | A built-in *My account* page (APEX offers the API `CHANGE_CURRENT_USER_PW`) |
| Password expiry, change on first use, admin reset, complexity | ✅ | Lifetime in days, expire/unexpire, admin reset, length and letters+digits rules, unlock |
| Lockout after failed sign-ins | ✅ | Per user and per IP, time-based (APEX: until an administrator unlocks) |
| Authorization schemes | ✅ | Role or SQL based, negation, fail closed |
| Session state protection (checksums) | ✅ | HMAC per app, page and user; `meta.page_url()` in SQL |
| Parsing schema | ✅ | Per-app database role (`SET LOCAL ROLE`) |
| VPD / row level security | ✅ | PostgreSQL RLS with `meta.app_user()` / `meta.has_role()`, shared by the UI and the REST API |
| CSRF protection | ✅ | Tokens on every POST, SameSite cookies |
| Activity monitoring and audit | ✅ | Page views, sign-ins, denials, errors per app. Database-level auditing via `pgaudit` |
| Error handling that hides internals | ✅ | Reference numbers; debug mode per app |
| Content Security Policy without `unsafe-inline` (26.1) | 🟡 | Scripts: strict (`script-src 'self'`, no inline scripts). Styles still allow inline `style` attributes (`style-src 'unsafe-inline'`), used for chart bar widths and developer HTML |
| Session sharing between applications | 🟡 | Each app has its own session; with OpenID Connect the second sign-in is silent. APEX: workspace sharing or a custom cookie |
| Forgot password for end users | ➖ | pgapex sends no mail. As in APEX apps, users ask an administrator for a temporary password (change on first use) |
| Database accounts, LDAP, SAML, HTTP-header authentication | ❌ | |
| Custom authentication | ❌ | |
| Persistent authentication ("remember me") | ❌ | APEX 22.1+ |
| App launcher / portal | ➖ | Not in APEX either; each app has its own URL |

## User interface

| APEX | pgapex | Notes |
|---|---|---|
| Universal Theme look and layout | ✅ | Header, side/top navigation, breadcrumbs, 12-column grid, region templates |
| Responsive: phone, tablet, desktop | ✅ | Tested at 390, 768, 1024 and 1440px on every change (`npm run test:e2e`) |
| Modal dialog pages | ✅ | Full screen on phones |
| Dark mode and user-chosen theme style | ✅ | Automatic (follows the device), light or dark per app; users may switch, saved on the account |
| Theme Roller (26.1: conditional and dynamic properties, CSS variables) | 🟡 | Accent and header colours, navigation position. No style variants or template options |
| Icons (Font APEX 2.5) | 🟡 | 31 line icons |
| Accessibility | 🟡 | Labels, keyboard, focus rings, reduced motion, table alternatives for charts; no formal audit yet |
| Drawers, top/bottom dialogs (26.1) | 🟡 | The navigation is a drawer on small screens; no drawer pages |
| New "Iris" default style (26.1) | ❌ | pgapex has its own neutral style |
| Progressive Web App | ❌ | |

## Globalization

| APEX | pgapex | Notes |
|---|---|---|
| Translated applications (26.1: text-message-based translation of one app) | ✅ | One app with translations, like 26.1; XLIFF 1.2 and CSV export/import, coverage per language |
| Text messages (`APEX_LANG.MESSAGE`, `&APP_TEXT$…`) | ✅ | `meta.message()`, `&APP_TEXT$NAME.`, fallback to the base and primary language |
| Language from browser, preference or session | ✅ | Browser, user preference or primary; `?lang=`; right-to-left languages |
| Date and timestamp format masks | ✅ | Per app or per language |
| Built-in runtime messages in ~34 languages | 🟡 | English and Dutch; other languages via text messages with the same names |
| Number format masks, automatic time zone | 🟡 | Numbers in charts follow the language; no number masks or time zones |

## Data and integration

| APEX | pgapex | Notes |
|---|---|---|
| SQL Workshop: SQL commands, object browser | ✅ | The object browser shows columns, RLS policies, grants, data and function source |
| RESTful services (ORDS) | ✅ | [PostgREST](https://postgrest.org) next to pgapex: `api` schema, the same RLS as the UI, per-app API role, tokens in the builder, a pre-request check, and **OAuth clients** (client credentials, like ORDS `oauth.create_client`) so tokens renew themselves |
| REST handler editor, REST-enabled SQL | 🟡 | Write RPC functions in the `api` schema instead of handlers; no REST-enabled SQL (rarely desirable) |
| SQL scripts, query builder, Quick SQL | ❌ | |
| Data Workshop (load CSV/XLSX/JSON) | 🟡 | SQL Workshop → Load Data: CSV/TSV/XLSX into a new table (inferred types) or an existing one (append, merge, replace) with a per-row error report; `data_load` process for end users. **Missing:** JSON/XML, saved data load definitions, column transformations, unloading ([chapter 16](guide/16-files.md)) |
| REST data sources, web credentials (26.1: OAuth refresh tokens, password flow) | ❌ | Calling web services from SQL is possible with the `http` or `pg_net` extensions ([extensions](guide/15-extensions.md)) |
| Printing, document generator (PDF) | 🟡 | Report PDF (filters applied, page numbers) with **report layouts** (paper, orientation, font, margins, texts, colors, logo; per-report columns and widths) and a print stylesheet on every page. **Missing:** document templates for letters and invoices (BI Publisher / APEX Office Print / document generator) |
| Data Reporter: self-service reports for business users (26.1) | ❌ | |
| Sending e-mail (`APEX_MAIL`), e-mail templates, *Send E-Mail* process | ➖ | Deliberately not included: pgapex doesn't send mail. Queue mail in a table and deliver it with your own service, or use an extension such as `pg_smtp_client` |
| JSON sources, duality views (24.2) | ➖ | PostgreSQL `jsonb` works in any SQL region, form or grid source |
| Remote servers / database links | ➖ | `postgres_fdw` or `dblink` |

## Workflow, automation and AI

| APEX | pgapex | Notes |
|---|---|---|
| Approvals and task list | ❌ | The HR sample builds an approval flow in PL/pgSQL with RLS |
| Workflow (26.1: parallel flows, multi-tenancy) | ❌ | |
| Automations (scheduled) | ❌ | `pg_cron` runs scheduled SQL today ([extensions](guide/15-extensions.md)); builder integration is planned |
| AI assistant, natural-language reports (NL2IR), AI agents and tools (26.1) | ❌ | `pgvector` covers semantic search on the data side |
| *Generate Text with AI* process, structured outputs (26.1) | ❌ | |
| Blueprints, spec-driven development (26.1) | ❌ | |

## Administration

| APEX | pgapex | Notes |
|---|---|---|
| Developer accounts | ✅ | |
| Instance administration, install/upgrade logs (26.1) | 🟡 | Versioned migrations (`npm run db:migrate`) |
| Debug messages | 🟡 | Per-app debug mode; server logs |
| Monitoring (top SQL) | 🟡 | Activity per app; top SQL via `pg_stat_statements` outside the builder |
| Workspaces (multi-tenant) | ❌ | One installation = one workspace |

## Different on purpose

- **No e-mail.** pgapex doesn't queue or send mail, and has no "forgot password" link (APEX apps
  don't have one out of the box either). Mail is an operational subsystem (SMTP, retries,
  deliverability) that teams usually already have; connect to it from your own schema.
- **PostgREST instead of ORDS**, and no web listener at all: the pgapex server talks to
  PostgreSQL directly.
- **Row level security instead of VPD**, and one set of policies for the UI and the API.
- **JSON export instead of SQL or APEXlang** files.
- **Server-rendered HTML** with progressive enhancement: pages work without JavaScript, and no
  inline scripts are needed.

## Gaps that PostgreSQL extensions close today

| Gap | Extension | See |
|---|---|---|
| Automations / scheduler | `pg_cron` | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Calling REST APIs from SQL (`APEX_WEB_SERVICE`) | `http`, `pg_net` | [chapter 15](guide/15-extensions.md#tier-3-situational) |
| Map data | PostGIS | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Semantic search / RAG | `pgvector` | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Statement auditing | `pgaudit` | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Code checks (Advisor for PL/pgSQL) | `plpgsql_check` | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Pivot reports | `tablefunc` | [chapter 15](guide/15-extensions.md#tier-1-included-with-postgresql) |
| Porting PL/SQL | `orafce` | [chapter 15](guide/15-extensions.md#tier-3-situational) |

## Where pgapex goes further

Small but real differences, for teams comparing the two:

- Open source (Apache-2.0), on any PostgreSQL 15+, including every managed service.
- A strict script CSP by default, and a security regression suite that runs in CI.
- Responsive layouts verified automatically at four screen sizes.
- The theme follows the device's light/dark setting automatically, and the choice is saved per user.
- A built-in *My account* page (own password, theme, language).
- One RLS policy set protects both the web UI and the REST API.

## Roadmap (proposed priority)

1. **Automations in the builder** on `pg_cron`: schedule an app's SQL or PL/pgSQL, with run history.
2. **Interactive report power features:** saved reports, control break, aggregates, highlight, row selection.
3. **Stricter CSP:** move inline `style` attributes (chart bars) to classes or CSS variables set from CSS, then drop `style-src 'unsafe-inline'`.
4. **Builder quality:** top SQL per app (`pg_stat_statements`), code checks (`plpgsql_check`), search and "where used".
5. **LDAP and SAML** authentication; "remember me".
6. **Document printing:** document templates (e.g. HTML templates rendered to PDF) for letters and invoices, and JSON in data loading.
7. **Approvals / workflow** built on the metadata model.
8. **Map and tree regions**; more chart types; several files per upload item, drag-and-drop.
9. **Builder:** drag-and-drop layout, a code editor with SQL autocomplete, a file-per-component export and CLI.
10. **Template components and plug-ins.**
11. **AI features.**

Sources: [APEX 26.1 new features](https://docs.oracle.com/en/database/oracle/apex/26.1/htmrn/new-features.html),
[What's new in APEX 24.2](https://apex.oracle.com/en/platform/features/whats-new-242/),
[APEX_MAIL (APEX API reference)](https://docs.oracle.com/en/database/oracle/apex/24.2/aeapi/APEX_MAIL.html).
