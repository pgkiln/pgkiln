-- =====================================================================
-- 167: every application runs as a database role of its own (sprint 186,
--      NX-S2)
--
-- An application's db_role is APEX's parsing schema: its pages, processes
-- and background work run as that role, so its grants and row level
-- security apply. Until now db_role could be empty, and the application
-- then ran as the runtime connection's own login, which is a member of
-- every shared application's role. Now:
--
--   - meta.role_is_powerful(role): a role no application (and no developer
--     login, 166) may run as: a superuser, a role that creates roles or
--     databases, bypasses row level security or replicates; pgkiln's own
--     roles and PostgreSQL's (pgkiln*, pg_*); and any member of such a role,
--     of the owner of pgkiln's schemas, or of PostgreSQL's roles that read
--     or write every table or the server's files;
--   - meta.app refuses an empty db_role and a powerful one when an
--     application is created or its db_role is set (the settings form, an
--     import, the Create Application wizard, anything else);
--   - the developer logins of shared workspaces (166) use the same check.
--
-- Upgrade: nothing is granted and no application is changed. An existing
-- application without a role (or with a powerful one) keeps its row; the
-- Advisor reports an error, the security checklist a red line, and the
-- server refuses to run it except for its developers from the builder
-- (src/app-role.ts). A developer gives it a role in Settings → Security,
-- where pgkiln offers to create app_<alias> with rights on a schema.
--
-- Written to run again (create or replace, drop ... if exists): the test
-- of this sprint runs it a second time inside a transaction.
-- =====================================================================

create or replace function meta.role_is_powerful(p_role text) returns boolean
language sql stable set search_path = meta, pg_catalog as $$
  select p_role is not null and (
    p_role like 'pgkiln%' or p_role like 'pg\_%'
    or exists (
      select 1 from pg_roles r
       where r.rolname = p_role
         and (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication
              -- a member of a powerful role, of pgkiln's own roles or of PostgreSQL's broad ones can SET ROLE to it
              or exists (select 1 from pg_roles g
                          where g.oid <> r.oid
                            and (g.rolsuper or g.rolcreaterole or g.rolcreatedb or g.rolbypassrls or g.rolreplication
                                 or g.rolname like 'pgkiln%'
                                 or g.rolname in ('pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program',
                                                  'pg_read_server_files', 'pg_write_server_files'))
                            and pg_has_role(r.oid, g.oid, 'MEMBER'))
              -- the owner of pgkiln's schemas, or a member of it
              or exists (select 1 from pg_namespace n
                          where (n.nspname = 'meta' or n.nspname like 'pgkiln%')
                            and pg_has_role(r.oid, n.nspowner, 'MEMBER')))));
$$;
comment on function meta.role_is_powerful(text) is
  'A role no application or developer login may run as (167): superuser, CREATEROLE, CREATEDB, BYPASSRLS, REPLICATION, pgkiln''s or PostgreSQL''s own, a member of one of those or of the owner of pgkiln''s schemas.';

-- (166) a shared workspace's developer login: the same check
create or replace function meta.workspace_dev_roles(p_ws int) returns setof text
language sql stable set search_path = meta, pg_catalog as $$
  select distinct a.db_role
    from meta.app a join pg_roles r on r.rolname = a.db_role
   where meta.app_workspace(a.id) = p_ws
     and not meta.role_is_powerful(a.db_role)
     and not exists (select 1 from meta.workspace_role x join meta.workspace w on w.id = x.workspace_id
                      where w.isolated and x.role_name = a.db_role)
$$;
revoke all on function meta.workspace_dev_roles(int) from public;

-- an application's role when it is made or set
create or replace function meta.app_role_check() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
begin
  if new.db_role is null or btrim(new.db_role) = '' then
    raise exception 'Application % needs a database role of its own (APEX: parsing schema): set db_role.', new.alias
      using errcode = '23502', hint = 'Settings → Security creates app_<alias> with rights on a schema; an import without a role gets one.';
  end if;
  if meta.role_is_powerful(new.db_role) then
    raise exception 'Application % can''t run as %: a superuser, a role that bypasses row level security, creates roles or owns pgkiln''s schemas (or a member of one) is refused.', new.alias, new.db_role
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists app_role_check on meta.app;
create trigger app_role_check before insert or update of db_role on meta.app
  for each row execute function meta.app_role_check();

-- what is left to do after the upgrade (nothing is changed or granted here)
do $$
declare
  r record;
begin
  for r in select alias, db_role from meta.app where db_role is null or btrim(db_role) = '' or meta.role_is_powerful(db_role) order by alias loop
    raise notice 'Application % %: it runs only for its developers from the builder until it has a role of its own (Settings → Security).',
      r.alias, case when r.db_role is null or btrim(r.db_role) = '' then 'has no database role' else format('runs as %s, a powerful role', r.db_role) end;
  end loop;
end $$;

-- the developer logins: memberships in roles that are powerful now go
select meta.workspace_sync_roles();
