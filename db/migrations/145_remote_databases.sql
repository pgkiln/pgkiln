-- Sprint 150 (AP-7 leftover; APEX: REST Enabled SQL services, regions on another database): remote databases.
--
-- A remote database is another PostgreSQL database whose tables applications query as if they were local: pgkiln
-- makes a postgres_fdw server for it, a user mapping (the remote user and password: kept by PostgreSQL in
-- pg_user_mapping, which only superusers and the server's owner can read; pgkiln itself never stores the password),
-- and imports the remote schema's tables (all, or the ones named) as foreign tables into a local schema of their
-- own. Regions, lists of values, reports, forms and grids then use <local schema>.<table> like any table: as the
-- application's database role, in its transaction, with the grants given here (SELECT, optionally INSERT, UPDATE,
-- DELETE). The remote side's own rights decide what the remote user may do there.
--
-- Administrators manage them (Workspace utilities → Remote databases); the rows are installation data, never
-- exported with an application (the foreign tables are database objects, like the application's own tables).

create table meta.remote_database (
  id            serial primary key,
  -- the static id: upper case, used in messages and the server's name
  name          text not null unique check (name ~ '^[A-Z][A-Z0-9_]{0,29}$'),
  description   text check (length(description) <= 1000),
  host          text not null check (length(host) between 1 and 253),
  port          int not null default 5432 check (port between 1 and 65535),
  dbname        text not null check (length(dbname) between 1 and 63),
  user_name     text not null check (length(user_name) between 1 and 63),
  remote_schema text not null default 'public' check (length(remote_schema) between 1 and 63),
  -- the schema the foreign tables go into; pgkiln's own (marked by its comment), dropped with the remote database
  local_schema  text not null unique check (local_schema ~ '^[a-z_][a-z0-9_]{0,62}$'),
  -- the remote tables to import; empty: all of the remote schema's tables and views
  tables        text[] not null default '{}',
  -- application database roles granted USAGE on the schema and SELECT (and with writable INSERT, UPDATE, DELETE)
  grant_roles   text[] not null default '{}',
  writable      boolean not null default false,
  -- the postgres_fdw server: pgkiln_rdb_<name in lower case>
  server_name   text not null unique,
  imported_at   timestamptz,
  imported      int,
  error         text,
  created_by    text not null,
  updated_by    text not null,
  updated_at    timestamptz not null default now()
);
revoke all on meta.remote_database from public;
comment on table meta.remote_database is 'Remote PostgreSQL databases imported as foreign tables (postgres_fdw) into a local schema (150); installation data, administrators only, never exported. Passwords live only in the user mapping.';
