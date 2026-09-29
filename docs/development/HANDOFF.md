# Handoff: work in progress (sprint 4)

This file lets another developer (or another Claude session) continue the current sprint without
the chat history. Keep it updated when you stop working. Delete it (or empty the sprint section)
when the sprint is merged.

Last updated: 2026-09-29. Step A (user directory) is **done**; next is step B (single sign-on).

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
| `main` | v0.2.0 (tagged) |
| `sprint-3` | v0.3.0: responsive UI, grid, charts, calendar, facets, docs. Pushed, **not merged yet** |
| `sprint-4` | **this sprint**, branched from `sprint-3` |

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

### B: single sign-on (OpenID Connect): design, not started

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

### C: PostgREST alongside pgapex: design, not started

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
