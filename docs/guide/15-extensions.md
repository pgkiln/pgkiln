# 15. Useful PostgreSQL extensions

pgapex itself needs only `pgcrypto`, which ships with PostgreSQL. Everything else in this chapter
is **optional**: extensions that make pgapex applications faster, safer or closer to what Oracle
APEX offers. Many APEX features that pgapex doesn't build in (scheduling, calling web services,
maps, AI search) are covered well by extensions, because in pgapex your application logic lives in
PostgreSQL anyway.

Last reviewed: 2026-09-30 (PostgreSQL 17).

## Tier 1: included with PostgreSQL

These are *contrib* modules. They're in the official Docker image (and therefore in `npm run
setup`) and on practically every managed service. Install with `create extension …` as the owner.

| Extension | What it gives a pgapex app | APEX counterpart |
|---|---|---|
| **pg_trgm** | Fast `ilike '%…%'` and similarity search with trigram indexes. Report search, facets and searchable lists of values on large tables stay fast | Oracle Text / IR search |
| **unaccent** | Accent-insensitive search (`café` finds `cafe`), essential in multilingual apps | Text search options |
| **citext** | Case-insensitive text columns (e-mail addresses, codes) without `lower()` everywhere | NLS_COMP=LINGUISTIC |
| **btree_gist** | Exclusion constraints on ranges, e.g. **no overlapping bookings/leave** enforced by the database, race-free | Custom PL/SQL checks |
| **pg_stat_statements** | Which SQL is slow or called most, per role, so per app (`db_role`) | Monitor Activity → Top SQL |
| **tablefunc** | `crosstab()` for pivot tables | Interactive report *Pivot* |
| **ltree** | Hierarchies (org charts, categories, menus) with fast subtree queries | Tree region, `CONNECT BY` |
| **postgres_fdw**, **file_fdw** | Query another PostgreSQL database, or a CSV file, as if it were a table | Remote servers / database links |
| **dblink** | Run a statement on a separate connection, the usual stand-in for Oracle's **autonomous transactions** (e.g. error logging that survives a rollback) | `PRAGMA AUTONOMOUS_TRANSACTION` |
| **amcheck**, **pg_buffercache** | Integrity checks and cache insight for DBAs | |

Two examples from the HR sample.

Accelerate the employee search with a trigram index on the searched column:

```sql
create extension if not exists pg_trgm;
create index emp_ename_trgm on hr.emp using gin (ename gin_trgm_ops);
-- used by: where ename ilike '%lak%'
```

(The report's *search all columns* box compares the whole row as text, which no index can speed
up. For large tables, add a filter item or facet on an indexed column instead.)

Make overlapping leave impossible even under concurrent requests. `hr.request_leave()` checks it
too, but only a constraint is race-free:

```sql
create extension if not exists btree_gist;
alter table hr.leave_request add constraint leave_no_overlap
  exclude using gist (empno with =, daterange(start_date, end_date, '[]') with &&)
  where (status in ('PENDING', 'APPROVED'));
```

pgapex shows a violation as the friendly "The values violate a rule (leave_no_overlap)" message.

## Tier 2: third-party, widely available

Not in the official image, but offered by the large managed services (Amazon RDS/Aurora, Azure
Database for PostgreSQL, Google Cloud SQL, Supabase, Neon and others; check your provider's list).
For self-hosting, use your distribution's packages (e.g. the PGDG apt/yum repositories) or an image
that includes them.

| Extension | What it gives a pgapex app | APEX counterpart |
|---|---|---|
| **[pg_cron](https://github.com/citusdata/pg_cron)** | Run SQL on a schedule inside the database (`select cron.schedule('nightly', '0 2 * * *', 'call hr.close_month()')`) | **Automations**, `DBMS_SCHEDULER` |
| **[pgaudit](https://github.com/pgaudit/pgaudit)** | Statement-level audit logging (reads, writes, DDL, role changes) to the server log, for compliance | Oracle Unified Auditing |
| **PostGIS** | Geometry and geography types, spatial indexes and functions: the foundation for a map region | **Map region**, Oracle Spatial |
| **pgvector** | Vector similarity search (embeddings) for semantic search and retrieval-augmented generation | APEX AI (RAG sources), Oracle AI Vector Search |
| **[plpgsql_check](https://github.com/okbob/plpgsql_check)** | Static analysis of PL/pgSQL: wrong columns, unused variables, missing `RETURN`, hidden casts. Run it on your app's functions in CI | **Advisor** (for code) |

Scheduling example with pg_cron. pg_cron must be in `shared_preload_libraries` (a server setting;
managed services have a switch for it). A job runs **as the role that scheduled it**, outside any
pgapex session, so `meta.app_user()` is `nobody` and row level security hides rows that depend on
the user. So give the job a narrow `security definer` function and a dedicated role:

```sql
-- as a superuser, once
create extension if not exists pg_cron;

-- the work: owned by the table owner, so it isn't filtered by RLS
create function hr.expire_stale_requests() returns int
language sql security definer set search_path = hr, pg_catalog as $$
  with x as (
    update hr.leave_request set status = 'WITHDRAWN'
     where status = 'PENDING' and start_date < current_date
    returning 1)
  select count(*)::int from x
$$;

-- a role that can do nothing but run it (pg_cron connects as the job's role, so it needs LOGIN
-- unless cron.use_background_workers is on)
create role hr_jobs login password 'change-me';
grant usage on schema cron, hr to hr_jobs;
revoke execute on function hr.expire_stale_requests() from public;
grant execute on function hr.expire_stale_requests() to hr_jobs;

-- as hr_jobs
select cron.schedule('hr-expire-requests', '15 1 * * *', 'select hr.expire_stale_requests()');
```

Audit triggers record such changes as made by `nobody`, which is what you want for system jobs.

## Tier 3: situational

| Extension | Use it when | Notes |
|---|---|---|
| **[orafce](https://pgxn.org/dist/orafce/)** | Porting PL/SQL from APEX apps: `nvl`, `decode`, `add_months`, `trunc` for dates, `dbms_output`, `utl_file` and more | Eases migration. Prefer plain PostgreSQL (`coalesce`, `case`) in new code |
| **pgTAP** | Unit tests for your PL/pgSQL business rules, run in CI | Complements pgapex's own test suites |
| **[http](https://github.com/pramsey/pgsql-http)** | Call a REST API from SQL synchronously (`select content from http_get(…)`) | Like `APEX_WEB_SERVICE`. Blocks the transaction while it waits |
| **[pg_net](https://github.com/supabase/pg_net)** | Fire-and-forget HTTP calls from triggers (webhooks) | Asynchronous: the request is sent after commit by a background worker |
| **[pgmq](https://github.com/pgmq/pgmq)** | A message queue in Postgres for background work handled by a worker service | Like AWS SQS, transactional |
| **pg_partman** | Partition big append-only tables such as `meta.activity_log` by month | Only needed at high volume |
| **[plv8](https://github.com/plv8/plv8)** | Server-side JavaScript functions | Like APEX's MLE JavaScript. Maintained upstream, but some hosts (e.g. Supabase on PostgreSQL 17) no longer offer it, so check before depending on it |
| **[pg_smtp_client](https://github.com/brianpursley/pg_smtp_client)** | Sending e-mail from SQL, if your team needs it | pgapex deliberately doesn't send mail ([chapter 11](11-from-apex.md)). This keeps mail out of pgapex and in your own schema |

## Security notes

- **Install extensions as the owner, then grant narrowly.** An extension's functions often run
  with high privileges. Give an app role only the functions it needs, e.g.
  `grant execute on function http_get(varchar) to hr_app;`.
- **Network access from SQL (http, pg_net) creates server-side request forgery risk.** Any SQL
  the app role runs can reach your internal network. Never grant it to roles that run
  user-influenced dynamic SQL. Allow only fixed URLs through a wrapper function, e.g.
  `hr.fetch_exchange_rates()` as `security definer` with a hard-coded endpoint.
- **pg_cron jobs run as their owner.** Schedule them with a restricted role, not a superuser.
- **pgaudit logs can contain data.** Treat the server logs as sensitive.
- **Row level security still applies** to everything an app role does through an extension's
  SQL functions, unless the function is `security definer`.

## Possible pgapex integrations (roadmap ideas)

| Idea | Extension | Effort |
|---|---|---|
| **Top SQL per application** on the Activity page | pg_stat_statements | Small |
| **Code check** of an app's functions in the builder (like APEX Advisor) | plpgsql_check | Small |
| **Map region** from GeoJSON or PostGIS geometries | PostGIS (optional) | Medium–large |
| **Pivot** view in interactive reports | tablefunc, or plain `group by` | Medium |
| **Tree region** for hierarchies | ltree, or recursive CTEs | Medium |

None of these would become *required*: pgapex keeps running on a stock PostgreSQL, and the
builder would show features only when the extension is installed.
