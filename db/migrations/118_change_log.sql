-- ---------------------------------------------------------------------
-- 118: the change log (sprint 106, Database Actions DA-17; Liquibase /
-- Flyway). The DDL a developer runs from the SQL Worksheet, Table
-- Properties and Schema Comparison is recorded as a change set: who, when,
-- the SQL, the schema it changes, where it came from, and a number per
-- workspace and schema (seq) that stays when other change sets are deleted,
-- so exported Flyway versions (V0001__add_bonus.sql) never change
-- (meta.change_set_counter).
-- SQL Workshop › Change Log lists them per schema and writes them as
-- migration files; exported_at says when a change set was last written.
--
-- The builder reads and writes it as the owner; nobody else has grants.
-- Installation data like the worksheet's history: not exported with an
-- application (the schema's DDL is not part of an application).
-- ---------------------------------------------------------------------
create table meta.change_set (
  id            bigint generated always as identity primary key,
  workspace_id  int  not null default 1 references meta.workspace on delete cascade,
  schema_name   text not null check (length(schema_name) between 1 and 63),
  seq           int  not null,
  -- the description in file names: V0001__<name>.sql
  name          text not null check (name ~ '^[a-z0-9][a-z0-9_]{0,59}$'),
  author        text not null,
  source        text not null check (source in ('worksheet', 'table', 'compare')),
  sql           text not null check (length(sql) between 1 and 1000000),
  object_name   text check (length(object_name) <= 63),
  created_at    timestamptz not null default now(),
  exported_at   timestamptz,
  unique (workspace_id, schema_name, seq)
);
create index change_set_schema_idx on meta.change_set (workspace_id, schema_name, seq);
revoke all on meta.change_set from public;
comment on table meta.change_set is 'The change log (118): DDL run from the SQL Workshop as change sets per workspace and schema; installation data, not exported';

-- the last number given per workspace and schema: a deleted change set's number is never given again
create table meta.change_set_counter (
  workspace_id  int  not null references meta.workspace on delete cascade,
  schema_name   text not null,
  last_seq      int  not null,
  primary key (workspace_id, schema_name)
);
revoke all on meta.change_set_counter from public;
comment on table meta.change_set_counter is 'The change log (118): the last change set number per workspace and schema; installation data';

create function meta.change_set_seq() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  insert into meta.change_set_counter as c (workspace_id, schema_name, last_seq) values (new.workspace_id, new.schema_name, 1)
    on conflict (workspace_id, schema_name) do update set last_seq = c.last_seq + 1
    returning last_seq into new.seq;
  return new;
end $$;
create trigger change_set_seq before insert on meta.change_set
  for each row execute function meta.change_set_seq();
