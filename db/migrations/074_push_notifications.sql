-- =====================================================================
-- 074: push notifications for Progressive Web Apps (APEX: APEX_PWA push
-- notifications, the Send Push Notification process)
--
-- An installable application (pwa) with pwa_push on lets its users turn on
-- notifications per device (My account, or the dynamic action
-- push_subscribe). The browser hands out a subscription: an endpoint URL at
-- its push service and two keys; meta.push_subscription keeps them.
--
-- meta.send_push(user, title, body, page, items, …) queues a notification
-- for every device of a user of the current application. Like
-- meta.web_request it only queues: the pgapex server sends after the caller
-- commits (woken by NOTIFY pgapex_push, else the scheduler), so a rolled
-- back transaction sends nothing. The server encrypts each message for the
-- device (RFC 8291) and signs the request with the application's VAPID key
-- (RFC 8292), kept in meta.push_key: one pair per application, the private
-- key encrypted like web credential secrets. meta.push_key is not part of
-- meta.app, so exports never contain it.
--
-- A link in a notification is a page of the application with items, signed
-- (meta.url_checksum) for the recipient, not for the sender.
--
-- Subscriptions end when the push service says so (404/410), when the user
-- signs out on the device (the service worker unsubscribes), when the
-- account is deactivated or gets a new password, and when access to the
-- application is removed.
-- =====================================================================

alter table meta.app add column pwa_push boolean not null default false;
comment on column meta.app.pwa_push is 'Progressive Web App: users may turn on push notifications (needs pwa)';

-- an export made before 074 has no pwa_push: import_app inserts NULL (see 054)
create function meta.app_push_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.pwa_push := coalesce(new.pwa_push, false);
  return new;
end $$;
create trigger app_push_default before insert or update on meta.app
  for each row execute function meta.app_push_default();

create table meta.push_key (
  app_id      int  primary key references meta.app on delete cascade,
  -- the uncompressed P-256 public key (65 bytes), base64url: the browser's applicationServerKey
  public_key  text not null check (public_key ~ '^[A-Za-z0-9_-]{87}$'),
  -- the 32-byte private key, base64url, encrypted (src/secrets.ts)
  private_key text not null,
  created_at  timestamptz not null default now()
);
revoke all on meta.push_key from public;
comment on table meta.push_key is 'VAPID key pair of an application (push notifications); the private key is encrypted. Never exported';

create table meta.push_subscription (
  id           bigserial primary key,
  app_id       int  not null references meta.app on delete cascade,
  username     text not null,
  endpoint     text not null unique check (length(endpoint) <= 1000 and endpoint ~ '^https?://'),
  p256dh       text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth         text not null check (auth ~ '^[A-Za-z0-9_-]{22}$'),
  user_agent   text check (length(user_agent) <= 300),
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz,
  failures     int  not null default 0
);
create index on meta.push_subscription (app_id, lower(username));
revoke all on meta.push_subscription from public;
comment on table meta.push_subscription is 'Devices on which a user turned on push notifications for an application';

create table meta.push_message (
  id            bigserial primary key,
  app_id        int  not null references meta.app on delete cascade,
  username      text not null,
  title         text not null,
  body          text,
  url           text,
  tag           text,
  urgency       text not null default 'normal' check (urgency in ('very-low', 'low', 'normal', 'high')),
  ttl_s         int  not null default 86400 check (ttl_s between 0 and 2419200),
  -- queued → sending (not_before: when it was claimed) → sent (at least one device) | no_device | error
  status        text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'no_device', 'error')),
  attempts      int  not null default 0,
  not_before    timestamptz not null default now(),
  devices       int,
  delivered     int,
  message       text,
  requested_by  text,
  requested_at  timestamptz not null default now(),
  sent_at       timestamptz
);
create index on meta.push_message (not_before) where status = 'queued';
create index on meta.push_message (app_id, id desc);
create index on meta.push_message (requested_at);
revoke all on meta.push_message from public;
comment on table meta.push_message is 'Push notifications queued with meta.send_push and their delivery; kept 7 days';

-- ---------------------------------------------------------------- the API

-- Queue a notification for every device of p_user; returns its id.
-- p_page/p_items: the page the notification opens (signed for p_user).
create function meta.send_push(
  p_user    text,
  p_title   text,
  p_body    text  default null,
  p_page    int   default null,
  p_items   jsonb default '{}',
  p_tag     text  default null,
  p_urgency text  default 'normal',
  p_ttl_s   int   default 86400
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app   int := meta.app_id();
  v_alias text;
  v_on    boolean;
  v_url   text;
  v_id    bigint;
begin
  if v_app is null then
    raise exception 'meta.send_push: no current application (call it from application code)';
  end if;
  select alias, pwa and pwa_push into v_alias, v_on from meta.app where id = v_app;
  if not coalesce(v_on, false) then
    raise exception 'meta.send_push: push notifications are off for this application (Settings → Progressive Web App)';
  end if;
  if p_user is null or p_user !~ '^[^\s:]{1,100}$' then
    raise exception 'meta.send_push: the user name is required (at most 100 characters, no spaces)';
  end if;
  if p_title is null or length(p_title) not between 1 and 200 then
    raise exception 'meta.send_push: the title is required (at most 200 characters)';
  end if;
  if length(p_body) > 1000 then
    raise exception 'meta.send_push: the body has at most 1000 characters';
  end if;
  if p_tag is not null and p_tag !~ '^[A-Za-z0-9_-]{1,32}$' then
    raise exception 'meta.send_push: the tag is 1 to 32 letters, digits, _ or - (a newer notification with the same tag replaces the older one)';
  end if;
  if coalesce(p_urgency, 'normal') not in ('very-low', 'low', 'normal', 'high') then
    raise exception 'meta.send_push: the urgency is very-low, low, normal or high';
  end if;
  if coalesce(p_ttl_s, 86400) not between 0 and 2419200 then
    raise exception 'meta.send_push: the time to live is 0 to 2419200 seconds (28 days)';
  end if;
  if p_items is not null and p_items <> '{}'::jsonb and (jsonb_typeof(p_items) <> 'object' or p_page is null) then
    raise exception 'meta.send_push: the items are a JSON object of item names and values, with a page';
  end if;
  if p_page is not null then
    if not exists (select 1 from meta.page where app_id = v_app and page_no = p_page) then
      raise exception 'meta.send_push: page % does not exist in this application', p_page;
    end if;
    v_url := format('/a/%s/%s', v_alias, p_page)
      || case when coalesce(p_items, '{}'::jsonb) = '{}'::jsonb then '' else
           '?' || (select string_agg(upper(key) || '=' || meta.url_encode(coalesce(value #>> '{}', '')), '&' order by upper(key) collate "C")
                     from jsonb_each(p_items))
           || '&cs=' || meta.url_checksum(v_app, p_page, p_user, p_items) end;
  end if;
  if (select count(*) from meta.push_message where app_id = v_app and status = 'queued') >= 1000 then
    raise exception 'meta.send_push: this application has 1000 notifications waiting already';
  end if;
  insert into meta.push_message (app_id, username, title, body, url, tag, urgency, ttl_s, requested_by)
  values (v_app, p_user, p_title, nullif(p_body, ''), v_url, p_tag, coalesce(p_urgency, 'normal'), coalesce(p_ttl_s, 86400), meta.app_user())
  returning id into v_id;
  perform pg_notify('pgapex_push', '');
  return v_id;
end
$$;

-- Whether p_user has turned on notifications on at least one device (APEX_PWA.HAS_PUSH_SUBSCRIPTION).
create function meta.has_push_subscription(p_user text default null) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select exists (select 1 from meta.push_subscription
                  where app_id = meta.app_id() and lower(username) = lower(coalesce(p_user, meta.app_user())))
$$;

grant execute on function meta.send_push(text, text, text, int, jsonb, text, text, int), meta.has_push_subscription(text) to public;

-- ---------------------------------------------------------------- ending subscriptions

-- a new password or a deactivated account: the devices of an attacker who knew the password stop receiving
create function meta.push_subscription_revoke_account() returns trigger
language plpgsql security definer set search_path = meta, pg_temp as $$
begin
  delete from push_subscription where lower(username) = lower(new.username);
  return new;
end $$;
create trigger push_subscription_revoke
  after update of password_hash, active on meta.account
  for each row
  when (new.password_hash is distinct from old.password_hash or (old.active and not new.active))
  execute function meta.push_subscription_revoke_account();

create function meta.push_subscription_revoke_access() returns trigger
language plpgsql security definer set search_path = meta, pg_temp as $$
begin
  delete from push_subscription s using account a
   where a.id = old.account_id and s.app_id = old.app_id and lower(s.username) = lower(a.username);
  return old;
end $$;
create trigger push_subscription_revoke
  after delete on meta.app_access
  for each row execute function meta.push_subscription_revoke_access();

-- ---------------------------------------------------------------- new types

alter table meta.process drop constraint process_type_check;
alter table meta.process add constraint process_type_check check (type in (
  'ai_generate', 'chain', 'data_load', 'download', 'form_dml', 'grid_dml', 'invoke_api', 'sql', 'workflow', 'plugin', 'send_push'));

alter table meta.dynamic_action drop constraint dynamic_action_action_check;
alter table meta.dynamic_action add constraint dynamic_action_action_check check (action in (
  'show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit',
  'set_focus', 'add_class', 'remove_class', 'show_success', 'show_error', 'clear_errors', 'ai_generate', 'execute_javascript', 'plugin',
  'push_subscribe'));
