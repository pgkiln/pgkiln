-- =====================================================================
-- 062: App Builder AI (APEX: AI Assistant in App Builder and SQL Workshop,
--      describe tables for LLMs)
--
-- meta.builder_ai: which AI service (migration 060) the App Builder uses
--   for developers (one row; an administrator chooses it). Without one the
--   builder's AI pages say so.
--
-- meta.ai_table_note: descriptions of tables, views and their columns for
--   the model (APEX: "describe tables for LLMs"), written by developers (or
--   drafted by AI and reviewed). They go with the table list when the
--   builder asks a model for SQL or for pages. Installation data (they
--   describe this database, not an application): not exported. The builder
--   can also write them as COMMENT ON (then they are part of the schema).
--
-- The builder's AI requests are logged in meta.ai_usage with source
-- "builder" and no application. Nothing a model answers is run without the
-- developer: generated SQL is shown, pages are proposed and created only
-- for the proposals the developer confirms (meta.generate_page).
-- =====================================================================

create table meta.builder_ai (
  id          boolean primary key default true check (id),
  service_id  int references meta.ai_service on delete set null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
insert into meta.builder_ai default values;
revoke all on meta.builder_ai from public;

create table meta.ai_table_note (
  schema_name text not null,
  table_name  text not null,
  -- '' describes the table itself
  column_name text not null default '',
  note        text not null check (length(btrim(note)) between 1 and 2000),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (schema_name, table_name, column_name)
);
revoke all on meta.ai_table_note from public;
comment on table meta.ai_table_note is 'Descriptions of tables and columns for AI models (App Builder AI); installation data, not exported';
