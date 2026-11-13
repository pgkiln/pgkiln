# 11. Coming from Oracle APEX

pgkiln borrows APEX's model on purpose, so most of what you know carries over. This chapter
maps the concepts, explains the differences that matter, and gives tips for porting PL/SQL.
What's missing is listed in the [feature parity matrix](../apex-feature-parity.md).

## Concept map

| Oracle APEX | pgkiln |
|---|---|
| Instance / workspace | One pgkiln installation; workspaces group applications and developers in the builder (Workspace utilities → Workspaces; not a security boundary: tenants who must not see each other get separate installations, [chapter 3](03-builder.md#workspaces)) |
| Parsing schema | The app's **database role** (`db_role`); schema access comes from its grants |
| Application, page, region, item, button | The same, stored in `meta.*` |
| Page Designer | Builder page designer (component tree, layout with drag and drop and a gallery, property editor) |
| Shared components | Navigation menu, lists, authorization schemes, lists of values, application items, application processes, build options, supporting objects |
| `:P1_ITEM`, `:APP_USER`, `:REQUEST`, `&ITEM.` | The same syntax |
| `v('P1_ITEM')` | `meta.v('P1_ITEM')` |
| `apex_page.get_url` / `apex_util.prepare_url` | `meta.page_url(page, items)` |
| `APEX_ACL` / `apex_acl.has_user_role` | `meta.has_role('role')` |
| `APEX_SESSION.SET_TENANT_ID`, `APP_TENANT_ID`; multi-tenant workflows and tasks | `meta.set_tenant(tenant)`, `meta.tenant_id()`; workflows, tasks and their lists follow the session's tenant ([chapter 6](06-processing.md#tenants)) |
| `APEX_DEBUG` (`message`, `error`, `warn`, `info`, `trace`), debug levels, *View Debug* | `meta.debug(level, text)`, `meta.debug_enabled(level)`; the app's debug level; Activity → Debug messages ([chapter 6](06-processing.md#debug-messages)) |
| Instance administration: install/upgrade log | Workspace utilities → Installation (administrators) |
| `APEX_WEB_SERVICE.make_rest_request`, `g_status_code` | `meta.web_request(url, method, body, headers, credential)` or `meta.web_request_source(source, params)`, then `meta.web_response(id)`. **Asynchronous**: the server makes the request after the page process that queued it, or after the commit ([chapter 9](09-reference.md#web-requests-from-sql)) |
| Workspace → Generative AI services; *Generate Text with AI* process and dynamic action; `APEX_AI.generate` | Workspace utilities → AI services (Claude, OpenAI, Gemini or an OpenAI-compatible service such as Ollama; administrators); the `ai_generate` process and dynamic action, with structured outputs into items ([chapter 6](06-processing.md#generate-text-with-ai)); `meta.ai_generate(service, prompt, system, schema)` then `meta.ai_result(id)` ([chapter 9](09-reference.md#ai-requests-from-sql)) |
| AI Assistant region; AI agents with tools; AI interactive reports (natural language to interactive report) | The `ai_assistant` region: a chat with context queries (RAG over your queries) and tools (SQL as the app role with bound arguments, REST data sources) ([chapter 4](04-pages-and-regions.md#ai_assistant-ai-assistant)); `"ai_filter"` on a report: *Ask in your own words*, the request becomes the report's settings as editable chips, with or without an AI service ([chapter 4](04-pages-and-regions.md#ask-in-your-own-words-ai-interactive-reports)) |
| App Builder / SQL Workshop AI Assistant (create pages, generate and explain SQL); describing tables for AI | The App Builder's AI service: *Create pages with AI* (proposals you confirm), SQL Workshop → AI (SQL from a question, shown not run; explain a query or error), *Describe tables* (`meta.ai_table_note`, optionally `COMMENT ON`) ([chapter 3](03-builder.md#app-builder-ai)) |
| Blueprints (spec-driven development) | Create → From a blueprint: a JSON blueprint (tables, pages, menu, sample data), optionally drafted by AI, reviewed, then created in one transaction ([chapter 3](03-builder.md#creating-an-application-from-a-blueprint)) |
| `APEX_DATA_PARSER.parse`, `get_columns` | `meta.parse_data(blob, …)` (rows with `cols` and `data`), `meta.parse_data_columns(blob, …)`; CSV/TSV and JSON, not Excel or XML ([chapter 9](09-reference.md#parsing-files-in-sql)) |
| Team Development (issues, labels, milestones, templates, feedback) | Builder → Team Development (`/builder/team`): issues per workspace with labels in groups, milestones, assignees, application and page links, Markdown comments with @mentions shown in the builder, history, saved views and a board; a set-up wizard with sample labels, templates and milestones; feedback and developer comments become issues. No e-mail and no GitHub synchronisation ([chapter 3](03-builder.md#team-development)) |
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
| Validation types (Rows returned, Expression, Function Body returning Boolean / Error Text, Item is NOT NULL / numeric / a valid date …, Item = Value, Item in Value, character checks, Regular Expression), Always Execute, Display Location | The same types as `type` (`exists`, `sql`, `function_body`, `function_error`, `not_null`, `numeric`, `valid_date`, `equals`, `in_list`, `chars_only`, `regex` …), `always_execute`, `display_location` ([chapter 6](06-processing.md#validations)). Interactive grid column validations aren't there yet: use a validation on the grid's process or a check constraint |
| Dynamic action events (Double Click, Key Down / Press, Mouse Enter / Leave, Select, Resize, Scroll, Page Unload, Before Refresh, Facets Change), conditions (greater / less than, not in list) and actions (Cancel Event, Set Style, Collapse / Expand Tree, Show AI Assistant, Trigger Geocoding, Invoke Interactive Report Dialog) | The same events, conditions and actions ([chapter 7](07-dynamic-actions.md)). JavaScript expression conditions: use a registered function |
| Component events: Row Initialization and Save [Interactive Grid], Date Select and View Change [Calendar], Map Object Clicked and Map Changed, Selection Change [Tree] | `grid_row_init`, `grid_save`, `calendar_date_select`, `calendar_view_change`, `map_object_click`, `map_change`, `tree_selection_change`, triggered by the region ([chapter 7](07-dynamic-actions.md#component-events)) |
| Workflow Diagram region | `workflow_diagram` with `{"instance_item": …}` ([chapter 6](06-processing.md#workflow-diagram-region)) |
| Map layers Points, Lines, Polygons, Heat Map, Extruded Polygons | `"layer"`: `markers`, `lines`, `polygons`, `heat`, `extruded` (drawn flat, shaded by height), with fill and line colours, width and opacity per layer or per row ([chapter 4](04-pages-and-regions.md#map)) |
| Items Image Upload, Text Field with autocomplete, Percent Graph, Display Map | `image_upload`, `autocomplete`, `percent_graph`, `display_map` ([chapter 5](05-items.md#item-types)) |
| Process types Close Dialog, Clear Session State, Reset Pagination, User Preferences, Server Side Geocoding, Print Report, Human Task – Create / – Manage, Form – Initialization | The same as `type` ([chapter 6](06-processing.md#declarative-process-types)), settings in the attributes |
| Server-side Condition (Rows returned, Expression, Function Body, Request = / != / is contained in, Item is NULL / NOT NULL / zero / = Value / in colon list, Current page in, Current page is a modal dialog, User is authenticated / public user, Current language in, Always / Never …) | The same list as `condition_type`: `exists`, `sql`, `function_body`, `request_in` / `request_not_in`, `item_null` / `item_not_null` / `item_zero` / `item_equals` / `item_in_list`, `page_in`, `page_is_dialog`, `user_signed_in` / `user_public`, `language_in`, `always` / `never` ([chapter 6](06-processing.md#server-side-conditions)). APEX's colon lists stay colon lists; *Request is contained in* takes commas |
| Build options (include / exclude) | Build options; `!NAME` for APEX's "exclude when the option is included" ([chapter 6](06-processing.md#build-options)) |
| Menu button, button badge | Button action `menu`; `badge` / `badge_query` |
| Dynamic actions *Set Focus*, *Add / Remove Class*, *Show Success / Error Message*, *Clear Errors* | `set_focus`, `add_class` / `remove_class`, `show_success` / `show_error`, `clear_errors` |
| Application computation / process on new session | Application process (`after_login`, `before_page`) |
| VPD | PostgreSQL row level security |
| APEX collections | Temporary or unlogged tables, or `jsonb` |
| File Browse item, `APEX_APPLICATION_TEMP_FILES` | Item type `file`; view `meta.temp_files` ([chapter 16](16-files.md)) |
| Rich Text Editor, Markdown Editor, Star Rating, Combobox, QR Code | Item types `richtext` (sanitised HTML), `markdown`, `rating`, `combobox` (colon-separated), `qrcode`; plus `daterange` (`from:to`) and `{"reveal": true}` on password items ([chapter 5](05-items.md)) |
| Data Generator (sample data for development, 26.1) | SQL Workshop → **Sample Data**: generators proposed per column, foreign keys to existing parent rows, a seed, preview, insert in one transaction (parents first), SQL/CSV download, saved definitions ([chapter 16](16-files.md#sql-workshop--sample-data)) |
| Data Workshop (load and unload: CSV, Excel, JSON, XML) / Data Load Definition, *Execute Data Load* process | SQL Workshop → Load Data and **Unload Data** (CSV, JSON, Excel, XML; [chapter 16](16-files.md#sql-workshop--unload-data)); Shared Components → Data load definitions; process type `data_load` with `"definition"` ([chapter 16](16-files.md#data-loading)) |
| SQL Workshop → Utilities → Generate DDL, Schema Comparison | SQL Workshop → **DDL** and **Compare**: a schema's DDL in an order that runs; two schemas compared by their DDL with a change script; also `pgkiln ddl` and `pgkiln compare` ([chapter 3](03-builder.md#sql-workshop)) |
| SQL Workshop → SQL Scripts, Quick SQL, Query Builder | The same names in the SQL Workshop: saved scripts with a result per statement and a run history, shorthand → PostgreSQL DDL, a SELECT built on a canvas of tables, joined by foreign keys or columns you connect, with column functions and grouping ([chapter 3](03-builder.md#sql-workshop)) |
| Interactive report *Download → PDF*, printing | Actions → Download PDF, Print ([chapter 16](16-files.md#printing)) |
| Pagination *Row Ranges X to Y*, *Maximum Row Count*, region *Lazy Loading*, *Server Cache* | `"pagination": "range"`, `max_rows`, `"lazy": true`, `"cache": {"scope", "seconds"}` ([large tables](04-pages-and-regions.md#large-tables)) |
| `APEX_UTIL.CHANGE_CURRENT_USER_PW`, `RESET_PASSWORD`, `EXPIRE_END_USER_ACCOUNT` | My account page; `meta.set_password()`, `meta.expire_password()` ([chapter 8](08-security.md#passwords-and-my-account)) |
| Navigation menu badges, a notification bell in the header, badges refreshed with dynamic actions and JavaScript | A list entry's `badge` or `badge_query` (also in the navigation bar), Settings → User Interface → *Notification bell* with `meta.notify(user, title, body, page, items)` or the process type `send_notification`, *Live badges* (seconds) and the dynamic action event `timer` ([chapter 4](04-pages-and-regions.md#notifications-and-live-badges)) |
| Progressive Web App push notifications: `APEX_PWA.SEND_PUSH_NOTIFICATION`, `HAS_PUSH_SUBSCRIPTION`, *Send Push Notification* process, the subscription settings page | `meta.send_push(user, title, body, page, items)`, `meta.has_push_subscription(user)`, process type `send_push`, *My account → Notifications* and the dynamic action `push_subscribe` ([chapter 17](17-mobile.md#push-notifications)) |
| `APEX_MAIL`, Send E-Mail process, e-mail templates | `meta.send_mail`, `meta.send_mail_template`, `meta.add_mail_attachment`, the `send_email` process and Shared Components → E-mail templates (`#NAME#` placeholders) ([chapter 6](06-processing.md#sending-e-mail)). Instead of the instance's SMTP settings: mail services with SMTP (password or OAuth2), Microsoft Graph, Amazon SES, Resend, Postmark, SendGrid or Mailgun. `APEX_MAIL.PUSH_QUEUE` is not needed: mail goes out right after the commit |
| `APEX_APP_SETTING`, `APEX_UTIL.GET/SET/REMOVE_PREFERENCE`, *Maintain session state: Per User* | Shared Components → Application settings and `meta.get_app_setting`/`meta.set_app_setting`; `meta.get_preference`/`set_preference`/`remove_preference`; `{"persist": "user"}` on an item ([chapter 6](06-processing.md#application-settings)) |
| `APEX_DATA_EXPORT.EXPORT` | `meta.data_export(query, format, options)` (CSV, JSON, XML, HTML) and the download process's `{"export": "xlsx"}` (also PDF) ([chapter 6](06-processing.md#data-export-from-sql)) |
| `APEX_LANG.LANG`, dynamic translations | Shared Components → Dynamic translations and `meta.lang(text)` ([chapter 14](14-globalization.md#dynamic-translations)) |
| Display Image, Geocoded Address items | Item types `image` and `address` (geocoder: `GEOCODER_URL`) ([chapter 5](05-items.md#display-image-and-geocoded-address)) |
| Shuttle, Select One, Select Many (24.2) items | Item types `shuttle` (ordered, colon-separated), `select_one` and `select_many` (a search field over the list of values; chips): plain selects without JavaScript ([chapter 5](05-items.md#shuttle-select-one-and-select-many)) |
| Classic Report region (report templates, pagination types) | Region type `classic_report`: `report_template` `standard`, `value_pairs`, `badges` or `media_list`; `pagination` `total`, `range` or `none` ([chapter 4](04-pages-and-regions.md#classic_report-classic-report)) |
| Breadcrumb region (Breadcrumb Bar), Help Text region and page help | Region types `breadcrumb` (from each page's *Breadcrumb parent*; no separate breadcrumb shared component) and `help_text`; the page's *Help text* (Markdown) ([chapter 4](04-pages-and-regions.md#breadcrumb-and-help_text)) |
| Translated applications (XLIFF), `APEX_LANG.MESSAGE`, `&APP_TEXT$NAME.` | Translations in the app (XLIFF/CSV import and export), `meta.message()`, `&APP_TEXT$NAME.` ([chapter 14](14-globalization.md)) |
| Application date format mask | Settings → Globalization → Date format (Oracle-style masks) |
| Number format masks (`FML999G999G990D00`) on columns and items | `{"formats": {...}}` on report, grid and cards columns, `{"format_mask": "..."}` on charts and number/display items ([chapter 14](14-globalization.md#number-formats)) |
| Automatic Time Zone | Settings → Globalization → Time zone and Automatic time zone; My account → Time zone ([chapter 14](14-globalization.md#time-zones)) |
| Universal Theme's default style (26.1: *Iris*) | Base style *Iris* (the default for new applications), *Lavender* or *Standard* ([chapter 14](14-globalization.md#base-styles-iris-lavender-and-standard)) |
| Theme styles, *Enable End Users to Choose Theme Style* | Theme style (automatic/light/dark) and *Users may choose light or dark*; Theme Roller style variants with *Users may choose a style* ([chapter 14](14-globalization.md#style-variants-theme-roller)) |
| Universal Theme 26.2: *Pillar Light* / *Pillar Dark*, Theme Roller's *Header Pillar Strip*, `u-color-*-subtle` | Theme Roller → *Navigation appearance* and *Header strip colour* (per application or style), the same utility classes ([chapter 14](14-globalization.md#navigation-appearances-pillar-light-and-pillar-dark)) |
| Template Options (regions, buttons) | *Template options* in the Page Designer: CSS classes from a fixed list ([chapter 4](04-pages-and-regions.md#template-options)) |
| ORDS | Not needed to serve apps; REST APIs with PostgREST, see [below](#ords-and-postgrest) |
| Export `f123.sql` / APEXlang | `meta.export_app('alias')` (JSON); an APEX `f123.sql` imports with `pgkiln import-apex` or Import → *From Oracle APEX* ([below](#importing-an-apex-application)) |

## Importing an APEX application

(Sprint 182.) An APEX application export in the **SQL format** (`f100.sql`, or a split export as a
directory or `.zip`) becomes a pgkiln application in one step:

```sh
pgkiln import-apex f100.sql --dry-run            # the report only
pgkiln import-apex f100.sql --alias sales --schema sales
pgkiln import-apex f100.sql --out apps/sales     # the application files, to edit, then: pgkiln import apps/sales
```

or in the builder: **App Builder → Import → From Oracle APEX** (upload, read the report, choose the
alias and the schema, Import). The file is **read as text and never run**: the importer parses the
`wwv_flow_imp…` calls (named arguments, `q'[…]'` quotes, `wwv_flow_string.join` lines, `unistr`,
`wwv_flow_imp.id` ids) and builds the same document `meta.export_app()` writes, which
`meta.import_app()` imports like any export. The tables, views and packages of the parsing schema
are not in an application export: create them in PostgreSQL first (`--schema` names the schema
unqualified tables are in; the default is the parsing schema in lower case). The application gets no
database role: set it in Settings.

**The import report** lists every component as *mapped*, *mapped with notes* or *not mapped*,
with its APEX type, and marks what **needs porting**: PL/SQL is carried over as it is (into the
PL/pgSQL or SQL field of the pgkiln component) and Oracle SQL keeps its `nvl`, `decode`, `sysdate`,
`dual`, `rownum`, `(+)` and package calls, which the report names. Port them with the table
[below](#porting-plsql-to-plpgsql); the [Advisor](03-builder.md#advisor) then finds what doesn't
run yet. Nothing unknown fails the import: it is in the report.

What maps:

| APEX | pgkiln |
|---|---|
| Application: name, alias, primary language, date format, home page, version | The same; authentication becomes the user directory, themes and templates pgkiln's theme |
| Pages: number, name, title, normal or modal (non-modal: modal), public, help, authorization | The same. The global page (0) and the login page (with `apex_authentication.login`) are not imported |
| Regions: Static Content, Classic Report, Interactive Report, Form, Interactive Grid, Breadcrumb, Help Text | `static`, `classic_report`, `report`, `form` (table, key column and item), `grid` (table, key, columns), `breadcrumb`, `help_text`; a table source becomes `select … from schema.table`. Other types (charts, cards, maps, PL/SQL dynamic content, …) become a static region that says what it was, with its source |
| Page items: text (e-mail, phone, URL), text area, number, date picker, select list, radio group, checkbox(es), switch, hidden, display only, password, popup LOV, shuttle, file, rich text, Markdown, star rating, colour, combobox, Select One / Many, QR code, image upload, display image, percent graph, address, display map | The pgkiln [item type](05-items.md#item-types) of the same name; form columns, primary key, required, help, lists of values (shared, SQL, `STATIC`/`STATIC2`), static defaults. A SQL or PL/SQL default or source becomes a before header [computation](06-processing.md#computations). Plug-in items become text fields |
| Buttons: submit, redirect to a page of the application (with items), defined by dynamic action | `submit`, `redirect` (target page and items), `da`; position as the slot |
| Server-side conditions | The [same catalogue](06-processing.md#server-side-conditions): rows returned, expression, function body, request =/in, item null / not null / zero / = / in list, current page, public user, language, never |
| Computations: static, item, query, SQL / PL/SQL expression, function body | `static`, `item`, `sql_query`, `sql_expression`, `function_body` |
| Branches to a page of the application, function returning a URL | `page` with items, `function` |
| Dynamic actions: change, click, page load, Dialog Closed, focus, key and mouse events, after refresh, before submit, custom; Show, Hide, Enable, Disable, Set Value, Refresh, Execute Server-side Code, Submit, Close / Cancel Dialog, Alert, Confirm, Set Focus, Add / Remove Class, Clear, Cancel Event | One pgkiln row per action with the event's trigger and client-side condition; *false* actions with the opposite condition |
| Shared lists of values (SQL, table, static), authorization schemes (exists, not exists, is in group / role) | `lov`, `authz_scheme` (`sql` or `role`); a scheme that isn't mapped is not created, so the components that name it are denied (fail closed) until you add it |
| Navigation menu | The navigation menu (entries to pages of the application) |

Validation types (CD-1):

| APEX `p_validation_type` | pgkiln `type` | Notes |
|---|---|---|
| `ITEM_NOT_NULL`, `ITEM_NOT_NULL_OR_ZERO`, `ITEM_NOT_ZERO`, `ITEM_CONTAINS_NO_SPACES`, `ITEM_IS_ALPHANUMERIC`, `ITEM_IS_NUMERIC`, `ITEM_IS_DATE`, `ITEM_IS_TIMESTAMP` | `not_null`, `not_null_or_zero`, `not_zero`, `no_spaces`, `alphanumeric`, `numeric`, `valid_date`, `valid_timestamp` | |
| `ITEM_IN_VALIDATION_EQ_STRING2`, `…_NOT_EQ_STRING2`, `…_IN_STRING2`, `…_NOT_IN_STRING2` | `equals`, `not_equals`, `in_list`, `not_in_list` | Colon lists stay colon lists |
| `ITEM_IN_VALIDATION_CONTAINS_ONLY_CHAR_IN_STRING2`, `…_AT_LEAST_ONE_CHAR_…`, `…_NO_CHAR_…` | `chars_only`, `chars_any`, `chars_none` | |
| `REGULAR_EXPRESSION` | `regex` | Checked by PostgreSQL (POSIX): check Oracle-only syntax |
| `EXISTS`, `NOT_EXISTS`, `SQL_EXPRESSION`, `EXPRESSION` (SQL) | `exists`, `not_exists`, `sql` | Oracle SQL is named in the report |
| `EXPRESSION` (PL/SQL), `PLSQL_EXPRESSION` | `sql` | Needs porting |
| `FUNC_BODY_RETURNING_BOOLEAN`, `FUNC_BODY_RETURNING_ERR_TEXT` | `function_body`, `function_error` | Needs porting |
| `PLSQL_ERROR`, plug-in validations, interactive grid column validations | not mapped | Use `function_body`, or a [grid column's validation](04-pages-and-regions.md#grid-interactive-grid) |

The error message's `#LABEL#` becomes the item's label; *Always Execute*, *When Button Pressed*,
the server-side condition and the display location (*Inline with Field and in Notification*, *Inline
with Field*, *Inline in Notification*; *On Error Page* becomes a notification) carry over.

Process types (CD-4):

| APEX `p_process_type` | pgkiln `type` | Notes |
|---|---|---|
| `NATIVE_FORM_INIT`, `NATIVE_FORM_DML` | `form_init`, `form_dml` | With the form region. `form_dml` decides by the button name (`CREATE`, `SAVE`, `DELETE` …): the report says when a button's *Database Action* doesn't match its name |
| `NATIVE_IG_DML` | `grid_dml` | With the grid region |
| `NATIVE_PLSQL` | `sql` | The PL/SQL as it is: needs porting |
| `NATIVE_SESSION_STATE` (clear the current page, pages, items, all) | `clear_session_state` | `{"pages": …}`, `{"items": …}`, `{"all": true}` |
| `NATIVE_CLOSE_WINDOW` | `close_dialog` | Items to return as `{"items": …}` |
| `NATIVE_RESET_PAGINATION` | `reset_pagination` | |
| `NATIVE_SEND_EMAIL` | `send_email` | From, to, cc, bcc, reply to, subject, plain and HTML body; attachments and e-mail templates are not carried over; the application needs a [mail service](06-processing.md#sending-e-mail) |
| `NATIVE_INVOKE_API` on a PL/SQL package | `sql`: `call pkg.proc(p_a => :P3_ID, …)` | Create the function or procedure in PostgreSQL (a schema for the package) |
| `NATIVE_INVOKE_API` on a REST data source | `invoke_api` with `source` and `params` | Create the [REST data source](19-rest-data-sources.md) under that name |
| `NATIVE_EXECUTION_CHAIN` | `chain` | Child processes keep their chain |
| `NATIVE_FORM_FETCH`, `NATIVE_FORM_PROCESS` (legacy forms), `NATIVE_WEB_SERVICE`, `NATIVE_USER_PREFERENCES`, `NATIVE_PRINT_REPORT`, `NATIVE_GEOCODING`, `NATIVE_WORKFLOW`, `NATIVE_HUMAN_TASK_*`, plug-ins | not mapped | The report says which pgkiln type to set up by hand |

Not imported yet: interactive report and grid column settings and saved reports, charts, cards,
calendars, maps, trees and faceted search, lists other than the navigation menu, application items,
processes and computations, shared component types beyond lists of values and authorization
schemes, translations, page JavaScript and CSS, plug-ins, and the APEXlang (`.apx`) and YAML
exports.

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

**How pgkiln does it.** The same model: a **user directory** with one account per person
(**Builder → Users**), and per application an **Access control** setting (only listed accounts, or
any active account) plus role assignments per account. Roles feed authorization schemes and
`meta.has_role()`. See [chapter 8](08-security.md#the-user-directory).

Instead of (or next to) passwords, applications can use **single sign-on with OpenID Connect**,
APEX's "Social Sign-In" scheme, with identity-provider groups mapped to application roles. Signing
in to a second app is then silent via the identity provider's session. See
[chapter 8](08-security.md#single-sign-on-openid-connect). **SAML 2.0** providers and **LDAP /
Active Directory** passwords work the same way (groups → roles), and *Keep me signed in* matches
APEX's persistent authentication. Unlike APEX, the user directory's accounts can have
[two-factor sign-in](08-security.md#two-factor-sign-in) (an authenticator app), per application and per role. **Database accounts** sign in with PostgreSQL login roles, and
**custom authentication** calls your own PL/pgSQL function (APEX: a custom PL/SQL scheme), see
[chapter 8](08-security.md#custom-authentication-a-plpgsql-function). The **login page** (APEX: page 9999 with
the Login region template) is a page you design in the Page Designer around a **Login** region, and
**Forgot password?** is built in (APEX apps build their own), see [chapter 8](08-security.md#the-login-page).

## ORDS and PostgREST

In the Oracle world, ORDS (Oracle REST Data Services) plays two roles:

1. **The web listener for APEX itself**: every APEX page request goes through ORDS's PL/SQL gateway.
2. **REST APIs**: RESTful services defined in APEX/ORDS, AutoREST for tables and views, and
   REST-enabled SQL.

In pgkiln, **role 1 doesn't exist**. The pgkiln server *is* the web tier, talking to PostgreSQL
directly. You don't need ORDS or any replacement to run applications.

For **role 2**, REST APIs, [PostgREST](https://postgrest.org) is the natural choice. It turns a
PostgreSQL schema into a REST API: tables and views become resources, functions become RPC
endpoints, and it authenticates with JWTs whose `role` claim selects the database role, so
grants and row level security apply, just as in pgkiln. That makes it a good partner rather than
a replacement:

| ORDS feature | PostgreSQL option |
|---|---|
| AutoREST for tables and views | PostgREST (automatic for an exposed schema) |
| Hand-written handlers (GET/POST with SQL or PL/SQL) | **REST modules** in the builder: method, path with parameters and SQL, served by pgkiln ([chapter 13](13-rest-api.md#rest-modules-in-the-builder)); or PostgREST RPC: `create function api.do_something(...)` → `POST /rpc/do_something` |
| OAuth2 client credentials (`oauth.create_client`, `/oauth/token`) | OAuth clients: `meta.oauth_create_client()` or Builder → REST API → OAuth clients, and `POST /oauth/token` on pgkiln ([chapter 13](13-rest-api.md#oauth-clients-client-credentials)). Or tokens from your identity provider |
| REST-enabled SQL | Not provided by PostgREST (and rarely desirable) |
| OpenAPI/Swagger | Generated for every REST module (`…/openapi.json`) and built into PostgREST |

pgkiln integrates with it: `meta.app_user()` and `meta.has_role()` understand PostgREST's JWT
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
| empty string is NULL | Postgres distinguishes them, but pgkiln stores empty items as NULL, as APEX does |
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
- **Hidden items aren't in the page**: a `hidden` item is value protected and its value stays on the server (APEX
  renders it with a checksum). For APEX's *Value Protected* = No, give it `{"value_protected": false}`: a hidden
  input that dynamic actions and JavaScript set ([Hidden items](05-items.md#hidden-items)).
- **Dates**: date items, date ranges, grid date cells and facet ranges are text in the application's date format
  (else ISO, `2026-10-01`) with pgkiln's date picker; format masks
  apply to report, grid and cards columns and to number and display items
  ([number formats](14-globalization.md#number-formats)).
- **Modal pages** open over the calling page, and close and refresh it after a successful submit,
  like an APEX "Close Dialog" process plus "Dialog Closed" refresh.
