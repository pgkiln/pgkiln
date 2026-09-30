# Handoff: work in progress

This file lets another developer (or another Claude session) continue the current sprint without
the chat history. Keep it updated when you stop working. Delete it (or empty the sprint section)
when the sprint is merged.

Last updated: 2026-09-30. Sprints 3–6 are **merged into `main`** (sprint 4 via PR #2; sprints 5 and 6 with `git merge` on the command line, as the owner asked). Next sprint: branch from `main`.

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
- `npm run setup` / `npm run db:reset` (recreates the DB: migrations + `db/seed/*`), `npm run dev`.
- Tests: `npm test` (needs the DB), `npm run test:e2e` (needs `npx playwright install chromium`).
- Stop the dev server with `kill $(lsof -t -iTCP:3100 -sTCP:LISTEN)`. **Don't** use `pkill -f server.ts`:
  the pattern matches the calling shell itself.
- GitHub: `git@github.com:NickVrgr/Postgresql_APEX.git` (SSH push works). The local `gh` CLI is
  logged in as an account without access to this repo: give the owner compare URLs instead of
  opening PRs.
- The example app `examples/tasks-app.sql` (ann / ann-password) may be installed in the dev DB.

## Branch state

| Branch | Status |
|---|---|
| `main` | Everything up to sprint 6, released as **v0.6.0** (tags: v0.2.0, v0.6.0; 0.3.0–0.5.0 were never tagged) |

The sprint branches were merged and deleted. Start the next sprint with `git checkout -b sprint-7 main`.

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
