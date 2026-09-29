# 13. REST APIs with PostgREST

pgapex serves web pages. For **REST APIs** (mobile apps, integrations, scripts) it works with
[PostgREST](https://postgrest.org), which runs as a separate service **next to** pgapex and turns
a PostgreSQL schema into a REST API. Both use the same database, the same accounts and the same
row level security policies, so a rule like "employees see only their own leave requests" holds in
the web app and in the API without writing it twice.

```
Browser ───> pgapex (pages, builder)      ─┐
                                           ├──> PostgreSQL (RLS: meta.app_user(), meta.has_role())
Client ──JWT──> PostgREST (schema "api")  ─┘
```

This is the pgapex counterpart of ORDS RESTful services in APEX; see
[chapter 11](11-from-apex.md#ords-and-postgrest) for the mapping.

## How it works

1. A client sends `Authorization: Bearer <token>`. The token is a JWT signed with a secret
   (or key) that PostgREST trusts.
2. PostgREST connects as `pgapex_authenticator`, verifies the token and switches to the database
   role in its `role` claim, e.g. `hr_api`. It puts all claims in the setting `request.jwt.claims`.
3. PostgREST first calls the pre-request function **`meta.api_check()`**, which rejects the request
   unless the token's application uses that role as its API role and the account is active with
   access to the application.
4. The request runs as `hr_api`. Views and functions in the `api` schema run with the caller's
   privileges, so the RLS policies on the base tables apply. `meta.app_user()` and
   `meta.has_role()` read the token's claims:

| Claim | Meaning |
|---|---|
| `role` | Database role PostgREST switches to: the application's **API role** |
| `app` | Application alias. `meta.app_id()` returns its id; roles come from the account's access to it |
| `app_user` | The user. If it's missing, `meta.app_user()` uses `preferred_username`, then `email`, then `sub` |
| `roles` | Optional extra application roles (useful for identity-provider tokens) |

Inside pgapex nothing changes: the session's user and roles take precedence over JWT claims, and
outside both `meta.app_user()` is `nobody`.

## Setup

### 1. Run PostgREST

For development, the bundled Compose file has a PostgREST service:

```bash
docker compose --profile api up -d postgrest     # http://127.0.0.1:3000
```

It uses these settings (set the same in your own deployment):

| PostgREST setting | Value | Why |
|---|---|---|
| `db-uri` | `postgres://pgapex_authenticator:…@db/pgapex` | Login role that may only switch to API roles |
| `db-schemas` | `api` | Only the API schema is exposed, never `hr`, `meta` or `public` |
| `db-anon-role` | `pgapex_anon` | Role for requests without a token; it has no privileges |
| `db-pre-request` | `meta.api_check` | Rejects tokens of inactive accounts or accounts without access |
| `jwt-secret` | `API_JWT_SECRET` | Shared with pgapex, which signs tokens with it |
| `db-max-rows` | `1000` | Caps the rows per response |

And in pgapex's `.env`:

| Variable | Example | Meaning |
|---|---|---|
| `API_URL` | `http://127.0.0.1:3000` | Where PostgREST is reachable (shown in the builder, used for its status check) |
| `API_JWT_SECRET` | 32+ random characters | Signs the tokens pgapex issues; must equal PostgREST's `jwt-secret` |

Migration 005 creates `pgapex_authenticator` with the password `pgapex_authenticator`. **Change it**
outside development: `alter role pgapex_authenticator password '…';`.

### 2. Create the API role and schema

The HR sample does this in `db/seed/hr_03_api.sql`. The pattern:

```sql
-- A role for API callers of this application, and permission for PostgREST to use it.
create role hr_api nologin;
grant hr_api to pgapex_authenticator;
update meta.app set api_role = 'hr_api' where alias = 'hr';

-- The API is a separate schema of views and functions: a stable contract, never the base tables.
create schema api;
grant usage on schema api to hr_api;

-- The views run with the caller's privileges (security_invoker), so it needs base privileges,
-- and RLS then filters the rows. Column grants keep salaries out of reach.
grant usage on schema hr to hr_api;
grant select (empno, ename, job, mgr, hiredate, deptno, active, username) on hr.emp to hr_api;
grant select, insert, update on hr.leave_request to hr_api;

create view api.leave_requests with (security_invoker = true) as
  select l.id, l.empno as employee_id, l.start_date, l.end_date, l.status
    from hr.leave_request l;

-- Functions become POST /rpc/<name>. Reuse the PL/pgSQL the web app calls.
create function api.decide_leave(id int, decision text, note text default null) returns void
language sql as $$ select hr.decide_leave(id, upper(decision), note) $$;

grant select on api.leave_requests to hr_api;
grant execute on function api.decide_leave(int, text, text) to hr_api;

notify pgrst, 'reload schema';   -- after every change to the api schema
```

You can also set the API role under **Builder → App → REST API**. pgapex refuses roles that bypass
row level security (superusers, `BYPASSRLS`) and its own roles.

### 3. Check it in the builder

**Builder → App → REST API** shows:

- whether PostgREST answers at `API_URL`, and whether `pgapex_authenticator` may switch to the API role;
- the **endpoints**: every view and function in `api` with the HTTP methods the API role may use;
- a form to **issue a token** for an account, and ready-to-run `curl` examples.

## Tokens

### Tokens issued by pgapex

Under **REST API → Issue a token**, pick an account and a lifetime (1 hour to 30 days). The token
is shown once and not stored. Issuing is logged in the activity log (`api_token`).

Such a token contains `role`, `app` and `app_user`, but **no roles**. `meta.has_role()` reads the
account's roles in the application at every request, and `meta.api_check()` rejects the token as
soon as the account is deactivated or loses access. Changing `API_JWT_SECRET` (in pgapex and
PostgREST) invalidates all tokens at once.

Use them for development, scripts and trusted integrations. The account needs access to the
application, like a person signing in. For a script, create a dedicated account (for example
`payroll-sync`) with only the roles it needs.

### Tokens from your identity provider

For apps and services that already sign in with your identity provider (see
[chapter 8](08-security.md#single-sign-on-openid-connect)), PostgREST can verify the provider's
access tokens directly:

- Set PostgREST's `jwt-secret` to the provider's **JSON Web Key Set** (for Keycloak:
  `<issuer>/protocol/openid-connect/certs`) and `jwt-aud` to the audience of your API. PostgREST
  doesn't refresh the key set itself; update it when the provider rotates keys. To keep accepting
  pgapex-issued tokens too, add the shared secret to the set as a symmetric (`"kty": "oct"`) key.
- Add claims at the provider (in Keycloak: *hardcoded claim* and *audience* mappers on a client
  scope): `role` = the API role (e.g. `hr_api`) and `app` = the application alias (`hr`).
- The username comes from `preferred_username` (or add `app_user`). It must match a pgapex account
  with access to the app, as `meta.api_check()` requires; roles come from that access, plus an
  optional `roles` claim.

This path isn't covered by the automated tests; try it with the bundled Keycloak before relying on it.

## Using the API

```bash
TOKEN=eyJ...    # from Builder → HR → REST API

# Rows the caller may see (RLS), with PostgREST's filtering, ordering and paging
curl "http://127.0.0.1:3000/leave_requests?status=eq.PENDING&order=start_date&limit=20" \
     -H "Authorization: Bearer $TOKEN"

# Call a function: request leave (as allen) or decide on it (as blake)
curl -X POST http://127.0.0.1:3000/rpc/request_leave -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"start_date": "2026-12-01", "end_date": "2026-12-04"}'
curl -X POST http://127.0.0.1:3000/rpc/decide_leave -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"id": 12, "decision": "approved", "note": "Enjoy"}'

# OpenAPI description of everything the caller may use
curl http://127.0.0.1:3000/ -H "Authorization: Bearer $TOKEN"
```

What the HR sample shows:

- `allen` sees only his own leave requests, `blake` sees his team's, and `king` (admin) sees all of them.
- `allen` can't approve his own request: `hr.decide_leave` raises an error, which PostgREST returns
  as HTTP 400 with the message.
- Approving through the API fires the same trigger as the web app: allen gets a notification, and
  the audit log records `blake` as the user.
- `api.employees` has no salary column, and `hr.emp.sal` isn't granted to `hr_api` at all.

## Responses to expect

| Status | Cause |
|---|---|
| 401 | No token for an endpoint (the anonymous role has no rights), a bad signature, or an expired token. Also `meta.api_check()`: the token's app doesn't use this API role |
| 403 | `meta.api_check()`: the account doesn't exist, is inactive or has no access. Or a missing grant (`permission denied`) |
| 404 | The view or function isn't in the `api` schema, or PostgREST's schema cache is stale: `notify pgrst, 'reload schema';` |
| 400 | An error raised by your PL/pgSQL (`raise exception`), a check constraint, or an RLS `with check` failure |

## Security notes

- **Expose only the `api` schema.** Base tables stay private, so you can change them without
  breaking clients, and nothing is exposed by accident when a table gets a new column.
- **Views are `security_invoker`** (PostgreSQL 15+). Without it, a view runs as its owner and
  **skips RLS**.
- **Give the API role column grants** for sensitive tables, as the HR sample does for salaries.
- **One API role per application**, granted only what its API needs. Never use the app's
  `db_role` for the API if the web app needs more than the API should allow.
- **Use HTTPS** in front of PostgREST, and consider rate limits and CORS rules at the reverse proxy.
- **Keep `API_JWT_SECRET` secret and long**; everyone who knows it can sign tokens for any account.
- Change the `pgapex_authenticator` password, and don't grant it roles other than API roles.
