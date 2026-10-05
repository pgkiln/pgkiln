# Oracle APEX feature parity

This page compares pgapex with **Oracle APEX 26.1** (May 2026), area by area. It's meant to be
honest: it shows what a team moving from APEX can use today and what is still missing. Pick an
open item and open an issue or pull request; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Legend: ✅ available · 🟡 partial (see notes) · ❌ not yet · ➖ not planned (a deliberate choice,
or better served by the PostgreSQL ecosystem; see the notes and [extensions](guide/15-extensions.md))

Last reviewed: 2026-10-05 (pgapex 0.27.0: Data Reporter; sample data generator; create application from several sheets, pasted data or existing tables; 0.26.0: working copies with a three-way merge; theme, library and boilerplate applications with subscriptions; 0.25.0: Gantt, pyramid and polar charts; map layers, clustering and server-side spatial filters; REST data sources that write back from forms and grids and synchronise into tables, OAuth2 password and refresh-token grants; debug messages per request and an install/upgrade log; `meta.web_request()` and `meta.parse_data()`; Theme Roller style variants and template options; 0.24.0: automations with several actions, error handling per row and runs from SQL; invoke-API workflow steps; Unload Data in the Data Workshop; create page wizards for cards, calendar, chart, map, faceted search, form and master-detail; create an application from a file; 0.23.0: interactive grid aggregates, frozen/moved/resized columns, layouts and saved grid reports, master-detail, row actions and copy/paste; download processes, execution chains in the background, workflow processes, branches to a function's URL or another app, the Dialog Closed event; number format masks, automatic time zone, runtime messages in German, French and Spanish; SQL scripts, Quick SQL, a query builder, XML loading and data load definitions; custom authentication, lists, page and application locks with developer comments, supporting objects; 0.22.0: keyset paging, report PDFs and REST collections streamed from a cursor, database-account authentication; 0.21.0: HTTP-header authentication behind a reverse proxy; 0.20.0: a popup list of values with server-side search; 0.19.0: row-range pagination, maximum row counts and row limits, lazy loading and caching of regions, streamed CSV/Excel downloads; 0.18.0: calendar week/day/list views with drag and drop, bubble/gauge/funnel/radar charts and drill-down, smart filters, a region display selector and more facet types, computations, conditional branches, build options, menu buttons, REST data sources and web credentials, rich text/Markdown, rating, combobox, date range and QR code items; 0.17.0: an App Builder home, workspace dashboard and utilities like APEX's; 0.16.0: a Page Designer with drag-and-drop layout, a code editor with autocomplete, template components and plug-ins, parallel branches and versions of workflows, the `pgapex` command line with one file per component; 0.15.0: drop and paste files, heat maps, filtering a report by the map area; 0.14.0: stacked, combo, scatter and pie charts, several files per upload item; 0.13.0: map and tree regions; 0.12.0: REST modules in the builder; 0.11.0: workflows and Progressive Web Apps; 0.10.0: LDAP, SAML, "Keep me signed in", document templates, JSON loading, approvals and the task list; pgapex installs no application, HR is an example).

## At a glance

| Area | ✅ | 🟡 | ❌ | ➖ | In short |
|---|---:|---:|---:|---:|---|
| App Builder and development | 14 | 1 | 0 | 0 | Page Designer with drag-and-drop and a code editor, wizards, search, where used, an Advisor, a CLI with one file per component, page locks and comments, supporting objects, working copies with a three-way merge, theme/library/boilerplate apps with subscriptions; App Builder AI (pages, SQL and table descriptions) |
| Regions | 18 | 2 | 0 | 0 | All everyday regions; sixteen chart types with drill-down; calendars with week/day/list views and drag and drop; faceted search, smart filters and a region display selector; interactive reports with breaks, aggregates, highlights, compute, group by, pivot, chart view and saved reports; maps and trees; template components; row ranges, lazy loading and region caching for large tables |
| Items | 10 | 2 | 0 | 0 | All common items, file upload (several files per item), rich text and Markdown editors, star rating, combobox, date range, QR code, password reveal |
| Logic and processing | 9 | 3 | 0 | 1 | Core APEX model complete with computations, conditional branches, build options and menu buttons, download, chain and workflow processes; no custom JavaScript in dynamic actions |
| Security | 19 | 1 | 0 | 0 | On par or stricter (CSP without `unsafe-inline`); OIDC, SAML and LDAP; header authentication behind a proxy; database accounts; custom authentication |
| User interface | 7 | 3 | 0 | 0 | Universal Theme-like and responsive; smaller theme roller and icon set |
| Globalization | 5 | 1 | 0 | 0 | One translated app like 26.1; number format masks and automatic time zone; five built-in languages |
| Data and integration | 8 | 1 | 0 | 2 | REST APIs via PostgREST, REST data sources that write back and synchronise, web credentials with OAuth2 grants, CSV/XLSX/JSON/XML loading with saved definitions and unloading, SQL scripts and Quick SQL, report PDFs and document templates |
| Workflow, automation and AI | 5 | 1 | 0 | 0 | Scheduled automations with several actions and runs from SQL, approvals, a task list and workflows with parallel branches, versions and invoke-API steps; AI with Claude or OpenAI: *Generate text with AI*, an assistant region with tools, natural-language report filters and blueprints |
| Administration | 3 | 2 | 0 | 0 | Workspaces that group applications and developers (not a tenant boundary); Top SQL per app; debug messages per request; an install/upgrade log |
| **Total** | **98** | **17** | **0** | **3** | 118 APEX features compared: 83% available, 14% partial |

(Counts are of the rows in the tables below.)

## App Builder and development

| APEX | pgapex | Notes |
|---|---|---|
| App Builder: create, edit, delete, run apps | ✅ | Builder at `/builder` |
| Create application wizard | ✅ | Blank app with its own database role and schema, started from a **boilerplate application** if wanted; **from a file**: CSV/TSV/XLSX/JSON/XML, where an Excel workbook with several sheets (or JSON with several arrays) becomes several tables, with a preview to include or leave out each sheet, edit table/column names, types and primary keys, and **foreign keys proposed** from matching columns; **from pasted data** (CSV/TSV text); **from existing tables** (pick the tables and views of a schema). Each gives a report and form per table, navigation and an optional dashboard (a chart per table), plus an optional faceted search for a single table, all created in one transaction. **Missing:** blueprints (26.1) |
| Create page wizards | ✅ | Report and form, interactive grid, form, cards, calendar, chart, map, faceted search and master-detail (stacked grids) from any table or view, with defaults from the catalog (columns, key, dates, positions, foreign keys), an optional modal form page and a navigation entry; also from SQL (`meta.generate_page`). No side-by-side or drill-down master-detail, no wizard for smart filters or trees |
| Page Designer | ✅ | IDE-style window (dark or light): component tree, a layout canvas with drag and drop (with keyboard and button alternatives) and a gallery of regions, items and buttons, a filterable property editor; undo/redo; panes become tabs on phones. Settings forms for report, grid, chart, cards, calendar, faceted search, smart filters, display selector, map, tree and template component regions. A code editor for SQL, PL/pgSQL, JSON and HTML with highlighting and autocomplete of tables, columns and `:ITEM` binds (no extra libraries). Drag and drop needs a mouse; on touch screens the Arrange buttons move components |
| Shared components | ✅ | Navigation menu, **lists** (static entries with nesting, badges, conditions, authorization and build options, or a query; for list regions, the navigation menu and the navigation bar), authorization schemes, build options, lists of values, application items and processes, access control, globalization, template components and plug-ins, web credentials, REST data sources, data load definitions, supporting objects |
| Export / import | ✅ | `meta.export_app()` / `meta.import_app()`: portable JSON, also in the builder |
| APEXlang: human-readable, diffable app files; static IDs (26.1) | 🟡 | `pgapex export --format dir`: one JSON file per component with sorted keys, SQL and HTML in sibling files, references by static id instead of database ids; `pgapex import --replace` updates an app in place, `pgapex diff` compares ([chapter 18](guide/18-cli.md)). Static ids are derived from names (template components have stored ones), and the files are JSON rather than a language of their own |
| Working copies, merge, team development | ✅ | **Working copies** of an application ([chapter 3](guide/03-builder.md#working-copies)): a second app on the same schema and data, compared three ways per component (settings, each shared component, page, region, item, …) with the main app as it was when copied; changes on one side merge, conflicts are chosen per component with a line diff; merge into the main app or refresh the copy, keeping users, sessions, saved reports, secrets and automation switches; locks respected. Conflicts are resolved per component, not per property |
| Application lock (26.1), page locks, comments | ✅ | Page and application locks, enforced on the server for every builder change; the owner or an administrator unlocks, and an administrator breaking a lock is logged. Developer comments per page and per app ([chapter 3](guide/03-builder.md)) |
| Supporting objects (install scripts) | ✅ | Install, upgrade and deinstall scripts travel with the export (JSON and directory formats), never run on import; reviewed and run from the builder as the app's role, in one transaction, with a result per statement ([chapter 3](guide/03-builder.md#supporting-objects)) |
| Theme, library and boilerplate application types (26.1) | ✅ | An application type in Settings ([chapter 3](guide/03-builder.md#application-types-and-subscriptions)): a **theme** app offers its theme (colours, navigation, Theme Roller styles) and template components, a **library** app its lists of values, authorization schemes, build options, template components and lists; other apps **subscribe** (the component is copied), see whether they are in sync, **refresh** one or all, and the master **publishes** to its subscribers (locked apps skipped). A **boilerplate** app is a *Start from* choice in Create application. Subscriptions are not exported; no subscriptions to pages or plug-ins other than template components |
| Advisor | ✅ | Per app: every SQL fragment planned (EXPLAIN, as the app's role, rolled back) for syntax, unknown objects, types and grants; PL/pgSQL blocks compiled; references to missing pages, items, lists of values, schemes and layouts; PL/pgSQL functions with `plpgsql_check` when installed. Plus the security checklist |
| Builder search, "where used" | ✅ | Search over every page and component (names, SQL, settings, help); "Used in" under items, pages, lists of values, schemes and report layouts. No search and replace |
| AI assistant, pages from natural language, describe tables for LLMs (26.1) | ✅ | **App Builder AI** (administrators choose the builder's AI service): SQL Workshop → AI writes SQL from a question (shown in an editor, never run automatically), explains a query or an error, and describes tables and columns for LLMs (notes, optionally `COMMENT ON`, with AI drafts from names, types and keys only); **Create pages with AI** turns a description into proposed pages that the developer edits and confirms ([chapter 3](guide/03-builder.md)). The model never sees table rows |
| Sample data source for development (26.1) | ✅ | SQL Workshop → **Sample Data** ([chapter 16](guide/16-files.md#sql-workshop--sample-data)): generators proposed per column from the catalog and column names (names, e-mail addresses, phones, companies, addresses, words and sentences, codes, number/date/time ranges, booleans, value lists from enums and CHECKs, sequences, foreign keys picking existing or newly inserted parent rows, values relative to another column, % nulls; identity/serial/generated columns skipped; unique and simple CHECK constraints respected), rows per table, a seed for repeatable data, preview (inserted and rolled back), insert in one transaction with parents first, download as SQL INSERTs or CSV, saved generator definitions |

## Regions

| APEX | pgapex | Notes |
|---|---|---|
| Classic report | ✅ | `report` with `interactive: false` |
| Interactive report | 🟡 | Search, column filters, sort, rows per page, control break, aggregates (with subtotals), highlight, saved private and public reports, computed columns, group by, pivot, chart view, row selection into a page item, CSV, Excel (typed cells) and PDF download, print, reset, reflow on phones. **Missing:** flashback, maximum rows (26.1), natural-language control (26.1), selection across pages |
| Interactive grid | ✅ | Inline edit, add and delete rows, lists of values, required columns, per-row errors, all-or-nothing save, signed row keys, search and paging; **aggregates** over the whole result (developer and user defined), **frozen columns**, column **reorder/resize/hide** (Actions → Columns, or drag and drop), per-user layouts and **saved grid reports** (private and public), **master-detail** (signed row selection, details refreshed in place), a **row actions menu** (edit, duplicate, delete, links) and **copy/paste** of cell ranges (tab-separated, spreadsheet compatible) ([chapter 4](guide/04-pages-and-regions.md)) |
| Form (automatic row processing) | ✅ | Fetch, insert, update, delete, in a page or a modal dialog. Detects rows deleted meanwhile, but no optimistic locking of concurrent edits yet |
| Charts | ✅ | Bar, column, stacked, line, area, combination (columns + lines), scatter, bubble, donut, pie, gauge, funnel, radar, **Gantt** (start/end, progress, milestones, dependencies, a today line, a time axis from hours to years), **pyramid** (area-proportional segments, or two series back to back) and **polar** (polar area); multi-series, tooltips, data table, palette checked for colour-vision deficiency; drill-down links on chart marks (checksummed, only to pages the user may open). Drawn on the server as SVG without inline styles. **Missing:** other Oracle JET types (e.g. stock, box plot, range), editing a Gantt by drag and drop |
| Cards and metric cards (26.1 metric card template) | ✅ | Cards from SQL, with a KPI "metric" style |
| Calendar | ✅ | Month, week, day and list views (agenda list on phones); create on click (a checksummed link with the slot); drag and drop to move events through the developer's move SQL, run as the app's role (CSRF, a *who may drag* authorization, only events the user sees). Works without JavaScript; dragging adds on top ([chapter 4](guide/04-pages-and-regions.md#calendar)) |
| Faceted search | ✅ | Checkbox, range (predefined, or a custom from/to on numbers and dates), star rating and search facets with live counts that honour the other facets; exclude on checkbox facets (26.1). Values travel as query parameters, never as SQL text. **Missing:** facet charts |
| Smart filters | ✅ | One search field with filter chips and suggestions over a report, the same facet types; URL-based, works without JavaScript ([chapter 4](guide/04-pages-and-regions.md#smart_filters)) |
| Static content, dynamic content | ✅ | `static` (HTML with substitutions) and `dynamic` (a SELECT returning HTML) |
| Breadcrumb | ✅ | Automatic, from the page's breadcrumb parent |
| Navigation menu (side or top) | ✅ | Collapsible side menu or top bar; a drawer on tablets and phones |
| Region display selector, tabs | ✅ | Tabs or a select list; regions can share a tab, *Show all*, the choice remembered in the session, `#R<id>` links. Accessible tabs with JavaScript; without it every region shows with links to each |
| Tree | ✅ | `tree` region from id / parent id / label rows, with icons, links and the first levels open; works without JavaScript |
| Map region (26.1: vector tiles, bounding box) | 🟡 | `map` region: several layers per map, each with its own query (markers, lines and areas from GeoJSON or a PostGIS geometry, heat maps), a legend that switches layers on and off and a colour per layer; marker clustering; popups with links. A report can be filtered by the visible area or by the distance from the map's centre on the server: with PostGIS (`ST_Intersects`/`ST_DWithin`, detected automatically) when installed, otherwise on latitude/longitude (bounding box, haversine). Configurable tile server. **Missing:** vector tiles; a map's own layers are not filtered by the visible area |
| Timeline, comments, media list, avatar template components (26.1: groups, Metric Card) | ✅ | Built in for every application: avatar (groups), badge, comments, media list, metric card and timeline, as regions (one or all rows, the group) and report column templates; an application's own copy replaces a built-in one ([chapter 4](guide/04-pages-and-regions.md#built-in-template-components)) |
| Pagination of large tables (row ranges, maximum row count) | ✅ | Reports and grids page in the database; `"pagination": "range"` shows APEX's "row ranges X to Y" without a total (it reads one row more for *Next*); `max_rows` is a maximum row count (the total is counted over at most max+1 rows: "of more than N"; downloads are capped too); page numbers and sizes are clamped on the server. Cards (500), charts (1000), dynamic content (1000) and lists of values (5000) have configurable row limits. Keyset ("seek") paging on an indexed sort (`"keyset"`), with signed positions |
| Lazy loading of regions | ✅ | `"lazy": true` on report, chart, cards, dynamic, tree and template component regions: a placeholder, fetched after the page shows (page, condition and authorization re-checked); without JavaScript a link shows the region ([chapter 4](guide/04-pages-and-regions.md#large-tables)) |
| Region caching (per user, per session, for a duration) | ✅ | `"cache": {"scope": "user" \| "session" \| "all", "seconds": N}` keeps rendered regions in server memory, keyed by app, region, roles, language, the query string and the item values the region uses; a page submit empties it. CSRF tokens and per-user links are never shared. Per server process |
| Template components and template directives | ✅ | Shared Components → Template components: `#PLACEHOLDERS#` (always escaped), `{if}`, `{case}` and `{loop}` directives, custom attributes, a wrapper; as a region type and as report column templates, with a preview. Templates are checked against an allow-list (no scripts, styles, event handlers or `javascript:` links) ([chapter 4](guide/04-pages-and-regions.md#template-components)) |

## Items

| APEX | pgapex | Notes |
|---|---|---|
| Text field, textarea, number, date picker, password, hidden, display only | ✅ | Native inputs, with the right phone keyboard (`inputmode`) |
| Select list, radio group, checkbox, switch | ✅ | |
| Checkbox group, shuttle / multi-select | ✅ | Colon-separated values, as in APEX |
| Popup LOV | ✅ | `popup_lov`: a dialog with server-side search (paged, at most 100 rows a page) of the item's own shared, static or SQL list of values, extra display columns, return vs display value; the posted value is checked against the list; a select list without JavaScript ([chapter 5](guide/05-items.md)) |
| Cascading, shared and static lists of values | ✅ | `cascade_parents`, `LOV:NAME`, `STATIC:` |
| E-mail, phone, URL, colour picker | ✅ | Typed inputs |
| Read-only condition, required, help text, default | ✅ | |
| BOOLEAN session state (26.1) | 🟡 | Stored as `true` / `false` text, which PostgreSQL casts to boolean; boolean columns map to switches |
| File browse / image upload, paste files (26.1) | 🟡 | Item type `file`: into a bytea column (with name and type) or a session temporary file (`meta.temp_files`), **several files per item** (one row per file in a child table, or a list of temporary files), drag-and-drop and paste (26.1), image preview, signed downloads through RLS ([chapter 16](guide/16-files.md)). **Missing:** object storage, image cropping |
| Rich text / markdown editor | ✅ | `richtext` (HTML rebuilt from an allow-list on the server when saved and shown, pasted HTML cleaned in the browser) and `markdown` (rendered on the server, HTML typed in it shown as text); a toolbar with JavaScript, a plain text field without ([chapter 5](guide/05-items.md)) |
| Star rating, QR code, combobox (tags), date range | ✅ | `rating` (radio buttons drawn as stars), `qrcode` (SVG drawn on the server, no dependency), `combobox` (free text with list-of-values suggestions, tags, colon-separated), `daterange` (`from:to`); all work without JavaScript and are checked on the server |
| Password reveal toggle (24.2) | ✅ | `{"reveal": true}` on password items; the value is never sent back to the page |

## Logic and processing

| APEX | pgapex | Notes |
|---|---|---|
| Session state, page items, `:BIND` and `&SUBST.` syntax | ✅ | Binds become escaped untyped literals, so APEX patterns like `:X is null or col = :X` work |
| Application items and processes | ✅ | `after_login`, `before_page` |
| Validations | ✅ | Not null, SQL expression, regex, required items; `RAISE … USING COLUMN` in PL/pgSQL targets a field |
| Conditions and authorization on components | ✅ | Pages, regions, items, buttons, processes, dynamic actions, navigation entries; re-checked on submit |
| Computations | ✅ | Static, item, SQL query, SQL expression and PL/pgSQL function body; before header and after submit; with a condition, authorization and build option ([chapter 6](guide/06-processing.md#computations)) |
| Page processes | ✅ | SQL / PL/pgSQL, form DML, grid DML, data loading (`data_load`), **invoke API** (a REST data source or URL, response values into items), **download** (a file from a query; several rows become one zip; on submit or on load), **execution chains** (child processes with their own conditions, nested, optionally run in the background with a status view), **workflow** (start, terminate, retry), **Generate text with AI** (text or structured output into items) |
| Branches | ✅ | Before header and after processing, to a page (with items) or a URL inside the app, *When button pressed*, server-side conditions (SQL, exists, item null/equals, request); the button's target page stays the fallback ([chapter 6](guide/06-processing.md#branches)); a PL/pgSQL function returning a path in the app, and a page of another application (with signed items) |
| Dynamic actions | 🟡 | Show, hide, enable, disable, set value (SQL), execute SQL, refresh region or item, alert, submit, set focus, add/remove class, show success/error message and clear errors (26.1); the **Dialog Closed** event (per dialog page, with the dialog's message). **Missing:** custom JavaScript, plug-ins |
| APEX PL/SQL APIs | 🟡 | `meta.app_user()`, `meta.has_role()`, `meta.v()`, `meta.page_url()`, `meta.message()`, `meta.html_escape()`, password functions, `meta.debug()`; **`meta.web_request()` / `meta.web_request_source()` + `meta.web_response()`** (APEX_WEB_SERVICE: queued and made by the server, right after the page process that queued it or by the scheduler after commit, through the allow-list/SSRF checks and the app's web credentials; responses kept 24 h) and **`meta.parse_data()` / `meta.parse_data_columns()`** (APEX_DATA_PARSER for CSV/TSV and JSON in SQL, same names and types as the data loader) ([chapter 9](guide/09-reference.md)). **Missing:** a synchronous web call inside one SQL statement, XLSX/XML in `parse_data` (use the data loader), `APEX_ZIP`, `APEX_JSON`-style builders, … |
| Declarative menu buttons, button badges (26.1) | ✅ | Menu buttons with links and submit requests (a hidden button can't be reached through a menu), works without JavaScript; badges as text with `&ITEM.` or from SQL ([chapter 6](guide/06-processing.md#menu-buttons-and-badges)) |
| Plug-ins | 🟡 | Template component plug-ins: one JSON file to export and import, three examples. **Missing:** item, region, process and dynamic action plug-ins with their own code (pgapex runs no third-party JavaScript or server code) |
| Build options | ✅ | Include / exclude (and `!NAME` for the reverse) on pages, regions, items, buttons, dynamic actions, validations, processes, computations, branches, navigation entries and application processes; fail closed; *Used in*, Advisor and export ([chapter 6](guide/06-processing.md#build-options)) |
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
| Content Security Policy without `unsafe-inline` (26.1) | ✅ | Scripts and styles: `script-src 'self'`, `style-src 'self' 'nonce-…'`. No inline scripts or `style` attributes; theme colours and chart geometry are in one `<style>` with a fresh nonce per response |
| Session sharing between applications | 🟡 | Each app has its own session; with OpenID Connect the second sign-in is silent. APEX: workspace sharing or a custom cookie |
| LDAP and SAML authentication | ✅ | LDAP / Active Directory (search + bind, StartTLS/LDAPS, groups → roles) and SAML 2.0 (signed assertions, SP metadata), next to local passwords and OpenID Connect |
| Database accounts, HTTP-header authentication | ✅ | HTTP header variable (`header`): the user from a header set by a reverse proxy or SSO gateway, trusted only from proxy addresses in `PGAPEX_AUTH_HEADER_PROXIES`, session bound to the header value, optional automatic accounts, sign-out URL; database accounts (`database`): a PostgreSQL login role and its password, checked by PostgreSQL through a short-lived connection, only listed roles or members of a role ([chapter 8](guide/08-security.md)) |
| Custom authentication | ✅ | A PL/pgSQL function or body checks the user name and password as the app's database role, plus post-authentication code; throttling and the activity log as for other types ([chapter 8](guide/08-security.md)) |
| Persistent authentication ("remember me") | ✅ | Per app, 1–365 days; rotating one-time tokens, revoked on sign-out, new password, deactivation or removed access; "Sign out on all devices" |

## User interface

| APEX | pgapex | Notes |
|---|---|---|
| Universal Theme look and layout | ✅ | Header, side/top navigation, breadcrumbs, 12-column grid, region templates |
| Responsive: phone, tablet, desktop | ✅ | Tested at 390, 768, 1024 and 1440px on every change (`npm run test:e2e`) |
| Modal dialog pages | ✅ | Full screen on phones |
| Dark mode and user-chosen theme style | ✅ | Automatic (follows the device), light or dark per app; users may switch, saved on the account; plus a choice of the app's style variants |
| Theme Roller (26.1: conditional and dynamic properties, CSS variables) | 🟡 | Base styles Iris and Standard; accent and header colours for the light and the dark theme; **style variants** (up to 10 saved styles per app: colours for light and dark mode, font, font size, corners; a default; users may choose one, kept per app on the account; exported with the app) with a **live preview** on Settings → Theme → Theme Roller; **template options** on regions, buttons, items and report columns (fixed lists of CSS classes) ([chapter 14](guide/14-globalization.md#style-variants-theme-roller)). **Missing:** conditional and dynamic theme properties (e.g. a colour from an item or a condition) |
| Icons (Font APEX 2.5) | 🟡 | 31 line icons |
| Accessibility | 🟡 | Labels, keyboard, focus rings, reduced motion, table alternatives for charts; no formal audit yet |
| Drawers, top/bottom dialogs (26.1) | ✅ | Modal pages open as a centred dialog or as a drawer from the left, right, top or bottom edge, in three sizes, sliding in (without animation for reduced motion); on phones full screen ([chapter 4](guide/04-pages-and-regions.md#dialogs-and-drawers)). Not yet: a footer slot for inline drawers |
| New "Iris" default style (26.1) | ✅ | Base style **Iris** (indigo accent, larger corners, softer shadows, light and dark palettes checked for WCAG AA contrast), the default for new applications; existing ones keep *Standard* until switched in Settings → Theme ([chapter 14](guide/14-globalization.md#base-styles-iris-and-standard)) |
| Progressive Web App | ✅ | Per app: installable (manifest, icon, standalone), service worker, offline pages (opt-in, wiped at sign-in/out), **forms sent offline queued on the device and sent later** (files included, once only, under the same user), location, camera and barcode items. **Missing:** push notifications |

## Globalization

| APEX | pgapex | Notes |
|---|---|---|
| Translated applications (26.1: text-message-based translation of one app) | ✅ | One app with translations, like 26.1; XLIFF 1.2 and CSV export/import, coverage per language |
| Text messages (`APEX_LANG.MESSAGE`, `&APP_TEXT$…`) | ✅ | `meta.message()`, `&APP_TEXT$NAME.`, fallback to the base and primary language |
| Language from browser, preference or session | ✅ | Browser, user preference or primary; `?lang=`; right-to-left languages |
| Date and timestamp format masks | ✅ | Per app or per language |
| Built-in runtime messages in ~34 languages | 🟡 | English, Dutch, German, French and Spanish; other languages via text messages with the same names |
| Number format masks, automatic time zone | ✅ | Oracle-style number masks (`999G999G990D00`, `FML…`, `0000`, `%`, `S`/`MI`/`PR`, `EEEE`, `X`, `RN`) on report, grid and cards columns, charts and number/display items, in the language's separators with the app's currency; Automatic Time Zone (browser, My account, app or database), `timestamptz` shown in it ([chapter 14](guide/14-globalization.md)) |

## Data and integration

| APEX | pgapex | Notes |
|---|---|---|
| SQL Workshop: SQL commands, object browser | ✅ | The object browser shows columns, RLS policies, grants, data and function source |
| RESTful services (ORDS) | ✅ | [PostgREST](https://postgrest.org) next to pgapex: `api` schema, the same RLS as the UI, per-app API role, tokens in the builder, a pre-request check, and **OAuth clients** (client credentials, like ORDS `oauth.create_client`) so tokens renew themselves |
| REST handler editor, REST-enabled SQL | ✅ | **REST modules** in the builder: handlers (method, path with parameters, SQL as collection, item or statements, roles, public) served by pgapex with bearer tokens and an OpenAPI description; plus PostgREST for schema-wide APIs. **Missing:** REST-enabled SQL (rarely desirable) |
| SQL scripts, query builder, Quick SQL | 🟡 | **SQL Scripts**: saved, upload/download, a result per statement, stop or continue on errors, optionally one transaction, run history. **Quick SQL** (a subset: tables, child tables, types, the main column directives, `/auditcols`, settings, views). A simple **query builder** (foreign-key joins, columns, conditions, sort, open in SQL Commands; no graphical canvas) |
| Data Workshop (load and unload) | ✅ | SQL Workshop → Load Data: CSV/TSV/XLSX/JSON into a new table (inferred types) or an existing one (append, merge, replace) with a per-row error report; `data_load` process for end users; **XML** (a repeating element, attributes and paths; DTDs refused) and saved **data load definitions** (mapping, transformations, format masks, defaults; used by Load Data and the process, exported with the app). **Unload Data**: a table or view (chosen columns, where, order) or a query to CSV (separator, enclosure, heading), JSON, XLSX or XML (element names), streamed with a cursor in a read-only transaction with a statement timeout ([chapter 16](guide/16-files.md)) |
| Large downloads without buffering (ORDS streams) | ✅ | CSV and Excel downloads stream from a database cursor (1,000 rows at a time, a streaming Excel writer) up to `DOWNLOAD_MAX_ROWS` (default 1,000,000), so memory stays flat. Report PDFs read their rows from a cursor in batches of 500 (`PDF_MAX_ROWS`, default 5,000, at most 100,000); REST collection handlers stream a chunked JSON array from a cursor |
| REST data sources, web credentials (26.1: OAuth refresh tokens, password flow) | ✅ | Shared Components → REST data sources: JSON endpoints with path, query, header and body parameters, a row selector, typed columns and a response cache feed reports, cards, charts, calendars, maps, trees, template components and shared lists of values as SQL over `rest`. **Write-back**: insert, update, delete and fetch operations (path and JSON body templates after the source's URL) used by forms and interactive grids. **Synchronisation** into a local table (merge on key columns with optional delete, replace, append) on demand, on a cron schedule or from SQL (`meta.request_rest_sync`), as the app's role, with a run log. Web credentials: basic, API-key header, bearer and OAuth2 client credentials, password and refresh-token grants (refresh tokens stored encrypted and rotated), secrets encrypted and write-only. Outgoing calls only to an allow-list of hosts, with SSRF checks ([chapter 19](guide/19-rest-data-sources.md)). **Missing:** XML/SOAP, the OAuth2 authorization code flow (consent in the browser) |
| Printing, document generator (PDF) | ✅ | **Document templates**: a query (with JSON columns for lines) fills an HTML template with Mustache-style tags, drawn as PDF with a report layout; buttons and links download them. Report PDF with **report layouts** and a print stylesheet on every page. No Word/Excel templates or DOCX/XLSX output |
| Data Reporter: self-service reports for business users (26.1) | ✅ | A **Data Reporter** region ([chapter 4](guide/04-pages-and-regions.md#data_reporter-data-reporter)): the developer offers tables and views with chosen columns, labels and format masks; signed-in users pick columns, filter, group with totals (count, sum, average, minimum, maximum), sort and chart, and save reports privately or shared with the app's users. Runs as the app's role (grants and RLS apply); works without JavaScript and fits phones. One source per report (offer a view to combine tables); no downloads from a reporter yet |
| JSON sources, duality views (24.2) | ➖ | PostgreSQL `jsonb` works in any SQL region, form or grid source |
| Remote servers / database links | ➖ | `postgres_fdw` or `dblink` |

## Workflow, automation and AI

| APEX | pgapex | Notes |
|---|---|---|
| Approvals and task list | ✅ | Task definitions (approval / action, owner roles and users, business administrators, priority, due date, details page), `meta.create_task` from application SQL, a task list region (claim, approve/reject/complete with comment, release, delegate, cancel, history), completion SQL in the same transaction. **Missing:** e-mail notifications (pgapex sends no mail), vacation rules, expiry/escalation policies |
| Workflow (26.1: parallel flows, multi-tenancy) | 🟡 | Workflow definitions of task, SQL, switch, wait, **invoke API** (a REST data source or URL through the invoke-API code, response values and the HTTP status into variables, retryable faults, no transaction open during the call) and end steps with variables, started from application SQL, run by the server (NOTIFY + polling) as the app's role; console region (terminate, retry a faulted step); diagram in the builder. **Parallel branches** (split, then a join that waits for all or for the first branch) and **versions** (development, active, inactive; running instances keep theirs) ([chapter 6](guide/06-processing.md#workflows)). **Missing:** multi-tenancy; no e-mail activity (pgapex has no e-mail features) |
| Automations (scheduled) | ✅ | Shared Components → Automations: cron schedules with time zones, once or per row of a query, **several ordered actions** with their own conditions, **error handling** (stop, skip the row and continue, or disable; row errors in the run history), roles, run history and Run now, **on-demand runs from SQL** with `meta.run_automation()` (like `APEX_AUTOMATION.EXECUTE`, synchronous in the caller's transaction), safe with several servers ([chapter 6](guide/06-processing.md#automations)) |
| AI assistant, natural-language reports (NL2IR), AI agents and tools (26.1) | ✅ | Region type **AI assistant**: a conversation per session, context queries (RAG over developer queries, run as the app's role, read-only), and **tools** the model may call: SQL with bound arguments checked against declared parameters (read-only unless marked as writing, row limit, timeout) and REST data sources, each optionally behind an authorization scheme. **Natural-language report filters**: an "Ask in your own words" box turns a question into the report's normal filters, search and sort, limited to its visible columns ([chapter 4](guide/04-regions.md)). Agents are defined per region (not as shared components); answers are not streamed. `pgvector` covers semantic search on the data side |
| *Generate Text with AI* process, structured outputs (26.1) | ✅ | **AI services** (Workspace utilities, administrators): Claude through `@anthropic-ai/sdk` or OpenAI through `openai`, encrypted write-only keys (or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), per-app access with daily request and token limits, a usage log. Page process `ai_generate` (text into an item, or structured output into several items with a schema built from the items or your own) and a dynamic action that runs it without a page submit; `meta.ai_generate` / `ai_result` / `ai_available` from SQL ([chapter 6](guide/06-processing.md)). Prompts, item values included, go to the chosen provider |
| Blueprints, spec-driven development (26.1) | ✅ | Create → **From a blueprint**: a JSON spec of tables (types, required, unique, allowed values, references), pages, navigation and sample data; optionally drafted by AI from a description; always reviewed (problems, SQL, pages, menu) before the application is created in one transaction; saved blueprints. **Missing:** a blueprint from an existing application |

## Administration

| APEX | pgapex | Notes |
|---|---|---|
| Developer accounts | ✅ | |
| Instance administration, install/upgrade logs (26.1) | 🟡 | Versioned migrations (`npm run db:migrate`), every run logged; Workspace utilities → **Installation** (administrators): server version, install and upgrade runs with errors, applied migrations, and warnings for migrations the database misses or the server doesn't know ([chapter 3](guide/03-builder.md)). **Missing:** instance-wide settings in the builder (they are environment variables) |
| Debug messages | ✅ | Debug levels 1–9 per app; `meta.debug(level, text)` and `meta.debug_enabled(level)` from application SQL (APEX_DEBUG); timed entries per request (page steps, regions, processes, branches, errors, SQL notices); Activity → **Debug messages** viewer per page view with filters and the slowest step highlighted; retention 1–90 days; password item values are never recorded ([chapter 6](guide/06-processing.md)). **Missing:** switching debug on per user or session (the APEX toolbar), debug entries for background jobs and REST requests |
| Monitoring (top SQL) | ✅ | Activity per app; Top SQL per app's database role from `pg_stat_statements` (sortable, resettable) |
| Workspaces (multi-tenant) | 🟡 | Workspaces group applications and developers: the builder shows and opens only the applications of a developer's workspaces (administrators: all), a current workspace with a switcher, new and imported applications go into it, administrators add workspaces, choose their developers and move applications ([chapter 3](guide/03-builder.md#workspaces)). **Missing:** isolation between tenants (the SQL Workshop and application code run with installation-wide rights; use separate installations), per-workspace user accounts, schemas and workspace administrators |

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
| Automations / scheduler | built in, or `pg_cron` | [chapter 6](guide/06-processing.md#automations), [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Calling REST APIs synchronously from SQL (`APEX_WEB_SERVICE`; the built-in `meta.web_request()` is queued) | `http`, `pg_net` | [chapter 15](guide/15-extensions.md#tier-3-situational) |
| Map data | PostGIS | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Semantic search / RAG | `pgvector` | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Statement auditing | `pgaudit` | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Code checks (Advisor for PL/pgSQL functions) | `plpgsql_check` (used by the Advisor when installed) | [chapter 15](guide/15-extensions.md#tier-2-third-party-widely-available) |
| Pivot reports | `tablefunc` | [chapter 15](guide/15-extensions.md#tier-1-included-with-postgresql) |
| Porting PL/SQL | `orafce` | [chapter 15](guide/15-extensions.md#tier-3-situational) |

## Where pgapex goes further

Small but real differences, for teams comparing the two:

- Open source (Apache-2.0), on any PostgreSQL 15+, including every managed service.
- A strict CSP by default (no inline scripts or styles), and a security regression suite that runs in CI.
- Responsive layouts verified automatically at four screen sizes.
- The theme follows the device's light/dark setting automatically, and the choice is saved per user.
- A built-in *My account* page (own password, theme, language).
- One RLS policy set protects both the web UI and the REST API.

## Roadmap (proposed priority)

Done in 0.23.0: the interactive grid, page logic, globalization, SQL and Data Workshop and builder gaps
above. Done in 0.19.0: large tables (row ranges, maximum row counts, lazy loading, region caching, streamed
downloads). Done in 0.18.0: calendar views, more chart types and drill-down; smart filters, display selector
and facet types; computations, branches, build options and menu buttons; REST data sources and web
credentials; rich text and the other new item types.

Done in 0.28.0 (AI with Claude and OpenAI): *Generate text with AI*, the AI assistant with tools, natural-language
report filters, App Builder AI and blueprints.

1. The 🟡 rows (sprint 37; workspaces and the Iris base style are done).

Sources: [APEX 26.1 new features](https://docs.oracle.com/en/database/oracle/apex/26.1/htmrn/new-features.html),
[What's new in APEX 24.2](https://apex.oracle.com/en/platform/features/whats-new-242/),
[APEX_MAIL (APEX API reference)](https://docs.oracle.com/en/database/oracle/apex/24.2/aeapi/APEX_MAIL.html).
