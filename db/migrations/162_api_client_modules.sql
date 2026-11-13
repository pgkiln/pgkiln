-- =====================================================================
-- 162: OAuth clients limited to REST modules (sprint 178, DA-11 leftover)
--
-- ORDS protects a module with a privilege and grants it to a client.
-- Here an OAuth client of an application (011) can be limited to some of
-- the application's REST modules:
--
--   rest_modules  null: the whole application, as before (its REST
--                 modules, AutoREST and, with an API role, the data API).
--                 A list of module names: the client's tokens work for
--                 those modules only. AutoREST and the data API refuse
--                 them, and its new tokens carry no database role.
--
-- The check is made with every request (src/runtime/rest.ts, and
-- meta.api_check for the data API), so a change applies to tokens that
-- were issued before it. Clients stay installation data (never exported).
-- =====================================================================

alter table meta.api_client
  add column rest_modules text[]
    check (rest_modules is null or (cardinality(rest_modules) between 1 and 50 and array_position(rest_modules, null) is null));
comment on column meta.api_client.rest_modules is
  'null: the client may call the whole application; else the names of the REST modules (meta.rest_module.name) its tokens are limited to';

-- the token check of the data API (083), and (162) a client limited to REST modules is refused
create or replace function meta.api_check() returns void
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_claims jsonb := meta.jwt_claims();
  v_role   text := current_setting('role', true);   -- the SET ROLE PostgREST did
  v_app    meta.app;
  v_acc    meta.account;
  v_client meta.api_client;
begin
  if v_claims is null or v_role is null or v_role in ('none', 'pgkiln_anon') then
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
    if v_client.rest_modules is not null then
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
