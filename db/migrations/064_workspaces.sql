-- =====================================================================
-- 064: workspaces (APEX: workspaces)
--
-- A workspace groups applications and the developers who build them. The
-- builder shows a developer the applications of their workspaces only and
-- refuses the others; administrators (meta.developer.is_admin) see every
-- workspace and manage them. Workspace 1, "Default", holds every
-- application and developer that existed before.
--
-- Not a security boundary between developers who write SQL: application code
-- and the SQL Workshop run with installation-wide rights (see the docs).
--
-- An application's workspace is a row in meta.workspace_app; no row means
-- the Default workspace, so imports, the CLI and older code paths put new
-- applications there until the builder moves them. Installation data: not
-- exported, kept by an in-place import (pgapex import --replace).
-- =====================================================================

create table meta.workspace (
  id          serial primary key,
  name        text not null check (name ~ '^\S(.{0,58}\S)?$'),
  description text check (length(description) <= 2000),
  created_at  timestamptz not null default now()
);
create unique index workspace_name_key on meta.workspace (lower(name));
insert into meta.workspace (id, name, description) values (1, 'Default', 'The workspace of this installation''s first applications and developers.');
select setval('meta.workspace_id_seq', 1);

create table meta.workspace_member (
  workspace_id int not null references meta.workspace (id) on delete cascade,
  username     text not null references meta.developer (username) on delete cascade on update cascade,
  primary key (workspace_id, username)
);
create index workspace_member_username_idx on meta.workspace_member (username);
insert into meta.workspace_member (workspace_id, username) select 1, username from meta.developer;

-- a developer added without the builder (the CLI, SQL) joins the Default workspace
create function meta.developer_default_workspace() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  insert into meta.workspace_member (workspace_id, username) values (1, new.username) on conflict do nothing;
  return new;
end $$;
create trigger developer_default_workspace after insert on meta.developer
  for each row execute function meta.developer_default_workspace();

create table meta.workspace_app (
  app_id       int primary key references meta.app (id) on delete cascade,
  workspace_id int not null references meta.workspace (id)
);
create index workspace_app_workspace_idx on meta.workspace_app (workspace_id);

-- the Default workspace can't be removed (applications without a row belong to it)
create function meta.workspace_keep_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if old.id = 1 then
    raise exception 'The Default workspace cannot be deleted.';
  end if;
  return old;
end $$;
create trigger workspace_keep_default before delete on meta.workspace
  for each row execute function meta.workspace_keep_default();

-- the workspace of an application (1 = Default when it has no row)
create function meta.app_workspace(p_app_id int) returns int
language sql stable set search_path = pg_catalog as $$
  select coalesce((select workspace_id from meta.workspace_app where app_id = p_app_id), 1)
$$;

revoke all on meta.workspace, meta.workspace_member, meta.workspace_app from public;
revoke all on function meta.app_workspace(int), meta.workspace_keep_default(), meta.developer_default_workspace() from public;

comment on table meta.workspace is 'Workspaces: groups of applications and developers (064). Installation data, not exported.';
comment on table meta.workspace_member is 'The developers of a workspace; administrators see every workspace without a row.';
comment on table meta.workspace_app is 'The workspace of an application; no row = the Default workspace (1).';
