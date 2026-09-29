-- =====================================================================
-- 005: REST APIs with PostgREST running alongside pgapex
--
-- PostgREST serves an application's `api` schema over HTTP. It connects as
-- pgapex_authenticator and switches to the role named in the request's JWT
-- (e.g. hr_api). The helpers below make meta.app_user(), meta.app_id() and
-- meta.has_role() understand PostgREST's verified JWT claims, so the same
-- row level security policies protect the web app and the API.
--
-- JWT claims used:
--   role      database role PostgREST switches to (the app's api_role)
--   app_user  the application user (falls back to preferred_username, email, sub)
--   app       the application alias (for roles from meta.app_access)
--   roles     extra application roles (e.g. from an identity provider);
--             pgapex's own tokens leave it out, so role changes apply at once
--
-- meta.api_check() is PostgREST's pre-request function: it rejects tokens of
-- inactive accounts or accounts without access, at every request.
-- =====================================================================

do $$
begin
  if not exists (select from pg_roles where rolname = 'pgapex_authenticator') then
    -- CHANGE THE PASSWORD outside development
    create role pgapex_authenticator login noinherit password 'pgapex_authenticator';
  end if;
  if not exists (select from pg_roles where rolname = 'pgapex_anon') then
    create role pgapex_anon nologin;   -- unauthenticated API requests: no privileges
  end if;
end
$$;
grant pgapex_anon to pgapex_authenticator;

-- The database role API tokens of an application use (e.g. hr_api).
alter table meta.app add column api_role text;

-- JWT claims set by PostgREST for the current request (NULL outside PostgREST).
create function meta.jwt_claims() returns jsonb
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

create or replace function meta.app_user() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('pgapex.app_user', true), ''),
    (select nullif(coalesce(c->>'app_user', c->>'preferred_username', c->>'email', c->>'sub'), '')
       from meta.jwt_claims() c),
    'nobody')
$$;

create or replace function meta.app_id() returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce(
    nullif(current_setting('pgapex.app_id', true), '')::int,
    (select a.id from meta.app a where a.alias = meta.jwt_claims()->>'app'))
$$;

-- In pgapex: roles of the session (resolved at sign-in).
-- In PostgREST: roles in the token, plus the account's roles in the token's app.
create or replace function meta.has_role(p_role text) returns boolean
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_session uuid := nullif(current_setting('pgapex.session_id', true), '')::uuid;
  v_claims  jsonb;
begin
  if v_session is not null then
    return exists (select 1 from meta.session s
                    where s.id = v_session and lower(p_role) = any (select lower(r) from unnest(s.roles) r));
  end if;
  v_claims := meta.jwt_claims();
  if v_claims is null then
    return false;
  end if;
  if jsonb_typeof(v_claims->'roles') = 'array'
     and exists (select 1 from jsonb_array_elements_text(v_claims->'roles') r where lower(r) = lower(p_role)) then
    return true;
  end if;
  return lower(p_role) = any (meta.account_roles(meta.app_id(), meta.app_user()));
end
$$;

-- PostgREST pre-request check (PGRST_DB_PRE_REQUEST = meta.api_check).
-- Runs before every API request, after PostgREST switched to the token's role.
-- A token is signed until it expires, so this is where deactivating an
-- account or revoking its access takes effect immediately:
--   * the token must name an application (claim "app") whose api_role is the
--     role PostgREST switched to;
--   * the user must be an active account with access to that application.
-- Anonymous requests (no token) pass; pgapex_anon has no privileges.
create function meta.api_check() returns void
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_claims jsonb := meta.jwt_claims();
  v_role   text := current_setting('role', true);   -- the SET ROLE PostgREST did
  v_app    meta.app;
  v_acc    meta.account;
begin
  if v_claims is null or v_role is null or v_role in ('none', 'pgapex_anon') then
    return;
  end if;
  select * into v_app from meta.app a where a.alias = v_claims->>'app';
  if not found or v_app.api_role is distinct from v_role then
    raise exception 'This token is not valid for an application with API role %.', v_role
      using errcode = 'PT401';
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

grant execute on function meta.jwt_claims(), meta.app_user(), meta.app_id(), meta.has_role(text), meta.api_check() to public;
