-- ---------------------------------------------------------------------
-- 111: the SQL Workshop's Data Modeler (sprint 98, Database Actions
-- DA-10: relational diagrams). A diagram is a named picture of some
-- tables and views of one schema: which objects it shows and where each
-- box stands. objects is a jsonb array of {"name", "x", "y"} (the
-- object's name in the schema, the box's position). The objects are only
-- names: the columns, keys and foreign keys are read from the catalog
-- whenever the diagram is shown, so a diagram never goes stale. Per
-- workspace, shared by its developers. The builder reads and writes it
-- as the owner; installation data, not exported.
-- ---------------------------------------------------------------------
create table meta.sql_diagram (
  id            bigint generated always as identity primary key,
  workspace_id  int not null default 1 references meta.workspace on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  schema_name   text not null check (length(schema_name) between 1 and 63),
  objects       jsonb not null default '[]' check (jsonb_typeof(objects) = 'array' and jsonb_array_length(objects) <= 500),
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  unique (workspace_id, name)
);
comment on table meta.sql_diagram is 'The SQL Workshop Data Modeler''s diagrams per workspace (111); installation data, not exported';
