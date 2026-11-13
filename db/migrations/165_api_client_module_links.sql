-- =====================================================================
-- 165: an OAuth client's REST modules by link, not by name (sprint 184,
-- code review of 0.94.0: CR-1, CR-2)
--
-- 162 kept a limited client's modules as names (api_client.rest_modules).
-- A name has no link to its module: renaming the module left the old name
-- (the client was refused everywhere, silently), and deleting a module and
-- later creating another one with its name granted the client a module
-- nobody gave it. Now:
--
--   api_client.module_limit  false: the whole application, as before.
--                            true: the client's tokens work for the modules
--                            linked in api_client_module only, AutoREST and
--                            the data API refuse them (403).
--   api_client_module        (client, module) by id: renaming a module keeps
--                            the link, deleting it removes the link. The
--                            client stays limited, so a deleted module is
--                            never re-granted and a client whose modules
--                            are all gone is refused everywhere.
--
-- Importing over an application (src/cli/replace.ts) re-creates its REST
-- modules; the links follow a module of the same name, as tasks follow
-- their definition. A module the import drops loses its links.
--
-- Clients stay installation data (never exported). Owner only, like 011:
-- meta.oauth_limit_client(client_id, modules) sets or (null) clears a limit.
-- =====================================================================

alter table meta.api_client add column if not exists module_limit boolean not null default false;
comment on column meta.api_client.module_limit is
  'false: the client may call the whole application; true: only the REST modules in meta.api_client_module';

create table if not exists meta.api_client_module (
  client_id int not null references meta.api_client on delete cascade,
  module_id int not null references meta.rest_module on delete cascade,
  primary key (client_id, module_id)
);
create index if not exists api_client_module_module on meta.api_client_module (module_id);
revoke all on meta.api_client_module from public;
comment on table meta.api_client_module is
  'The REST modules an OAuth client with module_limit is limited to (165; by id, so a renamed module keeps its clients)';

-- 162's names: a name of an existing module of the client's application becomes a link; any other
-- name (a module renamed or deleted since) is dropped, and the client stays limited
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'meta' and table_name = 'api_client' and column_name = 'rest_modules') then
    insert into meta.api_client_module (client_id, module_id)
    select c.id, m.id
      from meta.api_client c cross join lateral unnest(c.rest_modules) n(name)
      join meta.rest_module m on m.app_id = c.app_id and m.name = n.name
    on conflict do nothing;
    update meta.api_client set module_limit = true where rest_modules is not null;
    alter table meta.api_client drop column rest_modules;
  end if;
end
$$;

-- Set (a list of module names of the client's application) or clear (null) a client's limit.
create or replace function meta.oauth_limit_client(p_client_id text, p_modules text[]) returns void
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_client meta.api_client;
  v_names  text[] := (select coalesce(array_agg(distinct lower(trim(n))), '{}') from unnest(p_modules) n where trim(n) <> '');
  v_ids    int[];
  v_unknown text;
begin
  select * into v_client from meta.api_client c where c.client_id = p_client_id;
  if not found then
    raise exception 'OAuth client % does not exist.', p_client_id;
  end if;
  if p_modules is null then
    update meta.api_client set module_limit = false where id = v_client.id;
    delete from meta.api_client_module where client_id = v_client.id;
    return;
  end if;
  select string_agg(n, ', ' order by n) into v_unknown
    from unnest(v_names) n where not exists (select 1 from meta.rest_module m where m.app_id = v_client.app_id and m.name = n);
  if v_unknown is not null then
    raise exception 'The application of this client has no REST module named %.', v_unknown;
  end if;
  if cardinality(v_names) = 0 then
    raise exception 'Name at least one REST module, or null for no limit.';
  end if;
  select array_agg(m.id) into v_ids from meta.rest_module m where m.app_id = v_client.app_id and m.name = any (v_names);
  update meta.api_client set module_limit = true where id = v_client.id;
  delete from meta.api_client_module where client_id = v_client.id and module_id <> all (v_ids);
  insert into meta.api_client_module (client_id, module_id) select v_client.id, unnest(v_ids) on conflict do nothing;
end
$$;
revoke all on function meta.oauth_limit_client(text, text[]) from public;

-- the token check of the data API (083, 162); (165) a limited client is refused, also when its token has no
-- role claim (tokens issued by 0.94.0), which PostgREST runs as pgkiln_anon
create or replace function meta.api_check() returns void
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_claims jsonb := meta.jwt_claims();
  v_role   text := current_setting('role', true);   -- the SET ROLE PostgREST did
  v_app    meta.app;
  v_acc    meta.account;
  v_client meta.api_client;
begin
  if v_claims is null or v_role is null or v_role = 'none' then
    return;
  end if;
  if v_role = 'pgkiln_anon' then
    -- anonymous, unless it is the token of a limited client: that one is refused, not anonymous
    if v_claims ? 'client_id' and exists (select 1 from meta.api_client c join meta.app a on a.id = c.app_id
                                           where c.client_id = v_claims->>'client_id' and a.alias = v_claims->>'app' and c.module_limit) then
      raise exception 'This OAuth client is limited to REST modules of the application.' using errcode = 'PT403';
    end if;
    return;
  end if;
  select * into v_app from meta.app a where a.alias = v_claims->>'app';
  if not found or v_app.api_role is distinct from v_role then
    raise exception 'This token is not valid for an application with API role %.', v_role
      using errcode = 'PT401';
  end if;
  -- (083) the application's availability: unavailable or for developers only answers 503;
  -- restricted only for the users it names (never for an OAuth client)
  if v_app.availability in ('unavailable', 'developers') then
    raise exception '%', coalesce(nullif(v_app.availability_message, ''), 'The application is not available at the moment.') using errcode = 'PT503';
  end if;
  if v_app.availability = 'restricted'
     and (v_claims ? 'client_id' or not lower(meta.app_user()) = any (select lower(u) from unnest(v_app.availability_users) u)) then
    raise exception 'The application is not available to this account at the moment.' using errcode = 'PT403';
  end if;
  if v_claims ? 'client_id' then
    select * into v_client from meta.api_client c
     where c.client_id = v_claims->>'client_id' and c.app_id = v_app.id and c.active;
    if not found then
      raise exception 'The OAuth client of this token does not exist or was revoked.' using errcode = 'PT401';
    end if;
    if v_client.module_limit then
      raise exception 'This OAuth client is limited to REST modules of the application.' using errcode = 'PT403';
    end if;
    return;
  end if;
  select * into v_acc from meta.account ac where lower(ac.username) = lower(meta.app_user());
  if not found or not v_acc.active then
    raise exception 'The account of this token does not exist or is inactive.' using errcode = 'PT403';
  end if;
  if v_app.access_control <> 'any_user'
     and not exists (select 1 from meta.app_access aa where aa.app_id = v_app.id and aa.account_id = v_acc.id) then
    raise exception 'The account of this token has no access to the application.' using errcode = 'PT403';
  end if;
end
$$;
