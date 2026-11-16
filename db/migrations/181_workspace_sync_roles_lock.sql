-- =====================================================================
-- 181: workspace roles are synchronised one transaction at a time
--      (sprint 212)
--
-- meta.workspace_sync_roles() runs at the commit of every transaction
-- that changes a workspace, an application's role or a workspace's
-- roles (090), and when a developer login's pool opens. Each step checks
-- first and changes only what differs, but two transactions running it
-- at the same moment both saw the same privilege missing and both
-- granted it: the second failed with "tuple concurrently updated" (in
-- the tests, a new workspace next to the server's own sync). It now
-- takes a transaction-level advisory lock first, so a second sync waits
-- for the first one's commit and then finds nothing left to do. The
-- runtime login of a workspace that is no longer isolated is switched
-- off only while it can still sign in, instead of on every pass.
-- =====================================================================

-- the same as 175's, with (181) the lock and the conditional NOLOGIN
create or replace function meta.workspace_sync_roles() returns void
language plpgsql set search_path = meta, pg_catalog as $$
declare
  r record;
  s text;
  meta_owner text := (select nspowner::regrole::text from pg_namespace where nspname = 'meta');
begin
  -- (181) one at a time: two transactions that both find a privilege missing (or a login to switch off) would both
  -- change the same catalog row, and the second fails with "tuple concurrently updated". Held until the commit; the
  -- checks below then see what the transaction before it did
  perform pg_advisory_xact_lock(hashtext('pgkiln.workspace_sync_roles'));
  -- (166) every workspace's developer login; an isolated workspace's runtime login
  for r in select id, isolated, run_role, dev_role from meta.workspace where dev_role is not null loop
    if not exists (select 1 from pg_roles where rolname = r.dev_role) then
      execute format('create role %I login', r.dev_role);
    end if;
    -- (175) only when it differs: concurrent transactions don't update the same role
    if exists (select 1 from pg_roles where rolname = r.dev_role
                and not (rolcanlogin and rolinherit and not (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))) then
      execute format('alter role %I login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', r.dev_role);
    end if;
    if r.isolated then
      if not exists (select 1 from pg_roles where rolname = r.run_role) then
        execute format('create role %I login', r.run_role);
      end if;
      if exists (select 1 from pg_roles where rolname = r.run_role
                  and not (rolcanlogin and rolinherit and not (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))) then
        execute format('alter role %I login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', r.run_role);
      end if;
      if not pg_has_role(r.run_role, 'pgkiln_app_code', 'MEMBER') then
        execute format('grant pgkiln_app_code to %I', r.run_role);
      end if;
    end if;
    -- (175) no privileges in meta of their own (the runtime login reaches meta through pgkiln_app_code only)
    perform meta.login_meta_revoke(r.dev_role);
    if r.run_role is not null then
      perform meta.login_meta_revoke(r.run_role);
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
    -- (175) a role with rights on pgkiln's own tables is not for the developer login
    if meta.role_reaches_meta(r.role_name) then
      raise notice 'The role % has rights on pgkiln''s own tables (meta): the developer login of workspace % doesn''t get it; revoke those rights.', r.role_name, r.ws;
    elsif not exists (select 1 from pg_auth_members m where m.roleid = r.role_name::regrole and m.member = r.dev_role::regrole) then
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
        -- (175) an isolated workspace's role with rights on meta: not its developer login's
        or (l.rolname = w.dev_role and w.isolated and meta.role_reaches_meta(g.rolname))
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
    -- (181) only when it can still sign in: an ALTER ROLE on every pass changed the role's row every time
    if exists (select 1 from pg_roles where rolname = r.run_role and rolcanlogin) then
      execute format('alter role %I nologin', r.run_role);
    end if;
  end loop;
end $$;
revoke all on function meta.workspace_sync_roles() from public;
