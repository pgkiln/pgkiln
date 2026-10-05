# 9. SQL API and metadata reference

## Functions for application SQL

These are available to every application's SQL (region sources, processes, RLS policies,
triggers, your own functions).

| Function | Returns | Description |
|---|---|---|
| `meta.app_user()` | text | The signed-in application user, or `nobody`. In PostgREST requests: the token's user ([chapter 13](13-rest-api.md)) |
| `meta.app_id()` | int | The current application's id (in PostgREST: the app named in the token) |
| `meta.has_role(role)` | boolean | Whether the current user has the role in this application (roles are resolved at sign-in; in PostgREST: the token's `roles` claim or the account's roles in the token's app) |
| `meta.jwt_claims()` | jsonb | The verified JWT claims of a PostgREST request, or NULL |
| `meta.app_language()` | text | The language of the request (`nl`, `en-GB`, …) |
| `meta.message(name, variadic params)` | text | A text message in the current language, `%0`…`%9` replaced; falls back to the base and primary language |
| `meta.password_days_left(username)` | int | Days until the password expires (0: must change now, NULL: never) |
| `meta.v(name)` | text | The session-state value of an item (use it inside functions and `DO` blocks) |
| `meta.page_url(page, items jsonb default '{}', clear boolean default true)` | text | A URL to a page of the current app, with a valid checksum for the items: `meta.page_url(3, jsonb_build_object('P3_EMPNO', empno))` |
| `meta.html_escape(text)` | text | Escapes `& < > " '` for HTML (use it in dynamic content regions) |
| `meta.url_encode(text)` | text | Percent-encodes a URL component |
| `meta.temp_files` (view) | rows | The current session's uploaded files: `id`, `item_name`, `filename`, `mime_type`, `size`, `content`, `created_at` (like `APEX_APPLICATION_TEMP_FILES`; [chapter 16](16-files.md)) |
| `meta.delete_temp_file(id)` | void | Removes one of the current session's uploaded files |
| `meta.debug(level, text)`, `meta.debug(text)` | void | A [debug message](06-processing.md#debug-messages) (APEX: `apex_debug.message`): recorded with the request when the app's debug level is at least `level` (1 error, 2 warning, 4 information (the default), 6 trace, 9 everything); otherwise it returns at once. Texts are cut at 4000 characters |
| `meta.debug_enabled(level default 4)` | boolean | Whether a message of this level would be recorded (skip building expensive texts) |
| `meta.debug_level()` | int | The request's debug level (0: off, and outside a request) |

The runtime sets these settings in each request's transaction (don't set them yourself):
`pgapex.app_user`, `pgapex.app_id`, `pgapex.session_id`, `pgapex.debug_level`.

## Functions for developers and scripts

Run these as the owner (in the SQL Workshop, `psql` or migrations):

| Function | Description |
|---|---|
| `meta.generate_crud(app, table, report_page, form_page, label default null, icon default 'table')` | Report page + modal form page + menu entry for a table |
| `meta.generate_grid(app, table, page, label default null, icon default 'grid')` | Interactive grid page + menu entry |
| `meta.generate_page(app, kind, table, page, options default '{}')` | The create page wizards: `kind` is `form`, `cards`, `calendar`, `chart`, `map`, `facets`, `master_detail` (or `report_form`, `grid`). Options left out take the defaults of `meta.wizard_defaults`; JSON `null` means none. Returns the new page's id (below) |
| `meta.wizard_defaults(kind, table)` | The options a wizard proposes for a table, from the catalog |
| `meta.wizard_catalog(table)` | The columns as the wizards see them: kind (`text`, `number`, `date`, `timestamp`, `boolean`, `point`, `geometry`, `binary`, `other`), key, unique, foreign key and the parent's display column |
| `meta.export_app(alias)` | The application as JSON (`pgapex/2` format) |
| `meta.import_app(json, alias default null)` | Import an export, optionally under a new alias; returns the new app id |
| `meta.hash_password(text)` | A bcrypt hash for `meta.app_user.password_hash` / `meta.developer.password_hash` |
| `meta.authenticate(app_id, username, password)` | Username on success, NULL otherwise, including when the account has no access to the app (used by the login page) |
| `meta.account_roles(app_id, username)` | The account's roles in an application |
| `meta.set_password(username, password, change_on_first_use default true)` | Set a password (ends the account's sessions) |
| `meta.expire_password(username)`, `meta.unexpire_password(username)` | Require (or no longer require) a new password at the next sign-in |
| `meta.change_password(app_id, username, old, new, keep_session)` | Change a password knowing the current one (used by My account; runtime only) |
| `meta.api_check()` | PostgREST's pre-request function (`db-pre-request`): rejects tokens whose app doesn't use the current role as its API role, or whose account is inactive or has no access |

Options of `meta.generate_page` (all optional; column names must be columns of the table):

| Kind | Options |
|---|---|
| all | `label` (page name and menu entry), `icon`, `nav` (add a navigation entry; default true, false for `form`) |
| `form` | `columns` (array), `mode` (`normal` or `modal`), `return_page` |
| `cards` | `title`, `subtitle`, `body`, `badge`, `form_page` |
| `calendar` | `start`, `end`, `title`, `drag` (boolean), `form_page` |
| `chart` | `chart` (`bar`, `column`, `line`, `area`, `donut`, `pie`, `funnel`), `label_column`, `function` (`count`, `sum`, `avg`, `min`, `max`), `value_column` |
| `map` | `location` (geometry, point or `lat,lng` text) or `lat` + `lng`, `title`, `body`, `report` (boolean), `form_page` |
| `facets` | `columns` (report columns, array), `facets` (array), `search` (boolean), `form_page` |
| `master_detail` | `detail` (a table), `detail_column` (its column referring to this table) |
| `report_form` | `form_page` (required) |

```sql
select meta.generate_page('shop', 'calendar', 'shop.meeting', 12, '{"form_page": 13, "drag": true}');
select meta.generate_page('shop', 'facets', 'shop.product', 14, '{"facets": ["category_id", "price"]}');
select meta.generate_page('shop', 'master_detail', 'shop.orders', 15);
```

## Metadata tables

All in schema `meta`. `id` columns are generated; `seq` orders siblings (default 10).

### Application level

**`app`**: an application.

| Column | Type | Description |
|---|---|---|
| `alias` | text | URL name (`^[a-z][a-z0-9_-]*$`), unique |
| `name` | text | Display name |
| `home_page` | int | Page opened by `/a/<alias>` |
| `authentication` | text | `app_users`, `header`, `database`, `custom` or `none` |
| `custom_auth_function`, `custom_auth_code`, `custom_auth_post_code` | text | Custom authentication: a function `(p_username text, p_password text) returns boolean`, or a PL/pgSQL body, and post-authentication code ([chapter 8](08-security.md#custom-authentication-a-plpgsql-function)) |
| `nav_list`, `navbar_list` | text | A list shown as the navigation menu (instead of `nav_entry`) and as the navigation bar |
| `access_control` | text | `assigned` (only accounts with access) or `any_user` |
| `local_login` | boolean | Offer username and password sign-in |
| `sso_providers` | text[] | Names of identity providers (OpenID Connect or SAML) offered on the login page |
| `ldap_directories` | text[] | LDAP directories the password form checks, after local accounts |
| `remember_me_days` | int | Days a "Keep me signed in" sign-in lasts; NULL = not offered |
| `pwa`, `pwa_short_name`, `pwa_icon`, `pwa_offline_pages`, `pwa_offline_submit` | boolean, text, bytea, boolean, boolean | Progressive Web App ([chapter 17](17-mobile.md)) |
| `db_role` | text | Database role every request runs as |
| `api_role` | text | Database role of REST API tokens for this app (PostgREST switches to it) |
| `language`, `languages`, `language_from` | text, text[], text | Primary language, translated languages, `browser` / `user` / `primary` |
| `date_format`, `timestamp_format` | text | Display masks (e.g. `DD-MM-YYYY`); NULL: the language's default |
| `debug` | boolean | Show database error details to users |
| `debug_level` | smallint | [Debug messages](06-processing.md#debug-messages): 0 off, 1, 2, 4, 6 or 9 (APEX levels) |
| `debug_retention_days` | int | Days debug messages are kept (1–90, default 7) |
| `theme` | jsonb | `{"accent": "#0b63c5", "header": "#13294b", "nav": "side" \| "top"}` |

**`account`** (the user directory): `username` (unique, case-insensitive), `display_name`, `email`,
`password_hash` (bcrypt; NULL = no password), `active`, `created_at`, `last_login_at`.

**`app_access`**: `app_id`, `account_id`, `roles` (text[]); who may use which application.

**`app_user`**: a *view* over `account` + `app_access` (`id`, `app_id`, `username`, `password_hash`,
`roles`, `active`, `last_login_at`), kept for compatibility. Inserting creates the account if
needed and grants access; deleting revokes access.

**`app_group_role`**: `app_id`, `group_name`, `role`; identity-provider group → application role.

**`authz_scheme`**: `app_id`, `name` (uppercase), `type` (`role` / `sql`), `value`, `error_message`.

**`nav_entry`**: `app_id`, `parent_id` (sub-menu), `seq`, `label`, `icon`, `target_page`, `authz`.

**`lov`**: `app_id`, `name` (uppercase; used as `LOV:NAME`), `query`, `rest_source` (the query then reads the source's rows from `rest`).

**`list`**: `app_id`, `name` (uppercase), `type` (`static` / `sql`), `query`, `description`
([chapter 4](04-pages-and-regions.md#list-lists)).

**`list_entry`**: `app_id`, `list_name`, `parent_id` (an entry of the same list), `seq`, `label`, `icon`, `target_page`,
`target_items` (jsonb), `target_url` (a path inside the app or an `http(s)` address), `badge`, `description`, `condition`,
`authz`, `build_option`.

**`supporting_script`**: `app_id`, `name`, `kind` (`install` / `upgrade` / `deinstall`), `seq`, `script`
([chapter 3](03-builder.md#supporting-objects)).

**`web_credential`**: `app_id`, `name` (uppercase), `description`, `type` (`basic` / `header` / `bearer` / `oauth2`), `username` (or client id),
`header_name`, `token_url`, `scope`, `valid_for` (text[] of URL prefixes), `secret_enc` (encrypted by the server; not readable by the
runtime role, never exported) ([chapter 19](19-rest-data-sources.md#web-credentials)).

**`rest_source`**: `app_id`, `name` (uppercase), `description`, `url` (with `{param}`), `method`, `credential`, `headers` (jsonb),
`params` (jsonb), `body`, `row_selector`, `columns` (jsonb), `cache_seconds`, `timeout_s`, `max_rows`
([chapter 19](19-rest-data-sources.md#rest-data-sources)).

**`app_item`**: `app_id`, `name`, `description`.

**`app_process`**: `app_id`, `seq`, `name`, `point` (`after_login` / `before_page`), `code`, `authz`.

**`build_option`**: `app_id`, `name` (uppercase, unique per app), `status` (`include` / `exclude`),
`description` ([chapter 6](06-processing.md#build-options)). `meta.build_option_on(app_id, ref)`
tells whether a component with that `build_option` value is part of the application.

### Page level

**`page`**

| Column | Description |
|---|---|
| `app_id`, `page_no` | Unique together |
| `name`, `title` | Title supports `&ITEM.` |
| `requires_auth` | boolean |
| `parent_page` | Breadcrumb parent |
| `mode` | `normal` / `modal` |
| `protection` | `checksum` / `unrestricted` |
| `authz` | Authorization scheme |
| `build_option` | `NAME` / `!NAME`: only while the [build option](06-processing.md#build-options) is included / excluded |

Regions, items, buttons, dynamic actions, validations, processes, computations, branches,
navigation entries and application processes have the same `build_option` column.

**`region`**

| Column | Description |
|---|---|
| `page_id`, `seq`, `title` | |
| `type` | `report`, `grid`, `form`, `chart`, `cards`, `calendar`, `facets`, `smart_filters`, `display_selector`, `map`, `tree`, `template_component`, `list`, `tasks`, `workflows`, `static`, `dynamic` |
| `source` | SELECT (or HTML for `static`) |
| `table_name`, `pk_column` | For `form` and `grid` |
| `pk_item` | For `form`: the item holding the key |
| `columns` | 1–12 |
| `template` | `standard`, `plain`, `collapsible` |
| `condition`, `authz` | Visibility |
| `config` | Attributes per type ([chapter 4](04-pages-and-regions.md)) |
| `rest_source` | A REST data source the region reads; `source` is then SQL over `rest` ([chapter 19](19-rest-data-sources.md)) |

**`item`**: `page_id`, `region_id`, `seq`, `name`, `label`, `type`, `lov`, `source_column`,
`default_value`, `required`, `help`, `readonly_condition`, `authz`, `config` ([chapter 5](05-items.md)).

**`button`**: `page_id`, `region_id`, `seq`, `name`, `label`, `action` (`submit` / `redirect` / `da` /
`document` / `menu`), `target_page`, `target_items` (jsonb), `condition`, `authz`, `hot`, `confirm`,
`menu` (jsonb, for `menu`), `badge`, `badge_query` ([chapter 6](06-processing.md)).

**`dynamic_action`**: `page_id`, `seq`, `name`, `event`, `trigger_element`, `condition_type`,
`condition_value`, `action`, `affected_items`, `affected_region_id`, `code`, `items_to_submit`,
`message`, `css_classes`, `authz` ([chapter 7](07-dynamic-actions.md)).

**`validation`**: `page_id`, `seq`, `name`, `item_name`, `type` (`not_null` / `sql` / `regex`),
`expression`, `message`, `when_button`.

**`process`**: `page_id`, `seq`, `name`, `type` (`form_dml` / `grid_dml` / `sql` / `data_load` / `invoke_api`),
`region_id`, `code`, `config` (jsonb, for `data_load` and `invoke_api`), `point` (`submit` / `load`), `when_button`,
`authz`, `success_message`.

**`computation`**: `page_id`, `seq`, `item_name`, `point` (`before_header` / `after_submit`), `type`
(`static` / `item` / `sql_query` / `sql_expression` / `function_body`), `expression`,
`condition_type`, `condition_expr`, `condition_value`, `authz`
([chapter 6](06-processing.md#computations)).

**`branch`**: `page_id`, `seq`, `name`, `point` (`after_processing` / `before_header`), `when_button`,
`condition_type`, `condition_expr`, `condition_value`, `target_type` (`page` / `url`), `target_page`,
`target_items` (jsonb), `target_url`, `authz` ([chapter 6](06-processing.md#branches)).

### Runtime and instance

| Table | Contents | Readable by the runtime role |
|---|---|---|
| `session` | Sessions: `token_hash` (SHA-256 of the cookie), `app_id` (NULL = builder), `username`, `roles` (resolved at sign-in), `csrf_token`, `state` (jsonb session state), `created_at`, `last_seen` | yes |
| `activity_log` | `at`, `app_id`, `page_no`, `username`, `event` (`page_view`, `login`, `login_failed`, `login_locked`, `login_unlocked`, `logout`, `error`, `forbidden`, `api_token`, `password_expired`, `password_changed`; builder: `lock_broken`, `supporting_objects`, …), `ip`, `elapsed_ms`, `detail` | yes (insert/select) |
| `debug_view` | [Debug messages](06-processing.md#debug-messages): one row per recorded request: `app_id`, `page_no`, `username`, `session_id`, `method`, `path` (without the query string), `status`, `level`, `started_at`, `elapsed_ms`, `entries`. Written through `meta.debug_save()` (runtime role only), not exported | no |
| `debug_message` | The entries of a recorded request: `view_id`, `seq`, `elapsed_ms` (since the start), `duration_ms` (timed steps), `level`, `component`, `message` | no |
| `developer` | Builder accounts (`is_admin`: manages developers, breaks locks) | no |
| `builder_lock` | Page (`page_no`) and application (`page_no` 0) locks: `locked_by`, `locked_at`, `note` | no |
| `dev_comment` | Developer comments on an application (`page_no` 0) or page: `author`, `body`, `created_at` | no |
| `auth_provider` | OpenID Connect and SAML providers (`protocol`; SAML: `idp_sso_url`, `idp_cert`): `name`, `display_name`, `issuer`, `client_id`, `client_secret`, `scopes`, `username_claim`, `groups_claim`, `auto_create`, `enabled` | no |
| `account_identity` | Links an account to a provider's subject (`provider_id`, `subject`, `account_id`) | no |
| `sso_pending` | Sign-ins in progress (state, PKCE verifier, nonce or SAML request ID; kept for 10 minutes) | no |
| `saml_request` | SAML AuthnRequest IDs awaiting their response (used once) | no |
| `ldap_directory` | LDAP directories: URL, service account (write-only password), user and group search | no |
| `task_definition` | Approval and action task definitions per app | yes (read) |
| `rest_module` | REST modules per app: `name`, `title`, `handlers` (JSON) | yes (read) |
| `workflow_definition` | Workflow definitions per app: the active version's steps as JSON, a development version and the inactive ones | yes (read) |
| `workflow`, `workflow_event` | Workflow instances (state, current step, variables, their version and a copy of its steps) and their history; reached through `meta.workflows` / `meta.workflow_events` and the functions | no |
| `workflow_branch` | The parallel branches of workflow instances (step, wait, task and state of each) | no |
| `task`, `task_event` | Tasks and their history; reached only through `meta.tasks`, `meta.task_events` and the `meta.*_task` functions | no |
| `list`, `list_entry` | Lists and their entries per app (see above) | yes (read) |
| `supporting_script` | Supporting objects per app (see above) | no |
| `document_template` | Document templates per app: `name`, `description`, `query`, `template`, `layout`, `filename`, `authz` | yes (read) |
| `ldap_identity` | Links an account to a directory entry (`directory_id`, `subject` = entryUUID or DN) | no |
| `persistent_login` | "Keep me signed in" tokens: `token_hash`, `account_id`, `app_id`, `groups`, `method`, `expires_at` | no |
| `instance_setting` | Secrets, e.g. the URL checksum key | no |
| `setting` | Account settings: `password_min_length`, `password_require_mixed`, `password_lifetime_days` | yes (read) |
| `text_message` | Per app: `name`, `language`, `text` | yes |
| `translation` | Per app and language: `source` (primary-language text) → `target` | yes |
| `temp_file` | Uploaded files per session (deleted with the session; at most 20 per session). Read through the view `meta.temp_files` | no (through the view) |

Outside `meta`: `public.pgapex_migration` (applied migrations), `public.pgapex_seed` (applied example
scripts) and `public.pgapex_install_log` (each migration run that applied or failed a file: `started_at`,
`finished_at`, `version`, `kind` `install`/`upgrade`, `applied` files, `status`, `error`, `db_user`),
shown under Workspace utilities → **Installation**.

Retention: expired sessions are purged automatically; debug messages after the application's
`debug_retention_days` (and at most 5000 requests per application), by the scheduler. The activity log is kept until you delete
from it, for example with a scheduled
`delete from meta.activity_log where at < now() - interval '90 days'`.

## URL parameters

| Parameter | Used by | Meaning |
|---|---|---|
| `<ITEM>=value` | pages | Set an item (the page's items are cleared first) |
| `cs` | pages | Checksum of the item values |
| `clear=1` | pages | Clear the page's items |
| `dialog=1` | pages | Render for display inside a modal dialog |
| `r<id>_q` | report, grid | Search text |
| `r<id>_s`, `r<id>_d=desc` | report, grid | Sort by column position, descending |
| `r<id>_p` | report, grid | Page number |
| `r<id>_n` | report | Rows per page |
| `r<id>_a=fn\|column` | report, grid | An aggregate (repeatable); `fn` is `sum`, `avg`, `count`, `min`, `max` |
| `r<id>_sel=value`, `r<id>_selcs` | master grid | Select a master row: the value goes into the grid's `select_row` item; `selcs` is its signature (made by the runtime) |
| `r<id>_dup=key` | grid | Show the row with this key again as a new, unsaved row (Duplicate without JavaScript) |
| `r<id>_f=column\|op\|value` | report | Column filter (repeatable); `op` is `eq`, `ne`, `contains`, `not_contains`, `gt`, `ge`, `lt`, `le`, `null`, `not_null` |
| `r<id>_x_<column>=value` | report + facets, smart filters | Facet selection (repeatable) |
| `r<id>_xn_<column>=1` | report + facets | Exclude the selected values (facet with `exclude`) |
| `r<id>_rg_<column>=from\|to` | report + facets, smart filters | One of a range or star facet's ranges (`~`: the custom range) |
| `r<id>_rf_<column>`, `r<id>_rt_<column>` | report + facets | Custom range from / to, inclusive (facet with `custom`) |
| `r<id>_csv=1` | report | Download CSV |
| `r<id>_xlsx=1` | report | Download Excel |
| `r<id>_load=1` | lazy region | Show the region in the page (the link of its placeholder without JavaScript) |
| `r<id>_pdf=1` | report | Download PDF |
| `r<id>_m=YYYY-MM` | calendar | Month shown |

## Icons

Usable in navigation entries and cards (`icon` column):

`home` `users` `user` `building` `chart` `table` `list` `calendar` `shield` `history` `settings`
`org` `grid` `file` `check` `menu` `logout` `plus` `download` `filter` `database` `code`
`activity` `inbox` `close` `chevron` `edit` `layers` `bolt` `key` `play` `upload` `printer`

## HTTP endpoints

| Method and path | Purpose |
|---|---|
| `GET /a/:alias/:page` | Show a page (and CSV downloads) |
| `POST /a/:alias/:page` | Submit a page |
| `POST /a/:alias/:page/da/:id` | Run a server-side dynamic action (JSON) |
| `POST /a/:alias/:page/lov/:item` | Re-render a cascading list (JSON) |
| `GET/POST /a/:alias/login`, `POST /a/:alias/logout` | Sign in and out |
| `GET /a/:alias/sso/:provider` | Start single sign-on with a provider |
| `GET /sso/callback/:provider` | OpenID Connect redirect URI |
| `POST /sso/saml/:provider`, `POST /sso/saml/:provider/finish` | SAML assertion consumer service (and the same-site step after it) |
| `GET /sso/saml/:provider/metadata` | SAML service provider metadata |
| `GET/POST/PUT/PATCH/DELETE /a/:alias/rest/:module/…`, `GET …/openapi.json` | REST module endpoints (bearer token) and their OpenAPI description |
| `POST /a/:alias/workflows/:id` | Workflow console action (`terminate`, `retry`) |
| `POST /a/:alias/tasks/:id` | A task list action (`claim`, `release`, `approve`, `reject`, `complete`, `delegate`, `cancel`, `comment`) |
| `GET /a/:alias/manifest.webmanifest`, `/sw.js`, `/icon-192.png`, `/icon-512.png`, `/offline` | Progressive Web App files (only when the app has PWA on) |
| any page `?doc=NAME` | Download a document template filled with the page's values |
| `POST /a/:alias/account/devices` | Sign out on all devices ("Keep me signed in") |
| `POST /a/:alias/password` | Change an expired password while signing in |
| `GET/POST /a/:alias/account`, `POST /a/:alias/account/password`, `POST /a/:alias/account/theme` | My account, own password, the light/dark switch |
| `POST /a/:alias/tz` | The browser's time zone for the session (automatic time zone; sent by `app.js`, CSRF token required) |
| any page `?lang=xx` | Switch the language for the session |
| `/builder/...` | Builder |
| PostgREST (separate service, `API_URL`) | REST API of each app's `api` schema, see [chapter 13](13-rest-api.md) |
| `/static/...` | CSS, JavaScript, icons |
