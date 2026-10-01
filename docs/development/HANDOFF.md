# Handoff: work in progress

This file lets another developer (or another Claude session) continue the current sprint without
the chat history. Keep it updated when you stop working. Delete it (or empty the sprint section)
when the sprint is merged.

Last updated: 2026-10-01. Sprints 3–13 are merged into `main` and released as **v0.9.0** (migrations 001–016 are released: add 017+).

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
| `main` | Everything up to sprint 13, released as **v0.9.0** (tags: v0.2.0, v0.6.0, v0.7.0, v0.8.0, v0.9.0; 0.3.0–0.5.0 were never tagged). Migrations 001–016 are released |
| `sprint-14` | Merged into `main` (not released yet); can be deleted |
| `sprint-15` | Merged into `main` (not released yet); can be deleted |
| `sprint-16` | Approvals and the task list; HR moved to examples/ (see Sprint 16), pushed; not merged yet |
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
