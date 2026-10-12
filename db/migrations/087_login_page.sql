-- =====================================================================
-- 087: an editable login page and "Forgot password?" for app users
--
-- meta.app.login_page: the page that replaces the built-in sign-in page
--   (APEX: the login page, usually 9999). /a/<alias>/login sends visitors
--   there; it must not require authentication. Its "login" region is the
--   sign-in form, which posts to /a/<alias>/login as before.
-- meta.page.page_template: 'minimal' shows a page without the header and
--   navigation (APEX: Minimal (No Navigation)); login pages use it.
-- meta.app.password_reset: the sign-in page offers "Forgot password?" to
--   accounts with a password in the user directory, when the application
--   has an enabled mail service. A reset link is single-use and expires
--   after 30 minutes; only a SHA-256 hash of its token is stored.
-- meta.password_reset: the tokens (owner only; the functions below are
--   the runtime's way in).
-- =====================================================================
alter table meta.app add column login_page int check (login_page > 0);
alter table meta.app add column password_reset boolean not null default false;
alter table meta.page add column page_template text not null default 'standard' check (page_template in ('standard', 'minimal'));

-- an export made before 087 has neither: NULL becomes the default (like 077)
create function meta.login_page_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if tg_table_name = 'app' then
    new.password_reset := coalesce(new.password_reset, false);
  else
    new.page_template := coalesce(new.page_template, 'standard');
  end if;
  return new;
end
$$;
create trigger app_login_page_defaults before insert or update on meta.app
  for each row execute function meta.login_page_defaults();
create trigger page_login_page_defaults before insert or update on meta.page
  for each row execute function meta.login_page_defaults();

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
                  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter', 'ai_assistant', 'plugin', 'url', 'search',
                  'login'));

create table meta.password_reset (
  id          bigint generated always as identity primary key,
  app_id      int not null references meta.app on delete cascade,
  account_id  int not null references meta.account on delete cascade,
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  ip          text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 minutes',
  used_at     timestamptz
);
create index password_reset_account on meta.password_reset (account_id, created_at);
revoke all on meta.password_reset from public;

-- Whether the application offers "Forgot password?": turned on, app users with local passwords,
-- and an enabled mail service with a From address.
create function meta.password_reset_available(p_app_id int) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select exists (
    select 1
      from meta.app a
      join meta.app_mail_service ams on ams.app_id = a.id
      join meta.mail_service s on s.id = ams.service_id
     where a.id = p_app_id and a.password_reset and a.authentication = 'app_users' and a.local_login
       and s.enabled and nullif(btrim(ams.from_address), '') is not null)
$$;
revoke all on function meta.password_reset_available(int) from public;
grant execute on function meta.password_reset_available(int) to pgkiln_runtime;

-- A reset request for a user name or e-mail address. When it matches one active account with a
-- password and an e-mail address that may use the application, keeps the token's hash and queues
-- the mail (#USER# in the subject and bodies becomes the user name; the caller puts the link in).
-- Says nothing about whether an account matched: the caller shows the same answer either way.
-- At most 3 requests per account per hour.
create function meta.request_password_reset(p_app_id int, p_login text, p_token_hash text, p_ip text,
                                            p_subject text, p_body text, p_body_html text) returns void
language plpgsql volatile security definer set search_path = meta, public, pg_catalog as $$
declare
  v_acc   meta.account;
  v_n     int;
  v_from  text;
  v_send  text[];
  v_max   int;
  v_vals  jsonb;
  v_id    bigint;
begin
  if not meta.password_reset_available(p_app_id) or p_token_hash !~ '^[0-9a-f]{64}$' or btrim(coalesce(p_login, '')) = '' then
    return;
  end if;
  -- a user name, else an e-mail address that only one active account has
  select * into v_acc from meta.account where lower(username) = lower(btrim(p_login)) and active;
  if not found then
    select count(*) into v_n from meta.account where lower(email) = lower(btrim(p_login)) and active;
    if v_n <> 1 then
      return;
    end if;
    select * into v_acc from meta.account where lower(email) = lower(btrim(p_login)) and active;
  end if;
  if v_acc.password_hash is null or nullif(btrim(v_acc.email), '') is null then
    return;
  end if;
  if not exists (select 1 from meta.app a where a.id = p_app_id and a.access_control = 'any_user')
     and not exists (select 1 from meta.app_access where app_id = p_app_id and account_id = v_acc.id) then
    return;
  end if;
  select count(*) into v_n from meta.password_reset where account_id = v_acc.id and created_at > now() - interval '1 hour';
  if v_n >= 3 then
    return;
  end if;
  select ams.from_address, s.senders, ams.max_per_day into v_from, v_send, v_max
    from meta.app_mail_service ams join meta.mail_service s on s.id = ams.service_id
   where ams.app_id = p_app_id;
  if not meta.mail_sender_allowed(v_send, v_from) then
    raise warning 'password reset for app %: the mail service may not send as %', p_app_id, v_from;
    return;
  end if;
  if v_max is not null and (select count(*) from meta.mail_queue
                             where app_id = p_app_id and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
                               and status <> 'cancelled') >= v_max then
    raise warning 'password reset for app %: the daily mail limit is reached', p_app_id;
    return;
  end if;
  delete from meta.password_reset where created_at < now() - interval '7 days';
  insert into meta.password_reset (app_id, account_id, token_hash, ip) values (p_app_id, v_acc.id, p_token_hash, left(p_ip, 100));
  v_vals := jsonb_build_object('USER', v_acc.username);
  insert into meta.mail_queue (app_id, username, from_address, to_addresses, subject, body_text, body_html, template)
  values (p_app_id, v_acc.username, v_from, array[v_acc.email], left(replace(replace(meta.mail_fill(p_subject, v_vals, false), E'\r', ''), E'\n', ' '), 998),
          meta.mail_fill(p_body, v_vals, false), meta.mail_fill(p_body_html, v_vals, true), 'PASSWORD_RESET')
  returning id into v_id;
  perform pg_notify('pgkiln_mail', v_id::text);
end
$$;
revoke all on function meta.request_password_reset(int, text, text, text, text, text, text) from public;
grant execute on function meta.request_password_reset(int, text, text, text, text, text, text) to pgkiln_runtime;

-- The user name a valid (unused, unexpired) token is for, or null.
create function meta.password_reset_user(p_app_id int, p_token_hash text) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select ac.username
    from meta.password_reset r join meta.account ac on ac.id = r.account_id
   where r.app_id = p_app_id and r.token_hash = p_token_hash and r.used_at is null and r.expires_at > now() and ac.active
$$;
revoke all on function meta.password_reset_user(int, text) from public;
grant execute on function meta.password_reset_user(int, text) to pgkiln_runtime;

-- Set the new password with a valid token: the token and the account's other open requests are used
-- up, every session and "keep me signed in" token of the account ends. Returns the user name, or
-- null when the token is not valid (any more).
create function meta.reset_password(p_app_id int, p_token_hash text, p_new text) returns text
language plpgsql volatile security definer set search_path = meta, public, pg_catalog as $$
declare
  v_reset meta.password_reset;
  v_acc   meta.account;
begin
  select * into v_reset from meta.password_reset
   where app_id = p_app_id and token_hash = p_token_hash and used_at is null and expires_at > now()
   for update;
  if not found or coalesce(p_new, '') = '' then
    return null;
  end if;
  select * into v_acc from meta.account where id = v_reset.account_id and active;
  if not found then
    return null;
  end if;
  update meta.account set password_hash = crypt(p_new, gen_salt('bf', 10)), must_change_password = false where id = v_acc.id;
  update meta.password_reset set used_at = now() where account_id = v_acc.id and used_at is null;
  delete from meta.session where app_id is not null and lower(username) = lower(v_acc.username);
  delete from meta.persistent_login where account_id = v_acc.id;
  return v_acc.username;
end
$$;
revoke all on function meta.reset_password(int, text, text) from public;
grant execute on function meta.reset_password(int, text, text) to pgkiln_runtime;
