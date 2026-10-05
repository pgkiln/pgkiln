# 1. Installation and configuration

## Requirements

| Component | Version | Notes |
|---|---|---|
| PostgreSQL | 15 or newer (17 recommended) | Needs the `pgcrypto` extension (part of standard PostgreSQL) |
| Node.js | 20 or newer | `.nvmrc` pins the version used in development |
| Docker (optional) | any recent | For the bundled development database |

pgapex does not need any other services; there is no separate web listener (like ORDS for APEX).
For REST APIs you can run [PostgREST](https://postgrest.org) next to it ([chapter 13](13-rest-api.md)).

## Quick start (development)

```bash
git clone git@github.com:NickVrgr/Postgresql_APEX.git pgapex
cd pgapex
npm install
cp .env.example .env
npm run setup        # starts PostgreSQL 17 in Docker on port 5434 and installs pgapex (the migrations)
npm run dev          # starts pgapex on http://127.0.0.1:3100 and restarts on code changes
```

Open the **builder** at http://127.0.0.1:3100/builder, sign in as `admin` / `admin` (change the
password on the Developers page straight away) and create your first application from a table
(*Create application*), or follow the [tutorial](10-tutorial.md).

### The example application (optional)

pgapex comes with an example application, **HR**: employees, departments, leave requests with an
approval task, a dashboard, a REST API, translations, documents and more, built the way you would
build your own (`examples/hr/`). It is not part of pgapex; install it to see the features at work:

```bash
npm run example:hr   # http://127.0.0.1:3100/a/hr: king, blake, allen or demo (password = username)
```

The tests use it as their fixture: `npm test` and `npm run test:e2e` install it first.

### Using your own PostgreSQL instead of Docker

1. Create a database and an owner login (a superuser is simplest for development):
   ```sql
   create role pgapex login password 'choose-a-password' superuser;
   create database pgapex owner pgapex;
   ```
2. Point `DATABASE_URL` in `.env` at it, then run `npm run db:migrate` (and `npm run example:hr` for the example application).
3. Set `RUNTIME_DATABASE_URL` for the `pgapex_runtime` role that the first migration creates (see below).

## The two database connections

pgapex deliberately uses **two** database logins:

| Connection | Setting | Role | Used for |
|---|---|---|---|
| Owner | `DATABASE_URL` | the owner of the `meta` schema (e.g. `pgapex`) | migrations, the builder, the SQL Workshop |
| Runtime | `RUNTIME_DATABASE_URL` | `pgapex_runtime` (created by migration 001) | running applications |

The runtime role is **least privilege**. It can read application definitions and manage sessions,
but it cannot read developer accounts, password hashes or instance secrets. It is `NOINHERIT`, so
it reaches application data only by switching to an application's own database role
(`SET LOCAL ROLE`) for the duration of a request. If `RUNTIME_DATABASE_URL` is missing, pgapex
falls back to the owner connection and prints a warning; don't run like that in production.

The migration creates `pgapex_runtime` with the password `pgapex_runtime`. **Change it**:

```sql
alter role pgapex_runtime password 'a-long-random-password';
```

## Configuration reference

All settings are environment variables. They can also be placed in `.env` in the project root,
which is read at startup; real environment variables take precedence.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://pgapex:pgapex@localhost:5434/pgapex` | Owner connection (builder, migrations) |
| `RUNTIME_DATABASE_URL` | *(falls back to `DATABASE_URL`)* | Least-privilege connection that runs applications |
| `PORT` | `3100` | HTTP port |
| `HOST` | `127.0.0.1` | Interface to listen on; use `0.0.0.0` in a container |
| `PUBLIC_URL` | `http://127.0.0.1:<PORT>` | The address users reach pgapex at (e.g. `https://apps.example.com`). Single sign-on redirect URIs are built from it |
| `API_URL` | `http://127.0.0.1:3000` | Where PostgREST serves the REST API ([chapter 13](13-rest-api.md)) |
| `API_JWT_SECRET` | *(none)* | Signs REST API tokens; at least 32 characters, the same as PostgREST's `jwt-secret`. Without it, tokens can't be issued |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS: marks cookies `Secure` and sends HSTS |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy, so client IPs (used by login throttling) come from `X-Forwarded-For` |
| `PGAPEX_AUTH_HEADER_PROXIES` | *(none)* | Comma-separated IPs and CIDRs (e.g. `10.0.0.5, 192.168.10.0/24`) of the reverse proxies whose user header apps with **HTTP header** authentication trust; checked against the connection's own address, never `X-Forwarded-For`. Unset: header sign-in is refused ([chapter 8](08-security.md#http-header-authentication-reverse-proxy)) |
| `SESSION_IDLE_MINUTES` | `60` | A session ends after this long without requests |
| `SESSION_MAX_HOURS` | `8` | A session ends this long after sign-in, whatever the activity |
| `LOGIN_WINDOW_MINUTES` | `15` | Window for counting failed sign-ins |
| `LOGIN_MAX_FAILURES_PER_USER` | `5` | Failed sign-ins per username (since their last success) before a lock |
| `LOGIN_MAX_FAILURES_PER_IP` | `50` | Failed sign-ins per IP address before a lock |
| `STATEMENT_TIMEOUT` | `30s` | Maximum run time of any application SQL statement |
| `DB_POOL_SIZE` | `10` | Connections per pool (there are two pools) |
| `MAX_UPLOAD_MB` | `10` | Largest file a file item accepts (an item's `max_mb` can only lower it) |
| `DATA_LOAD_MAX_MB` | `50` | Largest file for SQL Workshop → Load Data and Create → From a file |
| `DATA_LOAD_MAX_ROWS` | `100000` | Most rows loaded from one file |
| `PDF_MAX_ROWS` | `5000` | Most rows in a report PDF (1 to 100,000; read with a cursor in batches) |
| `DOWNLOAD_MAX_ROWS` | `1000000` | Most rows in a report's CSV or Excel download and in a SQL Workshop → Unload Data file (streamed; at most 1,048,575) |
| `UNLOAD_STATEMENT_TIMEOUT` | `5min` | Statement timeout of SQL Workshop → Unload Data (each statement: the cursor and every batch of rows) |
| `REGION_CACHE_MAX_ENTRIES` | `1000` | Most regions in the [region cache](04-pages-and-regions.md#large-tables) of one server process (`0` turns caching off) |
| `REGION_CACHE_MAX_MB` | `64` | Memory for the region cache of one server process |
| `AUTOMATIONS` | on | `off` stops this server from running [automations](06-processing.md#automations) |
| `SCHEDULER_INTERVAL_S` | `30` | How often the automation scheduler looks for due runs |
| `BACKGROUND_PROCESSES` | on | `off` stops this server from running [background execution chains](06-processing.md#execution-chains) (another server runs them) |
| `PROCESS_JOB_INTERVAL_S` | `10` | How often a server looks for queued background chains (besides being woken by `NOTIFY`) |
| `PDF_FONT`, `PDF_FONT_BOLD` | *(none)* | TrueType fonts for report PDFs, for text beyond Western European (e.g. `DejaVuSans.ttf`) |
| `PGAPEX_SECRET_KEY` | *(none)* | Encrypts the secrets of web credentials; at least 32 characters (e.g. `openssl rand -base64 32`). Keep it outside the database; changing it means entering the secrets again ([chapter 19](19-rest-data-sources.md)) |
| `PGAPEX_REST_ALLOWED_HOSTS` | *(none: no outgoing calls)* | Hosts REST data sources and `invoke_api` may call: `api.example.com`, `*.example.com`, `host:8443`, `*` (any public host) ([chapter 19](19-rest-data-sources.md#server-configuration-and-the-allow-list)) |
| `PGAPEX_REST_PRIVATE_HOSTS` | *(none)* | Hosts that may resolve to private, loopback or link-local addresses (also allows them) |
| `PGAPEX_REST_MAX_BYTES` | `5000000` | Largest web service response read (also after decompression) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-restart on changes |
| `npm start` | Start (production) |
| `npm run setup` | Start the Docker database and apply the migrations |
| `npm run db:up` | Start the Docker database |
| `npm run db:migrate` | Apply pending migrations (`db/migrations/*.sql`) |
| `npm run example:hr` | Apply migrations, then install the HR example application (`examples/hr/*.sql`) |
| `npm run db:reset` | **Delete** the Docker database and set it up again |
| `npm run typecheck` | TypeScript type check |
| `npm test` | Unit and security tests (need the database; install the HR example first, as their fixture) |
| `npm run test:e2e` | Browser tests at phone, tablet and desktop widths (run `npx playwright install chromium` once) |

## Upgrading

Every schema change ships as a new, numbered file in `db/migrations/`. The runner records applied
files in `public.pgapex_migration` and applies only new ones, each in its own transaction:

```bash
git pull
npm ci
npm run db:migrate
# restart the server
```

Back up the database before upgrading. Released migrations are never modified.

## Production deployment

A typical setup: pgapex runs as a service behind a reverse proxy that terminates HTTPS.

```
Browser ──HTTPS──> nginx / Caddy / Traefik ──HTTP──> pgapex (node) ──> PostgreSQL
```

1. **Database**
   - Use a dedicated owner role (it doesn't need to be a superuser once migrations have run,
     but it must own the `meta` schema and be allowed to create roles if developers create apps in the builder).
   - Set a strong password for `pgapex_runtime`.
   - Enable regular backups (`pg_dump` or your provider's snapshots). Everything, including
     application definitions, lives in the database.
2. **Environment**
   ```bash
   NODE_ENV=production
   HOST=0.0.0.0
   PORT=3100
   DATABASE_URL=postgres://pgapex_owner:...@db:5432/pgapex
   RUNTIME_DATABASE_URL=postgres://pgapex_runtime:...@db:5432/pgapex
   COOKIE_SECURE=true
   TRUST_PROXY=true
   PUBLIC_URL=https://apps.example.com
   # only with a REST API (PostgREST):
   API_URL=https://api.example.com
   API_JWT_SECRET=<48+ random characters, same as PostgREST's jwt-secret>
   ```
3. **Process manager.** Run `npm start` under systemd, a container orchestrator or `pm2`.
   Example systemd unit:
   ```ini
   [Service]
   WorkingDirectory=/opt/pgapex
   EnvironmentFile=/opt/pgapex/.env
   ExecStart=/usr/bin/npm start
   Restart=always
   User=pgapex
   ```
4. **Reverse proxy** (nginx example):
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:3100;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```
5. **Restrict the builder.** `/builder` is for developers. Consider allowing it only from your
   office network or VPN at the proxy (for example an nginx `location /builder { allow …; deny all; }`).
6. **Change default passwords**: `admin` in the builder (Developers page), and the demo users if the sample is installed.
   Don't install the example application in production: `npm run db:migrate` installs pgapex only.
7. Walk through the checklist at the end of [SECURITY.md](../../SECURITY.md).

### Scaling

pgapex keeps no state in memory between requests (sessions live in `meta.session`), so you can
run several instances behind a load balancer. Each instance opens up to `2 × DB_POOL_SIZE`
database connections.

## Backups and moving applications

- **Everything** is in PostgreSQL: application definitions (`meta.*`), sessions and your data.
  A normal `pg_dump` backs it all up.
- To move a single application between environments (development → test → production), use
  **Builder → App → Export**, which downloads JSON, then **Builder → Import** on the target, or in SQL:
  ```sql
  select meta.export_app('hr');                  -- returns jsonb
  select meta.import_app('<the json>', 'hr');    -- returns the new app id
  ```
  The export contains the application only, not your tables, functions, roles or users. Ship
  those as SQL migrations in your own project, and create users on the target.
