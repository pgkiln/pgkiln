# 1. Installation and configuration

## Requirements

| Component | Version | Notes |
|---|---|---|
| PostgreSQL | 15 or newer (17 recommended) | Needs the `pgcrypto` extension (part of standard PostgreSQL) |
| Node.js | 20 or newer | `.nvmrc` pins the version used in development |
| Docker (optional) | any recent | For the bundled development database |

pgkiln does not need any other services; there is no separate web listener (like ORDS for APEX).
For REST APIs you can run [PostgREST](https://postgrest.org) next to it ([chapter 13](13-rest-api.md)).

### Hardware

pgkiln itself is light: one Node.js process and PostgreSQL. What a server needs depends mostly on
your own data and queries.

| | CPU | Memory | Disk |
|---|---|---|---|
| **Trying it out**, a small team | 1 core | 1 GB | 5 GB |
| **Production**, up to a few hundred users | 2 cores | 2–4 GB | 20 GB SSD, plus your data |
| **Larger** | more instances behind a load balancer ([Scaling](#scaling)), PostgreSQL on its own server | | sized by your data |

Memory and disk on the smallest server leave room for the operating system; with Docker the images
take about 1.2 GB (pgkiln 570 MB, `postgres:17` 640 MB).

**What we measured** (October 2026, with the HR example, the Docker compose stack, on a desktop CPU;
simulated users who sign in and request pages back to back, without pausing between clicks):

| | Idle | 5 users | 20 users | 50 users |
|---|---|---|---|---|
| Pages per second | – | 212 | 247 | 242 |
| Time per page (median / 99th percentile) | – | 24 / 39 ms | 84 / 116 ms | 214 / 282 ms |
| pgkiln memory | 140 MB | 390 MB | 440 MB | 610 MB |
| PostgreSQL memory | 85 MB | 155 MB | 160 MB | 165 MB |
| pgkiln CPU | ~0 | 1.1 cores | 1.1 cores | 1.2 cores |

- One pgkiln process uses about **one CPU core** at most and served about **240 pages per second**
  here. People pause between clicks, so that is far more than a team working normally generates;
  a smaller or shared CPU (a typical cloud server) is slower, so measure with your own pages.
- The **database** of the example is under 50 MB (pgkiln's own `meta` schema about 6 MB); sessions, the
  activity log and uploaded files grow with use. Back up and size the disk for your own tables.
- Each pgkiln instance opens up to 30 database connections with the default pool settings.

## Quick start (development)

```bash
git clone https://github.com/pgkiln/pgkiln.git
cd pgkiln
npm install
cp .env.example .env
npm run setup        # starts PostgreSQL 17 in Docker on port 5434 and installs pgkiln (the migrations)
npm run dev          # starts pgkiln on http://127.0.0.1:3100 and restarts on code changes
```

Open the **builder** at http://127.0.0.1:3100/builder, sign in as `admin` / `admin` (change the
password on the Developers page straight away) and create your first application from a table
(*Create application*), or follow the [tutorial](10-tutorial.md).

### The example application (optional)

pgkiln comes with an example application, **HR**: employees, departments, leave requests with an
approval task, a dashboard, a REST API, translations, documents and more, built the way you would
build your own (`examples/hr/`). It is not part of pgkiln; install it to see the features at work:

```bash
npm run example:hr   # http://127.0.0.1:3100/a/hr: king, blake, allen or demo (password = username)
```

The tests use it as their fixture: `npm test` and `npm run test:e2e` install it first.

### Using your own PostgreSQL instead of Docker

1. Create a database and an owner login (a superuser is simplest for development):
   ```sql
   create role pgkiln login password 'choose-a-password' superuser;
   create database pgkiln owner pgkiln;
   ```
2. Point `DATABASE_URL` in `.env` at it, then run `npm run db:migrate` (and `npm run example:hr` for the example application).
3. Set `RUNTIME_DATABASE_URL` for the `pgkiln_runtime` role that the first migration creates (see below).

The owner doesn't have to be a superuser: a role with `CREATEROLE` that owns the database is enough
(`pgcrypto` is a trusted extension).

### Installing into an existing database

pgkiln can live next to your own schemas: it adds the schema `meta`, three bookkeeping tables in
`public` (`pgkiln_migration`, `pgkiln_seed`, `pgkiln_install_log`) and the login roles
`pgkiln_runtime`, `pgkiln_authenticator` and `pgkiln_anon` (roles belong to the whole server). It
changes nothing else. When the pgkiln owner is not the database's owner, a database administrator
grants, once:

```sql
create role pgkiln login createrole password 'choose-a-password';
grant connect, create on database shop to pgkiln;
grant create on schema public to pgkiln;   -- since PostgreSQL 15 only the database owner may by default
```

Applications run as a role of their own, which the builder grants rights on its parsing schema. For
a schema the pgkiln owner doesn't own, its owner passes those rights on first:

```sql
-- as the owner of the schema sales
grant usage on schema sales to pgkiln with grant option;
grant select, insert, update, delete on all tables in schema sales to pgkiln with grant option;
grant usage, select on all sequences in schema sales to pgkiln with grant option;
```

(or the administrator grants them to the application's role, `app_<alias>`, directly).

## The two database connections

pgkiln deliberately uses **two** database logins:

| Connection | Setting | Role | Used for |
|---|---|---|---|
| Owner | `DATABASE_URL` | the owner of the `meta` schema (e.g. `pgkiln`) | migrations, the builder; an administrator's audited *Owner connection* in the SQL Workshop |
| Runtime | `RUNTIME_DATABASE_URL` | `pgkiln_runtime` (created by migration 001) | running applications |
| Developer logins | *(none: derived from `PGKILN_SECRET_KEY`)* | `pgkiln_ws<id>_dev_<suffix>`, one per workspace (migration 166) | the SQL Workshop and the tools that check a developer's SQL |

(sprint 185) The SQL Workshop doesn't run as the owner: each workspace has a **developer login** with the rights of
its applications' roles and schemas and none in `meta` (chapter 3, *Who the SQL Workshop runs as*). pgkiln sets its
password when it first opens a connection, derived from `PGKILN_SECRET_KEY`; without that key a single server
process uses a password of its own (several processes need the key, or they change each other's password). The
login connects to the database and host of `RUNTIME_DATABASE_URL`, so `pg_hba.conf` must let it sign in with a
password there, like the runtime role.

The runtime role is **least privilege**. It can read application definitions and manage sessions,
but it cannot read developer accounts, password hashes or instance secrets. It is `NOINHERIT`, so
it reaches application data only by switching to an application's own database role
(`SET LOCAL ROLE`) for the duration of a request. If `RUNTIME_DATABASE_URL` is missing, pgkiln
falls back to the owner connection and prints a warning; don't run like that in production.

### A non-superuser owner

(sprint 185) Instance settings → *Lockout checks* (and `pgkiln admin check`) warn when `DATABASE_URL` signs in as a
**superuser**: then migrations, the builder and an administrator's Owner connection could also read files on the
server, run programs and change every database of the PostgreSQL server. The Docker image's bundled database makes
`pgkiln` a superuser (the image's `POSTGRES_USER`); on a server of your own, make an owner without it:

```sql
create role pgkiln_owner login createrole password 'a-long-random-password';
alter database pgkiln owner to pgkiln_owner;
reassign owned by pgkiln to pgkiln_owner;   -- as a superuser, in pgkiln's database
```

The owner needs `CREATEROLE` (application roles, workspace logins) and to own the database. A few things then need
a superuser once (the Change Log's event triggers, `create extension` of an untrusted extension): pgkiln shows the
statements to run. Splitting the owner into a migration role and a builder role that can't create roles is not done
yet: `DATABASE_URL` is still used for both.

The migration creates `pgkiln_runtime` with the password `pgkiln_runtime`. **Change it**:

```sql
alter role pgkiln_runtime password 'a-long-random-password';
```

## Configuration reference

All settings are environment variables. They can also be placed in `.env` in the project root,
which is read at startup; real environment variables take precedence.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://pgkiln:pgkiln@localhost:5434/pgkiln` | Owner connection (builder, migrations; not the SQL Workshop since sprint 185: see above). Not a superuser, ideally |
| `RUNTIME_DATABASE_URL` | *(falls back to `DATABASE_URL`)* | Least-privilege connection that runs applications |
| `PORT` | `3100` | HTTP port |
| `HOST` | `127.0.0.1` | Interface to listen on; use `0.0.0.0` in a container |
| `PUBLIC_URL` | `http://127.0.0.1:<PORT>` | The address users reach pgkiln at (e.g. `https://apps.example.com`). Single sign-on redirect URIs are built from it, and developers' passkeys belong to its host name |
| `PGKILN_RP_ID` | the host of `PUBLIC_URL` | (0.61) A parent domain for developers' passkeys (`example.com` when the builder is at `builder.example.com`), so one passkey works on its sub-domains. Ignored unless it is the host or a parent of it |
| `API_URL` | `http://127.0.0.1:3000` | Where PostgREST serves the REST API ([chapter 13](13-rest-api.md)) |
| `API_JWT_SECRET` | *(none)* | Signs REST API tokens; at least 32 characters, the same as PostgREST's `jwt-secret`. Without it, tokens can't be issued |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS: marks cookies `Secure` and sends HSTS |
| `TRUST_PROXY` | `false` | Behind a reverse proxy, so client IPs (used by login throttling) come from `X-Forwarded-For`: `true` for one proxy, a number for several in a row (e.g. a CDN in front of nginx: `2`), or the proxies' addresses or subnets (`10.0.0.0/8,192.168.1.10`). Only the entries those proxies added are believed, never the ones a client sends along |
| `PGKILN_AUTH_HEADER_PROXIES` | *(none)* | Comma-separated IPs and CIDRs (e.g. `10.0.0.5, 192.168.10.0/24`) of the reverse proxies whose user header apps with **HTTP header** authentication trust; checked against the connection's own address, never `X-Forwarded-For`. Unset: header sign-in is refused ([chapter 8](08-security.md#http-header-authentication-reverse-proxy)) |
| `SESSION_IDLE_MINUTES` | `60` | A session ends after this long without requests. This and the next four can also be set in the builder (Workspace utilities → **Instance settings**), which wins over the variable |
| `SESSION_MAX_HOURS` | `8` | A session ends this long after sign-in, whatever the activity |
| `LOGIN_WINDOW_MINUTES` | `15` | Window for counting failed sign-ins |
| `LOGIN_MAX_FAILURES_PER_USER` | `5` | Failed sign-ins per username (since their last success) before a lock |
| `LOGIN_MAX_FAILURES_PER_IP` | `50` | Failed sign-ins per IP address before a lock |
| `STATEMENT_TIMEOUT` | `30s` | Maximum run time of any application SQL statement |
| `DB_POOL_SIZE` | `10` | Connections per pool (there are two pools) |
| `DB_NESTED_POOL_SIZE` | `5` | Connections per pool for queries a request makes while it holds a connection of that pool (opened only when needed) |
| `DB_ACQUIRE_TIMEOUT_MS` | `30000` | How long a request waits for a free connection before it fails with an error |
| `DB_IDLE_IN_TRANSACTION_MS` | `300000` | The database ends a transaction left idle this long (milliseconds), so a hung request frees its connection |
| `MAX_UPLOAD_MB` | `10` | Largest file a file item accepts (an item's `max_mb` can only lower it) |
| `PGKILN_PG_BIN` | (searched) | (sprint 103) The directory of pg_dump and pg_restore for Schema Export / Import (the server's major version or newer) |
| `PGKILN_DUMP_DIR` | `<temp>/pgkiln-dumps` | Where Schema Export / Import keeps its files (the Docker image: `/app/dumps`, a volume) |
| `PGKILN_DUMP_KEEP_DAYS` | `7` | Days an export or upload is kept |
| `PGKILN_DUMP_MAX_MB` | `2048` | Largest dump an administrator uploads |
| `DATA_LOAD_MAX_MB` | `50` | Largest file for SQL Workshop → Load Data and Create → From a file |
| `DATA_LOAD_MAX_ROWS` | `100000` | Most rows loaded from one file |
| `PDF_MAX_ROWS` | `5000` | Most rows in a report PDF (1 to 100,000; read with a cursor in batches) |
| `DOWNLOAD_MAX_ROWS` | `1000000` | Most rows in a report's CSV or Excel download and in a SQL Workshop → Unload Data file (streamed; at most 1,048,575) |
| `SAMPLE_DATA_STATEMENT_TIMEOUT` | `5min` | Statement timeout of SQL Workshop → Sample Data (each insert of a preview or a run) |
| `SAMPLE_DATA_MAX_ROWS` | `100000` | Most rows one Sample Data run generates (all tables together) |
| `UNLOAD_STATEMENT_TIMEOUT` | `5min` | Statement timeout of SQL Workshop → Unload Data (each statement: the cursor and every batch of rows) |
| `WORKSHEET_TXN_IDLE_SECONDS` | `300` | SQL Worksheet transaction mode: seconds without a run before an open transaction is rolled back (10 to 86400) |
| `WORKSHEET_TXN_MAX_PER_DEVELOPER` | `3` | Open worksheet transactions per developer (each holds a database connection) |
| `WORKSHEET_TXN_MAX` | `20` | Open worksheet transactions on the server |
| `REGION_CACHE_MAX_ENTRIES` | `1000` | Most regions in the [region cache](04-pages-and-regions.md#large-tables) of one server process (`0` turns caching off) |
| `REGION_CACHE_MAX_MB` | `64` | Memory for the region cache of one server process |
| `AUTOMATIONS` | on | `off` stops this server from running [automations](06-processing.md#automations) |
| `SCHEDULER_INTERVAL_S` | `30` | How often the automation scheduler looks for due runs |
| `BACKGROUND_PROCESSES` | on | `off` stops this server from running [background execution chains](06-processing.md#execution-chains) (another server runs them) |
| `PROCESS_JOB_INTERVAL_S` | `10` | How often a server looks for queued background chains (besides being woken by `NOTIFY`) |
| `QUEUE_RETRY_S` | `30` | (sprint 177) The wait before the second attempt of a queued [web request](09-reference.md#the-outbox-retries-callbacks-ordering), its callback or a [webhook event](13-rest-api.md#webhooks); it doubles with each attempt |
| `QUEUE_RETRY_MAX_S` | `3600` | The longest wait between two attempts (also the most a `Retry-After` header is honoured) |
| `WEBHOOKS` | on | `off` stops this server from processing webhook events (it still receives them; another server processes them). Queued web requests follow `AUTOMATIONS` |
| `GEOCODER_URL`, `GEOCODER_KEY` | *(none)* | A Nominatim-compatible search API for [geocoded address items](05-items.md#display-image-and-geocoded-address), e.g. your own Nominatim; `GEOCODER_KEY` is sent as `key` (LocationIQ). Without it address items are plain text items |
| `PDF_FONT`, `PDF_FONT_BOLD` | *(none)* | TrueType fonts for report PDFs, for text beyond Western European (e.g. `DejaVuSans.ttf`) |
| `ANTHROPIC_API_KEY` | *(none)* | Default API key of [AI services](03-builder.md#ai-services) with the provider Claude that have no key of their own |
| `OPENAI_API_KEY` | *(none)* | Default API key of AI services with the provider OpenAI that have no key of their own |
| `GEMINI_API_KEY` | *(none)* | (sprint 111) Default API key of AI services with the provider Gemini that have no key of their own |
| `OPENAI_COMPATIBLE_API_KEY` | *(none)* | (sprint 111) Default API key of OpenAI-compatible AI services (Ollama, vLLM, Azure OpenAI) that have no key of their own; without either, no key is sent (`none`) |
| `PGKILN_SECRET_KEY` | *(none)* | Encrypts the secrets of web credentials and the API keys of AI services; at least 32 characters (e.g. `openssl rand -base64 32`). Keep it outside the database; change it with `pgkiln admin rotate-key` ([chapter 3](03-builder.md#lockout-checks)), otherwise the secrets must be entered again |
| `PGKILN_OLD_SECRET_KEY` | *(none)* | (0.67) Only for `pgkiln admin rotate-key`: the key the secrets are stored with now |
| `PGKILN_REST_ALLOWED_HOSTS` | *(none: no outgoing calls)* | Hosts REST data sources and `invoke_api` may call: `api.example.com`, `*.example.com`, `host:8443`, `*` (any public host) ([chapter 19](19-rest-data-sources.md#server-configuration-and-the-allow-list)); a workspace's [network access list](03-builder.md#network-access) can narrow it, and the SMTP server of a workspace's own mail service must be on it |
| `PGKILN_REST_PRIVATE_HOSTS` | *(none)* | Hosts that may resolve to private, loopback or link-local addresses (also allows them) |
| `PGKILN_SERVER_<NAME>` | *(none)* | (sprint 141) The base URL of a [remote server](03-builder.md#static-workspace-files-remote-servers-and-web-credentials) that names this variable, e.g. `PGKILN_SERVER_CRM=https://crm.example.com`: it wins over the URL stored with the server, so each environment (development, test, production) sets its own. Only names starting `PGKILN_SERVER_` can be used |
| `PGKILN_PUSH_HOSTS` | the browsers' push services | The hosts push notifications may be posted to: `fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com,*.notify.windows.com` when unset ([chapter 17](17-mobile.md#push-notifications)) |
| `PGKILN_PUSH_SUBJECT` | `PUBLIC_URL` when it is https | The contact the push services see (`mailto:ops@example.com` or an https URL); Apple refuses notifications without one |
| `PGKILN_PUSH_PRIVATE_HOSTS` | *(none)* | For tests only: a push service on a private or loopback address, also over plain http |
| `PGKILN_REST_MAX_BYTES` | `5000000` | Largest web service response read (also after decompression) |
| `MIGRATE_ON_START` | `false` | `true` applies missing migrations when the server starts. Without it, a server whose database lacks migrations answers every request with 503 and names the missing files until they are applied (`npm run db:migrate` or `pgkiln migrate`; no restart needed) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `PGKILN_RELEASE_CHECK` | `off` | `on`: the server asks GitHub once a day for a newer pgkiln release and the [Workspace home](03-builder.md#the-release-check) announces it. Administrators can also set it in the builder (Instance settings → *New versions*), which wins over the variable. Keep it off where the server may not reach the internet |
| `PGKILN_RELEASE_URL` | GitHub's releases API | For tests and mirrors only: the address of a JSON document like GitHub's `releases/latest` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(none)* | (0.72) The OpenTelemetry Collector's OTLP/HTTP address (e.g. `http://otel-collector:4318`): pgkiln sends [traces, logs and metrics](#monitoring-with-opentelemetry) there. Workspace utilities → **OpenTelemetry** wins over it and over the other `OTEL_*` variables below |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `…_LOGS_ENDPOINT`, `…_METRICS_ENDPOINT` | the endpoint + `/v1/traces` … | A full URL per signal (only when the builder sets no collector URL) |
| `OTEL_EXPORTER_OTLP_HEADERS` | *(none)* | Headers sent to the collector, `name=value,name2=value2` (an API key) |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | `pgkiln`, *(none)* | The `service.name` and other resource attributes (`deployment.environment=prod`) |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | always on | `traceidratio` with a ratio from 0 to 1 sends that share of traces; a trace with an error is always sent |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` | `otlp` | `none` leaves that signal out |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Milliseconds between metric exports (5 s to 1 h) |
| `OTEL_SDK_DISABLED` | `false` | `true` turns the instance's export off, whatever the builder says |
| `PGKILN_METRICS`, `PGKILN_METRICS_TOKEN` | `off`, *(none)* | `on` opens `GET /metrics` (Prometheus) for administrators and for scrapers that send `Authorization: Bearer <PGKILN_METRICS_TOKEN>` |

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

## Docker

The quickest way to run pgkiln: the image [`pgkiln/pgkiln`](https://hub.docker.com/r/pgkiln/pgkiln)
(also `ghcr.io/pgkiln/pgkiln`, for amd64 and arm64) and a compose file with PostgreSQL 17. Docker is all
you need; no checkout of the source:

```bash
mkdir pgkiln && cd pgkiln
curl -fsSLO https://raw.githubusercontent.com/pgkiln/pgkiln/main/deploy/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/pgkiln/pgkiln/main/deploy/.env.example
# fill in POSTGRES_PASSWORD, RUNTIME_PASSWORD, PGKILN_SECRET_KEY (e.g. `openssl rand -hex 24` each)
# and PGKILN_ADMIN_PASSWORD (12+ characters) in .env
docker compose up -d
```

From a checkout of the source, `cd deploy && cp .env.example .env`, then `docker compose up -d --build`
builds the image from your copy instead.

Open http://127.0.0.1:3100/builder and sign in as `admin` with `PGKILN_ADMIN_PASSWORD`.

**What happens at each start** (`scripts/docker-start.ts`): the container checks the settings and
lists everything missing at once (it doesn't start on empty or too short secrets), waits for the
database, applies new migrations (with a lock, so several containers migrate once), and replaces
the builder's `admin` / `admin` with `PGKILN_ADMIN_PASSWORD` (a password changed later in the
builder is kept). `pgkiln_runtime` gets the password in `RUNTIME_DATABASE_URL` unless it
already signs in with it; `pgkiln_authenticator` (PostgREST) gets `PGKILN_AUTHENTICATOR_PASSWORD`,
or else a random one while it has its well-known default. Roles the start creates get their
passwords straight away. PostgreSQL roles belong to the whole server, not to one database: other
pgkiln databases on the same server share them, and with them these passwords. When the server
doesn't check passwords for the container's connection (`trust` in `pg_hba.conf`), the start
can't tell whether an older role has the password you configured. The same holds when the check
fails for another reason, such as a network error. The start then leaves that password alone
(other databases may use it), says so in the log, and you set it yourself. Without
`PGKILN_AUTHENTICATOR_PASSWORD`, checking the authenticator's default costs one failed sign-in in
the server log per start; setting it avoids that. `GET /healthz` answers `ok` when the database is reachable; the image's health
check uses it.

**`POSTGRES_PASSWORD` counts at the first start only**: the bundled database keeps it in the volume
`pgdata`. To change it later, change it in the database first
(`docker compose exec db psql -U pgkiln -c "\password pgkiln"`), then in `.env`. A wrong password
stops the container at once with a message saying so.

**Settings** go in `deploy/.env`: the ones in `.env.example`, and any other setting of the
[configuration reference](#configuration-reference).

| Setting | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `db` | `db`: the bundled PostgreSQL (its data is in the volume `pgdata`). Remove it to use your own server; add `https` for Caddy |
| `DATABASE_URL`, `RUNTIME_DATABASE_URL` | the bundled database | Your own PostgreSQL ([existing database](#installing-into-an-existing-database)); a server on the Docker host itself is `host.docker.internal` |
| `PGKILN_PORT`, `PGKILN_BIND` | `3100`, `127.0.0.1` | Only this machine can connect by default; `PGKILN_BIND=0.0.0.0` opens plain HTTP to the network |
| `PGKILN_DOMAIN` | | With the `https` profile: Caddy gets a certificate for this name (its DNS must point at the machine, ports 80 and 443 open). Set `PUBLIC_URL=https://…`, `COOKIE_SECURE=true` and `TRUST_PROXY=true` with it. Installing apps on phones and push notifications need HTTPS |
| `PGKILN_EXAMPLE` | | `hr` installs the HR example (its demo users have weak passwords: not on a public server) |
| `PGKILN_IMAGE` | `pgkiln/pgkiln:latest` | The image to run, e.g. a fixed version (`pgkiln/pgkiln:0.31.0`) or `ghcr.io/pgkiln/pgkiln` |

**Upgrading:** with the published image: `docker compose pull`, then `docker compose up -d` (with a
fixed version in `PGKILN_IMAGE`, change it first); `up -d` replaces the container when the image changed, so
`--force-recreate` isn't needed. Built from a checkout: `git pull`, then `docker compose up -d --build`. The new
container migrates the database before it starts serving. A `compose.yaml` from pgkiln 0.51.0 or older has
`pull_policy: missing` under `pgkiln`, which makes `docker compose pull` skip an image that is already present:
delete that line (or take the current `deploy/compose.yaml`) before the first upgrade this way. Back up first (`docker compose exec db pg_dump -U pgkiln pgkiln > backup.sql`).
Keep `PGKILN_SECRET_KEY`: without it, stored secrets (web credentials, AI keys, push keys, authenticator apps) can't
be decrypted. Keep a copy outside the server and confirm it on Instance settings; to change it, use
`pgkiln admin rotate-key` ([chapter 3](03-builder.md#lockout-checks)).

## Upgrading

Every schema change ships as a new, numbered file in `db/migrations/`. The runner records applied
files in `public.pgkiln_migration` and applies only new ones, each in its own transaction:

```bash
git pull
npm ci
npm run db:migrate
# restart the server
```

Back up the database before upgrading. Released migrations are never modified.

Each run that applies a file (or fails) is recorded in `public.pgkiln_install_log`; administrators
see it, with the applied migrations and any the database still misses, under Builder → Workspace
utilities → [Installation](03-builder.md#installation).

## Production deployment

A typical setup: pgkiln runs as a service behind a reverse proxy that terminates HTTPS.

```
Browser ──HTTPS──> nginx / Caddy / Traefik ──HTTP──> pgkiln (node) ──> PostgreSQL
```

1. **Database**
   - Use a dedicated owner role (it doesn't need to be a superuser once migrations have run,
     but it must own the `meta` schema and be allowed to create roles if developers create apps in the builder).
   - Set a strong password for `pgkiln_runtime`.
   - Enable regular backups (`pg_dump` or your provider's snapshots). Everything, including
     application definitions, lives in the database.
2. **Environment**
   ```bash
   NODE_ENV=production
   HOST=0.0.0.0
   PORT=3100
   DATABASE_URL=postgres://pgkiln_owner:...@db:5432/pgkiln
   RUNTIME_DATABASE_URL=postgres://pgkiln_runtime:...@db:5432/pgkiln
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
   WorkingDirectory=/opt/pgkiln
   EnvironmentFile=/opt/pgkiln/.env
   ExecStart=/usr/bin/npm start
   Restart=always
   User=pgkiln
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
   (NX-S3) With a public `PUBLIC_URL` the server refuses to start while a developer still has a default password
   (`admin`, or the user name): `pgkiln users password admin --developer` sets a new one.
   Don't install the example application in production: `npm run db:migrate` installs pgkiln only.
7. Walk through the checklist at the end of [SECURITY.md](../../SECURITY.md).

### Scaling

pgkiln keeps no state in memory between requests (sessions live in `meta.session`), so you can
run several instances behind a load balancer. Each instance opens up to
`2 × (DB_POOL_SIZE + DB_NESTED_POOL_SIZE)` database connections (30 with the defaults); keep the sum
of all instances below PostgreSQL's `max_connections` (100 by default).

## Monitoring with OpenTelemetry

(0.72; APEX: Workspace Utilities → OpenTelemetry) pgkiln sends **traces, logs and metrics** to your own monitoring
over OTLP, the OpenTelemetry protocol: Grafana (Tempo, Loki, Mimir), Jaeger, Datadog, Honeycomb, New Relic, Elastic,
OCI APM and the rest, normally through an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/). It sends
OTLP over HTTP as JSON (`http/json`), which every Collector accepts on port 4318. No agent and no extra package are
needed, and nothing runs while no collector is set.

Administrators set it up in Workspace utilities → **OpenTelemetry** (`/builder/telemetry`), or with the standard
`OTEL_*` variables of the [configuration reference](#configuration-reference) (a value set in the builder wins):

- **Collector URL**: the OTLP/HTTP base address; `/v1/traces`, `/v1/logs` and `/v1/metrics` are added.
  **Headers** (an API key) are stored encrypted with `PGKILN_SECRET_KEY` (rotated by `pgkiln admin rotate-key`)
  and never shown again, only their names. **Send a test span** sends one span and shows what the collector answered;
  *Status* shows what each server process sent, dropped, and the last problem.
- **What is traced.** Every application request is a trace: a server span `GET /a/:alias/:page` with the application,
  page, HTTP status, route and the user (see below), and a child span for **each SQL statement** (`db.query.text`,
  rows, SQLSTATE on errors; transaction control left out), **each outgoing web call** (REST data sources, `invoke_api`,
  `meta.web_request`, web credential token requests: `HTTP GET` with the host, path and status; a 4xx/5xx answer is
  an error span), **each AI request** (`gen_ai.*`: provider, model, input and output tokens) and **each AI tool call**
  of an assistant or agent. A W3C `traceparent` header goes along with every outgoing web call, so the called service
  joins the same trace, and an incoming `traceparent` (from a proxy or another service) is continued. Background work
  has traces of its own: each **mail** sending attempt and each **workflow step** (with the `invoke_api` call inside it).
  *Trace builder requests too* adds `/builder` requests (to the instance's collector only).
- **Sample ratio**: the share of traces sent (0 to 1). pgkiln keeps a trace's spans until it ends, so a trace with an
  error (an HTTP 5xx, a failing statement, a REST call answered with 500) is **always** sent.
- **Values stay out** unless *Include values* is on: SQL statements are sent with their literals replaced by `?`
  (`where ename = ?`), bind values, the query string, the full URL of outgoing calls and AI tool arguments are left
  out, and quoted values, `Key (col)=(value)`, e-mail addresses and long numbers are removed from error messages.
  With *Include values*, statements go as run, with `db.query.parameter.N`.
- **User**: *Hashed* (the default) sends `enduser.id` as a keyed hash (the same user always gives the same value,
  the name is not sent), *User name* sends the name, *Not sent* leaves it out.
- **Logs**: errors (also unhandled server errors), refused access and failed or locked sign-ins, as log records tied
  to the request's trace, with the application and page.
- **Metrics**, every 60 seconds (`OTEL_METRIC_EXPORT_INTERVAL`): `pgkiln.http.server.duration` (a histogram in
  milliseconds per application, method and status class), `pgkiln.errors`, `pgkiln.access_denied`,
  `pgkiln.signin_failures`, `pgkiln.ai.requests`, `pgkiln.ai.tokens` (per provider, model, input/output),
  `pgkiln.mail.sent`, and the levels `pgkiln.mail.queue`, `pgkiln.jobs.queue`, `pgkiln.workflows`,
  `pgkiln.ai.requests.pending`, `pgkiln.embeddings.queue`, `pgkiln.db.pool.connections`, `process.memory.rss`,
  `process.uptime`; `pgkiln.telemetry.dropped` counts what could not be sent.
- **Browser spans** (optional): a page whose trace is sent carries a signed `<meta name="pgkiln-trace">`, and `app.js`
  reports the page's load timings and its Ajax calls to `POST /a/<alias>/telemetry`; pgkiln adds them to the page's
  trace (*browser page load*, *browser POST*). The browser never sees the collector or its headers, and the token is
  bound to the trace, the application and 30 minutes.
- **Prometheus**: *Prometheus endpoint /metrics* (or `PGKILN_METRICS=on`) answers `GET /metrics` in the Prometheus
  text format, for administrators signed in to the builder and for scrapers with the metrics token (*Make a token*,
  shown once; or `PGKILN_METRICS_TOKEN`). It works without a collector.

Each **workspace** chooses on its page → *Mail and network access* → **OpenTelemetry**
(`/builder/workspaces/<id>/telemetry`, its administrators): *As the instance does* (the default), *Nothing* (its
applications send nothing, not even to the instance's collector), or *Also to our own collector*: an OTLP/HTTP URL
with its own headers and its own *Include values*, reached like any outgoing call of the workspace, through the
installation's allow-list (`PGKILN_REST_ALLOWED_HOSTS`) and the workspace's [network access](03-builder.md#network-access)
list. Its resource carries `pgkiln.workspace.id`. Metrics go to the instance's collector only.

A Collector that sends traces to Jaeger, for a first look (`docker compose`):

```yaml
services:
  jaeger:
    image: jaegertracing/all-in-one:1.62.0     # the UI on http://localhost:16686
    environment: { COLLECTOR_OTLP_ENABLED: "true" }
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.114.0
    command: ["--config=/etc/otel.yaml"]
    volumes: ["./otel.yaml:/etc/otel.yaml:ro"]
    ports: ["4318:4318"]
```

```yaml
# otel.yaml
receivers:
  otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } }
exporters:
  otlp/jaeger: { endpoint: jaeger:4317, tls: { insecure: true } }
  debug: {}
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [otlp/jaeger] }
    logs: { receivers: [otlp], exporters: [debug] }
    metrics: { receivers: [otlp], exporters: [debug] }
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (or the URL in the builder), open a page, and its trace shows
in Jaeger under the service `pgkiln`. A Prometheus scrape job for `/metrics`:

```yaml
scrape_configs:
  - job_name: pgkiln
    metrics_path: /metrics
    authorization: { credentials: "<the metrics token>" }
    static_configs: [{ targets: ["apps.example.com:443"] }]
    scheme: https
```

Every server process sends what it saw: with several instances, each is a `service.instance.id` (host and process).
A collector that is down costs a failed request per batch every few seconds, never a user's request; what doesn't fit
the queue (8,192 spans per collector) is dropped and counted.

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
