-- =====================================================================
-- 166: the SQL Workshop runs as the workspace's developer login, not as
--      the owner (sprint 185, NX-S1)
--
-- Until now the SQL Workshop of a workspace that isn't isolated (and of
-- every administrator) ran on the builder's owner connection: the rights
-- that run migrations, on pgkiln's own tables too. Now every workspace
-- has a developer login (meta.workspace.dev_role, pgkiln_ws<id>_dev_<x>),
-- the connection of its SQL Workshop's tools:
--
--   isolated workspace (090)   as before: a member of the workspace's
--                              database roles, starting as the first one;
--   shared workspace           a member of the database roles of the
--                              workspace's applications (what they may do
--                              with the data), USAGE and CREATE on the
--                              schemas those roles use and on public; the
--                              objects it creates are its own, with
--                              default privileges for the applications'
--                              roles. No rights in meta, no CREATEROLE,
--                              no CREATEDB.
--
-- An administrator can still choose the Owner connection, with a reason;
-- that choice and every statement run on it go to meta.owner_sql_audit.
--
-- Roles are shared by every database of a PostgreSQL server: the login
-- names carry a random suffix (as 090's), and everything below checks
-- what exists, so the migration can run again.
-- =====================================================================

-- every workspace gets its developer login's name (an isolated one also its runtime login's)
create or replace function meta.workspace_isolate() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
declare
  suffix text;
begin
  if tg_op = 'UPDATE' and old.run_role is not null and new.run_role is distinct from old.run_role then
    raise exception 'The login roles of a workspace can''t be renamed.';
  end if;
  if tg_op = 'UPDATE' and old.dev_role is not null and new.dev_role is distinct from old.dev_role then
    raise exception 'The login roles of a workspace can''t be renamed.';
  end if;
  if new.dev_role is null or (new.isolated and new.run_role is null) then
    loop
      suffix := substr(md5(random()::text || clock_timestamp()::text), 1, 8);
      exit when not exists (select 1 from pg_roles where rolname in (format('pgkiln_ws%s_run_%s', new.id, suffix), format('pgkiln_ws%s_dev_%s', new.id, suffix)))
            and not exists (select 1 from meta.workspace w where format('pgkiln_ws%s_dev_%s', new.id, suffix) in (w.run_role, w.dev_role)
                                                              or format('pgkiln_ws%s_run_%s', new.id, suffix) in (w.run_role, w.dev_role));
    end loop;
    if new.dev_role is null then
      new.dev_role := format('pgkiln_ws%s_dev_%s', new.id, suffix);
    end if;
    if new.isolated and new.run_role is null then
      new.run_role := format('pgkiln_ws%s_run_%s', new.id, suffix);
    end if;
  end if;
  return new;
end $$;

-- the database roles a shared workspace's developer login is a member of: those of its
-- applications, unless powerful, pgkiln's own, or an isolated workspace's
create function meta.workspace_dev_roles(p_ws int) returns setof text
language sql stable set search_path = meta, pg_catalog as $$
  select distinct a.db_role
    from meta.app a join pg_roles r on r.rolname = a.db_role
   where meta.app_workspace(a.id) = p_ws
     and not (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication)
     and a.db_role not like 'pgkiln%' and a.db_role not like 'pg\_%'
     and r.oid <> (select nspowner from pg_namespace where nspname = 'meta')
     and not exists (select 1 from meta.workspace_role x join meta.workspace w on w.id = x.workspace_id
                      where w.isolated and x.role_name = a.db_role)
$$;

-- the schemas a shared workspace's developer login may use and create in: those its
-- application roles have USAGE on (granted to them, not to everyone), and public
create function meta.workspace_dev_schemas(p_ws int) returns setof text
language sql stable set search_path = meta, pg_catalog as $$
  select n.nspname from pg_namespace n
   where n.nspname not in ('meta', 'information_schema') and n.nspname !~ '^pg_'
     and (n.nspname = 'public'
          or exists (select 1 from aclexplode(n.nspacl) x join pg_roles g on g.oid = x.grantee
                      where x.privilege_type = 'USAGE' and g.rolname in (select meta.workspace_dev_roles(p_ws))))
     -- not a schema of an isolated workspace
     and not exists (select 1 from meta.workspace w join meta.workspace_role x on x.workspace_id = w.id
                      where w.isolated and pg_get_userbyid(n.nspowner) in (x.role_name, w.run_role, w.dev_role))
$$;
revoke all on function meta.workspace_dev_roles(int), meta.workspace_dev_schemas(int) from public;

create or replace function meta.workspace_sync_roles() returns void
language plpgsql set search_path = meta, pg_catalog as $$
declare
  r record;
  s text;
  meta_owner text := (select nspowner::regrole::text from pg_namespace where nspname = 'meta');
begin
  -- (166) every workspace's developer login; an isolated workspace's runtime login
  for r in select id, isolated, run_role, dev_role from meta.workspace where dev_role is not null loop
    if not exists (select 1 from pg_roles where rolname = r.dev_role) then
      execute format('create role %I login', r.dev_role);
    end if;
    execute format('alter role %I login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', r.dev_role);
    if r.isolated then
      if not exists (select 1 from pg_roles where rolname = r.run_role) then
        execute format('create role %I login', r.run_role);
      end if;
      execute format('alter role %I login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', r.run_role);
      if not pg_has_role(r.run_role, 'pgkiln_app_code', 'MEMBER') then
        execute format('grant pgkiln_app_code to %I', r.run_role);
      end if;
    end if;
    -- (PostgreSQL 16+) the owner manages the login: ALTER DEFAULT PRIVILEGES FOR ROLE below needs it
    if not pg_has_role(current_user, r.dev_role, 'USAGE') and not (select rolsuper from pg_roles where rolname = current_user) then
      begin
        execute format('grant %I to %I', r.dev_role, current_user);
      exception when others then
        raise notice 'Could not make % a member of %: %', current_user, r.dev_role, sqlerrm;
      end;
    end if;
  end loop;

  -- an application of an isolated workspace runs as one of the workspace's roles
  for r in
    select a.alias, a.db_role, w.name from meta.app a join meta.workspace w on w.id = meta.app_workspace(a.id)
     where w.isolated and a.db_role is not null
       and not exists (select 1 from meta.workspace_role x where x.workspace_id = w.id and x.role_name = a.db_role)
  loop
    raise exception 'Application % runs as %, which is not a database role of workspace % (an administrator adds it on the workspace''s page).', r.alias, r.db_role, r.name
      using errcode = '42501';
  end loop;
  -- an isolated workspace's roles: only its logins have them
  for r in
    select x.role_name, w.id as ws, w.run_role, w.dev_role,
           rl.oid is null as missing, coalesce(rl.rolsuper or rl.rolcreaterole or rl.rolbypassrls or rl.rolreplication, false) as powerful
      from meta.workspace_role x join meta.workspace w on w.id = x.workspace_id and w.isolated
      left join pg_roles rl on rl.rolname = x.role_name
  loop
    continue when r.missing;
    if r.powerful or r.role_name like 'pgkiln%' or r.role_name = meta_owner then
      raise exception 'The role % can''t belong to an isolated workspace (a superuser, a role that creates roles or bypasses row-level security, or one of pgkiln''s own).', r.role_name
        using errcode = '42501';
    end if;
    if exists (select 1 from meta.app b where b.db_role = r.role_name and meta.app_workspace(b.id) <> r.ws) then
      raise exception 'The database role % is used by an application of another workspace; an isolated workspace''s roles are its own.', r.role_name
        using errcode = '42501';
    end if;
    if not exists (select 1 from pg_auth_members m where m.roleid = r.role_name::regrole and m.member = r.run_role::regrole) then
      execute format('grant %I to %I', r.role_name, r.run_role);
    end if;
    if not exists (select 1 from pg_auth_members m where m.roleid = r.role_name::regrole and m.member = r.dev_role::regrole) then
      execute format('grant %I to %I', r.role_name, r.dev_role);
    end if;
    if exists (select 1 from pg_auth_members m where m.roleid = r.role_name::regrole and m.member = 'pgkiln_runtime'::regrole) then
      execute format('revoke %I from pgkiln_runtime', r.role_name);
    end if;
  end loop;
  -- (166) a shared workspace's developer login: its applications' roles
  for r in
    select w.dev_role, g.role_name from meta.workspace w, meta.workspace_dev_roles(w.id) g(role_name)
     where not w.isolated and w.dev_role is not null
       and not exists (select 1 from pg_auth_members m where m.roleid = g.role_name::regrole and m.member = w.dev_role::regrole)
  loop
    execute format('grant %I to %I', r.role_name, r.dev_role);
  end loop;
  -- (166) ... the schemas those roles use, and public: USAGE and CREATE; what it creates there the roles may use
  for r in
    select w.id as ws, w.dev_role, d.nspname from meta.workspace w, meta.workspace_dev_schemas(w.id) d(nspname)
     where not w.isolated and w.dev_role is not null
  loop
    if not has_schema_privilege(r.dev_role, r.nspname, 'USAGE') or not has_schema_privilege(r.dev_role, r.nspname, 'CREATE') then
      execute format('grant usage, create on schema %I to %I', r.nspname, r.dev_role);
    end if;
    for s in select role_name from meta.workspace_dev_roles(r.ws) role_name
              where exists (select 1 from pg_namespace n, aclexplode(n.nspacl) x
                             where n.nspname = r.nspname and x.grantee = role_name::regrole and x.privilege_type = 'USAGE')
                and not exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) x
                                 where d.defaclrole = r.dev_role::regrole and d.defaclnamespace = r.nspname::regnamespace
                                   and d.defaclobjtype = 'r' and x.grantee = role_name::regrole)
    loop
      begin
        execute format('alter default privileges for role %I in schema %I grant select, insert, update, delete on tables to %I', r.dev_role, r.nspname, s);
        execute format('alter default privileges for role %I in schema %I grant usage, select on sequences to %I', r.dev_role, r.nspname, s);
        execute format('alter default privileges for role %I in schema %I grant execute on functions to %I', r.dev_role, r.nspname, s);
      exception when insufficient_privilege then
        raise notice 'Default privileges of % in % not set: %', r.dev_role, r.nspname, sqlerrm;
      end;
    end loop;
  end loop;
  -- (166) schemas a shared workspace's developer login no longer uses (or an isolated one's: it goes through its roles)
  for r in
    select w.dev_role, n.nspname, x.privilege_type from meta.workspace w
      join pg_roles l on l.rolname = w.dev_role
      cross join pg_namespace n cross join lateral aclexplode(n.nspacl) x
     where x.grantee = l.oid and n.nspowner <> l.oid
       and (w.isolated or n.nspname not in (select meta.workspace_dev_schemas(w.id)))
  loop
    execute format('revoke %s on schema %I from %I', r.privilege_type, r.nspname, r.dev_role);
  end loop;

  -- the developer login of an isolated workspace starts as the workspace's first role, so what its SQL creates
  -- belongs to an application role (SET ROLE picks another; RESET ROLE returns to this one); a shared one as itself
  for r in
    select w.dev_role, w.isolated, (select x.role_name from meta.workspace_role x join pg_roles rl on rl.rolname = x.role_name
                         where x.workspace_id = w.id order by x.role_name limit 1) as first
      from meta.workspace w where w.dev_role is not null
  loop
    if r.isolated and r.first is not null then
      execute format('alter role %I set role = %L', r.dev_role, r.first);
    else
      execute format('alter role %I reset role', r.dev_role);
    end if;
  end loop;
  -- memberships a workspace login no longer should have; a role a shared application uses goes back to pgkiln_runtime
  for r in
    select g.rolname as granted, l.rolname as login
      from meta.workspace w
      join pg_roles l on l.rolname in (w.run_role, w.dev_role)
      join pg_auth_members m on m.member = l.oid
      join pg_roles g on g.oid = m.roleid
     where (l.rolname = w.run_role and not w.isolated)
        or (w.isolated and g.rolname <> 'pgkiln_app_code' and not exists (select 1 from meta.workspace_role x where x.workspace_id = w.id and x.role_name = g.rolname))
        or (g.rolname = 'pgkiln_app_code' and l.rolname = w.dev_role)
        or (l.rolname = w.dev_role and not w.isolated and g.rolname not in (select meta.workspace_dev_roles(w.id)))
  loop
    execute format('revoke %I from %I', r.granted, r.login);
    if r.granted <> 'pgkiln_app_code'
       and exists (select 1 from meta.app a join meta.workspace w on w.id = meta.app_workspace(a.id) where a.db_role = r.granted and not w.isolated)
       and not pg_has_role('pgkiln_runtime', r.granted, 'MEMBER') then
      execute format('grant %I to pgkiln_runtime', r.granted);
    end if;
  end loop;
  -- the runtime logins of workspaces that are no longer isolated can't sign in
  for r in select run_role from meta.workspace where not isolated and run_role is not null loop
    if exists (select 1 from pg_roles where rolname = r.run_role) then
      execute format('alter role %I nologin', r.run_role);
    end if;
  end loop;
end $$;
revoke all on function meta.workspace_sync_roles() from public;

-- a new workspace: its developer login at the commit (insert is already covered for isolated)
drop trigger if exists workspace_isolate on meta.workspace;
create trigger workspace_isolate before insert or update of isolated, run_role, dev_role on meta.workspace
  for each row execute function meta.workspace_isolate();

-- the workspaces there are: their developer logins now
do $$
declare
  w record;
begin
  for w in select id from meta.workspace where dev_role is null loop
    update meta.workspace set isolated = isolated where id = w.id; -- fires workspace_isolate, which names dev_role
  end loop;
end $$;
select meta.workspace_sync_roles();

-- ---------------------------------------------------------------------
-- The Owner connection's audit: an administrator chose it (with a reason)
-- and every statement run on it from the SQL Workshop. Installation data,
-- not exported; kept until an administrator deletes it.
-- ---------------------------------------------------------------------
create table meta.owner_sql_audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  username     text not null,
  workspace_id int references meta.workspace on delete set null,
  tool         text not null check (tool ~ '^[a-z][a-z0-9_-]{0,39}$'),
  reason       text not null check (length(reason) between 1 and 500),
  statement    text check (length(statement) <= 100000),
  rows         bigint,
  status       text not null check (status in ('chosen', 'ended', 'ok', 'error')),
  error        text,
  ms           numeric
);
create index owner_sql_audit_at_idx on meta.owner_sql_audit (at desc);
revoke all on meta.owner_sql_audit from public;
comment on table meta.owner_sql_audit is 'The Owner connection in the SQL Workshop (166): who chose it and why, and each statement run on it. Installation data, not exported.';
