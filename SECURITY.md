# Security

## Reporting a vulnerability

Please report vulnerabilities **privately** through
[GitHub private vulnerability reporting](https://github.com/NickVrgr/Postgresql_APEX/security/advisories/new),
not as public issues. Include steps to reproduce and the affected version or commit. You will get
an acknowledgement within a few working days, and a fix and advisory are coordinated with you.

Supported versions: the latest release and the `main` branch.

# Security model and review

This document describes how pgapex authenticates users, authorizes access and
protects data. It also records the findings of the security review of the
first version (MVP). Every finding below has a regression test in
[`test/security.test.ts`](test/security.test.ts).

## Layers of defence

| Layer | Mechanism |
|---|---|
| Database role | The runtime connects as `pgapex_runtime` (NOINHERIT). It can read metadata and manage sessions, but cannot read `meta.developer`, password hashes or `meta.instance_setting`. It can reach an application's data only through `SET LOCAL ROLE <app db_role>`. |
| Application role ("parsing schema") | Every request runs in a transaction as the app's `db_role`. Postgres grants decide what the app can touch at all. |
| Row level security | `meta.app_user()` and `meta.has_role()` expose the signed-in application user to SQL, so RLS policies (and triggers, audit logs) know *who* is acting, not just which database role. |
| Authentication | Local accounts: bcrypt (pgcrypto) behind the `meta.authenticate()` SECURITY DEFINER function, constant work for unknown users, throttling per user and per IP. Single sign-on: OpenID Connect with PKCE, browser-bound one-time state, nonce, JWKS signature, issuer/audience/expiry checks and linking by subject; SAML 2.0 with signed assertions only, issuer, audience, recipient, validity and one-time `InResponseTo`, the same browser binding (a same-site re-post, since the IdP's cross-site POST carries no Lax cookie). LDAP: search, then bind as the user (empty passwords refused, RFC 4515 filter escaping), write-only service password. "Keep me signed in": a rotating one-time token (SHA-256 stored, owner-only), fixed expiry, access re-checked on each use, ended by sign-out, new password, deactivation or removed access. Session rotation on every sign-in. |
| Authorization schemes | On pages, regions, items, buttons, processes, dynamic actions and navigation entries. They are role based or SQL based and fail closed when unknown. |
| REST API (PostgREST) | Tokens are HS256 JWTs (shared `API_JWT_SECRET`) or identity-provider tokens. PostgREST switches to the app's API role (never one that bypasses RLS). `meta.api_check()` runs before every request and rejects tokens of inactive accounts or accounts without access; roles are read live. Only the `api` schema is exposed; the anonymous role has no privileges. |
| Passwords | Password policy (length, letters and digits, no username), expiry and change on first use enforced before a session exists; changing a password needs the current one and ends other sessions. |
| Approvals | Task tables are closed to application roles; `meta.tasks` and the `meta.*_task` functions check, for every call, who may see, claim, decide, delegate or cancel (one rights function for both). Initiators can't decide their own requests unless the definition allows it. The completion SQL runs as the application's role in the same transaction, so RLS applies and an error undoes the decision. |
| Workflows | Steps run as the application's role (grants and RLS apply), variables are binds (escaped literals), the instance tables are closed to application roles; only initiators and administrators see a workflow, terminate it, and only administrators retry. |
| REST modules | Bearer tokens only (HS256 with `API_JWT_SECRET`, the app claim must match; no cookies, so no CSRF), the account (active, access) or OAuth client (not revoked) checked on every request, handler roles via `meta.has_role()`, SQL as the application's role (RLS) with every value a bind. |
| Progressive Web Apps | Off by default, per app. Kept pages (opt-in) are removed at every sign-in and sign-out; forms kept offline are sent only for the user who filled them in, with a fresh CSRF token, and processed at most once (submission ids); the record a form was opened for is signed with the form. `Permissions-Policy` allows camera and geolocation for the application itself only (`camera=(self), microphone=(), geolocation=(self)`). |
| Outgoing web requests (REST data sources) | Off until `PGAPEX_REST_ALLOWED_HOSTS` lists hosts. Only http/https without user:password; the resolved address is checked at connect time and is the one connected to (no DNS rebinding); private, loopback, link-local (cloud metadata), CGNAT, multicast and documentation ranges are refused, also as IPv4-mapped, NAT64 and 6to4 addresses, unless the host is in `PGAPEX_REST_PRIVATE_HOSTS`; at most 3 redirects, each re-checked, credential headers dropped when a redirect leaves the origin; time and size limits (also after decompression). Parameter values are URL-encoded after a fixed host (`.`/`..` refused), header values are one line, and `Authorization`, `Cookie`, `Host` and transport headers can't be set on a source. Response values reach SQL as one escaped literal through `jsonb_to_recordset` with checked column names, as the app's role. |
| Web credential secrets | Encrypted with AES-256-GCM using `PGAPEX_SECRET_KEY`, which lives outside the database (a dump alone reveals nothing); write-only in the builder, never exported, logged or shown in errors; the runtime role's column grant leaves out `secret_enc`. Changing the key means entering the secrets again. |
| Page logic | Computations, branch conditions and badge SQL run as the app's role in savepoints with binds as literals; a PL/pgSQL function body becomes a `pg_temp` function behind a random dollar-quote tag (a body containing it is refused). URL branches are checked in the database (no scheme, `//`, `\`, `..` or control characters) and item values in them are URL-encoded, so a branch can't leave the app. A menu entry's request counts as a button only when the menu button is visible and the entry's authorization passes; a real button of that name keeps its own checks. Components of excluded build options are not rendered, run or accepted (an excluded page is a 404). |
| Calendar drag and drop | The move route checks the CSRF token first, then a signed-in user, page and region authorization and conditions and the region's *who may drag* scheme; the event must be in the region's query for this user (app role, RLS). The browser sends only an event key (≤ 200 characters) and a date-checked slot; new start and end reach the developer's move SQL as literals. Refusals and moves are logged. |
| Facets and smart filters | Search terms, facet values and range bounds are query parameters, never SQL text; bounds are checked against the column type, only a facet's own ranges are accepted unless it allows a custom range, column names are checked against the report and quoted, NUL bytes are dropped, and the number and size of filters is limited. Facets of regions the user can't see don't filter, and such regions get no display-selector tab. |
| Lazy regions and the region cache | The lazy region endpoint needs the app's session, re-checks page access and the region's condition and authorization, serves only lazy regions of that page (403 otherwise), never writes session state and answers `no-store`. Cached regions are keyed by a SHA-256 of the app, page, region definition, language, roles, visible regions, the query string and the values of every bind and substitution the region uses; the scope adds the session or user, and "all" is shared only between users with the same roles and sign-in state. CSRF tokens are filled in per request, regions with per-user checksum links aren't shared, and regions with errors aren't cached. Page numbers, sizes, row limits and cache durations are clamped on the server. |
| Session state protection | Item values in URLs, and the row keys of interactive grids, carry an HMAC checksum bound to app, page and user. Hidden, display, read-only and unauthorized items cannot be set by a form post. |
| Request integrity | A CSRF token on every POST (pages, AJAX, login, logout). Buttons are re-validated on submit. |
| Output | Auto-escaping HTML templates, strict CSP (no inline scripts, no inline styles: the page's one `<style>` carries a per-response nonce), `X-Frame-Options`, `nosniff`, `no-store`. Images may also come from the map tile server (`MAP_TILE_URL`, an http(s) origin only); map data travels as JSON in a `<script type="application/json">` element with `<` escaped. A map area in a report URL (`r<id>_bb`) is parsed into four range-checked numbers before it reaches SQL; anything else is ignored. The browser fetches tiles from that server directly, so it sees users' IP addresses, map areas and the site's origin (sent as `Referer`, which OpenStreetMap requires; never the page's path or query): self-host tiles where that matters. |
| Files | Uploads are size- and type-checked and stored per session (`meta.temp_files` shows only the session's own files). A posted text value can't point a file item at another file, and a "remove file" value only removes files of the form's own record. Downloads need a checksum bound to user, page, item and record, check page access and read as the app's role (RLS applies). They are sent as attachments with `nosniff` and a sandboxing CSP; only PNG, JPEG, GIF, WebP and PDF are shown inline. |
| Data loading and PDFs | The `data_load` process loads as the app's role (grants, RLS, triggers apply) and shows only data errors and `RAISE` messages per row. Report PDFs run the report's own query with the same page, region and row checks as the screen. |

## Findings of the MVP review and their fixes

Severity is rated for an internet-facing deployment.

| # | Finding (MVP) | Severity | Fix |
|---|---|---|---|
| 1 | **No authorization layer**: every signed-in user could open every page and press every button. | Critical | Authorization schemes on all component types. Links, menu entries and buttons to pages the user cannot open are hidden. |
| 2 | **Forged button requests**: the submit handler only checked that a button with that name existed. Its condition was never re-checked, so a hidden `DELETE` could be "pressed". | High | Visibility (authorization + conditions) is computed *before* posted values are applied. Requests for buttons that were not rendered get a 403 and are logged. |
| 3 | **IDOR through URL items**: `?P3_EMPNO=<any id>` opened any record. | High | Pages default to `protection = 'checksum'`. URL item values need an HMAC checksum (`urlChecksum` / `meta.page_url()`) bound to app, page and user. |
| 4 | **Runtime connected as a superuser**; apps without `db_role` ran as superuser. | High | Separate least-privilege `pgapex_runtime` login. The builder creates a dedicated role per app. Builder and migrations use the owner connection. |
| 5 | **No brute-force protection.** | High | Throttling in `activity_log`: 5 failures per user (since their last successful login) or 50 per IP within 15 minutes. The same applies to builder logins. |
| 6 | **Username enumeration by timing**: bcrypt only ran for existing users (~10× slower responses). | Medium | `meta.authenticate()` runs bcrypt against a random salt when the user is unknown. Error messages are identical. |
| 7 | **Session tokens stored in plain text**, with only an 8-hour idle timeout. | Medium | The cookie holds a 256-bit random token and the database stores only its SHA-256. Idle timeout is 60 minutes and the absolute limit is 8 hours (APEX defaults). Expired rows are purged. Password changes and deactivation end sessions. |
| 8 | **Logout via GET** (CSRF-able). | Low | POST with CSRF token only. |
| 9 | **No security headers**, and inline `onchange` handlers. | Medium | CSP `script-src 'self'`, `frame-ancestors 'self'`, `form-action 'self'`, `base-uri 'none'`, `nosniff`, `SAMEORIGIN`, `Cache-Control: no-store`, HSTS when `COOKIE_SECURE=true`. All behaviour lives in `/static/app.js` via event delegation. |
| 10 | **Database error details shown to end users** (table names, SQL fragments). | Medium | Only intentional messages (`RAISE EXCEPTION`, SQLSTATE P0001) and friendly constraint messages are shown. Everything else becomes "reference #id" in the activity log. The per-app `debug` flag shows details during development. |
| 11 | **Password hashes readable by the runtime connection.** | Medium | Column-level grants. Verification happens only inside `meta.authenticate()`. |
| 12 | **Default `admin/admin` builder account** with no way to change it in the UI. | Medium | A Developers page (change password, manage accounts). A banner appears while a default or trivial password is in use. Minimum password length is 8 for new accounts. |
| 13 | **CSV export formula injection** (new feature). | Low | Text cells starting with `= + - @` get a leading `'`. |
| 14 | **Read-only conditions failed open** (found during this review): an erroring condition made an item editable. | Medium | Read-only conditions fail closed. Region and button conditions already did. |

## Things that remain the developer's responsibility

- **Developer SQL is trusted**, as in APEX. It runs as the app role, so the
  role's grants define its reach. End-user input reaches SQL only as escaped
  literals, whitelisted operators, integers, or identifiers checked against
  the result's column list.
- **Static region HTML is trusted.** `&ITEM.` substitutions in it are
  escaped, and inline scripts, event handler attributes, `style` attributes
  and `<style>` blocks are blocked by the CSP (`style-src 'self' 'nonce-…'`):
  even HTML that slips through can't restyle the page to fake a form or hide
  a warning. Style developer HTML with the classes in `/static/app.css`.
- **Template components and plug-ins are not trusted like developer HTML**,
  because a plug-in file may come from someone else. A template is checked
  against an allow-list when it is saved, imported (builder or SQL trigger)
  and rendered: no scripts, styles, event handlers, `data-*`, forms, frames,
  unquoted attribute values or raw placeholders. Every placeholder is
  HTML-escaped, and a value that would make a `javascript:` (or similar) link
  is dropped. Plug-ins carry no code of their own.
- **The builder's code editor** suggests tables and columns as the
  application's own database role sees them (the runtime role for apps
  without one), so a developer of one application can't list another
  application's schema through it; it never returns password hashes.
- **Server-side checks belong in the database** for anything that matters:
  RLS policies, or checks inside PL/pgSQL functions (see `hr.decide_leave`).
  UI authorization hides things; the database enforces them.
- **`protection = 'unrestricted'`** pages accept any URL item values. Use it
  only for items that are harmless to set, such as search filters.
- **REST data sources**: a cached response is shared by every user of the
  application, so don't cache sources whose answer depends on the user. With
  `*` on `PGAPEX_REST_ALLOWED_HOSTS` developers can call any public host.
  OAuth tokens and the response cache are kept per server process.
- **Calendar move SQL** is developer SQL: pgapex checks that the user sees the
  event, but who may move *what* (e.g. only the organiser) belongs in the SQL
  or RLS.
- **Streamed downloads** keep a read-only transaction open while a slow
  client reads; `STATEMENT_TIMEOUT` applies to each fetch.
- **Lockout trade-off**: per-user throttling lets an attacker lock a known
  account for 15 minutes. The per-IP limit and the activity monitor help you
  spot this.

## Deployment checklist

1. Change the builder password (the Developers page), or delete `admin` after creating your own account.
2. `alter role pgapex_runtime password '...'` and set `RUNTIME_DATABASE_URL`.
3. Run behind HTTPS with `COOKIE_SECURE=true`, and set `TRUST_PROXY=true` behind a reverse proxy (client IPs are needed for throttling).
4. Keep `debug` off for production apps (see the Settings → Security checklist in the builder).
5. Give each app its own `db_role` with the minimum grants; add RLS where rows are per user or per team.
6. Restrict network access to `/builder` (reverse proxy or firewall) if developers are a small group.
7. With a REST API: set a long random `API_JWT_SECRET` (the same in PostgREST), change the `pgapex_authenticator` password, configure `db-pre-request = meta.api_check`, expose only the `api` schema, and run PostgREST behind HTTPS.
8. With REST data sources: list only the hosts you need in `PGAPEX_REST_ALLOWED_HOSTS` (avoid `*`), set a long random `PGAPEX_SECRET_KEY` (32+ characters) kept outside the database and its backups, and use `PGAPEX_REST_PRIVATE_HOSTS` only for internal services you mean to reach.
