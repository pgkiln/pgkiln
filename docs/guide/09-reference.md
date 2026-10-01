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

The runtime sets these settings in each request's transaction (don't set them yourself):
`pgapex.app_user`, `pgapex.app_id`, `pgapex.session_id`.

## Functions for developers and scripts

Run these as the owner (in the SQL Workshop, `psql` or migrations):

| Function | Description |
|---|---|
| `meta.generate_crud(app, table, report_page, form_page, label default null, icon default 'table')` | Report page + modal form page + menu entry for a table |
| `meta.generate_grid(app, table, page, label default null, icon default 'grid')` | Interactive grid page + menu entry |
| `meta.export_app(alias)` | The application as JSON (`pgapex/2` format) |
| `meta.import_app(json, alias default null)` | Import an export, optionally under a new alias; returns the new app id |
| `meta.hash_password(text)` | A bcrypt hash for `meta.app_user.password_hash` / `meta.developer.password_hash` |
| `meta.authenticate(app_id, username, password)` | Username on success, NULL otherwise, including when the account has no access to the app (used by the login page) |
| `meta.account_roles(app_id, username)` | The account's roles in an application |
| `meta.set_password(username, password, change_on_first_use default true)` | Set a password (ends the account's sessions) |
| `meta.expire_password(username)`, `meta.unexpire_password(username)` | Require (or no longer require) a new password at the next sign-in |
| `meta.change_password(app_id, username, old, new, keep_session)` | Change a password knowing the current one (used by My account; runtime only) |
| `meta.api_check()` | PostgREST's pre-request function (`db-pre-request`): rejects tokens whose app doesn't use the current role as its API role, or whose account is inactive or has no access |

## Metadata tables

All in schema `meta`. `id` columns are generated; `seq` orders siblings (default 10).

### Application level

**`app`**: an application.

| Column | Type | Description |
|---|---|---|
| `alias` | text | URL name (`^[a-z][a-z0-9_-]*$`), unique |
| `name` | text | Display name |
| `home_page` | int | Page opened by `/a/<alias>` |
| `authentication` | text | `app_users` or `none` |
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

**`lov`**: `app_id`, `name` (uppercase; used as `LOV:NAME`), `query`.

**`app_item`**: `app_id`, `name`, `description`.

**`app_process`**: `app_id`, `seq`, `name`, `point` (`after_login` / `before_page`), `code`, `authz`.

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

**`region`**

| Column | Description |
|---|---|
| `page_id`, `seq`, `title` | |
| `type` | `report`, `grid`, `form`, `chart`, `cards`, `calendar`, `facets`, `static`, `dynamic` |
| `source` | SELECT (or HTML for `static`) |
| `table_name`, `pk_column` | For `form` and `grid` |
| `pk_item` | For `form`: the item holding the key |
| `columns` | 1–12 |
| `template` | `standard`, `plain`, `collapsible` |
| `condition`, `authz` | Visibility |
| `config` | Attributes per type ([chapter 4](04-pages-and-regions.md)) |

**`item`**: `page_id`, `region_id`, `seq`, `name`, `label`, `type`, `lov`, `source_column`,
`default_value`, `required`, `help`, `readonly_condition`, `authz`, `config` ([chapter 5](05-items.md)).

**`button`**: `page_id`, `region_id`, `seq`, `name`, `label`, `action` (`submit` / `redirect` / `da`),
`target_page`, `target_items` (jsonb), `condition`, `authz`, `hot`, `confirm` ([chapter 6](06-processing.md)).

**`dynamic_action`**: `page_id`, `seq`, `name`, `event`, `trigger_element`, `condition_type`,
`condition_value`, `action`, `affected_items`, `affected_region_id`, `code`, `items_to_submit`,
`message`, `authz` ([chapter 7](07-dynamic-actions.md)).

**`validation`**: `page_id`, `seq`, `name`, `item_name`, `type` (`not_null` / `sql` / `regex`),
`expression`, `message`, `when_button`.

**`process`**: `page_id`, `seq`, `name`, `type` (`form_dml` / `grid_dml` / `sql` / `data_load`),
`region_id`, `code`, `config` (jsonb, for `data_load`), `point` (`submit` / `load`), `when_button`,
`authz`, `success_message`.

### Runtime and instance

| Table | Contents | Readable by the runtime role |
|---|---|---|
| `session` | Sessions: `token_hash` (SHA-256 of the cookie), `app_id` (NULL = builder), `username`, `roles` (resolved at sign-in), `csrf_token`, `state` (jsonb session state), `created_at`, `last_seen` | yes |
| `activity_log` | `at`, `app_id`, `page_no`, `username`, `event` (`page_view`, `login`, `login_failed`, `login_locked`, `login_unlocked`, `logout`, `error`, `forbidden`, `api_token`, `password_expired`, `password_changed`), `ip`, `elapsed_ms`, `detail` | yes (insert/select) |
| `developer` | Builder accounts | no |
| `auth_provider` | OpenID Connect and SAML providers (`protocol`; SAML: `idp_sso_url`, `idp_cert`): `name`, `display_name`, `issuer`, `client_id`, `client_secret`, `scopes`, `username_claim`, `groups_claim`, `auto_create`, `enabled` | no |
| `account_identity` | Links an account to a provider's subject (`provider_id`, `subject`, `account_id`) | no |
| `sso_pending` | Sign-ins in progress (state, PKCE verifier, nonce or SAML request ID; kept for 10 minutes) | no |
| `saml_request` | SAML AuthnRequest IDs awaiting their response (used once) | no |
| `ldap_directory` | LDAP directories: URL, service account (write-only password), user and group search | no |
| `task_definition` | Approval and action task definitions per app | yes (read) |
| `rest_module` | REST modules per app: `name`, `title`, `handlers` (JSON) | yes (read) |
| `workflow_definition` | Workflow definitions per app (steps as JSON) | yes (read) |
| `workflow`, `workflow_event` | Workflow instances (state, current step, variables, a copy of the steps) and their history; reached through `meta.workflows` / `meta.workflow_events` and the functions | no |
| `task`, `task_event` | Tasks and their history; reached only through `meta.tasks`, `meta.task_events` and the `meta.*_task` functions | no |
| `document_template` | Document templates per app: `name`, `description`, `query`, `template`, `layout`, `filename`, `authz` | yes (read) |
| `ldap_identity` | Links an account to a directory entry (`directory_id`, `subject` = entryUUID or DN) | no |
| `persistent_login` | "Keep me signed in" tokens: `token_hash`, `account_id`, `app_id`, `groups`, `method`, `expires_at` | no |
| `instance_setting` | Secrets, e.g. the URL checksum key | no |
| `setting` | Account settings: `password_min_length`, `password_require_mixed`, `password_lifetime_days` | yes (read) |
| `text_message` | Per app: `name`, `language`, `text` | yes |
| `translation` | Per app and language: `source` (primary-language text) → `target` | yes |
| `temp_file` | Uploaded files per session (deleted with the session; at most 20 per session). Read through the view `meta.temp_files` | no (through the view) |

Retention: expired sessions are purged automatically. The activity log is kept until you delete
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
| `r<id>_f=column\|op\|value` | report | Column filter (repeatable); `op` is `eq`, `ne`, `contains`, `not_contains`, `gt`, `ge`, `lt`, `le`, `null`, `not_null` |
| `r<id>_x_<column>=value` | report + facets | Facet selection (repeatable) |
| `r<id>_csv=1` | report | Download CSV |
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
| any page `?lang=xx` | Switch the language for the session |
| `/builder/...` | Builder |
| PostgREST (separate service, `API_URL`) | REST API of each app's `api` schema, see [chapter 13](13-rest-api.md) |
| `/static/...` | CSS, JavaScript, icons |
