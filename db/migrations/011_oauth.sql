-- ---------------------------------------------------------------------
-- OAuth clients for the REST API (like ORDS's OAUTH package)
--
-- A system that calls the API gets a client id and secret, and exchanges
-- them for a short-lived access token (OAuth 2.0 client credentials):
--
--   curl -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials \
--        https://apps.example.com/oauth/token
--
-- Tokens expire (token_minutes, default 60), so nothing has to be rotated
-- by hand: clients fetch a new token when theirs expires. Secrets can be
-- rotated with a grace period during which the old one still works.
--
-- In SQL (owner only), like oauth.create_client / oauth.grant_client_role:
--   select * from meta.oauth_create_client('hr', 'payroll-sync', '{manager}');
--   select meta.oauth_rotate_secret('<client id>');           -- old secret valid 24h
--   select meta.oauth_revoke_client('<client id>');
--
-- In the API a client acts as application user "client:<name>" with the
-- client's roles, read at every request (revoking works at once).
-- ---------------------------------------------------------------------
create table meta.api_client (
  id                    serial primary key,
  app_id                int  not null references meta.app on delete cascade,
  name                  text not null check (name ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  description           text,
  client_id             text not null unique,
  secret_hash           text not null,                 -- sha256 (hex) of the secret
  previous_secret_hash  text,                          -- valid until previous_valid_until
  previous_valid_until  timestamptz,
  roles                 text[] not null default '{}',
  token_minutes         int  not null default 60 check (token_minutes between 5 and 1440),
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  secret_changed_at     timestamptz not null default now(),
  last_used_at          timestamptz,
  unique (app_id, name)
);
revoke all on meta.api_client from public;

create function meta.oauth_secret() returns text
language sql volatile set search_path = meta, public, pg_catalog as $$
  select translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_')
$$;

create function meta.oauth_hash(p_secret text) returns text
language sql immutable set search_path = meta, public, pg_catalog as $$
  select encode(digest(p_secret, 'sha256'), 'hex')
$$;

-- Create a client; the secret is returned only here.
create function meta.oauth_create_client(p_app text, p_name text, p_roles text[] default '{}',
                                         p_description text default null, p_token_minutes int default 60)
returns table (client_id text, client_secret text)
language plpgsql set search_path = meta, public, pg_catalog as $$
declare
  v_app    int;
  v_id     text := translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_');
  v_secret text := meta.oauth_secret();
begin
  select a.id into v_app from meta.app a where a.alias = p_app;
  if not found then
    raise exception 'Application % does not exist.', p_app;
  end if;
  insert into meta.api_client (app_id, name, description, client_id, secret_hash, roles, token_minutes)
  values (v_app, lower(p_name), p_description, v_id, meta.oauth_hash(v_secret),
          (select coalesce(array_agg(distinct lower(trim(r))), '{}') from unnest(p_roles) r where trim(r) <> ''),
          p_token_minutes);
  return query select v_id, v_secret;
end
$$;

-- New secret; the old one keeps working for p_grace (0 = not at all).
create function meta.oauth_rotate_secret(p_client_id text, p_grace interval default '24 hours') returns text
language plpgsql set search_path = meta, public, pg_catalog as $$
declare
  v_secret text := meta.oauth_secret();
begin
  update meta.api_client c
     set previous_secret_hash = case when p_grace > interval '0' then c.secret_hash end,
         previous_valid_until = case when p_grace > interval '0' then now() + p_grace end,
         secret_hash = meta.oauth_hash(v_secret),
         secret_changed_at = now()
   where c.client_id = p_client_id;
  if not found then
    raise exception 'OAuth client % does not exist.', p_client_id;
  end if;
  return v_secret;
end
$$;

create function meta.oauth_revoke_client(p_client_id text) returns void
language sql set search_path = meta, pg_catalog as $$
  update meta.api_client set active = false where client_id = p_client_id
$$;

create function meta.oauth_grant_role(p_client_id text, p_role text) returns void
language sql set search_path = meta, pg_catalog as $$
  update meta.api_client set roles = (select array_agg(distinct r) from unnest(roles || lower(trim(p_role))) r)
   where client_id = p_client_id
$$;

create function meta.oauth_revoke_role(p_client_id text, p_role text) returns void
language sql set search_path = meta, pg_catalog as $$
  update meta.api_client set roles = array_remove(roles, lower(trim(p_role))) where client_id = p_client_id
$$;

revoke all on function meta.oauth_secret(), meta.oauth_hash(text),
  meta.oauth_create_client(text, text, text[], text, int), meta.oauth_rotate_secret(text, interval),
  meta.oauth_revoke_client(text), meta.oauth_grant_role(text, text), meta.oauth_revoke_role(text, text) from public;

-- Roles: for client tokens (claim client_id) the client's roles, read live.
create or replace function meta.has_role(p_role text) returns boolean
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_session uuid := nullif(current_setting('pgkiln.session_id', true), '')::uuid;
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
  if v_claims ? 'client_id' then
    return exists (select 1 from meta.api_client c
                    where c.client_id = v_claims->>'client_id' and c.active and lower(p_role) = any (c.roles));
  end if;
  if jsonb_typeof(v_claims->'roles') = 'array'
     and exists (select 1 from jsonb_array_elements_text(v_claims->'roles') r where lower(r) = lower(p_role)) then
    return true;
  end if;
  return lower(p_role) = any (meta.account_roles(meta.app_id(), meta.app_user()));
end
$$;

-- Pre-request check: client tokens need an active client of the token's app.
create or replace function meta.api_check() returns void
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_claims jsonb := meta.jwt_claims();
  v_role   text := current_setting('role', true);   -- the SET ROLE PostgREST did
  v_app    meta.app;
  v_acc    meta.account;
begin
  if v_claims is null or v_role is null or v_role in ('none', 'pgkiln_anon') then
    return;
  end if;
  select * into v_app from meta.app a where a.alias = v_claims->>'app';
  if not found or v_app.api_role is distinct from v_role then
    raise exception 'This token is not valid for an application with API role %.', v_role
      using errcode = 'PT401';
  end if;
  if v_claims ? 'client_id' then
    if not exists (select 1 from meta.api_client c
                    where c.client_id = v_claims->>'client_id' and c.app_id = v_app.id and c.active) then
      raise exception 'The OAuth client of this token does not exist or was revoked.' using errcode = 'PT401';
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
