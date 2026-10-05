# 11. Coming from Oracle APEX

pgapex borrows APEX's model on purpose, so most of what you know carries over. This chapter
maps the concepts, explains the differences that matter, and gives tips for porting PL/SQL.
What's missing is listed in the [feature parity matrix](../apex-feature-parity.md).

## Concept map

| Oracle APEX | pgapex |
|---|---|
| Instance / workspace | One pgapex installation (one workspace) |
| Parsing schema | The app's **database role** (`db_role`); schema access comes from its grants |
| Application, page, region, item, button | The same, stored in `meta.*` |
| Page Designer | Builder page designer (component tree, layout with drag and drop and a gallery, property editor) |
| Shared components | Navigation menu, lists, authorization schemes, lists of values, application items, application processes, build options, supporting objects |
| `:P1_ITEM`, `:APP_USER`, `:REQUEST`, `&ITEM.` | The same syntax |
| `v('P1_ITEM')` | `meta.v('P1_ITEM')` |
| `apex_page.get_url` / `apex_util.prepare_url` | `meta.page_url(page, items)` |
| `APEX_ACL` / `apex_acl.has_user_role` | `meta.has_role('role')` |
| Workspace users (APEX accounts), Application Access Control | `meta.account` (Builder → Users), `meta.app_access` (Access control) |
| Page access protection "Arguments must have checksum" | `protection = 'checksum'` (the default) |
| Automatic row processing (DML) | Process type `form_dml` |
| Interactive grid DML | Process type `grid_dml` |
| Interactive grid: aggregates, frozen columns, column reorder/resize/hide, saved reports, row actions menu, copy/paste | Grid `aggregates`, `layout`/`frozen`, Actions → Columns (or drag), saved grid reports, `row_actions`; copy/paste of cell ranges in the browser ([chapter 4](04-pages-and-regions.md#grid-interactive-grid)) |
| Master-detail (a detail region with a master region) | Master grid `select_row` (column → item), detail `master` (item, and the column new rows get) |
| PL/SQL process | Process type `sql` calling PL/pgSQL (`select my_fn(:P1_X)`) |
| `apex_error.add_error` / raising errors | `raise exception '…' using column = 'col'` |
| Before-header processes | Process `point = 'load'` |
| Page computations (static, item, SQL query, SQL expression, PL/SQL function body) | Computations `before_header` / `after_submit`; function bodies are PL/pgSQL ([chapter 6](06-processing.md#computations)) |
| Branches (page or URL, *When button pressed*, server-side condition), before header and after processing | Branches with `when_button` and a condition; URLs stay inside the application ([chapter 6](06-processing.md#branches)) |
| Build options (include / exclude) | Build options; `!NAME` for APEX's "exclude when the option is included" ([chapter 6](06-processing.md#build-options)) |
| Menu button, button badge | Button action `menu`; `badge` / `badge_query` |
| Dynamic actions *Set Focus*, *Add / Remove Class*, *Show Success / Error Message*, *Clear Errors* | `set_focus`, `add_class` / `remove_class`, `show_success` / `show_error`, `clear_errors` |
| Application computation / process on new session | Application process (`after_login`, `before_page`) |
| VPD | PostgreSQL row level security |
| APEX collections | Temporary or unlogged tables, or `jsonb` |
| File Browse item, `APEX_APPLICATION_TEMP_FILES` | Item type `file`; view `meta.temp_files` ([chapter 16](16-files.md)) |
| Rich Text Editor, Markdown Editor, Star Rating, Combobox, QR Code | Item types `richtext` (sanitised HTML), `markdown`, `rating`, `combobox` (colon-separated), `qrcode`; plus `daterange` (`from:to`) and `{"reveal": true}` on password items ([chapter 5](05-items.md)) |
| Data Workshop (CSV, Excel, JSON, XML) / Data Load Definition, *Execute Data Load* process | SQL Workshop → Load Data; Shared Components → Data load definitions; process type `data_load` with `"definition"` ([chapter 16](16-files.md#data-loading)) |
| SQL Workshop → SQL Scripts, Quick SQL, Query Builder | The same names in the SQL Workshop: saved scripts with a result per statement and a run history, shorthand → PostgreSQL DDL, a SELECT from tables joined by foreign keys ([chapter 3](03-builder.md#sql-workshop)) |
| Interactive report *Download → PDF*, printing | Actions → Download PDF, Print ([chapter 16](16-files.md#printing)) |
| Pagination *Row Ranges X to Y*, *Maximum Row Count*, region *Lazy Loading*, *Server Cache* | `"pagination": "range"`, `max_rows`, `"lazy": true`, `"cache": {"scope", "seconds"}` ([large tables](04-pages-and-regions.md#large-tables)) |
| `APEX_UTIL.CHANGE_CURRENT_USER_PW`, `RESET_PASSWORD`, `EXPIRE_END_USER_ACCOUNT` | My account page; `meta.set_password()`, `meta.expire_password()` ([chapter 8](08-security.md#passwords-and-my-account)) |
| `APEX_MAIL`, Send E-Mail process, e-mail templates | Not included: pgapex doesn't send mail. Queue mail in a table and deliver it with your own service, or use an extension such as `pg_smtp_client` ([chapter 15](15-extensions.md)) |
| Translated applications (XLIFF), `APEX_LANG.MESSAGE`, `&APP_TEXT$NAME.` | Translations in the app (XLIFF/CSV import and export), `meta.message()`, `&APP_TEXT$NAME.` ([chapter 14](14-globalization.md)) |
| Application date format mask | Settings → Globalization → Date format (Oracle-style masks) |
| Number format masks (`FML999G999G990D00`) on columns and items | `{"formats": {...}}` on report, grid and cards columns, `{"format_mask": "..."}` on charts and number/display items ([chapter 14](14-globalization.md#number-formats)) |
| Automatic Time Zone | Settings → Globalization → Time zone and Automatic time zone; My account → Time zone ([chapter 14](14-globalization.md#time-zones)) |
| Theme styles, *Enable End Users to Choose Theme Style* | Theme style (automatic/light/dark) and *Users may choose light or dark* |
| ORDS | Not needed to serve apps; REST APIs with PostgREST, see [below](#ords-and-postgrest) |
| Export `f123.sql` / APEXlang | `meta.export_app('alias')` (JSON) |

## Users per application

**How APEX does it.** An APEX instance has *workspaces*. Workspace users come in four kinds:
end users, developers, workspace administrators and instance administrators. With the *Oracle
APEX Accounts* authentication scheme, an application signs users in against the **workspace's**
accounts, so every application in a workspace shares the same set of users. You can restrict
access per application in two ways:

- **Application Access Control** (a shared component) defines roles such as *Reader*, *Contributor*
  and *Administrator* per application and assigns users to them. It generates authorization
  schemes and can require that a user has a role to use the application at all.
- **Authorization schemes** on pages and components.

Many organisations don't use APEX accounts at all. They choose another authentication scheme
(LDAP, social sign-in / OpenID Connect, SAML, database accounts or custom PL/SQL) and map
the identity provider's groups to APEX roles. Applications in the same workspace can also share
a session, so signing in to one signs you in to the others.

**How pgapex does it.** The same model: a **user directory** with one account per person
(**Builder → Users**), and per application an **Access control** setting (only listed accounts, or
any active account) plus role assignments per account. Roles feed authorization schemes and
`meta.has_role()`. See [chapter 8](08-security.md#the-user-directory).

Instead of (or next to) passwords, applications can use **single sign-on with OpenID Connect**,
APEX's "Social Sign-In" scheme, with identity-provider groups mapped to application roles. Signing
in to a second app is then silent via the identity provider's session. See
[chapter 8](08-security.md#single-sign-on-openid-connect). **SAML 2.0** providers and **LDAP /
Active Directory** passwords work the same way (groups → roles), and *Keep me signed in* matches
APEX's persistent authentication. **Database accounts** sign in with PostgreSQL login roles, and
**custom authentication** calls your own PL/pgSQL function (APEX: a custom PL/SQL scheme), see
[chapter 8](08-security.md#custom-authentication-a-plpgsql-function).

## ORDS and PostgREST

In the Oracle world, ORDS (Oracle REST Data Services) plays two roles:

1. **The web listener for APEX itself**: every APEX page request goes through ORDS's PL/SQL gateway.
2. **REST APIs**: RESTful services defined in APEX/ORDS, AutoREST for tables and views, and
   REST-enabled SQL.

In pgapex, **role 1 doesn't exist**. The pgapex server *is* the web tier, talking to PostgreSQL
directly. You don't need ORDS or any replacement to run applications.

For **role 2**, REST APIs, [PostgREST](https://postgrest.org) is the natural choice. It turns a
PostgreSQL schema into a REST API: tables and views become resources, functions become RPC
endpoints, and it authenticates with JWTs whose `role` claim selects the database role, so
grants and row level security apply, just as in pgapex. That makes it a good partner rather than
a replacement:

| ORDS feature | PostgreSQL option |
|---|---|
| AutoREST for tables and views | PostgREST (automatic for an exposed schema) |
| Hand-written handlers (GET/POST with SQL or PL/SQL) | **REST modules** in the builder: method, path with parameters and SQL, served by pgapex ([chapter 13](13-rest-api.md#rest-modules-in-the-builder)); or PostgREST RPC: `create function api.do_something(...)` → `POST /rpc/do_something` |
| OAuth2 client credentials (`oauth.create_client`, `/oauth/token`) | OAuth clients: `meta.oauth_create_client()` or Builder → REST API → OAuth clients, and `POST /oauth/token` on pgapex ([chapter 13](13-rest-api.md#oauth-clients-client-credentials)). Or tokens from your identity provider |
| REST-enabled SQL | Not provided by PostgREST (and rarely desirable) |
| OpenAPI/Swagger | Generated for every REST module (`…/openapi.json`) and built into PostgREST |

pgapex integrates with it: `meta.app_user()` and `meta.has_role()` understand PostgREST's JWT
claims, so **one set of RLS policies** protects the UI and the API, and each app has an API role,
tokens and an endpoint overview under **Builder → REST API**. The recommended setup is a dedicated
`api` schema with **views and functions** (not your base tables). See
[chapter 13](13-rest-api.md).

## Porting PL/SQL to PL/pgSQL

| PL/SQL | PL/pgSQL |
|---|---|
| `create or replace procedure p (a in number) is begin … end;` | `create or replace procedure p(a numeric) language plpgsql as $$ begin … end $$;` |
| functions returning values | `create function f(...) returns numeric language plpgsql as $$ … $$;` |
| `varchar2`, `number`, `date` (with time) | `text`, `numeric` / `int`, `timestamp` (or `date` for dates only) |
| `nvl(a, b)`, `decode(…)` | `coalesce(a, b)`, `case … end` |
| `sysdate`, `systimestamp` | `now()`, `current_date` |
| `raise_application_error(-20001, 'msg')` | `raise exception 'msg';` (add `using column = 'col'` to target a field) |
| `sql%rowcount`, `%notfound` | `get diagnostics n = row_count;`, `if not found then` |
| `select … into v from dual` | `select … into v;` (no `dual`) |
| sequences `seq.nextval` | `nextval('seq')`, or `generated always as identity` columns |
| packages | schemas + functions (package state → tables or session settings) |
| autonomous transactions | not supported; use a separate connection or `dblink` if you really need it |
| `v('APP_USER')`, `:APP_USER` | `meta.app_user()`, `:APP_USER` |
| empty string is NULL | Postgres distinguishes them, but pgapex stores empty items as NULL, as APEX does |
| `'a' \|\| null` is `'a'` | `'a' \|\| null` is **NULL**: use `concat(a, b)` or `concat_ws(sep, …)`, which skip NULLs, or `coalesce(b, '')` |

Tips:

- Cast bind variables where Postgres can't infer the type: `:P1_ID::int`, `:P1_DATE::date`.
- Use `returning` to get generated keys: `insert … returning id` inside a function, or return a
  column named like the item (`as p3_id`) from a process.
- Triggers are `create trigger … execute function f()`, with `new`/`old` records like Oracle's
  `:new`/`:old`.
- Row level security replaces most VPD policies, with simpler syntax.

## Things that behave differently

- **No PL/SQL in the page**: logic runs as SQL. Put anything procedural in a PL/pgSQL function and
  call it.
- **Everything is one transaction per submit**: validations and all processes commit or roll back
  together.
- **Errors are hidden by default**: unexpected errors show a reference number unless the app is in
  debug mode.
- **Dates**: date items use ISO format (`2026-10-01`) and the browser's date picker; format masks
  apply to report, grid and cards columns and to number and display items
  ([number formats](14-globalization.md#number-formats)).
- **Modal pages** open over the calling page, and close and refresh it after a successful submit,
  like an APEX "Close Dialog" process plus "Dialog Closed" refresh.
