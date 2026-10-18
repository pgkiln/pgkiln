-- =====================================================================
-- 120: Data Reporter datasets (APEX 26.1: Data Reporter → Datasets)
--
-- A dataset is a reusable, trusted view of a workspace's data for business
-- users: tables and views of one schema, joined (the joins proposed from
-- foreign keys), the columns users may see with labels, format masks and
-- descriptions, and an optional row filter. Developers define datasets in
-- the builder (Data Reporter); a Data Reporter region offers a dataset as a
-- source with {"id": "...", "dataset": "<name>"} in config.sources, and
-- the runtime builds the dataset's SELECT from the definition (identifiers
-- quoted, values as literals, operators from a whitelist) and runs reports
-- on it as the application's database role, so grants and row level
-- security apply.
--
--   tables  [{"alias": "t1", "table": "emp"},
--            {"alias": "t2", "table": "dept",
--             "join": {"to": "t1", "type": "left", "on": [{"column": "deptno", "ref": "deptno"}]}}]
--   columns [{"name": "ename", "table": "t1", "column": "ename", "label": "Name",
--             "format": "FML999G990D00", "description": "..."}]
--   filters [{"table": "t1", "column": "active", "op": "eq", "value": "true"}]
--
-- Per workspace, like the SQL Workshop's saved work. Installation data:
-- not part of an application's export (the builder's Data Reporter exports
-- and imports datasets as JSON files). The builder writes it as the owner;
-- the runtime reads it through its own login, and row level security shows
-- an isolated workspace's login its own workspace's datasets only.
-- =====================================================================
create table meta.dataset (
  id           bigint generated always as identity primary key,
  workspace_id int  not null default 1 references meta.workspace on delete cascade,
  name         text not null check (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  label        text not null check (length(btrim(label)) between 1 and 80),
  description  text check (length(description) <= 500),
  schema_name  text not null check (length(schema_name) between 1 and 63 and schema_name !~* '^(pg_.*|information_schema|meta)$'),
  tables       jsonb not null check (jsonb_typeof(tables) = 'array' and jsonb_array_length(tables) between 1 and 10),
  columns      jsonb not null default '[]' check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) <= 200),
  filters      jsonb not null default '[]' check (jsonb_typeof(filters) = 'array' and jsonb_array_length(filters) <= 5),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  unique (workspace_id, name)
);
revoke all on meta.dataset from public;
grant select on meta.dataset to pgkiln_runtime;
comment on table meta.dataset is 'Data Reporter datasets per workspace (120): joined tables and views, offered columns, a row filter; installation data, not exported';

-- May this login see a workspace's datasets? An isolated workspace's login: its own only;
-- other logins: those of workspaces that are not isolated.
create function meta.dataset_visible(p_workspace int) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select case when meta.login_workspace() is not null then p_workspace = meta.login_workspace()
              else not coalesce((select w.isolated from meta.workspace w where w.id = p_workspace), false) end
$$;

-- The workspace whose datasets an application's Data Reporter offers (refused for an
-- application the login may not see).
create function meta.dataset_workspace(p_app_id int) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select meta.app_workspace(meta.checked_app(p_app_id))
$$;

revoke all on function meta.dataset_visible(int), meta.dataset_workspace(int) from public;
grant execute on function meta.dataset_visible(int), meta.dataset_workspace(int) to pgkiln_runtime;

-- (090) an isolated workspace's logins see their own workspace's datasets only
alter table meta.dataset enable row level security;
create policy workspace on meta.dataset
  using ((select meta.isolation_off()) or meta.dataset_visible(workspace_id));
