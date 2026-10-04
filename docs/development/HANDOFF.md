# Handoff: work in progress

This file lets another developer (or another Claude session) continue the current sprint without
the chat history. Keep it updated when you stop working. Delete it (or empty the sprint section)
when the sprint is merged.

Last updated: 2026-10-01. Sprints 3–24 are merged into `main` and released as **v0.17.1** (migrations 001–028 are released: add 029+).

## Project in one paragraph

**pgapex** is an open source (Apache-2.0, © Vargar) Oracle APEX alternative on PostgreSQL:
applications are rows in the `meta` schema, rendered by a Node/TypeScript (Fastify) server with
server-side HTML, plus a builder at `/builder`. Read `docs/README.md` (the user guide),
`docs/guide/02-concepts.md` (architecture), `docs/guide/12-development.md` (code map) and
`SECURITY.md`. The parity status vs APEX 26.1 is in `docs/apex-feature-parity.md`.

## Conventions (agreed with the project owner)

- Act as **product owner**: prioritise APEX parity, keep the parity matrix and CHANGELOG current.
- **Branch per sprint** (`sprint-3`, `sprint-4`, …), logical commits, push the branch; the owner merges.
  Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never edit a released migration**: add `db/migrations/NNN_*.sql`. (003 is not released yet.)
- Everything that takes input or touches authorization needs a test in `test/security.test.ts`;
  every UI change must pass `npm run test:e2e` (phone 390 / tablet 768+1024 / desktop 1440).
- Docs are part of done: update the relevant `docs/guide/*` chapter.

## Environment notes

- Dev database: Docker container `pgapex-db`, port **5434** (5433 is another project on this machine).
  App on port **3100**. `.env` from `.env.example`.
- `npm run setup` / `npm run db:reset` install **pgapex only** (migrations); `npm run example:hr` adds the HR example
  (`examples/hr/`), which `npm test` / `npm run test:e2e` install first (pretest). `npm run dev`.
- **Principle (owner, 2026-10-01): pgapex is a framework; HR is only an example on top of it.** Nothing in `src/`
  or `db/migrations/` may depend on HR; builder defaults and help texts use neutral examples.
- Tests: `npm test` (needs the DB), `npm run test:e2e` (needs `npx playwright install chromium`).
- Stop the dev server with `kill $(lsof -t -iTCP:3100 -sTCP:LISTEN)`. **Don't** use `pkill -f server.ts`:
  the pattern matches the calling shell itself.
- GitHub: `git@github.com:NickVrgr/Postgresql_APEX.git` (SSH push works). The local `gh` CLI is
  logged in as an account without access to this repo: give the owner compare URLs instead of
  opening PRs.
- The example app `examples/tasks-app.sql` (ann / ann-password) may be installed in the dev DB.
- Demo LDAP: `docker compose --profile ldap up -d ldap` on port **3890** (3389 clashes with Windows RDP under WSL).
  The dev Keycloak has a SAML client; `examples/keycloak-saml.sql` registers it (reads Keycloak's certificate).
- The dev DB loads `pg_stat_statements` (set with `ALTER SYSTEM` on 2026-10-01; `docker-compose.yml`
  passes it for new containers). `plpgsql_check` is not in the `postgres:17` image.

## Branch state

| Branch | Status |
|---|---|
| `main` | Everything up to sprint 25, released as **v0.17.1** (tags: v0.2.0, v0.6.0–v0.17.1; 0.3.0–0.5.0 were never tagged). Migrations 001–028 are released |
| (sprint branches) | `sprint-17` … `sprint-24` (and sprint 23's five `sprint-23-*` work branches) were merged (v0.11.0–v0.17.0) and deleted |
| (older sprint branches) | `sprint-14` … `sprint-16` were merged (v0.10.0) and deleted |
| (older sprint branches) | `sprint-11` … `sprint-13` were merged (v0.9.0) and deleted |
| (older sprint branches) | `sprint-7` … `sprint-10` were merged and deleted |

Older sprint branches were merged and deleted.

## Sprint 4 goal (owner's order)

1. **A: user directory** (APEX-style workspace accounts with per-app roles)
2. **B: single sign-on** with OpenID Connect
3. **C: PostgREST alongside pgapex** (not inside it)

### A: user directory (in progress)

Design (implemented in `db/migrations/003_user_directory.sql`, applied to the dev DB):

- `meta.account`: one row per person (`username` unique case-insensitively, `display_name`,
  `email`, `password_hash` **nullable** = SSO-only, `active`, `last_login_at`).
- `meta.app_access (app_id, account_id, roles text[])`: per-app access and roles.
- `meta.app.access_control`: `'assigned'` (default: only accounts with an app_access row may sign
  in) or `'any_user'` (any active account). Mirrors APEX "Application Access Control".
- `meta.session.roles`: roles are resolved **at sign-in** and stored on the session.
  `meta.has_role()` now reads the session's roles. SSO (step B) adds group-mapped roles the same way.
- Old `meta.app_user` table → migrated, then **replaced by a writable view** with an INSTEAD OF
  trigger (`meta.app_user_write`), so old scripts/seeds (`db/seed/hr.sql`,
  `examples/tasks-app.sql`, tests) keep working. Duplicate usernames across apps are split
  (`name@alias`) rather than merged, for safety.
- `meta.authenticate(app, user, pw)`: returns NULL when the account has no access (same as a wrong
  password; bcrypt always runs). `meta.account_roles(app, user)`: roles from app_access.
- The runtime role may read `meta.account` **without** `password_hash`, and `meta.app_access`.

Status: **done** (commit "feat(users): …" on `sprint-4`). Migration 003, runtime
(`completeLogin()`, session roles), builder **Users** pages (`src/builder/users.ts`) and
**Access control** in Shared Components (`src/builder/routes.ts`), create-app first user reuses
existing accounts, 4 new tests (37 total), e2e covers `/builder/users` and an account page, docs
(chapters 3, 8, 9, 10, 11), parity matrix and CHANGELOG updated. `npm run db:reset && npm test && npm run test:e2e` green.

### B: single sign-on (OpenID Connect): done

Done (WIP commit on `sprint-4`):
- [x] `db/migrations/004_sso.sql`: `meta.auth_provider`, `meta.account_identity` (link by provider + `sub`),
      `app.sso_providers` / `app.local_login`, `meta.app_group_role`, `meta.sso_pending`; export/import include group roles
- [x] `src/sso.ts` (uses `jose`): discovery + JWKS cache, `startSignIn` (state, nonce, PKCE, browser cookie hash),
      `finishSignIn` (token exchange with client_secret_basic/post, ID token verification, nonce, claims),
      `resolveAccount` (link by sub; link existing account by username only if it has no identity at
      that provider; `auto_create`), `ssoAccess` (access row / any_user / mapped groups → roles)
- [x] Routes in `src/runtime/routes.ts`: `GET /a/:alias/sso/:provider`, `GET /sso/callback/:provider`
      (cookie `pgapex_sso`, path /sso); the login page shows provider buttons; password form only if `local_login`
- [x] `PUBLIC_URL` env var (redirect URI = PUBLIC_URL + /sso/callback/<name>)

To do:
- [x] Builder: `/builder/users/providers` (CRUD, write-only secret, redirect URI, "Test discovery");
      per app: sign-in methods in Settings, group → role mapping in Access control
- [x] `test/sso.test.ts`: 9 tests with an in-process mock IdP (tests now run with `--test-concurrency=1`; 46 total, green)
- [x] Keycloak demo: `docker compose --profile sso up -d keycloak` (port 8180, realm import in
      `docker/keycloak/`), `examples/keycloak-sso.sql`; verified in a real browser (carol auto-created
      with the manager role via the hr-managers group; king linked, admin)
- [x] Docs (chapters 1, 3, 8, 9, 11), SECURITY.md, parity matrix, CHANGELOG, .env.example (`PUBLIC_URL`)

Original design notes:

- Table `meta.auth_provider`: `name` (unique), `display_name`, `issuer`, `client_id`,
  `client_secret` (owner-only; the runtime must not read it, so load providers through the
  **owner** pool in Node), `scopes` (default `openid profile email`), `username_claim` (default
  `preferred_username`), `groups_claim` (default `groups`), `auto_create` (just-in-time accounts),
  `enabled`.
- Per app: `sso_providers text[]` (buttons on the login page), `local_login boolean` (show the
  password form). Group → role mapping per app: `meta.app_group_role (app_id, provider, group_name, role)`.
- Flow: `GET /a/:alias/sso/:provider` → authorization-code flow with **PKCE (S256)**, `state` and
  `nonce` stored in a short-lived table (`meta.sso_pending`: state PK, app_id, provider,
  code_verifier, nonce, next, created_at; delete on use and after 10 minutes). Callback
  `GET /sso/callback/:provider` (redirect URI = `PUBLIC_URL` + path; add a `PUBLIC_URL` env var) →
  exchange the code → verify the ID token with the provider's JWKS (library: `jose`): `iss`,
  `aud`, `exp`, `nonce`, algorithm allow-list → find the account by username claim (or create it
  if `auto_create`) → access = app_access row OR mapped group roles OR `any_user` → `completeLogin(..., { extraRoles })`.
- Builder: an "Identity providers" page (instance level) and per-app SSO settings + group mapping.
- Tests: a **mock OIDC provider** inside the test (Fastify with discovery, JWKS, authorize, token;
  sign with `jose`) covering success, bad state, bad nonce, wrong audience, expired token, no access.
  Optionally a `docker compose --profile sso` Keycloak with a realm import for manual demos.
- Cross-app SSO comes from the identity provider's own session (signing in to app B through the IdP is silent).

### C: PostgREST alongside pgapex: done

Done (WIP commit on `sprint-4`, verified manually with curl against a running PostgREST):
- [x] `db/migrations/005_api.sql`: roles `pgapex_authenticator` (login) and `pgapex_anon`; `meta.app.api_role`;
      `meta.jwt_claims()`; `meta.app_user()`, `meta.app_id()` and `meta.has_role()` fall back to PostgREST JWT claims
      (`app_user`/`preferred_username`/`email`/`sub`, `app`, `roles`)
- [x] `db/seed/hr_03_api.sql`: role `hr_api`, schema `api` (security_invoker views `employees` without salary,
      `leave_requests`, `my_notifications`; RPC `request_leave`, `decide_leave`)
- [x] `docker-compose.yml`: `postgrest` service (profile `api`, port 3000, `PGRST_JWT_SECRET=${API_JWT_SECRET}`);
      `.env.example`: `API_URL`, `API_JWT_SECRET`
- [x] `src/api.ts`: `issueApiToken(appId, username, hours)` (HS256 via jose; checks active + access). Tokens carry **no roles**
      claim: `has_role()` reads them live. `apiRoleProblem()` refuses superuser/BYPASSRLS/pgapex roles as API roles
- [x] `meta.api_check()` (in 005) = PostgREST `db-pre-request`: token's `app` must use the switched role as api_role; account
      must exist, be active and have access (PT401/PT403). Deactivation/revocation stops tokens immediately
- [x] `hr_api` gets column grants on `hr.emp` (no `sal`/`comm`)
- Verified: Allen's token sees only his own leave; Blake sees his team; Allen can't approve his own request (P0001);
  Blake approves (204) → trigger notifies Allen; the audit log records the API user; base tables and salary are not
  exposed; forged tokens are rejected.

Also done:
- [x] Builder: per-app "REST API" page (api_role, API_URL, issue a token for an account with a TTL, curl examples)
- [x] Tests (`test/api.test.ts`, 12): always-on SQL tests (as `hr_api` with `set_config('request.jwt.claims', …)`: app_user, has_role, RLS), plus
      HTTP tests that skip when PostgREST at API_URL isn't reachable (send `notify pgrst, 'reload schema'` first);
      optionally a PostgREST service container in CI
- [x] Docs: new chapter `docs/guide/13-rest-api.md` (setup, the api-schema pattern, tokens: pgapex-issued vs identity
      provider JWKS + role claim, security notes, change the authenticator password); update chapter 11
      (ORDS vs PostgREST, "on the roadmap" → done), chapter 1 config, the docs index, parity matrix ("RESTful services"), CHANGELOG
- [x] Full verification: `npm run db:reset && npm test` (58 green, HTTP tests ran) `&& npm run test:e2e` (16 green); version 0.4.0

Open / next sprint candidates:
- Identity-provider tokens straight into PostgREST (JWKS + `role`/`app` claim mappers) are documented but not tested.
- CI: no PostgREST service container yet, so the HTTP tests skip there.
- Tag `v0.4.0` after the owner merges.

Original design notes:

- `docker-compose.yml`: a `postgrest` service under `profiles: [api]`, with the authenticator
  role (login, noinherit), `web_anon` (no rights) and `db-schemas: api`.
- Make `meta.app_user()` fall back to the JWT claims PostgREST sets
  (`current_setting('request.jwt.claims', true)::jsonb`): `app_user` → `preferred_username` →
  `email` → `sub`. Make `meta.has_role()` fall back to claims `roles` (or `realm_access.roles`),
  plus `meta.account_roles(<app from claim "app">, user)`. So **one set of RLS policies** covers UI and API.
- HR example: an `api` schema with views over `hr.*` and RPC functions (e.g.
  `api.request_leave`, `api.decide_leave` wrapping `hr.*`), and a role `hr_api` granted on `api` only.
- Tokens: for development, a SQL function `meta.api_token(app, user, ttl)` that signs an HS256
  JWT with a secret shared with PostgREST (stored in `meta.instance_setting`, owner-only); for
  production, tokens from the IdP (step B) with a `role` claim.
- Builder: per-app "REST API" page (PostgREST URL, how to get a token, example curl).
- Docs: replace the "on the roadmap" note in `docs/guide/11-from-apex.md#ords-and-postgrest` with a
  real chapter; the parity matrix row "RESTful services".
- Tests: run PostgREST in CI (a service container) or skip when not reachable; check that allen via
  the API sees only his own leave requests.

## Sprint 5 (owner's choice: 1 accounts, 3 theme switch, 4 translations and e-mail; 2 "sign in once / app launcher" skipped, sign-in stays per app as in APEX)

Done:
- `db/migrations/006_accounts.sql`: `must_change_password`, `password_changed_at`, `theme_pref`, `language` on `meta.account`;
  `meta.setting` (password_min_length, password_require_mixed, password_lifetime_days); `meta.change_password`,
  `set_password` / `expire_password` / `unexpire_password` (owner only), `password_days_left`; forgot password:
  `meta.password_reset` (sha256 tokens), `start_/check_/finish_password_reset`, `meta.app.password_reset`
- `007_i18n.sql`: `meta.app.language/languages/language_from/date_format/timestamp_format`, `meta.text_message`,
  `meta.translation` (source text → target per language), `meta.message()`, `meta.app_language()`, export/import
- `008_mail.sql`: `meta.mail_queue`, `mail_attachment`, `email_template`, `send_mail`, `send_mail_template`,
  `add_attachment`, process type `send_email` (+ `meta.process.config`); export/import wrap the 007 versions (`*_base`)
- Runtime: `src/runtime/locale.ts` (language + theme per request, cached texts), `src/i18n.ts` (en + nl, all pgapex texts),
  `src/runtime/format.ts` (date masks), `src/runtime/account.ts` (My account, forgot/reset), expired-password step at sign-in
  (`POST /a/:alias/password`), theme switch in the user menu, `src/mail.ts` (nodemailer 10, NOTIFY + polling, retries)
- Builder: Users → account settings / expire / unlock / first-use; Settings → forgot password, theme style, users may choose,
  globalization; Shared Components → Globalization (`src/builder/globalization.ts`, XLIFF/CSV) and E-mail templates; Builder → Mail
- HR sample `db/seed/hr_04_i18n_mail.sql`: Dutch, text messages on the dashboard, e-mail on leave decisions, reset enabled
- Tests: `test/accounts.test.ts`, `test/mail.test.ts`, `test/i18n.test.ts`, sprint-5 block in `security.test.ts` (95 total),
  e2e covers account/forgot/Dutch/dark and the new builder pages (20). Docs: chapter 14, chapters 1/3/8/9/11/12, parity, SECURITY, CHANGELOG
- Dev: Mailpit `docker compose --profile mail up -d mailpit` (UI :8025); the local `.env` has SMTP_HOST=127.0.0.1, SMTP_PORT=1025

Open / candidates for sprint 6:
- More built-in languages (de, fr, …) for `src/i18n.ts`; number masks; time zones (APEX automatic time zone)
- The builder itself is English only and follows the OS for dark mode (no switch there)
- Chart data tables show raw column names as headings
- CI has no PostgREST or Mailpit service (the HTTP API tests skip; mail tests use a fake transport)
- File upload items (top of the roadmap), then automations on pg_cron

## Sprint 6 (owner's request, 2026-09-30)

1. **Remove e-mail entirely**, including forgot password. Owner: "not happy with the mailing part".
   Note for future work: APEX *does* have `APEX_MAIL`; the owner still chose to leave mail out. Don't
   re-add mail features; point to `pg_smtp_client` or an external service instead.
   - `008_mail.sql` and the reset part of `006` were deleted (both unreleased). **`008_drop_mail.sql`**
     idempotently removes the objects from databases that ran the development builds, unwraps
     `export_app`/`import_app`, drops the sample's mail trigger, and renames the seed record
     `hr_04_i18n_mail.sql` → `hr_04_i18n.sql`.
   - Code, builder (Mail page, e-mail templates, Send e-mail process, forgot-password setting), i18n texts,
     `nodemailer`, Mailpit, SMTP settings, tests and docs removed. Chapter 14 is now *Globalization*.
2. **Extensions**: `docs/guide/15-extensions.md` (tiers, APEX mapping, security notes, integration ideas);
   `test/extensions.test.ts` proves btree_gist/pg_trgm/unaccent/citext examples; `23P01` now has a friendly message.
3. **APEX 26.1 re-review**: `docs/apex-feature-parity.md` rewritten (116 rows: 43 ✅, 30 🟡, 37 ❌, 6 ➖),
   with a new roadmap: file upload → automations on pg_cron → IR power features → stricter CSP (styles) → builder quality.

Verification: `npm run db:reset && npm test && npm run test:e2e` (see the commit message for counts).

## Sprint 7 (owner's request, 2026-09-30)

Order: 1 role suggestions under roles fields, 2 file upload items, 3 data loading (CSV/XLSX into
a table), 4 printing (PDF). Migrations 001–008 are released (v0.6.0): add 009+.

1. **Role suggestions: done** (`roleHints()` / `roleHintsHtml()` in `src/builder/users.ts`, used on
   the account page and the app's Access control; chip click handler in `public/app.js`).
2. **File upload items: done** (`db/migrations/009_files.sql`, `src/runtime/files.ts`,
   `test/files.test.ts`, HR seed `hr_05_files.sql` = employee photo).
   - Item value = temp file uuid (`meta.temp_file`, readable only via the session-scoped view
     `meta.temp_files`); uploads are committed in their own transaction so they survive errors.
   - Form DML writes `source_column` + `config.filename_column` / `mime_column`; value `REMOVE`
     clears them. `fetchForms` never loads bytes; the item queries size/name when rendering.
   - Downloads: `GET /a/:alias/:page/file/:item?k=<pk|temp:uuid>&cs=` (checksum over
     `__FILE`/`__KEY`), page access checked, app role, attachment unless `inline=1` and safe type.
3. **Data loading: done.** `src/dataload.ts` (parser, inference, batched `loadRows` with a
   row-by-row retry to find bad rows; `LoadFailed` = roll back), builder `src/builder/dataload.ts`
   (SQL Workshop → Load Data; the file is a `meta.temp_file` of the builder session between
   steps), process type `data_load` (migration `010_data_load.sql` adds nullable
   `meta.process.config`; engine `dataLoad()`), HR page 13 (seed `hr_06_data_load.sql`),
   `public/samples/employees.csv`, `test/fixtures/employees.xlsx` (hand-built xlsx),
   `test/dataload.test.ts`.
4. **Printing: done.** `src/runtime/pdf.ts` (pdfkit, `autoFirstPage: false` so the orientation
   is chosen after measuring columns; footer written with bottom margin 0), `r<id>_pdf=1` in the
   page GET handler next to CSV, Actions menu Download PDF + Print (`data-print` in app.js),
   `@media print` in app.css, `test/printing.test.ts` (inflates content streams to read text).
5. **Docs: done.** Guide chapter 16, parity (43 ✅ / 33 🟡 / 34 ❌ / 6 ➖), CHANGELOG [Unreleased].

Verified: `npm test` 114/114 and `npm run test:e2e` 20/20 on the dev DB; a fresh install
(throwaway postgres:17 container) applies 001–010 and seeds 01–06 cleanly.

Ideas for next: document templates (HTML → PDF), several files per item / drag-and-drop,
JSON in data loading, automations on pg_cron (roadmap item 1).


## Sprint 8 (owner's request, 2026-09-30)

The owner asked: (a) REST API tokens without rotating them by hand, (b) whether uploaded files
reach PL/pgSQL code, (c) an equivalent of ORDS `oauth.create_client`, (d) adjustable PDF
layouts, (e) XLSX and CSV import/export. Migrations 001–010 come from sprints ≤7; add 013+.

1. **OAuth clients: done** (a + c; commit "feat(api): OAuth clients…"). Migration `011_oauth.sql`
   (`meta.api_client`, `oauth_create_client/rotate_secret/revoke_client/grant_role/revoke_role`),
   `src/oauth.ts` (`POST /oauth/token`, client credentials), builder REST API page section,
   `test/oauth.test.ts`, chapter 13.
2. **Files in PL/pgSQL** (b): nothing new needed. Sprint 7 already covers it: a file item without a
   source column puts the upload in `meta.temp_files` (like `APEX_APPLICATION_TEMP_FILES`), which
   processes read (`select content from meta.temp_files where id = :P5_FILE::uuid`); chapter 16.
3. **Excel download: done** (e). `src/xlsx.ts` (own writer on `fflate`, now a direct dependency;
   typed cells, inline strings so no formulas), `reportXlsx()` in `src/runtime/report.ts`,
   `r<id>_xlsx=1` next to CSV/PDF in `src/runtime/routes.ts`. Import (CSV/TSV/XLSX) was sprint 7.
4. **Report layouts: done** (d). Migration `012_report_layouts.sql` (`meta.report_layout`, one
   default per app via trigger, export/import wrap `export_app_base`/`import_app_base`, logo as
   base64). `src/runtime/pdf.ts` is now `layoutFor()` + pure `tablePdf()` + `layoutPreview()`;
   region config `pdf.layout/columns/widths(mm)/align`. Builder: generic component spec in
   `components.ts` (new field kinds `textarea`, `color`) + `src/builder/layouts.ts` (logo upload,
   magic-byte check, preview). HR seed `hr_07_layouts.sql` (Directory, page 11).
5. **Tests/docs: done.** `test/layouts.test.ts` (10), e2e covers the layout editor. Chapter 16,
   chapter 12 code map, parity matrix, CHANGELOG.

Verified: `npm test` 132/132, `npm run test:e2e` 20/20, fresh install (postgres:17) applies
001–012 and seeds 01–07.

Ideas for next: document templates (letters/invoices; HTML or a JSON layout → PDF), per-user
column choice for PDFs, a PL/pgSQL API to parse CSV/XLSX from `meta.temp_files` (APEX_DATA_PARSER),
automations on pg_cron (roadmap item 1).

## Sprint 9: hardening (owner's request, 2026-09-30)

After the review "is this a stable basis?": harden first, then features. Migrations 001–012 are
released (v0.7.0).

1. **Release 0.7.0** on `main` (tag `v0.7.0`), after fixing CI: it had been red since sprint 4
   because `API_JWT_SECRET` wasn't set there (commit "ci: set a test-only API_JWT_SECRET").
2. **Export/import consolidated**: `013_export_format.sql` replaces the `export_app_base` /
   `import_app_base` wrapper chain with one pair; format `pgapex/2` documented in chapter 3 with a
   compatibility promise. `test/export.test.ts` round-trips the HR app and fails when a new table
   referencing `meta.app`/`meta.page` is neither exported nor listed in `NOT_EXPORTED`.
   Rule: a later migration that adds a section redefines both functions with `create or replace`.
3. **Upgrade test**: `scripts/migrate.ts --root <dir>`; CI job `upgrade` installs v0.6.0 and v0.7.0
   (git archive of `db/`) with sample data, upgrades and runs `npm test`. Add each new tag to its matrix.
4. **Builder split**: `routes.ts` → `routes.ts`, `forms.ts`, `shared.ts`, `designer.ts`, `sql.ts`.
5. **Not done (needs the owner):** protect `main` on GitHub (Settings → Branches: require the `test`,
   `e2e` and `upgrade` checks). The local `gh` has no access.

## Sprint 10: features (owner's request, 2026-09-30)

1. **Interactive report power features** (`014_saved_reports.sql`): control break (`r<id>_b`),
   aggregates (`r<id>_a=fn|col`, totals + subtotals, separate queries over all filtered rows),
   highlights (`r<id>_h=col|op|color|value`, evaluated in SQL as `__h<n>` columns, CSS classes
   `hl-*`), saved reports (`meta.saved_report` via view `meta.saved_reports` and security definer
   `save_report` / `delete_saved_report`; POST `/a/:alias/:page/report/:id/save` and
   `…/saved/:sid/delete`; public ones need the region's `public_reports` scheme). `test/reports.test.ts`.
2. **Automations** (`015_automations.sql`, `src/automations.ts`, `src/builder/automations.ts`):
   cron + time zone, optional per-row query, roles read live by `meta.has_role()` via
   `pgapex.automation_id`, one transaction as the app's `db_role`, log (last 100). The scheduler
   runs in the server (`startScheduler()` in `server.ts`; not in tests), claims with `SKIP LOCKED`,
   advisory lock per run. Imported copies are disabled. HR seed `hr_08_automations.sql`.
   Binds aren't replaced inside `$$` blocks (the scanner skips strings). `test/automations.test.ts`.
3. **Report settings form** (`src/builder/report-settings.ts`) under report regions in the page
   designer; `mergeReportSettings()` keeps unknown keys and leaves defaults out. `test/report-settings.test.ts`.
   Generic additions: component field kinds `list` (text[]) and a `validate` hook on specs.

Verified: `npm test` 162/162, `npm run test:e2e` 20/20; a clean-environment run and the v0.6.0
upgrade path (see the commit/notes).

Ideas for next: settings forms for grid/chart/cards/calendar/facets; pivot/group-by in reports;
per-row error handling and on-demand runs (`meta.run_automation()`) for automations; document
templates; approvals/workflow.

## Sprint 11 (owner said "proceed" with the roadmap, 2026-10-01)

Order from the roadmap: 1 settings forms for the other region types, then IR power features (group by,
pivot, chart view, computed columns, row selection), stricter CSP, builder quality.

1. **Region settings forms: done.** `src/builder/region-settings.ts`: forms for grid, chart, cards,
   calendar and facets under the region in the page designer (`regionSettingsForm()` dispatches,
   report regions still go to `report-settings.ts`); one route `POST /builder/pages/:pid/region/:rid/settings`.
   Pure `merge*Settings()` per type (defaults left out, unknown keys kept, per-column grid keys kept);
   links only to pages of the app, LOVs only shared LOVs of the app (an existing custom LOV string
   survives), facets only to report regions on the same page. `parseLinkItems`/`linkItemsText` moved to
   `report-settings.ts`. `test/region-settings.test.ts` (9); e2e covers each region type's designer page.
   Docs: chapter 3, chapter 12 code map, parity matrix (roadmap item removed), CHANGELOG.

2. **IR power features: done.** `src/runtime/compute.ts` (tokenizer + recursive-descent parser for
   computed column expressions → SQL with quoted identifiers, literals, whitelisted functions;
   `/` is numeric with `nullif(…, 0)`), `src/runtime/report-views.ts` (group by, pivot via
   `fn(case when … then value end)`, chart view through `renderChartBody`). `report.ts`: new state
   `r<id>_c` (name|expr), `_v` (view), `_g`/`_ga`, `_pv`, `_ch`; form fields `_cn/_ce`, `_gb1-3/_gbf/_gbc`,
   `_pr/_pp/_pf/_pc`, `_ck/_cl/_cf/_cv` are folded in `normaliseReportParams()`; `filtered()` adds
   computed columns (`withComputations`) and returns a name → type map. Row selection: region config
   `selection {column, item}`, `selectionOf()`; `computeVisibility()` makes that item editable and
   `applyPostedItems()` joins its values with ':'. Select-all JS in `public/app.js`; on phones the
   header cell stays visible. Report settings form has a Row selection fieldset.
   Tests: `test/report-views.test.ts` (12), sprint-11 block in `security.test.ts` (3), report settings
   (+1), e2e covers compute/group/pivot/chart/selection at all viewports. `Browser` in
   `test/helpers.ts` can post arrays (repeated fields). Docs: chapter 4 (computed columns, row
   selection), chapter 3, 12, parity, CHANGELOG.

Not released yet (no tag): CHANGELOG entries are under [Unreleased].

Next on the roadmap: stricter CSP (inline `style` on chart bars), builder quality (top SQL, plpgsql_check,
search / where used), LDAP/SAML.

## Sprint 12 (owner: "please continue", 2026-10-01)

Branch `sprint-12` from `main` (which has sprint 11, unreleased).

1. **CSP without `unsafe-inline`: done.** `style-src 'self' 'nonce-…'`: `securityHeaders()` sets
   `req.cspNonce` in an onRequest hook and uses it in the header. `src/css.ts` `PageCss.cls(decl)` →
   hash-named class; `ctx.css` / `ctx.nonce` on PageContext; `pageStyle(ctx)` in render.ts emits the
   one `<style nonce id="pgapex-css">` (theme colours + rules), always present. Charts take the sheet
   as a parameter (`renderChartBody(…, ctx.css, lang, t)`). Dynamic action `refresh_region` returns
   `css`; app.js `insertRule`s it. Builder: 55 `style=""` → `u-*` utility classes (`!important`, as
   inline styles had precedence) and `.app-color-N`. Developer HTML with `style=` is now ignored by
   browsers (upgrade note in CHANGELOG, SECURITY.md, chapter 4).
   Tests: sprint-12 block in `security.test.ts` (3: no style attributes on any HR/builder page,
   nonce per response, classes can't break out of a rule); e2e records `securitypolicyviolation`
   events in every page check (verified it fails when a `style=` is reintroduced) and a new test
   refreshes a chart region through a dynamic action.
   Also fixed: chart legend swatches were grey (sprint 10's `.swatch` rule; now `.chip .swatch`).

Verified: `npm test` 190/190, `npm run test:e2e` 24/24.

## Sprint 13: builder quality (owner: "yes please proceed", 2026-10-01)

Branch `sprint-13` from `main` (sprints 11 and 12 merged, unreleased). Migrations 001–015 are released; 016 is new.

1. **Search and "Used in": done.** `src/builder/search.ts`: `appEntries()` turns pages and every
   COMPONENTS row into entries with their text fields; `search()`; `whereUsed()` for items (whole
   words), `LOV:NAME`, authorization fields / `public_reports`, pages (page fields, `"page": n`,
   `page_url(n`), report layouts. Route `/builder/apps/:id/search`; `usedInPanel()` in the designer
   (items, page) and Shared Components (app items, LOVs, schemes, layouts). New icons `search`, `alert`.
2. **Advisor: done.** `src/builder/advisor.ts`: per component kind, which fields hold SQL and their
   shape (select / boolean / statements / regex); EXPLAIN as the app role in one rolled-back
   transaction (savepoint per check, 5 s timeout); DO blocks → `create function pg_temp…`;
   unplannable statements → notes. Reference checks; `plpgsql_check_function_tb` over the app role's
   schemas when the extension exists. `splitStatements()` in `src/binds.ts` (shares `skipQuoted()`
   with the bind scanner). Route `/builder/apps/:id/advisor`.
3. **Top SQL: done.** `src/builder/top-sql.ts` (`topSql(role, sort)`, reset per role), link on the
   Activity page; migration `016_top_sql.sql` creates the extension when available and allowed.
   CI test job: `ALTER SYSTEM` + `docker restart` of the service container.
4. Tests: `test/builder-quality.test.ts` (8; a scratch page 99 with planted mistakes), splitStatements
   in `binds.test.ts`, sprint-13 block in `security.test.ts`; e2e covers search, advisor, top SQL and a
   "Used in" page. Docs: chapter 3 (Search and "Used in", Advisor, Top SQL), 12, parity
   (47 ✅ / 31 🟡 / 32 ❌ / 6 ➖), CHANGELOG.

Verified: `npm test` 200/200 (dev DB), fresh postgres:17 install 196 + 4 skipped (Top SQL, PostgREST),
`npm run test:e2e` 24/24.

Next on the roadmap: LDAP and SAML authentication, "remember me"; then document printing.

## Sprint 14: authentication (owner: "yes please proceed", 2026-10-01)

Branch `sprint-14` from `main` (v0.9.0). Migrations 001–016 are released; 017–019 are new.

1. **Keep me signed in: done.** `017_remember_me.sql` (`meta.app.remember_me_days`, `meta.persistent_login`
   owner-only, triggers revoke on new password / deactivation / removed access), `src/remember.ts`
   (issue, use = delete-and-return then re-issue with the same expiry, forget, count). `completeLogin()` is
   now `signIn()` + redirect; `loadContext()` restores a remembered browser. My account → Sign out on all
   devices. `test/remember.test.ts` (7).
2. **LDAP: done.** `018_ldap.sql` (`meta.ldap_directory`, `meta.ldap_identity`, `meta.app.ldap_directories`),
   `src/ldap.ts` (ldapts; only pass tlsOptions for ldaps://, it switches to TLS otherwise), login POST tries
   directories after local accounts; builder `src/builder/ldap.ts`; compose profile `ldap` (osixia/openldap,
   seed `docker/ldap/50-pgapex.ldif`); CI service `ldap`. `test/ldap.test.ts` (8; adds its own entries, skips
   without a server; clears login failures so the throttle doesn't trip).
3. **SAML: done.** `019_saml.sql` (auth_provider.protocol/idp_sso_url/idp_cert, `meta.saml_request`),
   `src/saml.ts` (@node-saml/node-saml 5; CacheProvider on meta.saml_request, values must be ISO dates; the
   assertion issuer is checked by us: node-saml only checks it for logout messages), routes: ACS relay page
   (`data-autosubmit`, app.js) → `/finish` with the Lax cookie; `/metadata`. Builder provider form has a
   protocol and SAML fields. `test/saml.test.ts` (6; mock IdP with openssl keys + xml-crypto signatures;
   every refusal asserts its reason). Verified against the real Keycloak in a browser (carol → manager).

Verified: `npm test` 221/221, `npm run test:e2e` 24/24. One earlier full run had a single failure in
`security.test.ts` "accounts lock after repeated failures" (message not captured); it didn't come back in
2 more full runs and 6 single runs. If it shows up again, capture the assertion (suspects: the per-IP
throttle shared by all tests from 127.0.0.1, or a dev server on the same database).

Next on the roadmap: document printing (templates → PDF), approvals / workflow.

## Sprint 15: document printing (owner: "yes, continue", 2026-10-01)

Branch `sprint-15` from `main` (sprint 14 merged). Migration 020 is new.

1. **Document templates: done.** `020_documents.sql` (`meta.document_template`, `meta.button.document`,
   action 'document'; export/import redefined with a `document_templates` section). `src/runtime/document.ts`:
   tag language (tokenize/parse/render, values always escaped, filters), tolerant HTML-subset parser, and
   `documentPdf()` (pdfkit: runs with continued text, lists, tables with % / mm widths, colspan, repeated
   header rows, page breaks, logo/data: images, footer with page numbers). `src/runtime/documents.ts`:
   `?doc=NAME` in the page GET (template read via the runtime pool: the page transaction already runs as
   the app role). Builder: component spec (validate = templateProblem), preview route
   `src/builder/documents.ts`, "Used in" for templates, Advisor checks. HR seed `hr_09_documents.sql`
   (EMPLOYEE_SHEET + Print button on page 3; P13_FILE accepts .json). `test/documents.test.ts` (10);
   `pdfText()` moved to `test/helpers.ts`.
2. **JSON in data loading: done.** `parseJson()` in `src/dataload.ts` (array, wrapper object, JSON Lines;
   detected by extension or content).

Verified: `npm test` 234/234, `npm run test:e2e` 24/24; employee sheet and a 4-page invoice checked visually.

Next on the roadmap: approvals / workflow.

## Sprint 16: approvals, and pgapex as a framework (owner: "yes," 2026-10-01)

Branch `sprint-16` from `main` (sprint 15 merged). Migration 021 is new.

1. **Approvals and the task list: done.** `021_approvals.sql`: `meta.task_definition` (shared component),
   `meta.task`, `meta.task_event` (closed to app roles), `meta.task_rights(task)` (the one rights function),
   views `meta.tasks` / `meta.task_events`, API `create_task`, `claim/release/delegate/cancel_task`,
   `add_task_comment`, `complete_task` (returns the action SQL + binds), `close_tasks`; region type `tasks`;
   export section `task_definitions`. `src/runtime/tasks.ts`: region (detached forms per task) and
   `POST /a/:alias/tasks/:id` (the completion SQL runs as the app role in the same transaction). Error flash
   `__FLASH_ERROR` on pages. Builder: component spec, region settings (`mergeTasksSettings`), Advisor.
   HR example `hr_10_approvals.sql` (LEAVE_APPROVAL via triggers, page 14 *My tasks*). `test/approvals.test.ts` (6),
   sprint-16 block in `security.test.ts`.
2. **HR out of the framework: done** (owner's remark during the sprint). `db/seed/` → `examples/hr/` (+ README);
   `migrate.ts --example <name>`; `--seed` reads an old release's `db/seed/` or means `--example hr`; package
   scripts `setup`/`db:reset` framework-only, `example:hr`, `pretest`, `pretest:e2e`; CI upgrade job archives
   the whole release tree. Builder defaults/placeholders/help texts neutral; layout preview sample made up.
   Docs: README, chapter 1, CHANGELOG. Verified: framework-only fresh install (no apps, builder works), then
   `npm test` there installs the example (232 + 9 skipped for services that DB lacks); v0.9.0 → this upgrade.

Verified: `npm test` 241/241, `npm run test:e2e` 24/24 (dev DB).

Next on the roadmap: workflow (multi-step) on top of task definitions; map and tree regions.

## Sprint 17: workflows (owner: "keep going with the next sprints, don't ask my permission", 2026-10-01)

Branch `sprint-17` from `main` (v0.10.0). Migration 022 is new. The owner now wants sprints merged,
released and continued without asking.

1. **Workflows: done.** `022_workflows.sql` (`meta.workflow_definition` with steps jsonb, `meta.workflow` instances
   with a copy of the steps, `meta.workflow_event`, `meta.task.workflow_id`, views `meta.workflows`/`workflow_events`,
   `start_workflow`, `terminate_workflow`, `retry_workflow`, trigger `task_wakes_workflow`, region type `workflows`,
   export section). `src/workflow.ts`: `stepProblems`, `runWorkflow`/`runWorkflows` (one step per owner transaction;
   app SQL after `set local role`, bookkeeping after `reset role`; don't reset after an error: it masks it),
   `startWorkflowRunner` (LISTEN pgapex_workflow + interval; started in server.ts), `workflowDiagram` (inline SVG,
   CSS classes only). `src/runtime/workflows.ts` console + `POST /a/:alias/workflows/:id`. Builder spec + extras
   (`src/builder/workflows.ts`), region settings, Advisor checks step SQL. HR example `hr_11_workflows.sql`
   (ONBOARDING from the employee form's CREATE). `test/workflows.test.ts` (7; `settle()` because a running
   `npm run dev` shares the database and its runner takes steps too), sprint-17 block in `security.test.ts`.
2. **REST API check** (owner asked to double-check the "secure REST APIs" request): already covered by PostgREST,
   tokens and OAuth clients; the gap is a builder for REST endpoints + OpenAPI, now roadmap item 2.
3. **Roadmap:** the owner prioritised a **Progressive Web App for field operations and logistics** next.

Verified: `npm test` 249/249, `npm run test:e2e` 24/24.

## Sprint 18: Progressive Web App for field work (owner's priority, 2026-10-01)

Branch `sprint-18`. Migration 023 is new.

1. **PWA: done.** `023_pwa.sql` (`meta.app.pwa`, `pwa_short_name`, `pwa_icon`, `pwa_offline_pages`, `pwa_offline_submit`;
   item type `location`). `src/runtime/pwa.ts`: manifest, `sw.js` (= `const PGAPEX = {base, offlinePages, offlineSubmit, version}` +
   `public/sw.js`), icons (own PNG encoder + 5×7 font letter tiles), offline page; `pwaHead`/`pwaBody` in render.ts and the
   login page. `public/sw.js`: static precache, network-first pages with an opt-in page cache (wiped on POST login/logout),
   offline fallback, **offline form queue** in IndexedDB (captured in the SW when a POST navigation fails; replay with a fresh
   CSRF token from a GET of the page, only for the user app.js reported; 303 = sent, 422 = invalid). `public/app.js`: SW
   registration, offline banner, queue panel, offline page list, location button, BarcodeDetector scan, photo downscale.
   Server: `__submit_id` per page form (session `__SUBMITS`, last 50) and signed form keys `__pk_<region>`/`__pkcs_<region>`
   (routes.ts POST). `Permissions-Policy` now `camera=(self), microphone=(), geolocation=(self)`. Builder: Settings →
   Progressive Web App (`src/builder/pwa.ts`, icon must be a square PNG ≥ 512). HR example `hr_12_pwa.sql` (PWA on,
   P3_WORK_LOCATION, camera photo). Tests: `test/pwa.test.ts` (6), `test/e2e/pwa.test.ts` (4, real Chromium: installability via
   CDP, offline pages, offline queue → sent once, geolocation, downscale), sprint-18 security block; `formFields()` in
   `test/helpers.ts` (posting a page form back as a browser would; a sloppy version blanked SCOTT's username once).
   New chapter 17.

Verified: `npm test` 256/256, `npm run test:e2e` 28/28.

Next on the roadmap: REST endpoints in the builder (with OpenAPI), then map and tree regions.

## Sprint 19: REST modules in the builder (owner: double-check the REST request, 2026-10-01)

Branch `sprint-19`. Migration 024 is new.

1. **REST modules: done.** `024_rest_modules.sql` (`meta.rest_module` with handlers jsonb; export section). `src/runtime/rest.ts`:
   `handlerProblems`, `matchHandler`, bearer tokens checked like `meta.api_check` (jose HS256, app claim, account active +
   access or client active), SQL in `runtime.tx` with `request.jwt.claims` set (so `meta.has_role()` works) and `set local role`
   to the app's db_role; collection/item/sql responses; OpenAPI 3 per module. Tokens and OAuth clients work without an API role
   now (no `role` claim). Builder spec + `src/builder/rest.ts` (endpoints, curl, OpenAPI link), Advisor checks handler SQL.
   HR example `hr_13_rest.sql` (`v1`). `test/rest.test.ts` (6), sprint-19 security block. Fix: `fieldset.prop-group { min-width: 0 }`
   (fieldsets were as wide as their widest unbreakable content: the e2e overflow check caught it on the module page).

Verified: `npm test` 263/263, `npm run test:e2e` 28/28.

Next on the roadmap: map and tree regions, more chart types, several files per upload item.

## Sprint 20: map and tree regions (roadmap item, 2026-10-01)

Branch `sprint-20`. Migration 025 is new.

1. `025_map_tree.sql`: region types `map` and `tree` (only the type check; config is jsonb). Applied to the dev DB.
2. **Map region**: `src/runtime/maps.ts` (`renderMap`: rows with `lat`/`lng` (or `latitude`/`longitude`, `lon`), or `location`
   text "lat,lng" like the `location` item type; `title`, `body`, `geojson`; config `link`, `height` small/medium/large, `zoom`, `empty`).
   It emits `<div data-map>` + `<script type="application/json" class="map-data">` (`<` escaped) + a `<details class="map-list">`
   list that works without script. `mapHead(ctx)` adds Leaflet CSS/JS (deferred) only on pages with a visible map region
   (wired into both heads in `render.ts`). Leaflet 1.9.4 (npm dependency, BSD-2) is served from `node_modules/leaflet/dist` at
   `/static/vendor/leaflet/` (second `fastifyStatic` in `app.ts`, `decorateReply: false`). `public/app.js` draws it (markers,
   GeoJSON, popups built with DOM, fitBounds). `src/maptiles.ts`: `MAP_TILE_URL` (default OpenStreetMap), `MAP_ATTRIBUTION`,
   `tileOrigin()` which `security.ts` adds to CSP `img-src`.
3. **Tree region**: `src/runtime/tree.ts` (`renderTree`: `id`, `parent_id`, `label`, optional `icon`; rows without a parent in the
   result are roots; cycles drawn once; `<details>`, `expanded` levels open (default 1); `link`). The label is a link inside
   `<summary>`; the rest of the row (e.g. `.tree-count`) toggles.
4. Builder: types in `components.ts` (with column help), settings forms + merges in `region-settings.ts` (map: height, zoom,
   empty, link; tree: expanded, empty, link), Advisor checks map/tree SQL as `select`. i18n `map.open`, `map.list`. CSS `.map*`, `.tree-view`.
5. HR example `examples/hr/hr_14_maps.sql`: `hr.dept.lat/lng` for the 4 cities; map "Where we work" on page 4 (offices +
   employees' `work_location`, links to page 5); tree "Organisation" on page 8 (links to page 3, a dialog; 2 levels open). Installed.
6. Tests: `test/maps.test.ts` (4) passes. `test/e2e/maps.test.ts`: the map test passes (Leaflet, tiles stubbed with
   `context.route` on the tile origin, markers, popup link, **no CSP violations**); the tree test opens a branch and a node's dialog
   (`dialog.t-dialog[open] iframe`: page 3 opens as a dialog).
7. Security tests (sprint-20 block: CSP `img-src` is exactly self, data: and the tile origin; a non-http `MAP_TILE_URL` adds
   nothing; labels and titles are escaped). Docs: chapter 4 (map, tree), chapter 12 code map, `.env.example`, SECURITY, parity
   (Tree ✅, Map 🟡: no vector tiles, heat maps or report filtering by map area), CHANGELOG.

Verified: `npm test` 269/269, `npm run test:e2e` 30/30; upgrade from v0.12.0 in a throwaway `postgres:17` container on port 5435
(`npm test` there passes, the PostgREST HTTP tests skipped with `API_URL=` as in CI); fresh framework-only install applies 001–025.

Next on the roadmap: more chart types, several files per upload item, workflow parallel branches/versions,
builder (drag-and-drop layout, code editor, CLI), template components and plug-ins, AI features.

## Sprint 21: more chart types, several files per upload item (roadmap item 1, 2026-10-01)

Branch `sprint-21` from `main` (v0.13.0). No migration (both features use jsonb config).

1. **Chart types** (`src/runtime/charts.ts`): `stacked` (negatives stack down), `combo` (first series as columns, the
   others as lines through the slot centres, shared `lineLayer`), `scatter` (numeric first column = x; `niceScale(min, max,
   zero = true)` got a third parameter), `pie` (`donut(…, pie)`). `REPORT_CHART_KINDS` (bar, column, line, area, donut, pie)
   limits the interactive report's chart view; region charts take all `CHART_KINDS`. i18n `chart.*`, `CHART_LABELS` in
   the builder, CSS. HR page **15 "Analytics"** (`hr_15_charts.sql`) has one of each.
2. **Several files per upload item** (`src/runtime/files.ts`): config `multiple: true`, `max_files` (≤ `MAX_FILES` = 10, a
   session keeps 20 temp files). `readMultipart` returns `lists` (all files per field) next to `files` (first per field,
   used by the builder uploads); `applyUploads` takes the lists. The value is `:`-separated temp ids (`tempIds()`).
   With `table` + `parent_column` (+ `key_column`, default `id`) in a form region (`childTable()`), `saveFileLists()`
   runs from `formDml` after insert/update (insert one row per temp file, delete ticked keys **only where
   parent_column = the record**) and before delete (all the record's files). `formDml` skips multiple items as columns.
   Remove boxes post `<ITEM>__REMOVE` = child key or `temp:<id>` (`removals()`, request-scoped from `ctx.body`); a ticked
   pending file is deleted at once. All-or-none per request: one refused file → none kept. Required = at least one
   file left. Downloads: key = child key (signed), read as the app role. Render: `fileListControl` in `items.ts`
   (`.file-list`, `.file-thumb`), `fileInput()` shared. `app.js` `max_px` now resizes every chosen file.
   HR: `hr_16_documents.sql` (`hr.emp_document` with RLS: own/team/admin; managers/admins insert/delete) and
   `P3_DOCUMENTS` (`wide`) on the employee form.
3. Tests: `test/charts.test.ts`, `report-views`, `region-settings`; `test/files.test.ts` "several files per upload item"
   (8); `test/security.test.ts` sprint-21 block (report chart kinds from the URL, chart labels escaped, multiple file
   item: posted ids and remove boxes can't reach other sessions/records; its `Browser` now posts arrays as repeated
   fields, `test/helpers.ts` `upload()` takes lists); e2e `responsive.test.ts` picks two files in the dialog at all
   four sizes (page 15 was already covered by the all-pages loop).
4. Docs: chapter 4 (chart kinds, query shapes), chapter 16 (several files), parity (Charts row, File browse row,
   roadmap), SECURITY (remove boxes), CHANGELOG, builder item config help.

Verified: `npm test` 286/286 and `npm run test:e2e` 34/34 (dev DB); CI-style in a clean worktree against a throwaway
`postgres:17` on port 5435 with only the workflow's env (+ `API_URL=http://127.0.0.1:1`): fresh install 283 + 3 skipped,
and upgrade from v0.13.0 283 + 3 skipped. Released as **v0.14.0**.

## Sprint 22: drop and paste files, heat maps, filtering a report by the map area (roadmap item 1, 2026-10-01)

Branch `sprint-22` from `main` (v0.14.0). Migration 026 is new. The parity matrix was reviewed first: its summary
counts had drifted from the tables (now 114 rows: 53 ✅ / 29 🟡 / 26 ❌ / 6 ➖).

1. **Drop and paste files**: `fileInput()` in `items.ts` adds `data-drop="<hint>"` (i18n `file.drop`, `file.drop_many`).
   `public/app.js` wraps each such input in `.file-drop` (`dropZones()`, again on `pgapex:replaced`), delegated
   drag events (`.dragover`), `addFiles()` (multiple: appended; single: first file) dispatches `change` (so `max_px`
   runs). Paste: the focused field's file item, else the page's only one unless a text field has focus. A file
   dropped outside a zone is blocked (`dropEffect = 'none'`) on pages with drop zones.
2. **Heat maps**: map config `layer: "heat"`; `maps.ts` gives each point a `weight` (column `weight`, default 1,
   ≤ 0 → 0). `app.js` `heatLayer()`: own `L.Layer` with a canvas in the overlay pane, radial alpha spots, colourised
   with `HEAT_STOPS` (dataviz sequential blue 300→700, translucent at the low end; tiles are light in both themes);
   `heatLegend()` (`.map-legend`, gradient in app.css).
3. **Map filters a report**: map config `report: <report region id on the page>` (like facets). `report.ts`:
   `parseArea()` (4 numbers, range-checked), `positionColumns()` (lat/lng, latitude/longitude/lon, or location),
   `areaCondition()` (numbers only in SQL; `location` text via a regex-guarded cast; west > east = across the
   antimeridian), `ReportState.area` from `r<id>_bb`, used in `filtered()` (so downloads too), a "Map area" chip
   (`chip-error` when the report has no position columns). `maps.ts` passes `filter: {url (with __BB__), clear,
   area}`; `app.js` `areaFilter()` shows "Show this area in the list" after the user moves the map, and "Show
   everything" while filtered; a filtered page fits the map to the area.
   **Migration 026**: `meta.import_app` (copy of 024's) remaps `config.report` for `type in ('facets', 'map')`.
4. Builder: map settings "Show places as" (markers/heat) and "Filter a report" (`mapReportFieldset`, warns when the
   report has no position columns); `mergeMapSettings` keeps `layer`/`report` (report must be on the page).
   `headingOf()` now translates configured headings too.
5. HR `hr_17_locations.sql`: page **16 "Locations"** (nav under Employees, icon `map`): heat map "Payroll by place"
   (weight = salary), map "Offices" filtering the "Employees" report (lat/lng from work location or the office).
6. Tests: `test/maps.test.ts` (heat data, filter URL, Chicago area rows + chip, bad areas ignored, location text and
   antimeridian SQL, no position columns), `region-settings` (map merge), `export` (maps remapped on import),
   `security.test.ts` sprint-22 block, e2e `test/e2e/maps.test.ts` (canvas painted, legend, button after moving,
   filtered rows all Chicago, Show everything, no CSP violations), new `test/e2e/files.test.ts` (drop + paste saved,
   single item takes one, text paste untouched, stray drop blocked).
7. Docs: chapter 4 (map: layer, heat, report), chapter 16 (drop and paste), chapter 12 code map, parity (Map and
   File browse rows, roadmap renumbered), SECURITY (map area parsing), CHANGELOG.

Verified: `npm test` 294/294 and `npm run test:e2e` 37/37 (dev DB); CI-style clean worktree + throwaway `postgres:17`:
fresh 291 + 3 skipped, upgrade from v0.14.0 291 + 3 skipped. Released as **v0.15.0**.

Next on the roadmap: workflow parallel branches and versions; builder (drag-and-drop layout, code editor with SQL
autocomplete, file-per-component export, CLI); template components and plug-ins; AI features. Smaller open items
seen this sprint: marker clustering and several layers per map; object storage and image cropping for files.

## Sprint 23: the rest of the roadmap except AI, in five parallel work branches (2026-10-01)

Branch `sprint-23` from `main` (v0.15.0). The work ran as five agents, each in its own git worktree under
`../pgapex-wt/<name>` (branch `sprint-23-<name>`) with its own `postgres:17` container (`pgapex-<name>`, ports
5441–5445, started with `docker run`, not compose) and app port (3111–3115) in the worktree's `.env`.
**Pitfall:** `npm run db:reset` in a worktree runs `docker compose` against the main `docker-compose.yml` (container
name `pgapex-db`); it fails on the name clash, but reset a worktree's database with `docker rm -f pgapex-<name> &&
docker run …` and `npx tsx scripts/migrate.ts` instead. Migrations were reserved per branch (027 workflow, 028
templates; 029/030 unused).

1. **Workflow branches and versions** (migration 027, `hr_18`): step types `parallel` (`branches`, `join`) and
   `join` (`wait_for: all|any`); `meta.workflow_branch` tracks each branch's position; an `any` join cancels the
   other branches and their tasks; end steps and terminate cancel open branches; nested branches; a faulted branch
   is retried by an admin. Versions: `version`/`steps` (active) plus `dev_version`/`dev_steps`, history;
   `meta.new_workflow_version` / `activate_workflow_version` / `discard_workflow_version`; instances keep their
   version's steps. A before-insert trigger fills version '1' for imports from older exports (`import_app` uses
   `jsonb_populate_record`, which skips defaults). Builder: `src/builder/workflows.ts` (versions route
   `POST …/shared/workflow_definition/:cid/versions`, read-only active steps, instance diagrams).
2. **Template components and plug-ins** (migration 028, `hr_19` page 19 "Team"): `meta.template_component`
   (static_id, template, wrapper, css_classes from a fixed set, attributes), allow-list trigger,
   `meta.export_/import_template_component` (format `pgapex-plugin/1`), region type `template_component`, report
   `config.column_templates`. 028 redefines `export_app` (from 024) and `import_app` (from 026): a later migration
   that changes either must start from 028's. Runtime: `src/runtime/template-components.ts` (language, escaping),
   `template-region.ts`; builder `src/builder/templates.ts`, `template-spec.ts`; examples in `examples/plugins/`.
3. **Page Designer and builder chrome** (no migration): `shell()` in `src/builder/ui.ts` draws the rail, toolbar and
   alerts; builder-only assets are listed in `BUILDER_STYLES` / `BUILDER_SCRIPTS` (add new ones there only);
   icons in `public/builder-icons.svg` (`bicon()`); theme `POST /builder/theme` (session + cookie
   `pgapex_btheme`). `src/builder/designer.ts` (panes, gallery, property tabs that remember the last one),
   `src/builder/arrange.ts` (move, span, drop, undo snapshots; same-page checks), `public/builder.js` / `.css`.
4. **Code editor** (no migration): `public/code-editor.js` / `.css` enhance `<textarea data-code>`;
   `codeAttrs()` in `forms.ts` marks code/JSON fields by component type; `src/builder/code-editor.ts`:
   `GET /builder/code/completions` (tables and columns as the app's role, cached 30 s per role,
   `clearCompletions()` after SQL Workshop runs) and `/builder/code/check`.
5. **CLI and file-per-component export** (no migration): `bin/pgapex.js` → `src/cli/main.ts`
   (migrate, apps, export, import, diff, users); `src/migrate.ts` (the runner, also behind `scripts/migrate.ts`);
   `src/appfiles.ts` (dir layout, keys from names; template components by static_id); `src/cli/replace.ts`
   (`import --replace`; `checkSchema()` refuses to run when a new `meta` table is unknown: add new app tables to
   `REPLACED` or `KEPT`). Chapter 18.

Merge (into `sprint-23`, in the order cli, workflow, templates, editor, designer): conflicts only in
`shared.ts`, `forms.ts`, `ui.ts`, `security.test.ts` and the code map. Fixed after merging: template components in
the dir export and in `--replace`; the property editor remembers its tab (the templates e2e test opens Attributes);
REST modules could not be saved in the builder (the same JSON-as-text bug the workflow agent fixed for steps).
The parity matrix summary was recounted (117 rows: 56 ✅ / 32 🟡 / 23 ❌ / 6 ➖).

Verified: dev DB `npm test` 357/357 (PostgREST and LDAP up) and `npm run test:e2e` 58/58; CI-style throwaway
`postgres:17` without PostgREST: upgrades from v0.15.0 and from v0.6.0, each 354 + 3 skipped. Released as **v0.16.0**.

Next: **AI features** (the last roadmap item) need the owner's decision on the provider and API keys. Smaller open
items: the Advisor doesn't flag regions/columns pointing at a missing template component; column templates apply
only to the normal report view (not downloads, group by or pivot); drag and drop needs a mouse (Arrange buttons on
touch); item/process/dynamic-action plug-ins with their own code are not planned for now.

## Sprint 24: OpenStreetMap tiles, an App Builder home like APEX's (owner's screenshots, 2026-10-01)

Branch `sprint-24` from `main` (v0.16.0). No migration.

1. **Map tiles blocked** ("Access blocked, 403" tiles from tile.openstreetmap.org): OSM refuses browser tile requests
   without a `Referer`, and pgapex sends `Referrer-Policy: same-origin`. Verified with curl (browser `Sec-Fetch-*`
   headers: no Referer → the blocked image, with Referer → the tile). Fix: `referrerPolicy:
   'strict-origin-when-cross-origin'` on the Leaflet tile layer (origin only). The map e2e test asserts the Referer.
2. **App Builder home** (`src/builder/home.ts`, owner's APEX 26.1 screenshot): tiles Create / Import / Dashboard /
   Workspace Utilities; the applications as a report or cards (`?view=`, `?sort=`, remembered in session state
   `__BVIEW` / `__BSORT`); search `?q=` on the server, live filtering by `input[data-filter-list]` in builder.js;
   side column About / Recent (`rememberApp()` on the app home, session state `__RECENT`, a comma list) / Tasks.
   `GET /builder/create` and `/builder/import` hold the forms (their POSTs stay in routes.ts and redirect back there on
   errors). `/builder/dashboard` and `/builder/utilities` are new. `shell()` adds `footer.ide-status` (user,
   database name from DATABASE_URL, language, version from package.json). CSS in builder.css ("App Builder home",
   `--gold` for APEX's gold headings and links). The designer gallery labels `template_component`.
3. Tests: `test/builder-home.test.ts`, a sprint 24 block in `security.test.ts`, the new pages in the responsive e2e.
   Docs: chapter 3 (builder window, App Builder home), chapter 12 code map, SECURITY (the tile server sees the origin).

Verified: dev DB (fresh) `npm test` 365/365, `npm run test:e2e` 58/58; CI-style upgrade from v0.16.0 362 + 3 skipped.
Note: one run without a reset had a workflow test fault at SPLIT; it did not reproduce. The owner's `npm run dev`
(tsx watch, port 3100) shares the dev DB and also runs workflows, with whatever code it last reloaded: stop it, or
reset the DB, before trusting a failure there. Released as **v0.17.0**.

Next: **AI features** need the owner's decision on the provider and API keys.

## Sprint 25: fixes from the owner's testing (2026-10-01)

Branch `sprint-25`, no migration. Workspace Utilities linked Password policy to `/builder/users/settings` (POST only;
the GET hit `/builder/users/:id` → 500 "invalid input syntax for type integer"). Now `/builder/users#account-settings`
(`region()` takes an optional id). `users/:id` routes are `:id(^\\d+$)`; `setErrorHandler` in `src/app.ts` maps
PostgreSQL 22P02 / 22003 to a 404 everywhere (malformed ids in any URL). Tests: every builder link on the home,
utilities and dashboard pages must answer 200 (`test/builder-home.test.ts`); malformed ids are 404s (security.test.ts).
Also: the owner's `npm run dev` (tsx watch) had stopped reloading after 19:59 and served old code; `touch
src/server.ts` restarted it. Map tiles: verified in Chromium against :3100 (Referer sent, real tiles); if the owner's
browser (Brave) still gets "Access blocked", Shields may strip the Referer: a server-side tile proxy is the option
offered. Verified: `npm test` 367/367 (fresh DB), `npm run test:e2e` 58/58. Released as **v0.17.1**.


## Sprint 26 (IN PROGRESS): five parity workstreams in parallel (owner: "move on with the parity list", 2026-10-01)

Branch `sprint-26` from `main` (v0.17.1). Five agents work in git worktrees under `../pgapex-wt/<name>`, branch
`sprint-26-<name>`, each with its own `postgres:17` container (made with `docker run`, NOT compose), migrated with the
HR example, and its own app port in the worktree's `.env` (`node_modules` is a symlink to the main checkout's: remove
the symlink with `rm`, never `rm -r`, before `git worktree remove`).

| Worktree / branch | Gaps (parity matrix) | Container, ports | Reserved |
|---|---|---|---|
| `items` / `sprint-26-items` | rich text / markdown editor, star rating, combobox (tags), date range, password reveal (QR only without a dependency) | `pgapex-items`, 5441, app 3111 | migration 032, `hr_20`, HR page 20 |
| `regions` / `sprint-26-regions` | region display selector and tabs, smart filters, faceted search range/search facets and exclude | `pgapex-regions`, 5442, 3112 | 031, `hr_21`, page 21 |
| `logic` / `sprint-26-logic` | conditional branches, computations, DA set focus/class, success/error message, clear errors, menu buttons and badges, build options | `pgapex-logic`, 5443, 3113 | 029, `hr_22`, page 22 |
| `data` / `sprint-26-data` | REST data sources + web credentials (SSRF allow-list, write-only secrets), invoke API process; new chapter 19 | `pgapex-data`, 5444, 3114 | 030, `hr_23`, page 23 |
| `views` / `sprint-26-views` | calendar week/day/list, create on click, drag and drop; bubble, gauge, funnel, radar charts; drill-down links | `pgapex-views`, 5445, 3115 | 033, `hr_24`, page 24 |

Reset a worktree DB: `docker rm -f pgapex-<n> && docker run -d --name pgapex-<n> -e POSTGRES_USER=pgapex -e
POSTGRES_PASSWORD=pgapex -e POSTGRES_DB=pgapex -p <port>:5432 postgres:17 -c shared_preload_libraries=pg_stat_statements`,
wait for `pg_isready`, then `npx tsx scripts/migrate.ts`. **Never** `npm run db:reset` in a worktree.

The agents commit on their own branch (trailer `Co-Authored-By` + `Claude-Session`), don't push, and don't edit
CHANGELOG, the parity matrix, SECURITY.md or this file. If a session ends while they run: check each worktree with
`git -C ../pgapex-wt/<n> log --oneline sprint-26..` and `git status`; uncommitted work can be finished by a new agent
told to continue from it (as was done in sprint 23).

**2026-10-04:** the first five agents had stopped with only uncommitted partial work (items: `src/richtext.ts`;
regions: `facet-state.ts` + report.ts; logic: `029_logic.sql`; views: charts.ts; data: nothing). The containers were
restarted and five new agents were launched to continue from that work, same branches, ports and reservations.

**To finish the sprint** (coordinator):
1. Merge the branches into `sprint-26` (suggested order: items, views, regions, data, logic; logic and data and
   regions may each redefine `meta.export_app` / `meta.import_app` (028's are the last released): the highest-numbered
   migration must carry all changes, so check 029–033 and write a follow-up migration if needed). Expect conflicts in
   `public/app.js`, `public/app.css`, `src/i18n.ts`, `src/builder/components.ts`, `src/builder/region-settings.ts`,
   `src/builder/arrange.ts`, `src/cli/replace.ts`, `src/appfiles.ts`, `test/security.test.ts` (appended blocks: keep
   all, check the closing braces), `test/e2e/responsive.test.ts`, `docs/guide/12-development.md`, `docs/README.md`.
2. `npx tsc --noEmit`; `npm run db:reset && npm test`; `npm run test:e2e` in the main checkout (the owner's
   `npm run dev` on :3100 shares the dev DB and runs workflows: a stray failure may come from it).
3. CI-style: a throwaway `postgres:17` (e.g. port 5446) without PostgREST, install `v0.17.1` with
   `npx tsx scripts/migrate.ts --seed --root <git archive of the tag>`, then `npm run example:hr` and `npm test`
   with DATABASE_URL/RUNTIME_DATABASE_URL pointing at it (the script used before: install tag, upgrade, test).
4. Update the parity matrix (rows + recount the summary from the tables), CHANGELOG (0.18.0), SECURITY.md
   (from the agents' security notes), this file, `.env.example` (data agent's env vars), package version, CI upgrade
   matrix (+ v0.18.0), the `v0.6.0 … v0.x` line in chapter 12; merge `sprint-26` into `main`, tag `v0.18.0`, push.
5. Clean up: remove the worktrees, branches `sprint-26-*` and `sprint-26`, and containers `pgapex-items`,
   `pgapex-regions`, `pgapex-logic`, `pgapex-data`, `pgapex-views`.

Still open for the owner: **AI features** (provider and API key storage); an optional server-side map tile proxy if
Brave keeps getting OpenStreetMap's "Access blocked"; leftovers `../pgapex-wt/designer-shots`, `editor-shots`, the docker
network `templates_default` and volume `templates_pgdata` (can be deleted).
