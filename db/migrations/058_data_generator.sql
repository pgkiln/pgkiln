-- ---------------------------------------------------------------------
-- 058: sample data generators (sprint 35; APEX 26.1: Data Generator /
--      "sample data for development")
--
-- meta.data_generator: a saved generator definition of SQL Workshop →
--   Sample Data: the schema, an optional seed (the same seed gives the
--   same rows), and per table the number of rows and per column the
--   generator, its options and the percentage of nulls:
--   [{"table": "emp", "rows": 50, "columns": [
--      {"column": "ename", "generator": "full_name", "options": "", "nulls": 0}, …]}]
--   Shared by the developers of the installation, like SQL scripts (041):
--   it describes tables of a schema, not an application, so it is not part
--   of an application export. Read and written only by the builder (owner);
--   the runtime role has no access.
-- ---------------------------------------------------------------------

create table meta.data_generator (
  id          serial primary key,
  name        text not null unique check (length(name) between 1 and 100),
  description text check (length(description) <= 1000),
  schema_name text not null check (length(schema_name) between 1 and 63 and schema_name !~ '^pg_' and schema_name not in ('meta', 'information_schema')),
  seed        bigint check (seed between 0 and 4294967295),
  tables      jsonb not null default '[]' check (jsonb_typeof(tables) = 'array'),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now()
);

revoke all on meta.data_generator from public;
