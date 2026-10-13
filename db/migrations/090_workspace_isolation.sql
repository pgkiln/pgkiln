-- =====================================================================
-- 090: isolated workspaces (APEX: workspaces as a tenant boundary)
--
-- An administrator can make a workspace *isolated*. Its applications then
-- run on two PostgreSQL login roles of its own instead of the shared ones:
--
--   run_role  application code (pages, processes, REST handlers, jobs): a
--             member of pgkiln_app_code (what application code may use in
--             meta, the same grants as pgkiln_runtime) and of the database
--             roles of the workspace's applications;
--   dev_role  the SQL Workshop and every other tool that runs a developer's
--             SQL in the builder: a member of the applications' database
--             roles only, no rights in meta.
--
-- SQL can always RESET ROLE (or set_config('role', ...)) back to the role it
-- logged in with, so the boundary is the login role: session_user, which SQL
-- cannot change. Row-level security on the meta tables the runtime reads
-- shows a workspace's logins the rows of their own applications only, and
-- hides isolated workspaces from the shared runtime role (pgkiln_runtime);
-- the owner (the builder) sees everything. meta.app_id() refuses an
-- application the login may not see, which closes the "app id from SQL" gap
-- for the functions that trust it (web requests, AI, mail, push, page links).
--
-- The server sets the login roles' passwords (derived from PGKILN_SECRET_KEY)
-- and opens a small pool per isolated workspace (src/workspace-db.ts).
-- Role memberships follow the workspace's applications automatically
-- (triggers below). Installation data, not exported.
-- =====================================================================

alter table meta.workspace
  add column isolated boolean not null default false,
  add column run_role text unique,
  add column dev_role text unique;
comment on column meta.workspace.isolated is 'Isolated (090): the workspace''s applications and SQL run on its own login roles (run_role, dev_role).';

-- ---------------------------------------------------------------------
-- pgkiln_app_code: the rights of application code in meta. pgkiln_runtime
-- keeps its own grants; meta.sync_app_code_grants() copies them here (also
-- after every later migration, from src/migrate.ts), so a new grant to
-- pgkiln_runtime reaches isolated workspaces too.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pgkiln_app_code') then
    create role pgkiln_app_code nologin;
  end if;
end $$;

create function meta.sync_app_code_grants() returns void
language plpgsql set search_path = meta, pg_catalog as $$
declare
  rt oid := 'pgkiln_runtime'::regrole;
  ac oid := 'pgkiln_app_code'::regrole;
  r  record;
begin
  -- schemas
  for r in
    select n.nspname, x.privilege_type, x.grantee from pg_namespace n, aclexplode(n.nspacl) x
     where x.grantee in (rt, ac) and n.nspname not in ('pg_catalog', 'information_schema')
  loop
    if r.grantee = rt and not has_schema_privilege(ac, r.nspname, r.privilege_type) then
      execute format('grant %s on schema %I to pgkiln_app_code', r.privilege_type, r.nspname);
    elsif r.grantee = ac and not exists (select 1 from pg_namespace n, aclexplode(n.nspacl) y
                                          where n.nspname = r.nspname and y.grantee = rt and y.privilege_type = r.privilege_type) then
      execute format('revoke %s on schema %I from pgkiln_app_code', r.privilege_type, r.nspname);
    end if;
  end loop;
  -- tables, views, sequences
  for r in
    select c.oid::regclass as rel, c.relkind, x.privilege_type, x.grantee from pg_class c, aclexplode(c.relacl) x
     where x.grantee in (rt, ac) and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
  loop
    if r.grantee = rt and not exists (select 1 from pg_class c, aclexplode(c.relacl) y where c.oid = r.rel and y.grantee = ac and y.privilege_type = r.privilege_type) then
      execute format('grant %s on %s %s to pgkiln_app_code', r.privilege_type, case when r.relkind = 'S' then 'sequence' else 'table' end, r.rel);
    elsif r.grantee = ac and not exists (select 1 from pg_class c, aclexplode(c.relacl) y where c.oid = r.rel and y.grantee = rt and y.privilege_type = r.privilege_type) then
      execute format('revoke %s on %s %s from pgkiln_app_code', r.privilege_type, case when r.relkind = 'S' then 'sequence' else 'table' end, r.rel);
    end if;
  end loop;
  -- columns
  for r in
    select a.attrelid::regclass as rel, a.attname, x.privilege_type, x.grantee from pg_attribute a, aclexplode(a.attacl) x
     where x.grantee in (rt, ac) and not a.attisdropped
  loop
    if r.grantee = rt and not exists (select 1 from pg_attribute a, aclexplode(a.attacl) y where a.attrelid = r.rel and a.attname = r.attname and y.grantee = ac and y.privilege_type = r.privilege_type) then
      execute format('grant %s (%I) on table %s to pgkiln_app_code', r.privilege_type, r.attname, r.rel);
    elsif r.grantee = ac and not exists (select 1 from pg_attribute a, aclexplode(a.attacl) y where a.attrelid = r.rel and a.attname = r.attname and y.grantee = rt and y.privilege_type = r.privilege_type) then
      execute format('revoke %s (%I) on table %s from pgkiln_app_code', r.privilege_type, r.attname, r.rel);
    end if;
  end loop;
  -- functions
  for r in
    select p.oid::regprocedure as fn, x.grantee from pg_proc p, aclexplode(p.proacl) x
     where x.grantee in (rt, ac) and x.privilege_type = 'EXECUTE' and p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
  loop
    if r.grantee = rt and not exists (select 1 from pg_proc p, aclexplode(p.proacl) y where p.oid = r.fn and y.grantee = ac) then
      execute format('grant execute on function %s to pgkiln_app_code', r.fn);
    elsif r.grantee = ac and not exists (select 1 from pg_proc p, aclexplode(p.proacl) y where p.oid = r.fn and y.grantee = rt) then
      execute format('revoke execute on function %s from pgkiln_app_code', r.fn);
    end if;
  end loop;
end $$;
revoke all on function meta.sync_app_code_grants() from public;

-- ---------------------------------------------------------------------
-- Who is asking: the workspace of the login role, and the applications it
-- may see.
-- ---------------------------------------------------------------------

-- the isolated workspace whose login role this session signed in with (null: another login)
create function meta.login_workspace() returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select id from meta.workspace where isolated and session_user::text in (run_role, dev_role)
$$;

-- the installation's owner (the builder, migrations) or a superuser: sees every application
create function meta.owner_login() returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce((select r.rolsuper or r.oid = (select nspowner from pg_namespace where nspname = 'meta')
                     from pg_roles r where r.rolname = session_user), false)
$$;

-- no isolated workspace: nothing to filter (the common case, checked once per query)
create function meta.isolation_off() returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select not exists (select 1 from meta.workspace where isolated)
$$;

-- the applications this login may see: its own workspace's (an isolated workspace's
-- login), every application (the owner), or those outside isolated workspaces (the rest)
create function meta.visible_apps() returns setof int
language sql stable security definer set search_path = meta, pg_catalog as $$
  with me as (select meta.login_workspace() as ws, meta.owner_login() as owner)
  select a.id from meta.app a, me
   where case
           when me.ws is not null then meta.app_workspace(a.id) = me.ws
           when me.owner then true
           else not exists (select 1 from meta.workspace w where w.id = meta.app_workspace(a.id) and w.isolated)
         end
$$;

create function meta.app_visible(p_app_id int) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select meta.isolation_off() or p_app_id in (select meta.visible_apps())
$$;

-- p_app_id when this login may see it; otherwise an error (for functions that take an application id)
create function meta.checked_app(p_app_id int) returns int
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
begin
  if p_app_id is not null and not meta.app_visible(p_app_id) then
    raise exception 'Application % is not in this workspace.', p_app_id using errcode = '42501';
  end if;
  return p_app_id;
end $$;

-- accounts: those with access to a visible application, or with no access to one it may not see
create function meta.visible_accounts() returns setof int
language sql stable security definer set search_path = meta, pg_catalog as $$
  with vis as (select meta.visible_apps() as app_id)
  select a.id from meta.account a
   where exists (select 1 from meta.app_access x where x.account_id = a.id and x.app_id in (select app_id from vis))
      or not exists (select 1 from meta.app_access x where x.account_id = a.id and x.app_id not in (select app_id from vis))
$$;

revoke all on function meta.login_workspace(), meta.owner_login(), meta.isolation_off(), meta.visible_apps(),
  meta.visible_accounts() from public;
grant execute on function meta.login_workspace(), meta.isolation_off(), meta.visible_apps(), meta.visible_accounts(),
  meta.owner_login() to pgkiln_runtime;
-- app_visible and checked_app stay executable by everyone (application code may check an id)

-- meta.app_id(): the application of the request, refused when the login may not see it
-- (application SQL can set pgkiln.app_id to another application's id)
create or replace function meta.app_id() returns int
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v int := coalesce(nullif(current_setting('pgkiln.app_id', true), '')::int,
                    (select a.id from meta.app a where a.alias = meta.jwt_claims()->>'app'));
begin
  if v is not null and not meta.isolation_off() and not meta.app_visible(v) then
    raise exception 'Application % is not in this workspace.', v using errcode = '42501';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Functions the server calls with an application id: the same check.
-- The originals stay, renamed, for the owner only.
-- ---------------------------------------------------------------------
alter function meta.account_roles(int, text) rename to account_roles_unchecked;
alter function meta.authenticate(int, text, text) rename to authenticate_unchecked;
alter function meta.change_password(int, text, text, text, uuid) rename to change_password_unchecked;
alter function meta.debug_save(int, int, text, uuid, text, text, int, int, timestamptz, numeric, jsonb) rename to debug_save_unchecked;
alter function meta.password_reset_available(int) rename to password_reset_available_unchecked;
alter function meta.password_reset_user(int, text) rename to password_reset_user_unchecked;
alter function meta.request_password_reset(int, text, text, text, text, text, text) rename to request_password_reset_unchecked;
alter function meta.reset_password(int, text, text) rename to reset_password_unchecked;
revoke all on function meta.account_roles_unchecked(int, text), meta.authenticate_unchecked(int, text, text),
  meta.change_password_unchecked(int, text, text, text, uuid),
  meta.debug_save_unchecked(int, int, text, uuid, text, text, int, int, timestamptz, numeric, jsonb),
  meta.password_reset_available_unchecked(int), meta.password_reset_user_unchecked(int, text),
  meta.request_password_reset_unchecked(int, text, text, text, text, text, text), meta.reset_password_unchecked(int, text, text)
  from public, pgkiln_runtime;

create function meta.account_roles(p_app_id int, p_username text) returns text[]
language sql stable security definer set search_path = meta, pg_catalog as $$
  select meta.account_roles_unchecked(meta.checked_app(p_app_id), p_username)
$$;
create function meta.authenticate(p_app_id int, p_username text, p_password text) returns text
language sql security definer set search_path = meta, pg_catalog as $$
  select meta.authenticate_unchecked(meta.checked_app(p_app_id), p_username, p_password)
$$;
create function meta.change_password(p_app_id int, p_username text, p_old text, p_new text, p_keep_session uuid default null) returns boolean
language sql security definer set search_path = meta, pg_catalog as $$
  select meta.change_password_unchecked(meta.checked_app(p_app_id), p_username, p_old, p_new, p_keep_session)
$$;
create function meta.debug_save(p_app_id int, p_page_no int, p_username text, p_session_id uuid, p_method text, p_path text,
  p_status int, p_level int, p_started_at timestamptz, p_elapsed_ms numeric, p_entries jsonb) returns bigint
language sql security definer set search_path = meta, pg_catalog as $$
  select meta.debug_save_unchecked(meta.checked_app(p_app_id), p_page_no, p_username, p_session_id, p_method, p_path,
    p_status, p_level, p_started_at, p_elapsed_ms, p_entries)
$$;
create function meta.password_reset_available(p_app_id int) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select meta.password_reset_available_unchecked(meta.checked_app(p_app_id))
$$;
create function meta.password_reset_user(p_app_id int, p_token_hash text) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select meta.password_reset_user_unchecked(meta.checked_app(p_app_id), p_token_hash)
$$;
create function meta.request_password_reset(p_app_id int, p_login text, p_token_hash text, p_ip text, p_subject text,
  p_body text, p_body_html text) returns void
language sql security definer set search_path = meta, pg_catalog as $$
  select meta.request_password_reset_unchecked(meta.checked_app(p_app_id), p_login, p_token_hash, p_ip, p_subject, p_body, p_body_html)
$$;
create function meta.reset_password(p_app_id int, p_token_hash text, p_new text) returns text
language sql security definer set search_path = meta, pg_catalog as $$
  select meta.reset_password_unchecked(meta.checked_app(p_app_id), p_token_hash, p_new)
$$;
revoke all on function meta.account_roles(int, text), meta.authenticate(int, text, text),
  meta.change_password(int, text, text, text, uuid),
  meta.debug_save(int, int, text, uuid, text, text, int, int, timestamptz, numeric, jsonb),
  meta.password_reset_available(int), meta.password_reset_user(int, text),
  meta.request_password_reset(int, text, text, text, text, text, text), meta.reset_password(int, text, text) from public;
grant execute on function meta.account_roles(int, text), meta.authenticate(int, text, text),
  meta.change_password(int, text, text, text, uuid),
  meta.debug_save(int, int, text, uuid, text, text, int, int, timestamptz, numeric, jsonb),
  meta.password_reset_available(int), meta.password_reset_user(int, text),
  meta.request_password_reset(int, text, text, text, text, text, text), meta.reset_password(int, text, text) to pgkiln_runtime;

-- ---------------------------------------------------------------------
-- Row-level security on the meta tables the runtime role reads or writes.
-- The owner (table owner) is not affected. Without isolated workspaces the
-- first condition is true once per query and nothing is filtered.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- tables with the application's id
  foreach t in array array['account_style', 'app_access', 'app_item', 'app_process', 'authz_scheme', 'build_option',
    'data_load_def', 'document_template', 'feedback', 'list', 'list_entry', 'lov', 'nav_entry', 'page', 'page_group',
    'plugin', 'report_layout', 'rest_module', 'rest_source', 'search_config', 'static_file', 'task_definition',
    'template_component', 'text_message', 'translation', 'workflow_definition', 'web_credential']
  loop
    execute format('alter table meta.%I enable row level security', t);
    execute format($p$create policy workspace on meta.%I using ((select meta.isolation_off()) or app_id in (select meta.visible_apps()))
                      with check ((select meta.isolation_off()) or app_id in (select meta.visible_apps()))$p$, t);
  end loop;
  -- tables of a page
  foreach t in array array['branch', 'button', 'computation', 'dynamic_action', 'item', 'process', 'region', 'validation']
  loop
    execute format('alter table meta.%I enable row level security', t);
    execute format($p$create policy workspace on meta.%I using ((select meta.isolation_off())
                        or exists (select 1 from meta.page p where p.id = page_id and p.app_id in (select meta.visible_apps())))$p$, t);
  end loop;
end $$;

-- rows without an application (builder sessions, instance activity): not for an isolated workspace's logins
alter table meta.session enable row level security;
create policy workspace on meta.session
  using ((select meta.isolation_off()) or app_id in (select meta.visible_apps()) or (app_id is null and meta.login_workspace() is null))
  with check ((select meta.isolation_off()) or app_id in (select meta.visible_apps()) or (app_id is null and meta.login_workspace() is null));
alter table meta.activity_log enable row level security;
create policy workspace on meta.activity_log
  using ((select meta.isolation_off()) or app_id in (select meta.visible_apps()) or (app_id is null and meta.login_workspace() is null))
  with check ((select meta.isolation_off()) or app_id in (select meta.visible_apps()) or (app_id is null and meta.login_workspace() is null));
alter table meta.app enable row level security;
create policy workspace on meta.app
  using ((select meta.isolation_off()) or id in (select meta.visible_apps()));
alter table meta.account enable row level security;
create policy workspace on meta.account
  using ((select meta.isolation_off()) or id in (select meta.visible_accounts()));

-- ---------------------------------------------------------------------
-- Role memberships follow the workspaces: a database role of an application
-- in an isolated workspace belongs to that workspace's two login roles and
-- not to pgkiln_runtime; it goes back to pgkiln_runtime when the application
-- leaves (or the workspace is no longer isolated).
-- ---------------------------------------------------------------------
create function meta.workspace_sync_roles() returns void
language plpgsql set search_path = meta, pg_catalog as $$
declare
  r record;
begin
  -- nothing isolated and never was: nothing to do
  if not exists (select 1 from meta.workspace where isolated or run_role is not null) then
    return;
  end if;
  -- the login roles of isolated workspaces
  for r in select id, run_role, dev_role from meta.workspace where isolated loop
    if not exists (select 1 from pg_roles where rolname = r.run_role) then
      execute format('create role %I login noinherit', r.run_role);
    end if;
    if not exists (select 1 from pg_roles where rolname = r.dev_role) then
      execute format('create role %I login noinherit', r.dev_role);
    end if;
    execute format('alter role %I login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', r.run_role);
    execute format('alter role %I login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', r.dev_role);
    if not pg_has_role(r.run_role, 'pgkiln_app_code', 'MEMBER') then
      execute format('grant pgkiln_app_code to %I', r.run_role);
    end if;
  end loop;
  -- an application's database role in an isolated workspace: only that workspace's logins
  for r in
    select a.alias, a.db_role, w.id as ws, w.run_role, w.dev_role, rl.rolsuper or rl.rolcreaterole or rl.rolbypassrls or rl.rolreplication as powerful
      from meta.app a
      join meta.workspace w on w.id = meta.app_workspace(a.id) and w.isolated
      join pg_roles rl on rl.rolname = a.db_role
  loop
    if r.powerful or r.db_role like 'pgkiln%' or r.db_role = (select nspowner::regrole::text from pg_namespace where nspname = 'meta') then
      raise exception 'Application % runs as %, a role that an isolated workspace can''t use (a superuser, a role that creates roles or bypasses row-level security, or one of pgkiln''s own).', r.alias, r.db_role;
    end if;
    if exists (select 1 from meta.app b where b.db_role = r.db_role and meta.app_workspace(b.id) <> r.ws) then
      raise exception 'The database role % is used by applications in two workspaces; an isolated workspace''s roles are its own. Give one of them another role first.', r.db_role;
    end if;
    if not exists (select 1 from pg_auth_members m where m.roleid = r.db_role::regrole and m.member = r.run_role::regrole) then
      execute format('grant %I to %I', r.db_role, r.run_role);
    end if;
    if not exists (select 1 from pg_auth_members m where m.roleid = r.db_role::regrole and m.member = r.dev_role::regrole) then
      execute format('grant %I to %I', r.db_role, r.dev_role);
    end if;
    if exists (select 1 from pg_auth_members m where m.roleid = r.db_role::regrole and m.member = 'pgkiln_runtime'::regrole) then
      execute format('revoke %I from pgkiln_runtime', r.db_role);
    end if;
  end loop;
  -- memberships a workspace login no longer should have (the application moved, changed its role, or
  -- the workspace is no longer isolated); a role that now belongs to a shared workspace's application
  -- goes back to pgkiln_runtime
  for r in
    select g.rolname as granted, l.rolname as login, w.id as ws, w.isolated
      from meta.workspace w
      join pg_roles l on l.rolname in (w.run_role, w.dev_role)
      join pg_auth_members m on m.member = l.oid
      join pg_roles g on g.oid = m.roleid
     where g.rolname <> 'pgkiln_app_code' or not w.isolated
  loop
    if r.granted = 'pgkiln_app_code' or not r.isolated
       or not exists (select 1 from meta.app a where a.db_role = r.granted and meta.app_workspace(a.id) = r.ws) then
      execute format('revoke %I from %I', r.granted, r.login);
      if r.granted <> 'pgkiln_app_code'
         and exists (select 1 from meta.app a join meta.workspace w on w.id = meta.app_workspace(a.id)
                      where a.db_role = r.granted and not w.isolated)
         and not pg_has_role('pgkiln_runtime', r.granted, 'MEMBER') then
        execute format('grant %I to pgkiln_runtime', r.granted);
      end if;
    end if;
  end loop;
  -- logins of workspaces that are no longer isolated can't sign in
  for r in select run_role, dev_role from meta.workspace where not isolated and run_role is not null loop
    if exists (select 1 from pg_roles where rolname = r.run_role) then
      execute format('alter role %I nologin', r.run_role);
    end if;
    if exists (select 1 from pg_roles where rolname = r.dev_role) then
      execute format('alter role %I nologin', r.dev_role);
    end if;
  end loop;
end $$;
revoke all on function meta.workspace_sync_roles() from public;

-- names for the login roles, given when a workspace is first isolated (unique per installation:
-- roles are shared by every database of the PostgreSQL server)
create function meta.workspace_isolate() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
declare
  suffix text;
begin
  if new.isolated and new.run_role is null then
    loop
      suffix := substr(md5(random()::text || clock_timestamp()::text), 1, 8);
      exit when not exists (select 1 from pg_roles where rolname in (format('pgkiln_ws%s_run_%s', new.id, suffix), format('pgkiln_ws%s_dev_%s', new.id, suffix)));
    end loop;
    new.run_role := format('pgkiln_ws%s_run_%s', new.id, suffix);
    new.dev_role := format('pgkiln_ws%s_dev_%s', new.id, suffix);
  end if;
  if new.run_role is distinct from old.run_role and old.run_role is not null then
    raise exception 'The login roles of a workspace can''t be renamed.';
  end if;
  return new;
end $$;
create trigger workspace_isolate before insert or update of isolated, run_role, dev_role on meta.workspace
  for each row execute function meta.workspace_isolate();

create function meta.workspace_sync_roles_trigger() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
begin
  perform meta.workspace_sync_roles();
  return null;
end $$;
create trigger workspace_sync_roles after insert or update of isolated on meta.workspace
  for each statement execute function meta.workspace_sync_roles_trigger();
create trigger workspace_sync_roles after insert or update or delete on meta.workspace_app
  for each statement execute function meta.workspace_sync_roles_trigger();
create trigger workspace_sync_roles after insert or delete or update of db_role on meta.app
  for each statement execute function meta.workspace_sync_roles_trigger();

-- deleting a workspace: its login roles go too (they own nothing; if they do, they stay, unable to sign in)
create function meta.workspace_drop_roles() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
declare
  r text;
begin
  foreach r in array array[old.run_role, old.dev_role] loop
    continue when r is null or not exists (select 1 from pg_roles where rolname = r);
    begin
      execute format('drop role %I', r);
    exception when others then
      execute format('alter role %I nologin', r);
      raise notice 'The login role % owns objects or has privileges; it stays, unable to sign in.', r;
    end;
  end loop;
  return null;
end $$;
create trigger workspace_drop_roles after delete on meta.workspace
  for each row execute function meta.workspace_drop_roles();

revoke all on function meta.workspace_isolate(), meta.workspace_sync_roles_trigger(), meta.workspace_drop_roles() from public;

select meta.sync_app_code_grants();
