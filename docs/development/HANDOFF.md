# Handoff: work in progress

This file lets another developer (or another Claude session) continue the current sprint without
the chat history. Keep it updated when you stop working. Delete it (or empty the sprint section)
when the sprint is merged.

Last updated: 2026-10-06 (sprint 38 released as v0.30.0; sprint 39 in progress on `sprint-39`). Sprints 3–38 are merged into `main` and released as **v0.30.0** (migrations 001–067 are released: add 068+; 033, 035, 045, 046, 048, 049 and 059 were never used). HR example files up to `hr_45` are released (sprint 39 added `hr_46`–`hr_48`; migrations 068–073).

## Project in one paragraph

**pgapex** is an open source (Apache-2.0, © Vargar) Oracle APEX alternative on PostgreSQL:
applications are rows in the `meta` schema, rendered by a Node/TypeScript (Fastify) server with
server-side HTML, plus a builder at `/builder`. Read `docs/README.md` (the user guide),
`docs/guide/02-concepts.md` (architecture), `docs/guide/12-development.md` (code map) and
`SECURITY.md`. The parity status vs APEX 26.1 is in `docs/apex-feature-parity.md`.

## Conventions (agreed with the project owner)

- Agents follow `docs/development/agent-rules.md` (one file for every sprint: mode A one agent in the main
  checkout, mode B parallel worktrees, plus a section per sprint). The per-sprint `sprint-NN-agent-rules.md`
  files named in older sprint sections below were folded into it and removed.

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
| `main` | Everything up to sprint 38, released as **v0.30.0** (tags: v0.2.0, v0.6.0–v0.30.0; 0.3.0–0.5.0 were never tagged). Migrations 001–067 are released |
| (sprint branches) | `sprint-32` … `sprint-35` (and `sprint-35-reporter`, `-sampledata`, `-appwizard`) were merged (v0.24.0–v0.27.0) |
| (sprint branches) | `sprint-31` and its five `sprint-31-*` work branches were merged (v0.23.0) |
| (sprint branches) | `sprint-25`, `sprint-26` (+ five `sprint-26-*`) and `sprint-27` were merged (v0.17.1, v0.18.0, v0.19.0) and deleted |
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


## Sprint 26 (DONE, v0.18.0): five parity workstreams in parallel (owner: "move on with the parity list", 2026-10-01)

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

**State at the last handoff (2026-10-04):** the five relaunched agents were still running, each with substantial
uncommitted work (new migrations 029/030/032, `src/secrets.ts`, `src/webclient.ts`, `src/websources.ts`,
`src/runtime/rest-sources.ts`, `src/qrcode.ts`, `examples/hr/hr_20_items.sql`, `hr_24_planner.sql`, edits across
runtime/builder/i18n) and had been asked to commit `wip:` checkpoints. Nothing is merged into `sprint-26` yet.

**2026-10-04 (later):** the session ended again; all five branches now have `wip:` commits (views also a docs
commit), with only small uncommitted edits left (items: 05-items.md; regions: export.test.ts + new
`test/regions-sprint26.test.ts`; logic: hr_22 + security.test.ts). A third round of agents was launched to finish
and verify each workstream.

**Workstream reports (collected for CHANGELOG / parity / SECURITY.md at the end):**

- **views: DONE, merged into `sprint-26`** (2026-10-04). No migration (033 unused; settings in region config JSON),
  HR `hr_24_planner.sql` page 24, export/import not redefined, no env vars. Tests: 388/396 (8 skipped LDAP/PostgREST),
  e2e 62/62. Parity — Calendar: month/week/day/list views; create on click (checksummed slot link); drag and drop
  moves events via developer `move` SQL run as the app role (CSRF, `move_authz`, row-level visibility); works without
  JS. Charts: bubble, gauge, funnel, radar (server SVG, no inline styles); checksummed, authz-aware drill-down links.
  Security: move route `POST /a/:alias/:page/calendar/:id/move` checks CSRF first, signed-in user, page/region
  authz + conditions, `move_authz`; event must be in the region query for this user (app role, RLS); client sends only
  an event key (≤200 chars) + a date-checked slot; start/end go to `move` SQL as literals; `key` is a plain column
  name; refusals and moves logged (`forbidden`, `calendar_move`).

- **regions: DONE, merged** (2026-10-04). Migration 031 (region types `smart_filters`, `display_selector`; redefines
  only `meta.import_app` from 028, adding `smart_filters` to the types whose `config.report` is remapped), HR
  `hr_21_regions.sql` page 21, no env vars. Tests 383/391 (8 skipped), e2e 62/62. Behaviour change: a facet filter in
  the URL (`r<id>_x_<col>`) only applies if a facet on that column exists on the page; report queries now take facet
  and search values as query parameters (`SqlParams` in binds.ts, `buildSql` returns `{text, values}`). Parity —
  Faceted search: checkbox, range (predefined + custom from/to, numbers and dates), star rating and search facets;
  exclude on checkbox facets. Smart filters: search field with chips and suggestions, URL-based, no JS needed. Region
  display selector: tabs or select list, shared tabs, Show all, session memory, `#R<id>` links, no-JS fallback.
  Security: facet/search input never becomes SQL text; bounds checked against the column type; only a facet's own
  ranges unless custom allowed; column names checked and quoted; NUL bytes dropped; limits 50 filters, 100 values
  ≤500 chars, 20 ranges; facets of regions the user can't see don't filter, such regions get no tab; settings routes
  are developer + CSRF, same page only.
- **logic: DONE, merged** (2026-10-04). Migration 029 (`meta.build_option`, `build_option` columns, `meta.computation`,
  `meta.branch`, DA `css_classes`, menu buttons, badges; **redefines export_app and import_app** from 028 adding
  `build_options` and per-page `computations`/`branches`), HR `hr_22_logic.sql` page 22, build option
  `LEAVE_FORECAST`. Tests 386/394, e2e 62/62. Chapter 6 renamed "Buttons, validations, processes and page logic".
  Parity — Computations ✅ (static, item, SQL query/expression, PL/pgSQL body; before header / after submit; condition,
  authz, build option). Branches ✅ before header / after processing, page or in-app URL, when button pressed,
  conditions; missing: branch to another app, function-returning-URL. Build options ✅ (include/exclude, `!NAME`,
  fail closed, Advisor/Used in, exported). DAs: Set Focus, Add/Remove Class, Show Success/Error, Clear Errors. Buttons:
  menu button (no JS needed) and badges (static or SQL). Security: computation/branch/badge SQL runs as the app role
  in savepoints with literal binds; PL/pgSQL bodies become `pg_temp` functions with a random dollar-quote tag (a body
  containing it is refused); URL branches DB-checked (no scheme, `//`, `\`, `..`, control chars; item values
  URL-encoded); a menu `request` counts as a button only if the menu button is visible and the entry's authz passes
  (a real button of that name keeps its own checks); menu links only to openable pages, signed; `css_classes` checked
  `^[a-z][a-z0-9_-]{0,39}` (≤5) in DB, builder and app.js; excluded build options fail closed (404 for pages); runtime
  role has SELECT only on the new tables. Note: `examples/hr/README.md` file table stops at hr_10.

- **data: DONE, merged** (2026-10-04). Migration 030 (`meta.web_credential`, `meta.rest_source`, region
  `rest_source`, process type `invoke_api`; redefines export/import adding `web_credentials` without `secret_enc` and
  `rest_sources`), HR `hr_23_rest_sources.sql` page 23 (credential `HR_API`, sources `DEPARTMENTS`, `DEPARTMENT`,
  `EMPLOYEES_API`, LOV `DEPARTMENTS_REST`, public `departments/:deptno` handler in REST module v1), new chapter 19.
  **Env vars** (all optional; unset = no outgoing calls, no secrets): `PGAPEX_REST_ALLOWED_HOSTS` (`api.example.com`,
  `*.example.com`, `host:8443`, `*`), `PGAPEX_REST_PRIVATE_HOSTS`, `PGAPEX_SECRET_KEY` (≥32 chars),
  `PGAPEX_REST_MAX_BYTES` (default 5000000). Parity row: "REST Data Sources / Web Credentials / Invoke API ✅/🟡 —
  JSON endpoints with path/query/header/body params, row selector, typed columns, response cache, feeding reports,
  cards, charts, calendars, maps, trees, template components and shared LOVs as SQL over `rest`; web credentials basic,
  API-key header, bearer, OAuth2 client credentials, encrypted write-only secrets; `invoke_api` process; SSRF-checked
  allow-list (chapter 19). Not covered: XML/SOAP, DML write-back, sync into local tables, OAuth2 authorization code."
  Security (SECURITY.md): http/https only, no userinfo; host allow-list; resolved address checked at connect time and
  used (no DNS rebinding); private/loopback/link-local/CGNAT/multicast/doc ranges refused incl. IPv4-mapped, NAT64,
  6to4 unless in PRIVATE_HOSTS; ≤3 redirects re-checked, credential headers dropped cross-origin; ≤60 s, size limit
  after decompression. Secrets AES-256-GCM with a key outside the DB, write-only, never exported/logged; runtime role
  has a column grant without `secret_enc`; changing the key means re-entering secrets. Parameter values URL-encoded
  after a fixed host, `.`/`..` refused, one-line headers, no Authorization/Cookie/Host/transport headers on a source.
  Response values go into SQL as one escaped literal via `jsonb_to_recordset`, checked column names, app role.
  Residual: cached responses shared by all users of the app; `*` lets developers call any public host; OAuth tokens
  and cache are per process. Coordinator fixes at merge: facet/map report pickers now select `rest_source` (the
  column list of a REST-backed report was wrong), calendar drag and drop resolves a REST-backed region.

- **items: DONE, merged** (2026-10-04). Migration 032 (only widens `meta.item` type check), HR `hr_20_items.sql` page 20
  "Reviews" (`hr.review`). Item types `richtext`, `markdown`, `rating`, `combobox`, `daterange`, `qrcode`, password
  `{"reveal": true}`; all work without JS; no env vars, no deps; export/import unchanged. Parity: Rich text / markdown
  editor ✅, Star rating, QR code, combobox (tags), date range ✅, Password reveal ✅. Security: rich text rebuilt from an
  allow-list on the server when saved and every time shown (links only http/https/mailto/tel/relative with
  `rel="noopener noreferrer nofollow"`; scripts, styles, handlers, images, SVG, frames, comments dropped; obfuscated
  `javascript:` refused); Markdown input HTML shown as text, output through the same allow-list; Markdown rendering is
  linear time (headings/links regexes rewritten, timing test); pasted HTML sanitised in the browser; QR SVG on the
  server, ≤2000 chars, display only; rating/date range validated server side (422); password never echoed.

**Released 2026-10-04 as v0.18.0.** Final checks on `sprint-26`: `npm run db:reset && npm test` 480 pass + 8 skipped;
`npm run test:e2e` 73/73; upgrade from v0.17.1 (throwaway `postgres:17` on 5446) 479 pass + 9 skipped. Parity matrix
recounted (66 ✅ / 32 🟡 / 17 ❌ / 6 ➖ of 121), CHANGELOG 0.18.0, SECURITY.md (five new layers rows, residual risks,
checklist item 8), CI upgrade matrix + v0.18.0. Worktrees, branches and containers of sprint 26 removed.
Follow-ups: `examples/hr/README.md` file table stops at hr_10; the old dev DB on 5434 was reset (owner's `npm run dev`
shares it).

**Merged state (2026-10-04):** ALL FIVE merged. After items: `npm run db:reset && npm test` 480 pass, 8 skipped.
Upgrade test from v0.17.1 (container `pgapex-upg`, port 5446, before items was merged): 457 pass, 9 skipped.
Earlier: views, regions, logic, data merged into `sprint-26` + migration **034** (export/import
with 029's, 030's and 031's changes). `npm run db:reset && npm test`: 458 pass, 8 skipped, 0 fail. Still to do: items
(agent running), CI-style upgrade test, release steps below. Done since: e2e 70/70; parity rows (not yet the
summary counts / "Last reviewed"), CHANGELOG Unreleased and SECURITY.md written for the four merged workstreams
(add items' entries).

**Merge note:** 029 (logic), 030 (data) and 031 (regions) each redefine `meta.export_app`/`meta.import_app`: after
merging, write migration 034 combining all three changes. (Done: 034.)

**How to resume after a session ends:**
1. Containers: `docker start pgapex-items pgapex-regions pgapex-logic pgapex-data pgapex-views pgapex-db`.
2. Per worktree: `git -C ../pgapex-wt/<n> log --oneline sprint-26..` and `git -C ../pgapex-wt/<n> status`.
   A workstream is finished only when its agent reported tests green and the tree is clean.
3. For each unfinished one, launch a new agent with: "Read `docs/development/sprint-26-agent-rules.md` (in the main
   checkout) and follow it. Worktree `../pgapex-wt/<n>`, branch `sprint-26-<n>`, DB `pgapex-<n>` port <db>, app port
   <app>, reserved migration <m>, HR `hr_<x>` page <x>. Continue the uncommitted/wip work for the gaps in the table
   above; commit `wip:` checkpoints often." Scratch files like `test/zz-*.ts` (views) must not be committed.
4. Then follow "To finish the sprint" below.

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

## Sprint 27 (DONE, v0.19.0): large tables (owner, 2026-10-04: "move on with large tables, only one agent")

Branch `sprint-27` from `main` (v0.18.0 + the CI fix 1519757: the App Builder home table overflowed at 768px on the
GitHub runner because `.sr-only` labels escaped the table's scroll area). One agent works **in the main checkout**
(no worktree), dev DB on 5434; reserved migration **035**, HR `hr_25` page 25. Scope (parity rows "Pagination of
large tables", "Lazy loading of regions", "Region caching", "Large downloads without buffering"):
1. Report/grid pagination without a total ("row ranges X to Y", fetch size+1 for Next) and a maximum row count;
   optionally keyset paging on an indexed sort.
2. Row limits on cards, charts, dynamic content and select-list LOVs (configurable, sensible defaults).
3. Lazy loading of regions: placeholder + fetch through the refresh-region endpoint after the page shows; without
   JavaScript the normal render (or a link).
4. Region caching per user / session / all users for a duration (invalidated on submit of the page); never across apps.
5. Streamed CSV/Excel downloads with a cursor (DECLARE/FETCH, no new dependency) so memory stays flat.
The agent commits `wip:` checkpoints often. CI is readable now: `gh run list -R NickVrgr/Postgresql_APEX` /
`gh run view <id> --log-failed` (owner logged gh in as NickVrgr on 2026-10-04).

**Result (2026-10-04, v0.19.0):** row ranges (`"pagination": "range"`) and `max_rows` for reports and grids; row limits
for cards/charts/dynamic/LOVs; `"lazy": true` (endpoint `GET /a/:alias/:page/region/:id`, no-JS link `r<id>_load=1`);
`"cache": {scope, seconds}` in `src/runtime/region-cache.ts` (in memory, per process); CSV/Excel streamed with
DECLARE/FETCH and a streaming `XlsxWriter`. No migration; HR `hr_25_large_tables.sql` page 25 (`hr.reading`, 200,000
rows), `hr_26_web_services_hint.sql` (page 23 hint text). Env: `DOWNLOAD_MAX_ROWS`, `REGION_CACHE_MAX_ENTRIES`,
`REGION_CACHE_MAX_MB`. Deferred: keyset paging, streaming PDFs and REST collections, popup LOV with server search.
Tests 496 + 8 skipped, e2e 77/77. The owner's local `.env` has `PGAPEX_REST_PRIVATE_HOSTS=127.0.0.1:3100` and a
`PGAPEX_SECRET_KEY` (added 2026-10-04 so HR page 23 works).

Next on the roadmap: **AI features** (needs the owner's decision on provider and API key storage).

## Sprint 28 (DONE, v0.20.0): popup LOV with server-side search (owner: "keep going", 1 agent, low usage left, 2026-10-04)

Branch `sprint-28` from `main` (v0.19.0). One agent in the main checkout, dev DB 5434; reserved migration 036 (only if
needed), HR `hr_27` page 26. Scope: item type `popup_lov` (APEX Popup LOV): a modal/dialog with a search field that
queries the LOV on the server (paged, clamped, as the app's role, item/page authorization re-checked; only the item's
own LOV), several display columns, return value vs display value; without JavaScript a plain select list or a GET
search link. The agent commits `wip:` checkpoints and pushes `sprint-28` after each commit.
**If a session ends:** `git log --oneline main..sprint-28`; finish with tsc, `npm run db:reset && npm test`,
`npm run test:e2e`; then parity row "Popup LOV", CHANGELOG 0.20.0, SECURITY.md, version, CI matrix + v0.20.0, the
chapter 12 version line, merge, tag, push, `gh run list` to check CI.

**Result:** `popup_lov` (endpoint `POST /a/:alias/:page/lov/:item/search`, `searchLov`/`lovLookup` in items.ts); no migration (036 unused: the type was already allowed); HR `hr_27_popup_lov.sql` page 26. Tests 502 + 8 skipped, e2e 78/78. Next: AI features (owner's decision on provider/API keys), keyset paging, streaming PDFs.

## Sprint 29 (DONE, v0.21.0): HTTP-header authentication (owner: "please continue", 1 agent, 2026-10-04)

Branch `sprint-29` from `main` (v0.20.0); one agent in the main checkout, dev DB 5434; reserved migration 036, HR
`hr_28` (only if useful). Scope (parity row "Database accounts, HTTP-header authentication"): an app authentication
type `header` (APEX "HTTP Header Variable") for apps behind a reverse proxy / SSO gateway that sets a user header
(e.g. `X-Remote-User`): header name per app, only trusted when the request comes from a proxy address listed in an
env var (e.g. `PGAPEX_AUTH_HEADER_PROXIES`), otherwise refused; optional automatic account creation like OIDC;
session bound to the header value (a changed header ends the session). Database accounts stay out of scope.
**If a session ends:** `git log --oneline main..sprint-29`; finish tests, then parity row, CHANGELOG 0.21.0,
SECURITY.md, `.env.example`, version, CI matrix + v0.21.0, chapter 12 version line, merge, tag, push, check CI.

**Result:** app authentication `header` (`src/headerauth.ts`, `headerSession` in routes.ts; migration 036: `header_name`, `header_auto_create`, `logout_url`); env `PGAPEX_AUTH_HEADER_PROXIES`. Tests 511 + 8 skipped, e2e 78/78. Next: AI features (owner's decision), keyset paging, streaming PDFs/REST collections, database-account authentication.

## Sprint 30 (DONE, v0.22.0): the smaller open items (owner: "do the other smaller items as long as you got usage", 2026-10-04)

Branch `sprint-30` from `main` (v0.21.0); one agent in the main checkout, dev DB 5434; reserved migration 037, HR
`hr_28` page 27. Items in order, each finished, tested and committed before the next (stop anywhere, still mergeable):
1. **Keyset ("seek") paging** for row-range reports with a sort on indexed/unique columns (parity row "Pagination of
   large tables" → drop "Missing: keyset").
2. **Streaming PDFs** of reports and **streaming REST collections** (REST modules' collection handlers) with a cursor
   (parity row "Large downloads without buffering" → ✅ when both are done).
3. **Database-account authentication** (APEX "Database Accounts": sign in with a PostgreSQL role's password, checked
   by a connection attempt or `pg_authid`-free method; roles allowed per app) (parity row "Database accounts,
   HTTP-header authentication" → ✅).
**If a session ends:** `git log --oneline main..sprint-30` shows which items are committed; run tsc, `npm run
db:reset && npm test`, `npm run test:e2e`; update the parity rows of the finished items + summary counts, CHANGELOG
0.22.0, SECURITY.md, `.env.example`, version, CI matrix + v0.22.0, chapter 12 version line, this file; merge, tag,
push, check CI with `gh run list -R NickVrgr/Postgresql_APEX`.

**Result (2026-10-05, v0.22.0):** keyset paging (`"keyset": [...]`, signed `r<id>_k`), report PDFs from a cursor in
batches (`PDF_MAX_ROWS`), streamed REST collections, authentication type `database` (`src/dbauth.ts`, migration 037).
Tests 527 + 8 skipped, e2e 78/78. HR `hr_28` was not used.

## Sprint 31 (DONE, v0.23.0): five parity workstreams in parallel (owner: "read the handoff and the parity and keep building, multiple agents if necessary", 2026-10-05)

Branch `sprint-31` from `main` (v0.22.0). Same set-up as sprint 26: five agents in git worktrees under
`../pgapex-wt/<name>`, branch `sprint-31-<name>`, each with its own `postgres:17` container (`docker run`, not compose)
and app port in the worktree's `.env`; `node_modules` is a symlink (remove it with `rm`, never `rm -r`, before
`git worktree remove`). Rules for the agents: `docs/development/sprint-31-agent-rules.md`. AI features stay out
(owner's decision on provider and API keys is pending).

| Worktree / branch | Gaps (parity matrix) | Container, ports | Reserved |
|---|---|---|---|
| `grid` / `sprint-31-grid` | Interactive grid: aggregates, frozen columns, column reorder/resize/hide, saved grid reports per user, master-detail (a detail grid/report following the selected master row), row actions menu, copy/paste of cells | `pgapex-grid`, 5441, app 3111 | migration 038, `hr_28`, HR page 27 |
| `logic` / `sprint-31-logic` | Page processes: download (file from a query/bytea), execution chains (child processes, optionally in the background), workflow processes (start, terminate); branches: function returning a URL, to another app; dynamic action event "dialog closed" | `pgapex-logic`, 5442, 3112 | 039, `hr_29`, page 28 |
| `i18n` / `sprint-31-i18n` | Number format masks (report columns, items, charts), automatic time zone (browser time zone into the session, timestamptz shown in it), built-in runtime messages in German, French and Spanish | `pgapex-i18n`, 5443, 3113 | 040, `hr_30`, page 29 |
| `workshop` / `sprint-31-workshop` | SQL Workshop: SQL scripts (saved, run, results per statement), Quick SQL (shorthand → DDL), a simple query builder; Data Workshop: XML loading, saved data load definitions | `pgapex-workshop`, 5444, 3114 | 041, `hr_31` (only if useful) |
| `builder` / `sprint-31-builder` | Custom authentication (a PL/pgSQL function), generic Lists (shared component + list region), page locks and developer comments, supporting objects (install/upgrade/deinstall scripts in the export) | `pgapex-builder`, 5445, 3115 | 042, `hr_32`, page 31 |

Several workstreams may redefine `meta.export_app`/`meta.import_app` (latest definitions: 034): the coordinator writes
migration **043** combining all changes after merging.

**How to resume after a session ends:** `docker start pgapex-grid pgapex-logic pgapex-i18n pgapex-workshop
pgapex-builder pgapex-db`; per worktree `git -C ../pgapex-wt/<n> log --oneline sprint-31..` and `git status`. For an
unfinished one, launch an agent: "Read `docs/development/sprint-31-agent-rules.md` and follow it. Worktree
`../pgapex-wt/<n>`, branch `sprint-31-<n>`, DB `pgapex-<n>` port <db>, app port <app>, reserved migration <m>, HR
`hr_<x>` page <p>. Continue the uncommitted/wip work for the gaps in the table above." Then finish like sprint 26
(merge order: i18n, workshop, grid, logic, builder; migration 043; tsc, db:reset + test, e2e, upgrade test from v0.22.0;
parity rows + counts, CHANGELOG 0.23.0, SECURITY.md, `.env.example`, version, CI matrix + v0.23.0, chapter 12 version
line; merge, tag, push; remove worktrees, branches and containers).

**State at the handoff (2026-10-05, ~08:15):** v0.22.0 is released and CI on `main` is green (a flaky
database-auth test was fixed on `main` in 68d8b65: page views are logged without
awaiting, so the "last log entry" raced). The five agents were still running; each had pushed nothing itself, but
the coordinator pushed their `wip:` commits to `origin/sprint-31-<n>`. Uncommitted work may exist in the worktrees
(only on the owner's machine, under `../pgapex-wt/<n>`). Progress at that moment:

| Workstream | Committed (wip) | Uncommitted at handoff | Probably still to do |
|---|---|---|---|
| grid | aggregates, layout per user, master-detail, row actions; client side (move, resize, paste, master-detail refresh) | nothing | tests (security + functional), HR `hr_28` page 27, docs, e2e |
| logic | migration 039; download, chain, workflow processes; branches; background jobs; dialog_closed event; builder fields, Advisor, jobs panel, replace; HR page 28 | `test/page-logic.test.ts` (new) | finish tests, security tests, docs, e2e |
| i18n | `numformat.ts` + migration 040; time zone per request, locale number symbols, settings; masks on report/grid/cards/chart/PDF columns and number items | edits in format.ts, report-settings.ts, components.ts, app.css | German/French/Spanish messages, HR `hr_30` page 29, tests, docs, e2e |
| workshop | migration 041; SQL script splitter/runner + pages; Quick SQL parser/DDL/page; query builder; workshop tests | `src/xml.ts`, `test/xml.test.ts`, dataload.ts edits | XML loading, saved data load definitions, security tests, docs, e2e |
| builder | migration 042; custom authentication; lists (shared component, region, menu/bar) | `src/builder/locks.ts`, `supporting.ts`, edits in routes/designer/shared/ui/cli/export test | page locks + comments, supporting objects, export/import (migration 042 may redefine them), HR `hr_32` page 31, tests, docs, e2e |

**How to take over (another Claude account / session):**
1. If you are on the owner's machine (`/home/nickquispel/projects/postgres_apex`): the worktrees and containers exist.
   Start the containers (`docker start pgapex-db pgapex-grid pgapex-logic pgapex-i18n pgapex-workshop pgapex-builder`).
   Make sure no earlier agent is still editing a worktree (its `git status` stops changing). Commit any uncommitted
   work as `wip: …` on the worktree's branch first, so nothing is lost.
2. If you are on another machine: clone, `git fetch`, and recreate a worktree per workstream from `origin/sprint-31-<n>`
   (`git worktree add ../pgapex-wt/<n> sprint-31-<n>`), symlink `node_modules`, write `.env` from the main `.env` with
   the workstream's DB port and app port (table above), create the container (`docker run` command in sprint 26's
   section), `npx tsx scripts/migrate.ts && npm run example:hr`. Uncommitted work from the owner's machine is then
   missing: the table above says what to redo.
3. Per unfinished workstream, launch an agent (several in parallel is fine) with: "Read
   `docs/development/sprint-31-agent-rules.md` and follow it. Worktree `../pgapex-wt/<n>`, branch `sprint-31-<n>`, DB
   `pgapex-<n>` port <db>, app port <app>, reserved migration <m>, HR `hr_<x>` page <p>. Continue the wip work (commits
   and uncommitted changes) for the gaps of your row in the Sprint 31 table of HANDOFF.md; finish, test, and report."
   Push each branch after the agent finishes (`git push origin sprint-31-<n>`), so another account can pick it up.
4. Coordinator: collect each final report below, then finish as written above (merge order i18n, workshop, grid,
   logic, builder; migration 043 combining every redefinition of `meta.export_app`/`meta.import_app`; full tests,
   upgrade test from v0.22.0, docs, release 0.23.0, cleanup). Then sprint 32 (below).
5. Keep this file updated and pushed after every milestone (merge of a workstream, release): usage can end without
   warning.

**Takeover (2026-10-05, ~08:15):** a new coordinator session found no agent still running (worktrees unchanged for
20+ minutes; two orphaned dev servers stopped), committed every worktree's uncommitted work as `wip:` and pushed all
five `sprint-31-<n>` branches. Five new agents were launched (one per workstream) to finish them.

**Workstream reports:** (fill in as agents finish)

**Owner (2026-10-05):** the coordinator merges `sprint-31` into `main` itself when finished (and releases 0.23.0);
do **not** start sprint 32 in that session.

- **logic: DONE** (pushed, not merged). Migration `039_page_logic.sql`, HR `hr_29_toolkit.sql` page 28. export/import
  not redefined (`process_job` in `NOT_EXPORTED`). **039 redefines `meta.has_role`** (background-job branch): combine
  in 043 if builder also redefines it. Env vars `BACKGROUND_PROCESSES`, `PROCESS_JOB_INTERVAL_S` (default 10) → `.env.example`.
  Hotspots: engine.ts, routes.ts, logic.ts, render.ts, public/app.js, builder components/advisor/designer, metadata.ts,
  i18n.ts, cli/replace.ts, server.ts, runtime/files.ts, end of security.test.ts, guide 01/06/12.
  Security: download queries run as app role (logged `download`); function branches checked, off-app refused and logged
  `forbidden`; app branches signed per target app/page/user; `meta.enqueue_process_job` only queues current-app chains
  with session roles; passwords dropped from job binds; request-bound processes refused in background;
  `meta.process_jobs` security_barrier own-jobs view; workflow terminate/retry checked in DB; `dialog_closed` same-origin.
  Parity: Download process, execution chains (+ background), workflow process start/terminate/retry, branch function
  returning URL, branch to another app, DA event Dialog Closed: all Yes. Tests 548 pass / 8 skip, e2e 81/81.
- **grid: DONE** (pushed, not merged). Migration `038_grid_reports.sql` (saved_report.kind report/layout, new unique
  key, redefines view `meta.saved_reports`, `meta.save_report`, `meta.delete_saved_report`; adds `save_grid_layout`,
  `reset_grid_layout`), HR `hr_28_grid.sql` page 27, nav seq 28. export/import not redefined. No env vars.
  **19 new i18n keys in en/nl: i18n's de/fr/es tables need them after merging.** Hotspots: public/app.js (large grid
  section), runtime/routes.ts (region endpoint, grid routes), grid.ts, regions.ts, report.ts, builder region-settings/
  components, i18n.ts, app.css, end of security.test.ts, responsive e2e, guide 03/04/08/09/11/12/18.
  Security: master row selection HMAC-bound to app/page/user/region/value; `GET …/region/:id` only lazy regions or
  details of a visible master; layout/apply routes check CSRF, page access, grid visible, Actions on; layout input
  sanitised (identifiers, widths 40–1000, ≤5 frozen, ≤6000 chars); detail master column never editable, inserts
  without a selection refused. Parity: IG aggregates, frozen columns, reorder/resize/hide, per-user layouts and saved
  reports, master-detail, row actions menu, copy/paste of cell ranges: done. Tests 545 pass / 8 skip, e2e 83/83.
- **builder: DONE**. The agent squashed the wip into 3 commits on a9f1ddd; that result is pushed as
  **`origin/sprint-31-builder-final`** (merge this one). `origin/sprint-31-builder` still holds the older wip tip (not
  force-pushed). Migration 042, HR `hr_32_lists.sql` page 31 (lists HR_SHORTCUTS, HR_DEPARTMENTS, HR_NAVBAR, two
  supporting scripts). **042 redefines `export_app`/`import_app`** from 034 (adds `lists`, `list_entries`,
  `supporting_scripts`; import sets list-entry parents after inserting): combine in 043. No env vars.
  New i18n keys `list.missing`, `list.empty`, `list.navbar` (en/nl): de/fr/es need them. Existing tests changed:
  logic.test.ts "Used in (3)" for LEAVE_FORECAST; page-3 link regex `/a\/hr\/3(?![0-9])/` in security and
  template-components tests. Hotspots: builder routes.ts (settings form `$23`–`$27`, developers page), ui.ts (lock
  check), runtime routes.ts (login), components.ts, shared.ts, region-settings, designer, search, render.ts,
  regions.ts, appfiles.ts, cli replace/main, metadata.ts, i18n.ts, app.css, builder.css, end of security.test.ts,
  responsive e2e, guide 03/04/08/09/11/12/18.
  Security: custom auth runs as app role in a temp function, password only a parameter, failures logged by SQLSTATE,
  same "invalid" answer + throttling, function name constrained, random dollar-quote tag, nothing configured = no
  sign-in; list URLs limited to app paths or http(s) (constraint + `safeListUrl`), noopener, checksums, entries hidden
  by authz/condition/build option/page access; locks enforced server-side on every builder POST (423 for JSON),
  owner or admin unlocks, admin break logged `lock_broken`, developers get `is_admin` (existing + CLI-created default
  admin); supporting objects never run on import, need developer session + CSRF, run as app role in one transaction
  with 600s timeout, logged `supporting_objects`; locks/comments not exported.
  Parity: Custom authentication, Lists (shared component, list region, nav menu/bar), page/app locks + developer
  comments, supporting objects: all Yes. Left out: "Used in" doesn't count `nav_list`/`navbar_list`.
  Tests 556 pass / 8 skip, e2e 78/78.
- **workshop: DONE**. Squashed into 4 commits; pushed as **`origin/sprint-31-workshop-final`** (merge this one;
  `origin/sprint-31-workshop` holds the older wip tip). Migration 041, HR `hr_31_data_load_xml.sql` (page 13 accepts
  .xml, definition EMP_XML, sample `public/samples/employees.xml`; no new page). **041 redefines
  `export_app`/`import_app`** from 034 (adds `data_load_definitions`; id/app_id replaced on import): combine in 043.
  No env vars (`DATA_LOAD_MAX_MB/ROWS` apply to XML). Hotspots: builder components.ts, shared.ts (SHARED list),
  runtime engine.ts (`dataLoad`), appfiles.ts (`NAMED`), builder ui.ts (`workshopTabs`), sql.ts, builder.css, top
  and end of security.test.ts, responsive e2e, guide 03/08/11/12/16.
  Security: workshop routes need builder login + CSRF and run as owner (like SQL Commands); XML refuses DOCTYPE/
  entities, depth ≤100, element counts limited; definition table names regex + CHECK + regclass + quoted, masks as
  literals, values as params, processes see only own-app definitions and load as app role; Load Data temp file bound
  to the uploading session; script download names sanitised; **SQL Commands/Scripts text now logged (≤2000 chars),
  passwords in statements end up in the activity log**; known limit: big SELECT results fully buffered.
  Parity: SQL Scripts yes; Quick SQL yes (subset); Query Builder yes (simple, no canvas); XML loading yes; data load
  definitions yes. Tests 585 pass / 8 skip, e2e all pass.
- **i18n: DONE** (pushed `sprint-31-i18n`). Migration `040_globalization.sql`, HR `hr_30_formats.sql` page 29.
  export/import not redefined (whole `meta.app` row copied). No env vars. **`src/i18n/de.ts`, `fr.ts`, `es.ts` are
  `Record<MessageKey,string>`: every other branch's new keys must be added there (tsc flags them).** Behaviour change:
  number items now refuse non-numbers (422), as APEX. Hotspots: builder components/routes/report-settings; runtime
  routes (signIn, login form, posted items), engine (validate), report, regions, items, locale, account, charts, grid,
  pdf, report-views, render; db.ts (appTx), metadata.ts, app.js, app.css, security.test.ts (end + P22 test), guide
  04/05/09/11/12/14. Possible existing flake: files.test.ts "more files are added…" (order of contract/diploma.pdf).
  Security: time zone names only if exact in `pg_timezone_names` (≤64), bound `set_config(..., true)`; check
  constraints on app/account time_zone and app.currency `^[A-Z]{3}$`; `POST /a/:alias/tz` CSRF, own session only,
  no-op without automatic time zone; runtime role column grant on `meta.account.time_zone`, always `ctx.user`; mask
  literals/currency escaped, bad/over-long masks fall back, parser caps 200 chars, exponent 4 digits, NaN/Infinity
  refused; `FORMAT.CURRENCY` only if `^[A-Z]{3}$`.
  Parity: number format masks (report/grid/cards columns, charts, number/display items, locale separators, currency),
  Automatic Time Zone, runtime messages en/nl/de/fr/es: Done. Tests 587 pass / 8 skip, e2e 82/82.

**Merged and released (2026-10-05):** i18n, workshop-final, grid, logic, builder-final merged into `sprint-31`
(conflicts: appended test blocks, help texts, imports; workshop's and builder's `.script-results` CSS clash solved by
renaming builder's to `.support-results`; every new key of grid, logic and builder added to de/fr/es). Migration
**043**: export/import with 041's and 042's sections (042 had dropped 041's), and the list-entry parent check as an
AFTER trigger (the BEFORE trigger broke `pgapex import --replace` depending on row order). Tests: dev DB 713 pass /
8 skip, e2e 90/90; clean worktree with CI env only: fresh 713/8 and upgrade from v0.22.0 713/8. Released as
**v0.23.0** (parity 79/26/10/6). Sprint 32 not started (owner).

## Sprint 32 (DONE, v0.24.0): parity items one after another (owner: "keep going with the handoff.md, sprint and apex-feature-parity, with only 1 agent at the time", 2026-10-05)

Branch `sprint-32` from `main` (v0.23.0 + 3bb983a, the custom-auth test flake fix (same race as 68d8b65, which made
every CI upgrade job red after the sprint 31 merge) + 192f0af, CI actions checkout/setup-node/upload-artifact moved
to v7 (Node.js 24), both committed straight to `main`). **One agent at a time** works in the main checkout (no
worktree), dev DB `pgapex-db` on 5434, app 3100. Rules: `docs/development/sprint-32-agent-rules.md`. Items in order;
each one is finished, tested and committed on `sprint-32` (and pushed) before the next agent starts, so the branch
can be merged after any item:

| # | Item (parity row) | Reserved | Status |
|---|---|---|---|
| 0 | CI: actions off Node.js 20; custom-auth flake | (none) | done on `main` (3bb983a, 192f0af); CI run 37286030252 green, no Node 20 warning |
| 1 | Automations: several actions per automation (ordered, each with its own condition), error handling per row (stop / skip and continue, errors in the run log), on-demand runs from SQL (`meta.run_automation(...)`, like `APEX_AUTOMATION.EXECUTE`) | migration 044, HR `hr_33` | **done** (bcfec61..14943e4) |
| 2 | Workflow: an **invoke API** activity (a REST data source or URL through the existing invoke-API code, response values into workflow variables, outgoing allow-list/SSRF checks). No e-mail activity (no e-mail features) | 045 (unused), `hr_34` | **done** (ca079be..c6066d2) |
| 3 | Data Workshop: **unload data** (a table or a query to CSV, JSON, XLSX or XML, streamed with a cursor) | 046 (only if needed), `hr_35` (only if useful) | **done** (40da186, 00d6d40, a972bb6) |
| 4 | Create page wizards for more page types: cards, calendar, chart, map, faceted search report, form only, master-detail | 047 | **done** (497fd88..6561f5f) |
| 5 | Create application from a spreadsheet (upload CSV/XLSX → new table in the app schema + report and form pages) | 048 (unused) | **done** (379e32c..b18e83d) |

Later CI note: `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19; check the first CI run after that date (Postgres
service, Playwright deps).

**State at the handoff (2026-10-05, owner: "stop and create a handoff"):** items 0–3 are done and pushed;
`sprint-32` is clean and equal to `origin/sprint-32`; no agent and no dev server is running. Items 4 and 5 are not
started (no code, migrations 045–048 unused). `main` CI is green (run 37286030252). Nothing of sprint 32 is merged
into `main` yet; the branch is mergeable as it is (full suite last run by an agent after item 3: 760 pass / 8 skip,
e2e 90/90). To continue: launch one agent with "Read `docs/development/sprint-32-agent-rules.md` and follow it.
Item 4 of the Sprint 32 table in HANDOFF.md." (the item 4 row above has the scope: cards, calendar, chart, map,
faceted search, form only, master-detail; defaults from the catalog; functional + security tests), record its
report below, then item 5, then release 0.24.0 as described under "If a session ends". The owner may also choose to
release 0.24.0 with items 1–3 only.

**Coordinator already did (so a successor doesn't redo it):** parity rows Automations (✅) and Workflow (invoke API)
plus the summary counts (80/25/10/6) and the "Last reviewed" line; CHANGELOG `[Unreleased]` for items 0–3; Data Workshop row ✅ (counts 81/24/10/6); `.env.example` `UNLOAD_STATEMENT_TIMEOUT`; item 4: Create page wizards row ✅ (counts 82/23/10/6) and its CHANGELOG entry. Still to do
at release: rows for items 4–5, CHANGELOG entries for them, SECURITY.md (notes in the item reports below), version,
CI matrix + v0.24.0.

**If a session ends:** `git log --oneline main..sprint-32` and `git status`; make sure no agent is still editing (the
`git status` output stops changing); commit any uncommitted work as `wip:`;
launch the next agent with "Read `docs/development/sprint-32-agent-rules.md` and follow it. Item <n> of the Sprint 32
table in HANDOFF.md." When the items are done (or usage runs low): parity rows + summary counts, CHANGELOG 0.24.0,
SECURITY.md, `.env.example`, version, CI upgrade matrix + v0.24.0, chapter 12 version line, this file; clean-worktree
CI check (memory: CI has no `.env`), merge into `main`, tag v0.24.0, push, check `gh run list -R NickVrgr/Postgresql_APEX`.

**Parallel worktree (owner, 2026-10-05: "deploy another agent for the other tasks"):** items 2–4 run one after
another in a second agent, mode B: worktree `../pgapex-wt/ai2`, branch `sprint-36-ai2` (from `sprint-36` at 28e160d),
DB container `pgapex-ai2` on **5447**, app port **3102**. It builds on item 1's files without editing them and may
merge `sprint-36` in. When it reports: merge `sprint-36-ai2` into `sprint-36`, run the full tests on `pgapex-ci`,
then remove the worktree (`rm` the `node_modules` symlink first, never `rm -r`) and `docker rm -f pgapex-ai2`.
If the session ended mid-item: check `git log sprint-36-ai2`, and relaunch with "Read `docs/development/agent-rules.md`
and follow it in mode B. Sprint 36, items <n>… Worktree `../pgapex-wt/ai2`, branch `sprint-36-ai2`, DB 5447, app 3102."

**Item reports:** (filled in as agents finish)

- **Item 1 (done, e957689):** AI services (Workspace utilities, administrators; Claude via `@anthropic-ai/sdk`,
  OpenAI via `openai`; encrypted write-only keys or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`; per-app access with daily
  limits; usage log `meta.ai_usage`), process and dynamic action `ai_generate` (text, or structured output into items),
  `meta.ai_generate`/`ai_result`/`ai_available` from SQL, AI usage per app in the builder. Tables `ai_service`,
  `app_ai_service`, `ai_usage`, `ai_request`: not exported (KEPT/NOT_EXPORTED); export_app/import_app not redefined.
  HR `hr_41`, page 37 "Leave assistant" (shows "No AI service is configured" until an admin adds `HR_ASSISTANT`).
  Tests: npm test 992 (982 pass, 10 skipped), e2e 114/114, all against `test/ai-mock.ts`.
  **Open security item:** `meta.app_id()` is settable by app SQL, so `meta.ai_generate` / `meta.web_request` can be
  queued under another app's id (pre-existing for web requests; noted in SECURITY.md). Fix both together in a later item.
- **Items 2–4 (done, worktree `ai2`, fast-forwarded into `sprint-36`, worktree and `pgapex-ai2` removed):**
  item 2 (061, `hr_42`, page 38 "HR assistant"): region `ai_assistant` (conversation per session in
  `meta.ai_conversation`, context queries, SQL and REST tools with checked arguments, per-tool authz) and NL2IR
  (`"ai_filter"` on report regions → normal `r<id>_f/q/s/d` parameters); `src/ai/chat.ts` (tool loop for both
  providers). Item 3 (062): `meta.builder_ai`, SQL Workshop → AI (SQL from a question, explain, describe tables in
  `meta.ai_table_note`), "Create pages with AI" on the app dashboard. Item 4 (063): `src/blueprint.ts`, Create → From a
  blueprint, `meta.blueprint`. All new tables KEPT/NOT_EXPORTED; export_app/import_app not redefined; no env vars.
  Coordinator: `logUsage` shared from `src/ai/service.ts` (was copied in `chat.ts`), usage sources widened.
  Tests after merge (pgapex-ci): npm test 1038 (1028 pass, 10 skipped), e2e 128/128.

- **1 automations: DONE** (4 `wip:` commits bcfec61..14943e4, pushed). Migration `044_automation_actions.sql`:
  `meta.automation_action` (automation name, seq, name, code, condition with row binds; FK on `(app_id,
  automation_name)`, cascades), each old automation's code became one action "Action"; `meta.automation.code` stays
  but is always empty (writing it creates/replaces the single action, error if there are several: old scripts,
  `hr_08`, old exports keep working). `error_handling` stop (default) / skip (savepoint per row) / disable; run log
  has failed rows, first 50 row errors, status `warning`. One runner for all runs: PL/pgSQL `meta.automation_execute`
  (bind substitution ported from `src/binds.ts`, parity test). `meta.run_automation(p_name, p_raise default true)`:
  synchronous in the caller's transaction as the caller's role, current app only, automation's roles and user
  `automation:<name>` while running, same advisory lock as the scheduler, trigger `sql`. **044 redefines
  `export_app`/`import_app`** from 043 (section `automation_actions`, `code` left out). CLI dir layout
  `shared/automation-actions/<automation>/<seq>-<action>.json`. Builder Actions box (reorder without JS), error
  handling, row errors in the run history. HR `hr_33_automation_actions.sql` ("Remind managers" with 2 actions, skip;
  page 6 button "Send reminders now"). No env vars. Security: action table closed to app roles; `automation_begin/end`
  are security definer limited to `meta.app_id()` (an app can read its own automation definitions: same trust model as
  `pgapex.app_id`); `has_role()` answers with the automation's roles during a SQL run (treat them like a security
  definer function's); row values become escaped literals. Parity row → ✅ (text in the agent report: actions with
  conditions, stop/skip/disable, `meta.run_automation()`). Tests 730 pass / 8 skip, e2e 90/90, upgrade from v0.23.0 ok.
- **2 workflow invoke API: DONE** (ca079be..c6066d2, pushed). Step type `invoke_api` in `src/workflow.ts`: a REST
  data source of the app (`source` + `params`, its web credential) or a URL (`url`, `method`, `credential`, `body`);
  `&VAR.` from workflow variables; `variables` (variable → JSON path, or the source's first-row columns),
  `status_variable` (then an error status doesn't fault), `response_variable`, `timeout` 1–60 s. The page process's
  call code moved into `invoke()` in `src/websources.ts` (shared; allow-list, SSRF checks, credential URLs unchanged).
  **No transaction during the call:** the path is committed as `waiting` with a lease (3 × timeout + 30 s), the call
  runs, then a new transaction checks the path still waits with the same lease (terminated/retried meanwhile → result
  dropped); a server dying mid-call → lease expires → fault "didn't finish" (no automatic repeat of a POST). Limit: the
  in-process runner awaits each call. Builder help/validation, diagram class `.wf-invoke_api`, Advisor
  (`invokeStepReferences`). Steps are jsonb: no migration, export/import **not** redefined. HR
  `hr_34_workflow_invoke_api.sql` (workflow `DEPARTMENT_CHECK`, `hr.notify_me`, button on page 23). No env vars.
  Security: only own-app sources/credentials; host fixed by the developer (no substitutions in the host, URL-encoded
  after it); fields re-checked before each call; response can't overwrite `DETAIL_PK`/`WORKFLOW_ID`/`INITIATOR`;
  secrets never in variables/events/errors. Parity: add invoke API to the Workflow row, missing stays e-mail activity
  (not planned) and multi-tenancy. Tests 748 pass / 8 skip, e2e 90/90 (coordinator re-ran the full suite).
- **3 unload data: DONE** (40da186, 00d6d40, a972bb6, pushed). `/builder/sql/unload` (tab in `workshopTabs`, linked
  from Load Data): a table/view (columns, where, order by) or a query → CSV (separator, enclosure, heading, BOM;
  `csvField` from report.ts generalised), JSON (exact numbers, json embedded), XLSX (streaming `XlsxWriter`), XML
  (validated element names). DECLARE/FETCH batches of 1000 with back pressure, cap `DOWNLOAD_MAX_ROWS` (XLSX
  1,048,575). `unloadStatement()` reuses `splitScript`: exactly one SELECT/WITH/VALUES/TABLE; where/order text checked
  the same way. Own owner connection, `begin transaction read only` + `statement_timeout`, connection closed after
  (`release(true)`); logged `sql_unload`. Files `src/unload.ts`, `src/builder/unload.ts`. No migration (046 unused), no
  HR part, export/import not redefined. Env `UNLOAD_STATEMENT_TIMEOUT` (default 5min). Security: owner + developer
  session + CSRF like SQL Commands; read-only/one statement guard against mistakes, not a boundary (a developer can
  already run any SQL); nothing leaks into the pool. Tests 760 pass / 8 skip, e2e 90/90.
- **4 create page wizards: DONE** (497fd88..6561f5f, pushed). Migration `047_page_wizards.sql`: `meta.wizard_catalog`,
  `meta.wizard_defaults(kind, table)`, `meta.generate_page(app, kind, table, page, options jsonb)` for `form`, `cards`,
  `calendar`, `chart`, `map`, `facets`, `master_detail` (`report_form`/`grid` hand over to generate_crud/generate_grid).
  Builder `src/builder/wizards.ts`: step 1 type + table (GET), step 2 options with catalog defaults, POST creates the
  pages and opens the designer; no JS needed. Optional modal form page, navigation entry, calendar drag and drop off by
  default. Export/import not redefined; no HR part, no env vars. Security (for SECURITY.md): option column names must
  exist in the table and go into SQL only as `%I`, table names schema-qualified, fixed lists for types/functions/icons;
  `meta`, `pg_*`, `information_schema` refused; functions run as the caller, revoked from PUBLIC (tested for
  `pgapex_runtime` and an app role); developer session + CSRF + app lock; generated calendar move SQL runs as the app
  role (RLS) and the wizard warns to set `move_authz`. Limitation: the PostGIS map branch was checked only for its SQL
  (no PostGIS in dev/CI). Tests 776 pass / 8 skip, e2e 90/90.
- **5 create application from a file: DONE** (379e32c..b18e83d, pushed). `/builder/create/file` (upload, reuses
  `parseFile`, type inference and limits of `src/dataload.ts`, stored as a builder-session temporary file) →
  `/builder/create/file/:id` preview (app name, alias, schema, authentication, first user; table name; per column
  name/type, empty name skips) → one owner transaction: schema + role, table with identity `id`, rows via `loadRows`
  (all or nothing unless "skip rows with errors"), `analyze`, pages via `meta.generate_page` (2 report + 3 modal form,
  4 dashboard chart, 5 faceted search) with navigation. App creation moved to `src/builder/newapp.ts` (shared with the
  blank wizard); new `src/builder/appfromfile.ts`. No migration, no HR part, no env vars, export/import not
  redefined. Security: developer session + CSRF (also multipart), temp file only for the uploading session and
  deleted after, quoted lower-case identifiers in the app schema, fixed types; **behaviour change**: `meta`,
  `information_schema`, `pg_*` refused as parsing schema (also blank apps), blank app needs a name, alias ≤ 50 chars.
  Tests 789 pass / 8 skip, e2e 90/90.

**Released 2026-10-05 as v0.24.0:** parity rows (Create page wizards ✅, Create application wizard text; counts
82/23/10/6), CHANGELOG 0.24.0, SECURITY.md (five 0.24.0 rows), version, CI matrix + v0.24.0, chapter 12 line.
CI-style run in a clean worktree without `.env` (throwaway postgres:17 on 5446): 789 pass / 8 skip. Next: pick the
next sprint from the parity matrix (AI features still wait for the owner's decision on provider and API keys).

## Sprint 33 (DONE, v0.25.0): parity items one after another (owner: "please keep going, read the handoff and parity", 2026-10-05)

Branch `sprint-33` from `main` (v0.24.0). As in sprint 32: **one agent at a time** in the main checkout (no worktree),
dev DB `pgapex-db` on 5434, app 3100. Rules: `docs/development/sprint-33-agent-rules.md`. Each item is finished,
tested, committed and pushed on `sprint-33` before the next agent starts, so the branch can be merged after any item.

| # | Item (parity row) | Reserved | Status |
|---|---|---|---|
| 1 | Charts: Gantt (tasks with start/end, progress, dependencies optional), pyramid and polar charts, server-side SVG like the others, with drill-down and the data-table alternative | 048 (unused), `hr_35` | **done** (5d857e8..acf68b0) |
| 2 | Map region: marker clustering, several layers per map (markers, lines/areas, heat map each with its own query), spatial filtering on the server with PostGIS when installed (bounding box / distance) and a plain lat/lng fallback | 049 (unused), `hr_36` | **done** (1d885c6..9b67ee1) |
| 3 | REST data sources: writing back from forms and grids (insert/update/delete through the source's endpoints), synchronisation into a local table (on demand and scheduled, merge/replace), OAuth2 password flow and refresh tokens | 050, `hr_37` | **done** (3875dd2..87ad118) |
| 4 | Debug messages (APEX debug): `meta.debug(level, text)` from application SQL, per-request debug entries with timings when debug is on, a viewer in the builder per page view, retention; plus an install/upgrade log of migrations in the builder's administration | 051, (no HR) | **done** (02afbf9..2b10cc4) |
| 5 | APEX PL/SQL API equivalents: `meta.web_request(...)` (APEX_WEB_SERVICE through the outgoing allow-list/SSRF checks), `meta.parse_data(...)` (APEX_DATA_PARSER for CSV/JSON/XLSX in bytea) where feasible in SQL, documented as a reference | 052, `hr_38` (only if useful) | **done** (58da370..f10b12e) |
| 6 | Theme Roller: style variants (several saved styles per app, switch per user) and template options on regions/buttons (a fixed list of CSS classes per component) | 053, (no HR) | **done** (565281a..86f0088) |

**State at the handoff (2026-10-05, owner: "stop and commit / update handoff and feature parity for switching to
another Claude account"):** all six items are done, committed and pushed; `sprint-33` is clean and equal to
`origin/sprint-33`; no agent is running. Nothing of sprint 33 is merged into `main` and 0.25.0 is not released.
Last full runs on the throwaway DB: after item 5 on a **fresh** database in a clean worktree without `.env`: 877 pass /
10 skip, e2e 103/103. Item 6's agent: e2e 107/107, unit 891 pass / 1 fail (export.test.ts, then fixed in 86f0088 and
re-run for export/cli only) → **a full `npm test` after item 6 is still owed** (expected 892 pass / 10 skip).

**Release (2026-10-05, next session):** item 1 below fixed by migration `054_import_app_debug_defaults.sql` (a
`before insert or update` trigger on `meta.app` coalescing `debug_level`/`debug_retention_days`, like 053) and a test
in `test/export.test.ts` that strips the 050–053 keys from an export. 050's keys were already defaulted by
import_app. CI-style run in a clean worktree without `.env` on a fresh postgres:17 (5446): **893 pass / 10 skip,
e2e 107/107**. Released as 0.25.0 (SECURITY.md rows for items 1–6, CI matrix v0.25.0, CHANGELOG, chapter 12).

**Next, in order (as it was at the handoff; all done):**
1. **Fix (bug found at the handoff, blocks the release):** importing an export made before migration 051 (e.g. any
   v0.24.0 export) fails: `null value in column "debug_level" of relation "app" violates not-null constraint` (also
   `debug_retention_days`). `meta.import_app` builds the app row with `jsonb_populate_record`, so a missing key becomes
   an explicit NULL and the column default doesn't apply. Reproduce: `begin; select
   meta.import_app(meta.export_app('hr') #- '{app,debug_level}', 'zz_t'); rollback;`. 051 is **not released**, so
   fix it in a way that also works for databases that already ran 051 (dev DB, CI-style DBs): e.g. a new migration 054
   (sprint 34 then starts at 055) with a `before insert` trigger on `meta.app` that coalesces both columns to their
   defaults (053 did the same for `template_options` on region/button: copy that pattern), plus a test in
   `test/export.test.ts` that imports an export without the 051/053 keys. Check the other columns added by 050–053
   the same way (050's are filled by import_app's defaults; 053's `meta.app.theme` keys are inside jsonb).
2. Full `npm test` + `npm run test:e2e` in a clean worktree without `.env` against a **fresh** throwaway postgres:17
   (memory: CI has no `.env`). Env for that: `DATABASE_URL=postgres://pgapex:pgapex@localhost:5446/pgapex
   RUNTIME_DATABASE_URL=postgres://pgapex_runtime:pgapex_runtime@localhost:5446/pgapex
   API_JWT_SECRET=ci-only-api-secret-not-for-production-0123456789 API_URL=http://127.0.0.1:1`. The container
   `pgapex-ci` (port 5446) may still exist: `docker rm -f pgapex-ci` and start a new one.
3. Release 0.25.0: SECURITY.md (security notes of items 1–6 are in the reports below), `.env.example` (no new vars
   in sprint 33), version in package.json, CHANGELOG `[Unreleased]` → `[0.25.0]`, CI upgrade matrix + v0.25.0,
   chapter 12 version line, this file (migrations 048–053 released; 048 and 049 unused), then merge into `main`, tag
   v0.25.0, push, check `gh run list -R NickVrgr/Postgresql_APEX` (the local `gh` may lack access: give compare URLs).
4. Sprint 34 (planned below).

Environment notes for the next session: a `tsx watch src/server.ts` (pid 144937, started 13:37, maybe the owner's)
keeps a dev server on 3100 against the dev DB; its scheduler made scheduler/workflow tests flaky, which is why the
agents ran tests on the throwaway DB. It was not killed.

**If a session ends:** `git log --oneline main..sprint-33` and `git status`; make sure no agent is still editing;
commit any uncommitted work as `wip:`; launch the next agent with "Read `docs/development/sprint-33-agent-rules.md`
and follow it. Item <n> of the Sprint 33 table in HANDOFF.md." The coordinator records each report below and updates
the parity row(s) + summary counts and CHANGELOG `[Unreleased]` after each item. At the end (or when usage runs low):
SECURITY.md, `.env.example`, version 0.25.0, CI upgrade matrix + v0.25.0, chapter 12 version line, this file;
CI-style run in a clean worktree without `.env` (throwaway postgres:17 on 5446), merge into `main`, tag, push, check CI.

**Item reports:** (filled in as agents finish)

- **1 charts: DONE** (5d857e8..acf68b0, pushed). `gantt`, `pyramid`, `polar` in `src/runtime/charts.ts` (SVG, nonce'd
  classes, tooltips, data table, checksummed drill-down); Gantt columns label/start/end + optional `progress`,
  `task_id`, `depends_on`. Page Designer chart settings; `chart.*` texts in 5 languages. HR `hr_35_project_charts.sql`
  (`hr.project_task`, page 32 "Project plan"). No migration, export/import not redefined, no env vars. Not done: the
  create-page wizard's chart types (fixed list inside 047's `meta.generate_page`; would need a migration). Known
  issue: the Gantt "today" line uses the server's UTC time, not the session time zone. Security: region query as
  the app role (RLS), values escaped, dependency ids only used as map keys, `kind` allow-listed. Tests 802 pass /
  8 skip, e2e 94/94. Coordinator: Charts row ✅, Regions 17/3, totals 83/22/10/3, CHANGELOG `[Unreleased]`.
- **2 maps: DONE** (1d885c6..9b67ee1, pushed). `config.layers` (≤7 extra: name, source SQL as the app role, markers or
  heat, cluster, link, hidden), legend toggle, colour per layer, per-layer errors; clustering in `public/app.js`;
  `src/runtime/spatial.ts` (area helpers moved from report.ts): `r<id>_bb` and new `r<id>_near=lat,lng,km` (map
  `filter: "distance"`), PostGIS detected via `pg_extension` (cached 1 min) → `ST_Intersects`/`ST_DWithin`, else
  lat/lng box + haversine (poles, antimeridian). Builder map settings per layer, Advisor checks layer SQL. Gantt today
  line in the session time zone. HR `hr_36_map_layers.sql` page 33 "Field visits" (`hr.field_visit`). No migration,
  export/import not redefined, no env vars. Verified against `postgis/postgis:17-3.5` (throwaway, port 5447); a
  real-PostGIS test skips without the extension. Security (for SECURITY.md): layer SQL as the app role (RLS), links
  only to openable pages, names/texts as escaped JSON or HTML and DOM-built popups, `_near`/`_bb` parsed as numbers
  with range checks (only narrow visible rows), the app role needs USAGE on the PostGIS schema. Tests 823 pass /
  9 skip, e2e 95/95. **Note:** an `npm run dev` (`tsx watch`, started 13:34 outside this session) shared the dev DB
  and made workflow/job tests fail; the agent stopped its listener on 3100 but its watcher (pid 144937) restarts it
  on file changes. Not killed by the coordinator (may be the owner's).
- **3 REST write-back, synchronisation, OAuth2: DONE** (3875dd2..87ad118, pushed; the agent's session ended after
  the e2e commit, the coordinator wrote the chapter 19/12 docs and fixed the Advisor). Migration
  `050_rest_writeback_sync.sql`: `meta.rest_source` gets `key_columns`, `operations` (insert/update/delete/fetch:
  method, path after the source's URL with `{column}`/`{param}` URL-encoded, JSON body template, row_selector) and
  `sync_*` (table, merge/replace/append, delete missing, cron schedule + time zone, enabled, run state);
  `meta.rest_sync_log` (last 100 per source); `meta.request_rest_sync(name)` (queues a run for the scheduler,
  current app only) and `meta.rest_sync_status(id)`. `meta.web_credential`: `grant_type`
  (client_credentials/password/refresh_token), `oauth_username`, `password_enc`, `refresh_token_enc` (stored and
  rotated by the server, owner connection only), `token_refreshed_at`. **050 redefines `export_app`/`import_app`**
  from 044 (new secrets and sync state left out, imported syncs switched off). Code: `src/restsync.ts` (writeRows as
  the app role in one transaction, `meta.app_user()` = `rest_sync:<SOURCE>`, advisory lock per source, `syncTick()`
  from the automations scheduler), write-back in `src/runtime/rest-sources.ts` + `grid.ts` + `engine.ts` (form fetch
  and form_dml, grid Add/Save/Delete only for defined operations; updates send the row as read in this request plus
  the changes), `callOperation` in `src/websources.ts`; builder Write back / Synchronisation groups, Synchronise now,
  run history, OAuth2 fields; `pgapex import --replace` keeps the new secrets and sync state. HR
  `hr_37_rest_writeback.sql` page 34 "Contacts (REST)" (`hr.crm_contact` behind an HR REST module, copy
  `hr.crm_contact_copy`). No env vars. Security (for SECURITY.md): operation paths validated (no host, `..`, `:`,
  `//`), values URL-encoded, host fixed, allow-list/SSRF checks and credential URL limits on every call; password and
  refresh token encrypted, write-only, not readable by the runtime role, never exported or logged; grid writes only
  writable columns (key, read-only and master columns excluded); sync writes as the app role (grants/RLS);
  `request_rest_sync` limited to `meta.app_id()`. Limits: no transaction across web-service calls (a grid save
  failing halfway leaves earlier rows sent); no OAuth2 authorization code flow; no XML/SOAP. Coordinator: parity row
  ✅, Data and integration 7/1/1/2, totals 84/21/10/3, CHANGELOG `[Unreleased]`. Tests (clean worktree, no `.env`,
  throwaway postgres:17 on 5446): 844 pass / 10 skip, e2e 99/99.
- **4 debug messages: DONE** (02afbf9..2b10cc4, pushed). Migration `051_debug_messages.sql`: `meta.app.debug_level`
  (0, 1/2/4/6/9) and `debug_retention_days` (1–90, default 7); `meta.debug_view` (one row per recorded request) and
  `meta.debug_message`; `meta.debug(level, text)`, `meta.debug(text)`, `meta.debug_enabled(level)`,
  `meta.debug_level()` (public); `meta.debug_save`/`debug_purge` security definer, runtime only (≤5000 requests per
  app). `meta.debug()` raises a NOTICE tagged `pgapex.debug`, collected per connection by `appTx` while debug is on
  (kept on rollback); other warnings level 2, notices level 9. `src/debug.ts` (DebugLog only when level > 0; steps,
  regions, processes, branches, errors; saved in a root `onResponse` hook; purge from the scheduler hourly). Debug
  off: no writes, only one more `set_config` in the existing statement. Builder Activity → Debug messages
  (`/builder/apps/:id/debug`), Workspace utilities → Installation (`/builder/installation`, admins);
  `src/migrate.ts` logs runs in `public.pgapex_install_log`. **Export/import not redefined** (the two app columns
  travel; an imported app keeps the exporter's debug level, like the old `debug` flag). No env vars, no HR part.
  Security (for SECURITY.md): app roles/runtime have no rights on the debug tables; viewer needs a developer session +
  CSRF, request shown only under its own app; password item values and URL query values never recorded, item values
  only at level 9 (cut at 200 chars); DB error messages may quote values (level 1, like the activity log); any
  developer can see any app's debug (no per-app developer access); Installation page admins only. Not done:
  background jobs/automations/REST API not recorded; no per-user/session debug switch. Coordinator: Debug messages
  ✅, Instance administration stays 🟡 (text extended), Administration 3/1/1/0, totals 85/20/10/3, CHANGELOG.
  Tests (throwaway DB on 5446): 859 pass / 10 skip, e2e 99/99.
- **5 SQL API equivalents: DONE** (58da370..f10b12e, pushed). Migration `052_web_request_parse_data.sql`:
  `meta.web_request(url, method, body, headers, credential, timeout_s)` / `meta.web_request_source(source, params,
  timeout_s)` queue a row in `meta.web_request_log` (URL/method/header/body checks, ≤100 waiting per app, own-app
  credential/source); `meta.web_response(id)` (jsonb) / `meta.web_response_blob(id)` (NULL for other apps). Made by
  `src/webrequests.ts`: `runPending()` right after a `sql` page process (same transaction, ≤5 per process, also in
  chains) and `webRequestTick()` on the scheduler pass after commit (≤50 per pass, 5 at a time, SKIP LOCKED);
  through `websources.ts` `call()`/`invoke()` (new `secretHeaders` option: app auth-like headers dropped on
  cross-origin redirects). Retention 24 h / 500 per app; stuck running → error after 15 min. `meta.parse_data()` /
  `meta.parse_data_columns()` in PL/pgSQL for CSV/TSV/JSON (names, types, delimiter detection, Windows-1252 fallback
  as `src/dataload.ts`, compared in tests; 100k rows ≈ 1.2 s); XLSX (no inflate in SQL) and XML refused with a hint.
  HR `hr_38_parse_and_fetch.sql` page 35. **Export/import not redefined** (`web_request_log` in `KEPT` of
  `src/cli/replace.ts`). No env vars (`PUBLIC_URL` now also visible to SQL as `pgapex.public_url`). Security (for
  SECURITY.md): allow-list/SSRF/redirect/size/credential URL checks on every call; secrets never in the log or SQL;
  log table closed to app/runtime roles, security definer functions limited to `meta.app_id()`;
  `web_request_take/done` only act on requests queued in the caller's own transaction; headers re-filtered before
  sending; responses belong to the app, not a user (any app code with the id can read it); `parse_data` runs as the
  caller, row cap 1,000,000, XML refused. Not done: synchronous call inside one statement, XLSX/XML parsing, a
  builder page for web requests, binary/multipart bodies, debug entries for scheduler-made requests. Coordinator:
  APEX PL/SQL APIs row text (stays 🟡), extensions table note, CHANGELOG, hr_37 row in `examples/hr/README.md`.
  Agent tests (reused DB on 5446): 877 pass / 10 skip, e2e 103/103.
  Coordinator re-ran on a fresh DB in a clean worktree: 877 pass / 10 skip, e2e 103/103.
- **6 Theme Roller: DONE** (565281a..86f0088, pushed). Migration `053_theme_styles_template_options.sql`. Style
  variants in `meta.app.theme` (`styles` ≤10, `style` default, `style_choice`): accent/header `#rrggbb`, 6 fixed font
  stacks, size 14–17 px, radius 0/4/8/14; "Standard" = the base colours. `src/runtime/styles.ts` (lists, `parseStyle`,
  `appStyles`, request style, `themeCss()` into the nonce'd `<style id="pgapex-css">`); `public/app.css` uses
  `--font`, `--font-size`, `--radius`. Builder Settings → Theme → Theme Roller (`/builder/apps/:id/theme`,
  `src/builder/themeroller.ts`; rename/delete move or drop users' choices; Settings saves only its own theme keys).
  User choice: user menu + My account → `POST /a/:alias/account/style`, kept in `meta.account_style` (per app,
  loaded at sign-in; session only when signed out). Template options: `template_options text[]` on `meta.region` and
  `meta.button` (fixed lists in `src/runtime/template-options.ts`, `to-*` classes; Page Designer checkboxes, new
  `options` field kind); a trigger turns NULL into `'{}'` so older exports import. **Export/import not redefined**
  (styles travel in `meta.app.theme`; `account_style` in `KEPT`/`NOT_EXPORTED`). No env vars, no HR part. Docs ch. 4
  (Template options), 14 (Style variants), 3, 9, 11, 12, 18. Security (for SECURITY.md): only checked hex values and
  fixed constants become CSS, re-checked on every render (a bad hand-edited style is skipped); style names only as
  escaped HTML; list lookups by own keys (`__proto__` refused); style switch CSRF + `safeNext`, only the app's own
  styles; `account_style.style` format check, runtime role rights on that table only; Theme Roller needs developer
  session + CSRF, respects app locks; template options shape-checked in the DB, only listed classes rendered; no
  inline styles. Not done: live preview, style colours in dark mode, conditional/dynamic properties, template options
  on items/report columns. Coordinator: Theme Roller row text (stays 🟡: 26.1 conditional/dynamic properties missing),
  Dark mode row text, CHANGELOG; totals unchanged 85/20/10/3. Tests: see "State at the handoff" above.

## Sprint 37 (DONE, v0.29.0): Workspaces, an "Iris"-like default style, then the 🟡 rows (owner, 2026-10-06: "move on with the next tasks from the handoff and apex-feature-parity, work autonomously")

Branch `sprint-37` from `main` (v0.28.0). One agent (mode A), tests on `pgapex-ci` (5446).

| # | Item | Reserved | Status |
|---|---|---|---|
| 1 | **Workspaces** (row "Workspaces (multi-tenant)"): `meta.workspace`, `meta.workspace_member`, `meta.app.workspace_id` (existing apps and developers → workspace 1 "Default"); current workspace in the builder session (switcher in the header); app lists, dashboard, search, create/import, working copies scoped to it; every `/builder/apps/:id` and `/builder/pages/:pid` request (GET and POST) refused with 404 for an app outside the developer's workspaces (administrators: all); Workspace utilities → Workspaces (administrators): create, rename, delete when empty, members, move applications | 064 | **done** (tests: `test/workspaces.test.ts`, security block "sprint 37 workspaces"; e2e builder pages `workspaces`, `workspace`) |
| 2 | **New default style like "Iris"** (row ❌): `theme.base = 'iris'` → `<html data-style="iris">`, a full light/dark variable set in app.css, default for new applications, a Base style choice in Settings → Theme | none (theme jsonb) | **done** (tests in `theme-styles.test.ts` "base style Iris", e2e Iris pages in responsive) |
| 3 | 🟡 rows, one by one: (a) drawer pages and top/bottom dialogs (065: `meta.page.dialog_position`, `dialog_size`), (b) built-in template components timeline, comments, media list, avatar, metric card, (c) Theme Roller: dark colours of styles, template options on items and report columns, (d) interactive report: maximum rows, selection across pages, (e) instance settings, (f) more runtime languages | 065+ | (a) **done** (065, `hr_43`, `test/drawers.test.ts`, e2e drawer test); (b) **done** (`src/runtime/builtin-components.ts`, `hr_44` page 39, tests in `template-components.test.ts`); (c) **done** (066 item template options, column_options, dark colours, live preview); (d) **done** (selection across pages: POST …/report/<id>/select; IR row ✅); (e) **done** (`src/instance.ts`, `/builder/instance`, row ✅); (f) **done** (it, pt, pl, sv, da, nb (+ `no`), cs, ja, zh: fourteen languages) |

**Workspaces design decision:** not a security boundary between developers who write SQL. Application code runs on the
runtime connection with `SET LOCAL ROLE` (a `RESET ROLE` in a process gets pgapex_runtime's rights), the SQL Workshop
runs as the owner, and security definer functions trust `pgapex.*` settings. Real tenant isolation would need a
separate runtime login per workspace and an audit of the 73 definer functions. Workspaces therefore organise
applications and developers and limit what the builder shows and changes; the docs say so and recommend separate
installations (databases) for tenants that must not see each other. Parity row → 🟡.

**Release 0.29.0 (2026-10-06):** CI-style run on 5446: 1069 pass / 10 skip, e2e 136/136. Parity totals 100/15/0/3
(85% available). Also fixed on the way: temporary files of one upload are stored in the order chosen (a flaky
files test); a server waiting for migrations recovers by itself once they are applied.

## Sprint 39 (IN PROGRESS): every remaining 🟡 parity row except languages (owner, 2026-10-06: "make sure that all other apex feature parity are done before you continue with the other languages")

Branch `sprint-39` from `main` (v0.30.0). One agent; tests on 5446. Migrations from 068.

| # | Parity row | Plan | Status |
|---|---|---|---|
| 1 | Dynamic actions (custom JavaScript) | Static application files (Shared Components; JS/CSS served same-origin, so the CSP stays `script-src 'self'`), app/page file references, DA action *Execute JavaScript* calling a function the app's file registers | **done**: migration 068 (`meta.static_file`, `static_includes` on app and page), `src/runtime/static-files.ts` (route, `staticHead`), `src/builder/static-files.ts`, `window.pgapex` in app.js, dir layout `static/`, `hr_46`; tests `static-files`, `e2e/static-files`, security block; rows ✅ (DA + new *Static application files* row; totals 104/12/0/3) |
| 2 | Plug-ins (item/region/process/DA with own code) | A plug-in file bundling template component(s), static files and SQL; region/item/DA plug-ins built on 1 | **done**: migration 069 (`meta.plugin`, type/action `plugin`, `dynamic_action.config`, `meta.import_plugin`), `src/runtime/plugins.ts`, `src/builder/plugins.ts`, `pgapex.plugins.register` in app.js, `pgapex plugin build\|install`, `examples/plugins/<name>/` sources + built files, `hr_47` (page 40); tests `plugins`, e2e, security; row ✅ (105/11/0/3) |
| 3 | Theme Roller conditional/dynamic properties | Style chosen by a SQL rule per request; CSS variables from item values (checked) | **done**: `condition` and `&ITEM.` colours in `src/runtime/styles.ts`, `resolveConditionalStyle` in render.ts, Theme Roller fields; tests in `theme-styles`, security block; row ✅ (106/10/0/3) |
| 4 | APEX PL/SQL APIs | XML in `meta.parse_data`, `meta.v_boolean`, JSON builder mapping, zip | **done**: migration 070 (XML via xmltable mirroring `xmlTable`, Excel via `meta.unpacked_file` filled by `src/unpack.ts` on upload/web response, `meta.zip_*`, `meta.v_boolean`), docs ch9; tests `sql-apis`, security; rows APIs + BOOLEAN ✅ (108/8/0/3) |
| 5 | File browse: object storage | S3-compatible storage for file items (SigV4, web credentials) | **done**: migration 071 (`aws_sigv4` credentials), `src/objectstore.ts`, files.ts/engine.ts (`object_store`, `size_column`, after-commit/rollback hooks in `appTx`), docs ch16/19; tests `object-storage` (mock S3 checking signatures), security; row ✅ (109/7/0/3) |
| 6 | Map region | Vector tiles; layers filtered by the visible area | **done**: no migration (region config `visible_area`, `tiles` per layer); `src/mvt.ts` (MVT 2.1 encoder, no dependency), `servedLayer`/`layerInArea`/`layerTile` in `src/runtime/maps.ts`, routes GET `…/map/:id/layer/:n?bb=` and `…/map/:id/tiles/:n/:z/:x/:y.mvt` in routes.ts, app.js `areaLayer`/`vectorTiles` (own MVT reader, canvas, click hit-test, `map.zoom_in` note in 22 languages), builder *Load* field, `hr_48` (page 41, 20 000 stations); tests `map-tiles` (independent MVT decoder), e2e maps, security block; row ✅ (110/6/0/3) |
| 7 | SQL scripts, query builder | A graphical query builder canvas | **done**: `querybuilder.ts` (drawn joins `j`/`ja`+`jb`, functions `fn=ref:fn` with group by, positions `p`, table order `o`, fixes aliases shifting after Apply), canvas in builder.js `setupQueryCanvas` (no inline styles: CSSOM), builder.css `.qb-*`; tests `workshop` (Query builder), e2e `query-builder`, security block; row ✅ (111/5/0/3) |
| 8 | Workflow multi-tenancy | Tenant per workflow instance | **done**: migration 072 (`meta.session.tenant_id`, `meta.set_tenant`/`tenant_id()`, `tenant_id` on workflow/task/process_job defaulting to `meta.tenant_id()`, `task_rights` and the two views filter), `appTx` reads the session's tenant per transaction, the runner and process jobs set it; tests `tenants`, security block; row ✅ (112/4/0/3) |
| 9 | APEXlang | A human-readable text format for the directory export | **done**: `src/yamltext.ts` (strict YAML subset writer/reader, cross-checked with PyYAML on the whole HR export), `docToFiles(doc, 'text')`, reader takes .json or .yaml per file, `pgapex export --format text`, diff in the directory's style, builder `?format=text`; migration 073 `meta.region.static_id` (region key in exports, `data-static-id`, builder field, replace.ts keeps saved reports); tests `yamltext`, `cli` (text round trip, mixed, static ids), security block; row ✅ (113/3/0/3) |
| 10 | Icons | Grow the set further | **done**: dependency `lucide-static` (ISC; NOTICE), `src/icons.ts` (`iconParts`/`isIcon`, modifiers, `fa-` names, `lucideSymbol`, `searchIcons`), route `/static/icon/:file` (app.ts, immutable cache, licence comment kept), builder `GET /builder/icons/search`, picker "any icon" field (`<name>__custom`, checked in `parseFields`) and live search (builder.js), modifier CSS in app.css; tests `icons`, e2e `icons`; row ✅ (114/2/0/3) |
| 11 | BOOLEAN session state, Workspaces isolation | Typed boolean helpers; per-workspace runtime login | BOOLEAN **done** with item 4 (`meta.v_boolean`); workspaces isolation todo |
| 12 | PWA push notifications (owner, 2026-10-06; keys per app, as in APEX) | VAPID per app, RFC 8291 encryption without a dependency, queue + NOTIFY, My account switch, `push_subscribe` DA, `send_push` process | **done**: migration 074 (`meta.app.pwa_push`, `meta.push_key` (not on meta.app: export_app exports every app column), `meta.push_subscription`, `meta.push_message`, `meta.send_push`/`has_push_subscription`, revoke triggers on account/app_access, new process type and DA action); `src/push.ts` (keys, `encryptPayload`, `vapidHeader`, `subscriptionProblem`, `pushTick`, listener started in server.ts, fallback in the scheduler); `src/webclient.ts` takes a host list of its own (`hosts`); `src/runtime/push.ts` (routes `/a/:alias/push/subscribe|unsubscribe`, My account section; the account page now has a `pgapex-meta` script); `public/app.js` (`pgapexPush` at the top: one user per device via localStorage), `public/sw.js` (push, notificationclick, unsubscribe on sign-out with the form's CSRF token); builder `src/builder/pwa.ts` (stats, test, new keys); texts in 22 languages; tests `test/push.test.ts` (RFC 8291 example byte for byte, a local push service), `test/e2e/push.test.ts` (full Chromium: the headless shell has no notifications; incognito has no Push API, so a real subscription is not tested in a browser), security block |
| 13 | Parity review (owner, 2026-10-06) | Compare APEX features missing from the matrix | **done**: 18 rows added (Ajax callbacks, DA events/actions, lost update detection, region templates, developer toolbar, …); roadmap item 3 orders them |

## Sprint 38 (DONE, v0.30.0): the remaining 🟡 rows (owner's standing instruction: keep going without asking)

Branch `sprint-38` from `main` (v0.29.0). One agent; tests on 5446.

| # | Item | Reserved | Status |
|---|---|---|---|
| 1 | Icons: 136 line icons (was 39), an icon picker in the builder (`forms.ts iconPicker`) | — | **done** (`test/icons.test.ts`) |
| 2 | Accessibility: axe-core (dev dependency) audit in `test/e2e/accessibility.test.ts`; fixes (role=img chart marks, tree toggles, rich-text buttons, scrolling tables, contrast) | — | **done**, row ✅ |
| 3 | Cropping pictures before upload (file item `"crop"`), crop dialog in app.js, texts in all languages | `hr_45` | **done** |
| 4 | Session sharing between applications (`meta.app.session_group`, `meta.shared_login`, `src/sharedlogin.ts`) | 067 | **done** (`test/session-sharing.test.ts`), row ✅ |
| 5 | `meta.zip` / JSON builder APIs | — | **not started** (PostgreSQL can't deflate in SQL; would need a server-side queue like `web_request`) |
| 6 | More built-in languages: fi, tr, el, ru, uk, ko, ar, he (22 in all) | — | **done** |

Parity totals after sprint 38: 102 / 13 / 0 / 3 (86% available).

**Release 0.30.0:** CI-style run 1081 pass / 10 skip, e2e 141/141.

**Owner, 2026-10-06: "make sure that all other apex feature parity are done before you continue with the other languages."**
Sprint 39 therefore takes every remaining 🟡 row except the languages row: APEX PL/SQL APIs (zip, JSON), map vector
tiles, timeline… (see the parity matrix), Theme Roller conditional properties, workflow multi-tenancy, APEXlang, file
object storage, BOOLEAN session state, dynamic action/plug-in rows (decide ✅ or ➖ by design), SQL Workshop graphical
query builder, workspaces isolation.

## Sprint 36 (DONE, v0.28.0): AI with Claude and OpenAI (owner, 2026-10-05: "keep going, I want Claude and OpenAI as options for the AI, work with 1 agent and keep going, don't stop")

Branch `sprint-36` from `main` (v0.27.0). **One agent at a time** in the main checkout; tests on the throwaway DB
`pgapex-ci` (5446). Rules: `docs/development/agent-rules.md`, mode A, plus its "Sprint 36" section (official SDKs
`@anthropic-ai/sdk` and `openai` allowed, keys encrypted, mock server in tests, default Claude model `claude-opus-5-5`).
To continue: launch one agent with "Read `docs/development/agent-rules.md` and follow it (mode A). Sprint 36, item <n>."
Each item finished, tested, committed and pushed before the next agent starts. After sprint 36: release 0.28.0, then
sprint 37 (Workspaces, a new default style like "Iris", 🟡 rows) without asking.

| # | Item (parity rows) | Reserved | Status |
|---|---|---|---|
| 1 | **AI foundation + *Generate Text with AI* + structured outputs** (row "Generate Text with AI process, structured outputs"): `src/ai/` provider interface (Claude, OpenAI), AI services in the builder's administration (provider, model, encrypted key, base URL for admins, enabled per app, token/request limits), usage log; page process *Generate text with AI* (system prompt, user prompt with `&ITEM.` substitutions, output into an item; structured output with a JSON schema mapping fields to items); a dynamic action to run it without a full page submit; usage per app in the builder | 060, `hr_41`, HR page 37 | **done** (e957689) |
| 2 | **AI assistant, NL2IR, agents and tools** (row "AI assistant, natural-language reports (NL2IR), AI agents and tools"): a chat region (conversation per session, system prompt, optional RAG over developer-chosen queries run as the app role), agents with tools the developer defines (SQL queries/functions run as the app role with bound arguments, REST data sources), natural language → interactive report filters/sorts on a report region | 061, `hr_42`, page 38 | **done** (sprint-36-ai2) |
| 3 | **App Builder AI** (row "AI assistant, pages from natural language, describe tables for LLMs"): describe tables/columns for LLMs (annotations kept as comments/meta), create page(s) from a description (proposes `meta.generate_page` calls the developer confirms), SQL Workshop: SQL from a question (shown, never run automatically), explain a query/error | 062 | **done** (sprint-36-ai2) |
| 4 | **Blueprints / spec-driven development** (row "Blueprints, spec-driven development"): a JSON blueprint (tables, pages, navigation, sample data) → a new app; optionally drafted by AI from a description, always reviewed before creation | 063 | **done** (sprint-36-ai2) |

**Item reports:** (filled in as agents finish)

**Release 0.28.0 (2026-10-06):** the owner found 500s (`column "app_type" does not exist` on `/builder/create`,
`column a.debug_level does not exist` on app pages): the dev DB was still at migration 050. Fixed by migrating, and the
server now checks at start: missing migrations → every request gets a 503 naming them (or `MIGRATE_ON_START=true`
applies them). A GET crawler (scratch script, not in the repo) visited the builder (1001 URLs), every Page Designer
and Shared Components node (4078), the HR app as king/allen/blake (777/456/474 URLs) and every HR region refresh
endpoint: no 500s and no SQL errors. CI-style run on 5446: 1029 pass / 10 skip, e2e 128/128.

## Sprint 35 (DONE, v0.27.0): three parity workstreams in parallel (owner, 2026-10-05: "run 3 agents and move on with the next tasks to do")

Branch `sprint-35` from `main` (v0.26.0). Three agents in git worktrees under `../pgapex-wt/<name>`, branch
`sprint-35-<name>`, each with its own `postgres:17` container and app port in the worktree's `.env` (`node_modules` is a
symlink: remove it with `rm`, never `rm -r`, before `git worktree remove`). Rules: `docs/development/sprint-35-agent-rules.md`.
AI rows stay out. The coordinator merges the three branches into `sprint-35` (conflicts expected only in appended
blocks: app.ts, security.test.ts, responsive.test.ts, replace.ts, export.test.ts, CSS, docs), then records reports,
parity rows, CHANGELOG, SECURITY.md and releases 0.27.0.

| Worktree / branch | Gap (parity row) | Container, ports | Reserved |
|---|---|---|---|
| `reporter` / `sprint-35-reporter` | **Data Reporter** (26.1, ❌): business users build their own reports in the running app from data sources the developer exposes (curated tables/views per app): pick columns, filters, sort, group with aggregates, optional chart; save privately or share with the app's users; run as the app's role (RLS); a region type or page the developer places, plus the builder side to define the sources | `pgapex-reporter`, 5451, app 3121 | migration 057, `hr_39`, HR page 36 |
| `sampledata` / `sprint-35-sampledata` | **Sample data for development** (26.1, ❌; APEX Data Generator): SQL/Data Workshop page to generate realistic rows for one or more tables: per-column generators inferred from names and types (names, e-mail-like strings, dates in a range, numbers, values from a list, foreign keys picking existing parent rows, nulls %), row counts, preview, insert in one transaction (parents first) or download as SQL/CSV; saved generator definitions to rerun | `pgapex-sampledata`, 5452, app 3122 | migration 058, `hr_40` (only if useful) |
| `appwizard` / `sprint-35-appwizard` | **Create application wizard** (🟡 → ✅): from a file with several sheets/tables (XLSX sheets → several tables, foreign keys proposed from matching columns), from pasted data (CSV/TSV text), and from existing tables (pick tables of a schema → report + form pages per table, navigation, dashboard); keep the current single-file flow working | `pgapex-appwizard`, 5453, app 3123 | migration 059 (only if needed), no HR |

**If a session ends:** for each worktree `git -C ../pgapex-wt/<name> status` / `log --oneline sprint-35..`; commit leftovers
as `wip:`; relaunch an agent with "Read `docs/development/sprint-35-agent-rules.md` and follow it. Your workstream: <name>
in the Sprint 35 table of HANDOFF.md; your worktree is /home/nickquispel/projects/pgapex-wt/<name>."

**Workstream reports:** (filled in as agents finish)

**Release 0.27.0:** the three branches merged into `sprint-35` (conflicts only in appended blocks: security.test.ts,
responsive.test.ts, app.ts, builder.css); worktrees and containers removed. CI-style run (clean worktree, no `.env`,
fresh postgres:17 on 5446): **959 pass / 10 skip, e2e 111/111**. Parity: Create application wizard ✅, Sample data ✅,
Data Reporter ✅ (App Builder 13/1/1/0, Data and integration 8/1/0/2, totals 90/19/6/3). SECURITY.md rows, CHANGELOG,
CI matrix v0.27.0. CI on the merge: all green except `upgrade (v0.27.0)`, one flaky test (debug.test.ts saved a
30-day-old debug request that a purge could delete first); fixed in the test after the tag (main, not re-tagged). **Next candidates** (owner to choose): Workspaces (multi-tenant); a new default style like "Iris";
Blueprints / spec-driven development; the AI rows (provider decision pending); 🟡 rows (APEX PL/SQL APIs, Theme Roller
conditional/dynamic properties, Instance administration, …). Data Reporter follow-ups: downloads, several sources.

- **sampledata: DONE** (branch `sprint-35-sampledata`, merged). Migration `058_data_generator.sql`: `meta.data_generator`
  (installation data like `meta.sql_script`, no app_id, not exported; schema check refuses meta/information_schema/pg_*;
  closed to the runtime). `src/sampledata.ts` (proposals from the catalog and names, generators, unique avoidance,
  per-column seeded streams, topological insert with RETURNING, SQL/CSV/zip), `src/sampledata-words.ts`,
  `src/builder/sampledata.ts` (`/builder/sql/sample-data`, Workshop tab). Env `SAMPLE_DATA_STATEMENT_TIMEOUT` (5min),
  `SAMPLE_DATA_MAX_ROWS` (100000). HR `hr_40_sample_data.sql` (saved generator "HR demo staff"). Tests
  `test/sampledata.test.ts`, security block "sprint 35 sampledata". Docs ch. 1, 3, 8, 9, 11, 12, 16. Limits: SQL/CSV
  downloads can only point FKs at existing parents with identity keys; only simple CHECK shapes parsed; preview runs the
  full insert. Agent's tests: 923 pass / 10 skip, e2e 107/107.

- **reporter: DONE** (branch `sprint-35-reporter`, merged into `sprint-35`; conflicts only in the appended test blocks).
  Migration `057_data_reporter.sql`: `meta.data_report` (users' reports: user data, in `KEPT`, `REPOINTED`
  `data_report.region_id`, `NOT_EXPORTED`), view `meta.data_reports`, security definer `meta.save_data_report(...)` /
  `meta.delete_data_report(id)` (own reports only). New region type `data_reporter`: sources (table/view, static id,
  label, description, offered columns with labels and format masks) in `meta.region.config.sources` (travel with the
  export), sharing (everyone / nobody / authz scheme), rows per page. `src/runtime/data-reporter.ts` (list, editor as a
  GET form: columns, ≤5 filters, ≤3 group-by, ≤5 totals, ≤3 sorts, chart via `renderChartBody`; save private/shared,
  copy, delete; params `dr<id>_`), `src/builder/reporter.ts` (Page Designer settings). HR `hr_39_data_reporter.sql` page
  36 "My reports" (`hr.staff_v`, two sources, a shared report of king). Texts in 5 languages. Tests
  `test/data-reporter.test.ts`, security block "sprint 35 reporter", e2e "data reporter (page 36)" and builder page
  `data_reporter_region`. Docs ch. 3, 4, 9, 12. Security (for SECURITY.md): runs as the app role (RLS, tested with two
  users); definitions re-checked before running or saving (offered and readable columns only, whitelisted operators and
  functions via `Object.hasOwn`, sum/avg numeric only, bounded counts and lengths); identifiers only the developer's,
  quoted; values escaped literals; meta/pg_*/information_schema sources ignored at runtime and refused in the builder;
  save/delete need CSRF, sign-in, page access and a visible region; definer functions only touch the user's own rows;
  runtime role has no direct rights on `meta.data_report`. Limits: one source per report, no downloads, grouped results
  ≤1000 rows, sources per region. Agent's tests: 929 pass / 10 skip, e2e 111/111. Parity row ✅ (text in the report).

- **appwizard: DONE** (branch `sprint-35-appwizard`, merged into `sprint-35`). No migration (059 unused), no HR part, no new
  tables or env vars. `src/builder/appsheets.ts` (several XLSX sheets / JSON arrays → several tables, key and foreign
  keys proposed from names, types and values, "Update the proposals" without JS, one transaction: tables, rows, FKs with
  indexes, report+form per table via `meta.generate_page`, navigation, optional dashboard with a chart per table);
  `src/builder/appwizard.ts` (`/builder/create/paste`: CSV/TSV text ≤4 MB as a session temp file; `/builder/create/tables`:
  tables/views of an existing schema → report+form or report per table). `dataload.ts` exports `cellText`, `tableSheet`.
  Tests `test/app-wizard.test.ts` (+ `test/xlsxbook.ts`), security block "sprint 35 appwizard", e2e pages `create_paste`,
  `create_tables` and a several-sheets flow. Docs ch. 3, 12. Security (for SECURITY.md): developer session + CSRF; pasted
  data is a temp file owned by the builder session; names validated and quoted, key = a chosen column index, FKs
  recomputed on the server and only proposed ones applied; meta/information_schema/pg_* refused as parsing and source
  schema; posted table names only matched against a fresh catalog lookup; escaped output; one transaction. By design the
  app from existing tables gets the blank-app grants on every table of the schema; an FK to another schema may give a
  select list the app role can't read. Agent's tests: 925 pass / 10 skip, e2e 107/107. Parity row: ✅ (text in the
  agent's report: several sheets, FKs proposed, pasted data, existing tables; missing: blueprints).

## Sprint 34 (DONE, v0.26.0, owner 2026-10-05: "add to the next sprint"; "read the handoff, apex feature parity and keep going")

Branch `sprint-34` from `main` (v0.25.0). Worked by one session directly (no sub-agents), same rules as
`docs/development/sprint-33-agent-rules.md` with `sprint-34` for `sprint-33`. Migration numbers from **055**.

| # | Item (parity row) | Status |
|---|---|---|
| 1 | Working copies | **done** (migration 055; see report below) |
| 2 | Theme, library and boilerplate application types | **done** (migration 056; see report below) |

Release 0.26.0: CI-style run in a clean worktree without `.env` on a fresh postgres:17 (5446): **909 pass / 10 skip,
e2e 107/107** (before the release commit, which only adds `app_type` to the old-export import test). SECURITY.md rows
for both items; CI matrix v0.26.0.

**Sprint 35 candidates** (owner to choose; the remaining ❌ rows of the parity matrix, AI rows are the owner's call):
Sample data source for development (26.1); Data Reporter (self-service reports for business users, 26.1);
Blueprints / spec-driven development (26.1); Workspaces (multi-tenant); a new default style like "Iris" (26.1);
AI rows (assistant, NL2IR, *Generate Text with AI*). 🟡 rows worth finishing: Create application wizard (several
sheets, pasted data), APEX PL/SQL APIs, Theme Roller (conditional/dynamic properties), Instance administration.

**Item reports:**

- **1 working copies: DONE** (pushed on `sprint-34`). Migration `055_working_copies.sql`: `meta.working_copy` (app_id =
  the copy, main_app_id, name, `base` = main's pgapex/2 export when copied/refreshed/merged, created/refreshed/merged
  stamps; trigger refuses copies of copies). `src/workingcopy.ts`: createCopy (import_app of main's export as
  `<alias>-<name>`, copies app_access and web-credential secrets, switches automations/syncs off), three-way
  compare per *component* on top of `docToFiles` (page dirs normalised to `pages/<seq>`, seq prefixes stripped for
  identity; statuses copy/main/conflict), `mergedDoc` (main's files + copy's version per resolved component →
  `filesToDoc`), `mergeCopy` (merge: replaceApp onto main and copy; refresh: onto copy; base := main's new export;
  fingerprint of the comparison must match; lock check on the target's pages), deleteCopy. Builder
  `src/builder/workingcopies.ts`: `/builder/apps/:id/working-copies`, `POST /builder/working-copies` (outside
  /apps/:id so a locked main can still be copied), `/apps/:id/compare` (+ `?c=` line diff via `cli/diff.ts`
  `unifiedDiff` with names), `/apps/:id/merge` (direction merge|refresh, `r_<i>` conflict choices), delete. Header
  button "Working copies" in `appHeader`. `working_copy` in `KEPT` (replace.ts) and `NOT_EXPORTED` (export test).
  Activity event `working_copy`. Tests: `test/workingcopy.test.ts`, security block "sprint 34 working copies", e2e
  responsive pages `working_copies`, `working_copy_compare`. Docs ch. 3 "Working copies", ch. 12 code map; parity row
  ✅ (App Builder 10/2/3/0, totals 86/20/9/3); CHANGELOG. Security (for SECURITY.md at release): developer session +
  CSRF on every POST; names checked (`^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$`), all output escaped (diffs too); merge
  refused on another developer's app/page lock of the target and on a stale fingerprint; `meta.working_copy` closed to
  the runtime role; a copy runs against the main app's schema/role/data with the same app_access (by design), no
  automations/syncs; any developer can merge any copy (no per-app developer rights, as elsewhere). Limits: conflicts
  per component, not per property; renaming a region on one side while the other side changes its items gives a
  "not consistent" refusal. No env vars, no HR part. Tests (clean worktree, fresh DB 5446): 901 pass / 10 skip, e2e
  107/107.
- **2 application types and subscriptions: DONE** (pushed on `sprint-34`). Migration `056_app_types_subscriptions.sql`:
  `meta.app.app_type` (standard/theme/library/boilerplate, exported; trigger defaults NULL from older exports) and
  `meta.subscription` (app_id, kind theme|lov|authz_scheme|build_option|template_component|list, name ('' for
  theme), master_app_id, created/refreshed stamps; not exported, in `KEPT` and `NOT_EXPORTED`). `src/subscriptions.ts`:
  `KINDS` (table, key column, which master types offer it), offers, subscribe (copies now; replaces a same-named
  component), refresh (one or all; every column but id/app_id, lists with their entries re-parented; theme = the whole
  `meta.app.theme`), publish (refresh all subscribers, `skip` callback for locked apps), inSync, unsubscribe.
  Builder `src/builder/subscriptions.ts`: `/builder/apps/:id/subscriptions` (type, subscriptions with state,
  subscribe select, subscribers + publish), POST subscribe/refresh/unsubscribe/publish, `subscriptionNote()` under a
  component in Shared Components (shared.ts), tree link. Settings: Application type select (routes.ts `$28`).
  Create: *Start from* a boilerplate (`startFromBoilerplate` in newapp.ts: replaceApp of the boilerplate's export,
  then the new app's name/role/authentication restored, type standard, api_role null). Tests:
  `test/subscriptions.test.ts`, security block "sprint 34 application types and subscriptions", e2e pages
  `subscriptions`, `subscribers`. Docs ch. 3 (Creating an application, Application types and subscriptions), ch. 12;
  parity row ✅ (App Builder 11/2/2/0, totals 87/20/8/3), Create application wizard row mentions boilerplates;
  CHANGELOG. Limits: no subscriptions to pages, REST sources or other plug-ins; subscribed LOVs on a REST source need a
  same-named source in the subscriber.

Original plan:

| # | Item (parity row) | Notes |
|---|---|---|
| 1 | **Working copies, merge, team development** (App Builder ❌) | APEX 24.1+: a working copy of an app to change in isolation, compare it with the main app, merge back (with conflicts shown per component). Build on the per-component export (`pgapex export --format dir`, static ids) and `pgapex diff`; a copy is a second app linked to its main app; merge per component; locks from sprint 31 respected |
| 2 | **Theme, library and boilerplate application types** (App Builder ❌, APEX 26.1) | App types: a *theme* app (styles/templates shared by subscribing apps), a *library* app (shared components such as lists of values, authorization schemes, template components, plug-ins that other apps subscribe to and refresh from), a *boilerplate* app (a starting point copied by the create-application wizard). Subscriptions refresh on demand and are shown in "Used in" |

Owner's decision the same day: the parity matrix no longer lists *Forgot password for end users*, *App launcher /
portal* and *Sending e-mail* (all were ➖; the summary is now 82/23/10/3 of 118). No e-mail features stays the rule.
