# 13. REST APIs

pgapex offers two ways to expose data securely over REST (mobile apps, integrations, scripts),
which can be combined:

| | [REST modules](#rest-modules-in-the-builder) | [PostgREST](#how-it-works) |
|---|---|---|
| What | Endpoints you define in the builder: a method, a path and the SQL | A separate service that turns a schema of views and functions into an API |
| Served by | pgapex itself, under `/a/<alias>/rest/<module>/` | PostgREST, next to pgapex |
| Runs as | the application's database role (like its pages) | a dedicated API role |
| Good for | a handful of tailored endpoints, field apps, integrations | broad data access with filtering, sorting and embedding |

Both use the same tokens (App → REST API: tokens and OAuth clients), the same accounts and the
same row level security, and both publish an OpenAPI description.

## REST modules in the builder

**Shared Components → REST modules** (APEX: RESTful Services). A module is a set of handlers under
`/a/<alias>/rest/<name>/`:

```json
[{"method": "GET",  "path": "orders",     "type": "collection", "source": "select id, customer, total from sales.orders order by id"},
 {"method": "GET",  "path": "orders/:id", "type": "item",       "source": "select * from sales.orders where id = :ID::int"},
 {"method": "POST", "path": "orders",     "type": "sql",        "source": "select sales.create_order(:CUSTOMER, :TOTAL::numeric) as id", "roles": ["sales"]},
 {"method": "GET",  "path": "products",   "type": "collection", "source": "select id, name from sales.product", "auth": "public"}]
```

| Key | Meaning |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | Segments with `:parameters`, e.g. `orders/:id/lines` |
| `type` | `collection`: a SELECT, returned page by page as `{items, offset, limit, has_more}` (`?limit=` up to 500, `?offset=`, `page_size` for the default); the page streams from a cursor as a chunked JSON array (an error before the first rows is still a 4xx/5xx, a failure after them ends the response short) · `item`: one row as an object, 404 when there is none · `sql`: statements; the first row of the last one is the response (201 for POST, 204 without a row; `status` overrides) |
| `source` | The SQL. Binds: path parameters, query parameters and the fields of a JSON (or form) body, upper case (`:ID`, `:CUSTOMER`); `:BODY` is the whole JSON body |
| `roles` | The caller needs one of these roles (as `meta.has_role()` sees them) |
| `auth` | `token` (default) or `public` (no token; the SQL runs with `meta.app_user()` = `nobody`) |
| `description` | For the OpenAPI description |

**Calling them.** Send `Authorization: Bearer <token>` with a token from **App → REST API**: a token
issued for an account, or one from `POST /oauth/token` for an OAuth client ([below](#tokens)). An
application needs no API role for these endpoints. On every request pgapex checks the token's
signature and application, and that the account is active with access (or that the client is not
revoked). The SQL then runs **as the application's database role** with `meta.app_user()` = the
caller and `meta.has_role()` = the caller's roles, so the same grants and RLS policies as the
application's pages apply. A browser session (cookie) is not accepted, so pages of other sites
can't call the API on a user's behalf.

**Errors** are JSON `{"error": "…"}`: 401 (no or invalid token), 403 (no access, a missing role,
or a missing grant), 404, 405, and 400 for errors of the SQL itself such as a PL/pgSQL
`raise exception` (its message) or invalid input.

**OpenAPI.** `GET /a/<alias>/rest/<module>/openapi.json` describes the module's endpoints (without
their SQL), for Swagger UI, Postman or client generators. The builder lists every endpoint with a
curl example; the Advisor checks the handlers' SQL.

**Example:** the HR example application's module `v1` (`examples/hr/hr_13_rest.sql`):

```bash
TOKEN=…   # App → REST API → Issue a token for allen
curl http://127.0.0.1:3100/a/hr/rest/v1/my/leave -H "Authorization: Bearer $TOKEN"
curl -X POST http://127.0.0.1:3100/a/hr/rest/v1/leave -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"start_date": "2027-05-03", "end_date": "2027-05-04", "reason": "dentist"}'
```

## PostgREST

[PostgREST](https://postgrest.org) runs as a separate service **next to** pgapex and turns
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

The HR sample does this in `examples/hr/hr_03_api.sql`. The pattern:

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

There are three kinds of token:

| Kind | For | Lifetime | Acts as |
|---|---|---|---|
| **OAuth clients** (client credentials) | Systems and integrations: ETL jobs, other servers, scheduled scripts | Minutes (default 60); the client fetches new tokens itself | `client:<name>`, with the client's roles |
| Tokens issued in the builder | Development and trying things out | 1 hour to 30 days | An account |
| Identity-provider tokens | Apps whose users already sign in with your provider | Set by the provider | An account |

### OAuth clients (client credentials)

This is the pgapex counterpart of ORDS's `oauth.create_client` and `/oauth/token`, and the way
to connect other systems. A client gets a **client ID and secret** once. With them it asks
pgapex for a **short-lived access token** whenever it needs one, using the standard OAuth 2.0
client credentials grant. Tokens expire on their own, so nobody has to rotate them by hand, and
every OAuth library handles the renewal.

Create a client in the builder under **REST API → OAuth clients** (name, roles, token lifetime),
or in SQL (owner only):

```sql
select * from meta.oauth_create_client('hr', 'payroll-sync', '{manager}', 'Nightly payroll export', 60);
--  client_id               | client_secret
--  H4oHJkaIYQaqiOJqBgA5WQ  | (shown once, stored as a SHA-256 hash)

select meta.oauth_grant_role('H4oHJkaIYQaqiOJqBgA5WQ', 'auditor');
select meta.oauth_revoke_role('H4oHJkaIYQaqiOJqBgA5WQ', 'auditor');
select meta.oauth_rotate_secret('H4oHJkaIYQaqiOJqBgA5WQ');          -- old secret valid 24 hours
select meta.oauth_rotate_secret('H4oHJkaIYQaqiOJqBgA5WQ', '0');     -- old secret invalid at once
select meta.oauth_revoke_client('H4oHJkaIYQaqiOJqBgA5WQ');
```

Get a token and use it:

```bash
curl -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://apps.example.com/oauth/token
# {"access_token":"eyJ…","token_type":"bearer","expires_in":3600}

curl https://api.example.com/employees -H "Authorization: Bearer eyJ…"
```

- **Credentials:** the token endpoint accepts HTTP Basic (`client_secret_basic`) or
  `client_id` / `client_secret` form fields (`client_secret_post`). Errors follow RFC 6749
  (`invalid_client` → 401, `unsupported_grant_type` → 400). Failed attempts are logged
  (`oauth_failed`) and throttled per IP address like sign-ins.
- **What a client token may do:** it acts as application user `client:<name>`, so RLS policies
  and audit triggers can tell integrations apart. It has the client's roles, which are **read at
  every request**: granting or revoking a role, or revoking the client, works immediately, even
  for tokens already issued. A `roles` claim in the token doesn't count for clients.
- **Rotating a secret:** *New secret* in the builder, or `meta.oauth_rotate_secret()`. The old
  secret keeps working for a grace period (24 hours by default, 7 days, or none), so you can
  update the integration without downtime.
- **Lifetime** is 5 to 1440 minutes per client. Shorter means a leaked token is useful for less
  time. Because revocation is checked live, a leaked token is also stopped by revoking the client.

### Tokens issued in the builder

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
