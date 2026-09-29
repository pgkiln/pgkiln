-- =====================================================================
-- 006: account self-service and password policy (like APEX accounts)
--
--   * users change their own password (APEX_UTIL.CHANGE_CURRENT_USER_PW)
--   * "Require change of password on first use" and password expiry after
--     N days (APEX account login controls), admin reset and expire
--     (APEX_UTIL.RESET_PASSWORD, EXPIRE_END_USER_ACCOUNT)
--   * forgot password: one-time reset links sent by e-mail (APEX has no
--     built-in end-user flow; here it's an opt-in per application)
--   * preferences per account: light/dark theme and language
-- =====================================================================

alter table meta.account
  add column must_change_password boolean not null default false,
  add column password_changed_at  timestamptz,
  add column theme_pref           text not null default 'auto' check (theme_pref in ('auto', 'light', 'dark')),
  add column language             text check (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$');

update meta.account set password_changed_at = now() where password_hash is not null;

-- Whatever sets a password (builder, scripts, the meta.app_user view) resets
-- its age; a new hash set by someone else than the user can require a change.
create function meta.account_password_changed() returns trigger
language plpgsql as $$
begin
  if new.password_hash is distinct from old.password_hash then
    new.password_changed_at := case when new.password_hash is null then null else now() end;
  end if;
  return new;
end
$$;
create trigger account_password_changed before update of password_hash on meta.account
  for each row execute function meta.account_password_changed();

create function meta.account_password_created() returns trigger
language plpgsql as $$
begin
  if new.password_hash is not null then
    new.password_changed_at := coalesce(new.password_changed_at, now());
  end if;
  return new;
end
$$;
create trigger account_password_created before insert on meta.account
  for each row execute function meta.account_password_created();

-- Instance-wide account settings, readable by the runtime (not secrets).
create table meta.setting (
  name  text primary key,
  value text not null
);
insert into meta.setting values
  ('password_min_length', '8'),        -- APEX: Minimum Password Length
  ('password_require_mixed', 'false'), -- letters and digits
  ('password_lifetime_days', '0');     -- APEX: Account Password Lifetime; 0 = never expires

create function meta.setting(p_name text) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select value from meta.setting where name = p_name
$$;

-- Days until the password of an account expires (NULL: never).
create function meta.password_days_left(p_username text) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select case when a.must_change_password then 0
              when l.days > 0 and a.password_changed_at is not null
                then greatest(0, l.days - extract(day from now() - a.password_changed_at)::int)
         end
    from meta.account a, (select coalesce(meta.setting('password_lifetime_days'), '0')::int as days) l
   where lower(a.username) = lower(p_username)
$$;

-- Change a password knowing the current one. Same access rules as
-- meta.authenticate(); ends the account's other sessions.
create function meta.change_password(p_app_id int, p_username text, p_old text, p_new text, p_keep_session uuid default null)
returns boolean
language plpgsql security definer set search_path = meta, public, pg_catalog as $$
declare
  v_user text := meta.authenticate(p_app_id, p_username, p_old);
begin
  if v_user is null then
    return false;
  end if;
  if p_new is null or p_new = p_old then
    raise exception 'The new password must be different from the current one.';
  end if;
  update meta.account
     set password_hash = crypt(p_new, gen_salt('bf', 10)), must_change_password = false
   where lower(username) = lower(v_user);
  delete from meta.session
   where app_id is not null and lower(username) = lower(v_user) and id is distinct from p_keep_session;
  return true;
end
$$;

-- ---------------------------------------------------------------------
-- Administration (owner only; grant them to an app role to build your own
-- user admin pages, like the APEX_UTIL procedures).
-- ---------------------------------------------------------------------
create function meta.set_password(p_username text, p_password text, p_change_on_first_use boolean default true) returns void
language plpgsql as $$
begin
  update meta.account set password_hash = meta.hash_password(p_password), must_change_password = p_change_on_first_use
   where lower(username) = lower(p_username);
  if not found then raise exception 'No account "%".', p_username; end if;
  delete from meta.session where app_id is not null and lower(username) = lower(p_username);
end
$$;

-- The next sign-in must set a new password (APEX_UTIL.EXPIRE_END_USER_ACCOUNT).
create function meta.expire_password(p_username text) returns void
language sql as $$
  update meta.account set must_change_password = true where lower(username) = lower(p_username)
$$;

create function meta.unexpire_password(p_username text) returns void
language sql as $$
  update meta.account set must_change_password = false, password_changed_at = now()
   where lower(username) = lower(p_username) and password_hash is not null
$$;

revoke all on function meta.set_password(text, text, boolean), meta.expire_password(text), meta.unexpire_password(text) from public;

-- ---------------------------------------------------------------------
-- Forgot password: one-time links, valid 30 minutes. Only the SHA-256 of
-- the token is stored.
-- ---------------------------------------------------------------------
alter table meta.app add column password_reset boolean not null default false;

create table meta.password_reset (
  token_hash text primary key,
  account_id int not null references meta.account on delete cascade,
  app_id     int not null references meta.app on delete cascade,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index on meta.password_reset (account_id, created_at);

-- Start a reset for a username or e-mail address. Returns the account's
-- e-mail and a token when the account may reset its password in this app,
-- and nothing otherwise (the caller shows the same message either way).
create function meta.start_password_reset(p_app_id int, p_login text)
returns table (username text, email text, display_name text, token text)
language plpgsql security definer set search_path = meta, public, pg_catalog as $$
declare
  v_acc   meta.account;
  v_token text := encode(gen_random_bytes(32), 'hex');
begin
  select a.* into v_acc from meta.account a
   where (lower(a.username) = lower(p_login) or lower(a.email) = lower(p_login))
     and a.active and a.email is not null and a.password_hash is not null
   order by lower(a.username) = lower(p_login) desc
   limit 1;
  if not found
     or not exists (select 1 from meta.app x where x.id = p_app_id and x.password_reset and x.local_login)
     or (not exists (select 1 from meta.app x where x.id = p_app_id and x.access_control = 'any_user')
         and not exists (select 1 from meta.app_access aa where aa.app_id = p_app_id and aa.account_id = v_acc.id))
     -- at most 3 links per account per hour
     or (select count(*) from meta.password_reset r where r.account_id = v_acc.id and r.created_at > now() - interval '1 hour') >= 3 then
    return;
  end if;
  delete from meta.password_reset r where r.created_at < now() - interval '1 day';
  update meta.password_reset r set used_at = now() where r.account_id = v_acc.id and r.used_at is null;
  insert into meta.password_reset (token_hash, account_id, app_id)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_acc.id, p_app_id);
  return query select v_acc.username, v_acc.email, v_acc.display_name, v_token;
end
$$;

-- Whether a token is valid (for showing the form), and for which account.
create function meta.check_password_reset(p_app_id int, p_token text) returns text
language sql stable security definer set search_path = meta, public, pg_catalog as $$
  select a.username from meta.password_reset r join meta.account a on a.id = r.account_id
   where r.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and r.app_id = p_app_id
     and r.used_at is null and r.created_at > now() - interval '30 minutes' and a.active
$$;

-- Set a new password with a token (once). Ends all sessions of the account.
create function meta.finish_password_reset(p_app_id int, p_token text, p_new text) returns text
language plpgsql security definer set search_path = meta, public, pg_catalog as $$
declare
  v_user text := meta.check_password_reset(p_app_id, p_token);
begin
  if v_user is null then
    return null;
  end if;
  update meta.password_reset set used_at = now() where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  update meta.account set password_hash = crypt(p_new, gen_salt('bf', 10)), must_change_password = false
   where lower(username) = lower(v_user);
  delete from meta.session where app_id is not null and lower(username) = lower(v_user);
  return v_user;
end
$$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
grant select on meta.setting to pgapex_runtime;
grant select (must_change_password, password_changed_at, theme_pref, language) on meta.account to pgapex_runtime;
grant update (theme_pref, language) on meta.account to pgapex_runtime;
grant execute on function meta.setting(text), meta.password_days_left(text) to public;
revoke all on function meta.change_password(int, text, text, text, uuid), meta.start_password_reset(int, text),
  meta.check_password_reset(int, text), meta.finish_password_reset(int, text, text) from public;
grant execute on function meta.change_password(int, text, text, text, uuid), meta.start_password_reset(int, text),
  meta.check_password_reset(int, text), meta.finish_password_reset(int, text, text) to pgapex_runtime;
