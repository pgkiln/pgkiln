-- =====================================================================
-- 175: a developer login reads none of pgkiln's own tables (sprint 201,
--      SEC-1)
--
-- The SQL Workshop runs as the workspace's developer login (166). That
-- login must have no rights on pgkiln's own tables (meta): not the
-- developers' password hashes, not the workspaces, mail and AI services,
-- tokens, sessions, factors or another workspace's rows. A fresh
-- installation grants it nothing in meta, but nothing kept it that way:
-- a login reaches whatever the roles it is a member of reach, and a
-- direct grant (or a grant to an application's role) went unnoticed.
-- Now:
--
--   - meta.role_reaches_meta(role): can the role use one of meta's base
--     tables (itself or through a role it is a member of, table or
--     column privileges)? Such a role counts as powerful
--     (meta.role_is_powerful): no application runs as it, and no
--     developer login becomes a member of it; a login that is a member
--     already loses the membership at the next synchronisation;
--   - meta.workspace_sync_roles() takes every privilege a workspace login
--     holds directly on meta's tables, views, sequences, functions and on
--     the schema back (they get none by design; schema USAGE and the
--     views and functions granted to PUBLIC stay);
--   - the tables that hold secrets, credentials, sessions or every
--     workspace's rows get row level security with one policy: the owner
--     of meta (and its members) only. A grant that slips through later
--     still shows no row (the owner, superusers and SECURITY DEFINER
--     functions are not affected: the policy is not forced);
--   - a shared workspace's developer login sees its own workspace's
--     applications only (meta.login_workspace, meta.app_visible), so SQL
--     can't SET pgkiln.app_id to another workspace's application and use
--     the views and functions that application code may (meta.tasks,
--     meta.send_mail, ...) as that application.
--
-- What the developer login may still read in meta: the views granted to
-- PUBLIC for application code, which show the rows of the application in
-- pgkiln.app_id (its own workspace's, see above) and of the session in
-- pgkiln.session_id (test/security.test.ts, sprint 201, lists them).
--
-- Written to run again (create or replace, drop policy if exists).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Which roles reach pgkiln's own tables
-- ---------------------------------------------------------------------
create or replace function meta.role_reaches_meta(p_role text) returns boolean
language sql stable set search_path = meta, pg_catalog as $$
  select exists (
    select 1 from pg_roles r join pg_class c on c.relnamespace = 'meta'::regnamespace and c.relkind in ('r', 'p')
     where r.rolname = p_role
       and (has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            or has_any_column_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))
$$;
comment on function meta.role_reaches_meta(text) is
  'Can the role use one of pgkiln''s own tables (a base table in meta), itself or through a role it is a member of (175)? Such a role is powerful: no application or developer login runs as it.';

create or replace function meta.role_is_powerful(p_role text) returns boolean
language sql stable set search_path = meta, pg_catalog as $$
  select p_role is not null and (
    -- pgkiln's own roles (the runtime, application code, PostgREST's and the workspaces' logins) and PostgreSQL's
    p_role in ('pgkiln_runtime', 'pgkiln_app_code', 'pgkiln_authenticator', 'pgkiln_anon')
    or p_role ~ '^pgkiln_ws[0-9]+_(run|dev)_' or p_role like 'pg\_%'
    or exists (
      select 1 from pg_roles r
       where r.rolname = p_role
         and (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication
              -- a member of a powerful role, of pgkiln's own roles or of PostgreSQL's broad ones can SET ROLE to it
              or exists (select 1 from pg_roles g
                          where g.oid <> r.oid
                            and (g.rolsuper or g.rolcreaterole or g.rolcreatedb or g.rolbypassrls or g.rolreplication
                                 or g.rolname in ('pgkiln_runtime', 'pgkiln_app_code', 'pgkiln_authenticator', 'pgkiln_anon')
                                 or g.rolname ~ '^pgkiln_ws[0-9]+_(run|dev)_'
                                 or g.rolname in ('pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program',
                                                  'pg_read_server_files', 'pg_write_server_files'))
                            and pg_has_role(r.oid, g.oid, 'MEMBER'))
              -- the owner of pgkiln's schemas, or a member of it
              or exists (select 1 from pg_namespace n
                          where (n.nspname = 'meta' or n.nspname like 'pgkiln%')
                            and pg_has_role(r.oid, n.nspowner, 'MEMBER'))))
    -- (175) a role with rights on pgkiln's own tables
    or meta.role_reaches_meta(p_role));
$$;
comment on function meta.role_is_powerful(text) is
  'A role no application or developer login may run as (167, 175): superuser, CREATEROLE, CREATEDB, BYPASSRLS, REPLICATION, pgkiln''s own roles (runtime, app code, PostgREST, workspace logins) or PostgreSQL''s, a member of one of those or of the owner of pgkiln''s schemas, or a role with rights on a table in meta.';

-- ---------------------------------------------------------------------
-- 2. A workspace login holds no privileges in meta of its own
-- ---------------------------------------------------------------------
create or replace function meta.login_meta_revoke(p_login text) returns void
language plpgsql set search_path = meta, pg_catalog as $$
declare
  r record;
  l oid := (select oid from pg_roles where rolname = p_login);
begin
  if l is null then
    return;
  end if;
  -- tables, views, sequences (a table's REVOKE ALL takes its column privileges too)
  for r in
    select c.oid::regclass as rel, c.relkind from pg_class c
     where c.relnamespace = 'meta'::regnamespace
       and (exists (select 1 from aclexplode(c.relacl) x where x.grantee = l)
            or exists (select 1 from pg_attribute a, aclexplode(a.attacl) x where a.attrelid = c.oid and x.grantee = l))
  loop
    execute format('revoke all on %s %s from %I', case when r.relkind = 'S' then 'sequence' else 'table' end, r.rel, p_login);
  end loop;
  for r in
    select p.oid::regprocedure as fn from pg_proc p, aclexplode(p.proacl) x
     where p.pronamespace = 'meta'::regnamespace and x.grantee = l
  loop
    execute format('revoke all on function %s from %I', r.fn, p_login);
  end loop;
  if exists (select 1 from pg_namespace n, aclexplode(n.nspacl) x where n.nspname = 'meta' and x.grantee = l) then
    execute format('revoke all on schema meta from %I', p_login);
  end if;
end $$;
revoke all on function meta.login_meta_revoke(text) from public;

-- the same as 166's, with (175): the logins' own privileges in meta go; an isolated workspace's role that reaches
-- meta is not given to its developer login (and taken back)
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
    if exists (select 1 from pg_roles where rolname = r.run_role) then
      execute format('alter role %I nologin', r.run_role);
    end if;
  end loop;
end $$;
revoke all on function meta.workspace_sync_roles() from public;

-- ---------------------------------------------------------------------
-- 3. A shared workspace's developer login sees its own workspace's
--    applications only
-- ---------------------------------------------------------------------

-- the workspace whose login this session signed in with: an isolated workspace's runtime or developer login, or
-- (175) a shared workspace's developer login; null for every other login (the shared runtime, the owner)
create or replace function meta.login_workspace() returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select id from meta.workspace where session_user::text = dev_role or (isolated and session_user::text = run_role)
$$;

-- without isolated workspaces nothing is filtered, except (175) for a workspace's developer login
create or replace function meta.app_visible(p_app_id int) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select (meta.isolation_off() and meta.login_workspace() is null) or p_app_id in (select meta.visible_apps())
$$;

create or replace function meta.app_id() returns int
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v int := coalesce(nullif(current_setting('pgkiln.app_id', true), '')::int,
                    (select a.id from meta.app a where a.alias = meta.jwt_claims()->>'app'));
begin
  if v is not null and not meta.app_visible(v) then
    raise exception 'Application % is not in this workspace.', v using errcode = '42501';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 4. Tables with secrets, credentials, sessions or every workspace's rows:
--    the owner of meta only, whatever is granted
-- ---------------------------------------------------------------------
create or replace function meta.meta_owner_member() returns boolean
language sql stable set search_path = meta, pg_catalog as $$
  select pg_has_role(current_user, (select nspowner from pg_namespace where nspname = 'meta'), 'MEMBER')
$$;
comment on function meta.meta_owner_member() is
  'Is the current role the owner of meta or a member of it (175)? The policy of the tables only the builder reads.';

do $$
declare
  t text;
  r record;
begin
  foreach t in array array[
    -- developers and their sign-in
    'developer', 'developer_factor', 'developer_identity', 'developer_recovery_code', 'developer_trusted_browser',
    'builder_token', 'builder_ai', 'auth_provider', 'ldap_directory', 'ldap_identity', 'saml_request', 'sso_pending',
    -- workspaces (every workspace's rows) and their credentials
    'workspace', 'workspace_member', 'workspace_role', 'workspace_app', 'workspace_link', 'workspace_credential', 'workspace_file',
    -- services with keys and passwords
    'mail_service', 'app_mail_service', 'ai_service', 'app_ai_service', 'remote_server', 'remote_database', 'api_client',
    'instance_setting', 'push_key', 'gallery_source',
    -- application users' secrets, tokens and sign-ins
    'account_factor', 'account_identity', 'account_recovery_code', 'password_reset', 'persistent_login', 'shared_login',
    'push_subscription',
    -- what developers ran, sent and asked
    'owner_sql_audit', 'sql_history', 'sql_share', 'mail_queue', 'mail_attachment', 'web_request_log',
    'ai_request', 'ai_conversation', 'ai_tool_call', 'app_backup', 'dump_job', 'network_refusal'
  ] loop
    continue when to_regclass('meta.' || t) is null;
    -- builder only: nobody but the owner has rights on them
    for r in
      select distinct x.grantee from pg_class c, aclexplode(c.relacl) x
       where c.oid = ('meta.' || t)::regclass and x.grantee <> c.relowner
      union
      select distinct x.grantee from pg_attribute a, aclexplode(a.attacl) x
       where a.attrelid = ('meta.' || t)::regclass
    loop
      if r.grantee = 0 then
        execute format('revoke all on meta.%I from public', t);
      else
        raise notice 'meta.% was granted to %: revoked (only the builder reads it).', t, r.grantee::regrole;
        execute format('revoke all on meta.%I from %s', t, r.grantee::regrole);
      end if;
    end loop;
    execute format('alter table meta.%I enable row level security', t);
    execute format('drop policy if exists meta_owner_only on meta.%I', t);
    execute format('create policy meta_owner_only on meta.%I using ((select meta.meta_owner_member())) with check ((select meta.meta_owner_member()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. No base table or sequence of meta for PUBLIC (the views for
--    application code keep their grants)
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel, c.relkind from pg_class c, aclexplode(c.relacl) x
     where c.relnamespace = 'meta'::regnamespace and c.relkind in ('r', 'p', 'S') and x.grantee = 0
  loop
    raise notice '% was granted to PUBLIC: revoked.', r.rel;
    execute format('revoke all on %s %s from public', case when r.relkind = 'S' then 'sequence' else 'table' end, r.rel);
  end loop;
end $$;

-- the logins there are: their own privileges in meta, and memberships in roles that reach meta, go now
select meta.workspace_sync_roles();
