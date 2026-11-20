-- =====================================================================
-- 191: several mail services per application (sprint 236, MG-1)
--
-- Until now meta.app_mail_service had app_id as its key: one mail service
-- per application. An application that sends order mail as orders@ and
-- safety mail as safety@ through two accounts (two SMTP mailboxes, two
-- providers) could not. Now:
--
-- meta.app_mail_service is keyed (app_id, service_id); is_default marks the
--   application's default service, exactly one per application that has a
--   link (a partial unique index for "at most one"; the triggers below for
--   "at least one": the first link becomes the default, a new default
--   takes over from the old one, deleting the default promotes another).
--   Existing rows become the default. A link to another workspace's own
--   service is refused (it was already never used).
-- meta.mail_service_for_app(app, from): the linked, enabled service whose
--   allowed senders match the From address (the default first when several
--   do), else the default service (meta.mail_service_for_app(app), which
--   keeps its meaning: the default link, else the workspace's own service
--   when the application has no link). An application with one service
--   sends exactly as before.
-- meta.mail_queue.service_id: the service chosen when the mail was queued;
--   the sender (src/mail/mail.ts) uses it while it is still one of the
--   application's services, and the daily limit (max_per_day of the link)
--   counts the application's mail through that service.
-- meta.mail_caller(p_from): the chosen service for a From address;
--   meta.mail_caller() stays (the default service: add_mail_attachment).
-- Password reset mail goes through the default service.
--
-- app_mail_service stays installation data: not exported, kept by an
-- in-place import (src/cli/replace.ts KEPT). export_app/import_app unchanged.
-- =====================================================================

alter table meta.app_mail_service add column is_default boolean not null default false;
update meta.app_mail_service set is_default = true;
alter table meta.app_mail_service drop constraint app_mail_service_pkey;
alter table meta.app_mail_service add primary key (app_id, service_id);
create unique index app_mail_service_default on meta.app_mail_service (app_id) where is_default;
create index app_mail_service_service on meta.app_mail_service (service_id);
comment on column meta.app_mail_service.is_default is 'The application''s default mail service (191): mail whose From address no other linked service may send as goes through it';

-- Before insert or update: the first link of an application is its default; a new default takes over;
-- a service of another workspace is refused.
create function meta.app_mail_service_before() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_ws int;
begin
  if tg_op = 'INSERT' or new.service_id <> old.service_id or new.app_id <> old.app_id then
    select s.workspace_id into v_ws from meta.mail_service s where s.id = new.service_id;
    if v_ws is not null and v_ws is distinct from meta.app_workspace(new.app_id) then
      raise exception 'mail service % belongs to another workspace', new.service_id using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' and not new.is_default
     and not exists (select 1 from meta.app_mail_service where app_id = new.app_id and is_default) then
    new.is_default := true;
  end if;
  if new.is_default and (tg_op = 'INSERT' or not old.is_default) then
    update meta.app_mail_service set is_default = false
     where app_id = new.app_id and is_default and service_id <> new.service_id;
  end if;
  return new;
end
$$;
create trigger app_mail_service_before before insert or update on meta.app_mail_service
  for each row execute function meta.app_mail_service_before();

-- After delete: when the default went, another link (the lowest service id) becomes the default.
create function meta.app_mail_service_after_delete() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
begin
  if old.is_default and not exists (select 1 from meta.app_mail_service where app_id = old.app_id and is_default) then
    update meta.app_mail_service set is_default = true
     where app_id = old.app_id
       and service_id = (select min(service_id) from meta.app_mail_service where app_id = old.app_id);
  end if;
  return null;
end
$$;
create trigger app_mail_service_after_delete after delete on meta.app_mail_service
  for each row execute function meta.app_mail_service_after_delete();

-- (126) the default service: the default link (an installation service, or the application's workspace's own),
-- else, for an application without links, its workspace's own service. Null: none.
create or replace function meta.mail_service_for_app(p_app_id int) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce(
    (select x.service_id from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id
      where x.app_id = p_app_id and (s.workspace_id is null or s.workspace_id = meta.app_workspace(p_app_id))
      order by x.is_default desc, x.service_id limit 1),
    case when not exists (select 1 from meta.app_mail_service x where x.app_id = p_app_id)
         then (select s.id from meta.mail_service s where s.workspace_id = meta.app_workspace(p_app_id)) end)
$$;
revoke all on function meta.mail_service_for_app(int) from public;

-- The service for a mail from p_from: the linked, enabled service that may send as it (the default first), else the default.
create function meta.mail_service_for_app(p_app_id int, p_from text) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce(
    (select x.service_id from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id
      where x.app_id = p_app_id and p_from is not null and s.enabled
        and (s.workspace_id is null or s.workspace_id = meta.app_workspace(p_app_id))
        and meta.mail_sender_allowed(s.senders, p_from)
      order by x.is_default desc, x.service_id limit 1),
    meta.mail_service_for_app(p_app_id))
$$;
revoke all on function meta.mail_service_for_app(int, text) from public;

-- The service a queued mail goes through: the one chosen when it was queued while that is still one of the
-- application's services, else the one for its From address now.
create function meta.mail_service_for_mail(p_app_id int, p_service_id int, p_from text) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select case
    when p_service_id is not null and (
           exists (select 1 from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id
                    where x.app_id = p_app_id and x.service_id = p_service_id
                      and (s.workspace_id is null or s.workspace_id = meta.app_workspace(p_app_id)))
           or p_service_id = meta.mail_service_for_app(p_app_id))
      then p_service_id
    else meta.mail_service_for_app(p_app_id, p_from) end
$$;
revoke all on function meta.mail_service_for_mail(int, int, text) from public;

alter table meta.mail_queue add column service_id int references meta.mail_service on delete set null;
comment on column meta.mail_queue.service_id is 'The mail service chosen when the mail was queued (191)';
-- the mail of the last day counts against the limit of the service it went through (until now: the only one)
update meta.mail_queue q set service_id = x.service_id
  from meta.app_mail_service x where x.app_id = q.app_id and q.created_at > now() - interval '2 days';
create index mail_queue_app_service on meta.mail_queue (app_id, service_id, created_at);

-- (126) the calling application and the service for a From address (null: the default)
create function meta.mail_caller(p_from text, out app_id int, out service_id int, out from_address text, out max_per_day int, out senders text[])
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_role text;
  v_from text := nullif(btrim(p_from), '');
begin
  app_id := meta.app_id();
  if app_id is null then
    raise exception 'meta.send_mail: no current application (call it from application code)';
  end if;
  select a.db_role into v_role from meta.app a where a.id = app_id;
  if not found then
    raise exception 'meta.send_mail: no current application (call it from application code)';
  end if;
  if v_role is not null and current_setting('role') is distinct from v_role then
    raise exception 'meta.send_mail: called outside the application''s own database role';
  end if;
  select s.id, coalesce(x.from_address, nullif(s.settings->>'default_from', '')), x.max_per_day, s.senders
    into service_id, from_address, max_per_day, senders
    from meta.mail_service s left join meta.app_mail_service x on x.app_id = mail_caller.app_id and x.service_id = s.id
   where s.id = case when v_from is null then meta.mail_service_for_app(mail_caller.app_id)
                     else meta.mail_service_for_app(mail_caller.app_id, v_from) end
     and s.enabled;
  if not found then
    raise exception 'meta.send_mail: this application may not send e-mail (an administrator chooses its mail service under Workspace utilities → Mail services, or the workspace''s administrators set up the workspace''s own)';
  end if;
end
$$;
revoke all on function meta.mail_caller(text) from public;

create or replace function meta.mail_caller(out app_id int, out service_id int, out from_address text, out max_per_day int, out senders text[])
language sql stable security definer set search_path = meta, pg_catalog as $$
  select * from meta.mail_caller(null::text)
$$;
revoke all on function meta.mail_caller() from public;

-- (081) queue one mail: through the service for its From address
create or replace function meta.mail_enqueue(p_to text, p_subject text, p_body text, p_body_html text, p_from text, p_cc text, p_bcc text, p_reply_to text, p_template text)
returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  c        record;
  v_to     text[] := meta.mail_addresses(p_to, 'to');
  v_cc     text[] := meta.mail_addresses(p_cc, 'cc');
  v_bcc    text[] := meta.mail_addresses(p_bcc, 'bcc');
  v_reply  text[] := meta.mail_addresses(p_reply_to, 'reply to');
  v_from   text[];
  v_count  int;
  v_id     bigint;
begin
  select * into c from meta.mail_caller(p_from);
  if cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) = 0 then
    raise exception 'meta.send_mail: no recipient';
  end if;
  if cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) > 50 then
    raise exception 'meta.send_mail: at most 50 recipients per mail (to, cc and bcc together)';
  end if;
  if cardinality(v_reply) > 1 then
    raise exception 'meta.send_mail: one reply-to address';
  end if;
  if p_subject is null or length(p_subject) not between 1 and 998 or p_subject ~ '[\r\n]' then
    raise exception 'meta.send_mail: the subject is required, on one line (at most 998 characters)';
  end if;
  if p_body is null and p_body_html is null then
    raise exception 'meta.send_mail: a plain text or HTML body is required';
  end if;
  if coalesce(octet_length(p_body), 0) > 1048576 or coalesce(octet_length(p_body_html), 0) > 1048576 then
    raise exception 'meta.send_mail: each body is at most 1 MB';
  end if;
  v_from := meta.mail_addresses(coalesce(nullif(btrim(p_from), ''), c.from_address), 'from');
  if cardinality(v_from) <> 1 then
    raise exception 'meta.send_mail: no From address (give one, or an administrator sets the application''s)';
  end if;
  if not meta.mail_sender_allowed(c.senders, v_from[1]) then
    raise exception 'meta.send_mail: the mail service may not send as % (nor may another mail service of this application; an administrator sets their allowed senders)', v_from[1];
  end if;
  if c.max_per_day is not null then
    select count(*) into v_count from meta.mail_queue
     where app_id = c.app_id and service_id = c.service_id
       and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' and status <> 'cancelled';
    if v_count >= c.max_per_day then
      raise exception 'meta.send_mail: this application''s limit of % mails per day is reached', c.max_per_day;
    end if;
  end if;
  insert into meta.mail_queue (app_id, username, from_address, reply_to, to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html, template, service_id)
  values (c.app_id, nullif(current_setting('pgkiln.app_user', true), ''), v_from[1], v_reply[1], v_to, v_cc, v_bcc, p_subject, p_body, p_body_html, p_template, c.service_id)
  returning id into v_id;
  perform pg_notify('pgkiln_mail', v_id::text);
  return v_id;
end
$$;
revoke all on function meta.mail_enqueue(text, text, text, text, text, text, text, text, text) from public;

-- (087, renamed in 090) "Forgot password?": through the default service
create or replace function meta.password_reset_available_unchecked(p_app_id int) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select exists (
    select 1
      from meta.app a
      join meta.app_mail_service ams on ams.app_id = a.id and ams.is_default
      join meta.mail_service s on s.id = ams.service_id
     where a.id = p_app_id and a.password_reset and a.authentication = 'app_users' and a.local_login
       and s.enabled and nullif(btrim(ams.from_address), '') is not null)
$$;

create or replace function meta.request_password_reset_unchecked(p_app_id int, p_login text, p_token_hash text, p_ip text,
                                                                  p_subject text, p_body text, p_body_html text) returns void
language plpgsql volatile security definer set search_path = meta, public, pg_catalog as $$
declare
  v_acc   meta.account;
  v_n     int;
  v_from  text;
  v_send  text[];
  v_max   int;
  v_svc   int;
  v_vals  jsonb;
  v_id    bigint;
begin
  if not meta.password_reset_available_unchecked(p_app_id) or p_token_hash !~ '^[0-9a-f]{64}$' or btrim(coalesce(p_login, '')) = '' then
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
  select ams.from_address, s.senders, ams.max_per_day, s.id into v_from, v_send, v_max, v_svc
    from meta.app_mail_service ams join meta.mail_service s on s.id = ams.service_id
   where ams.app_id = p_app_id and ams.is_default;
  if not meta.mail_sender_allowed(v_send, v_from) then
    raise warning 'password reset for app %: the mail service may not send as %', p_app_id, v_from;
    return;
  end if;
  if v_max is not null and (select count(*) from meta.mail_queue
                             where app_id = p_app_id and service_id = v_svc
                               and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
                               and status <> 'cancelled') >= v_max then
    raise warning 'password reset for app %: the daily mail limit is reached', p_app_id;
    return;
  end if;
  delete from meta.password_reset where created_at < now() - interval '7 days';
  insert into meta.password_reset (app_id, account_id, token_hash, ip) values (p_app_id, v_acc.id, p_token_hash, left(p_ip, 100));
  v_vals := jsonb_build_object('USER', v_acc.username);
  insert into meta.mail_queue (app_id, username, from_address, to_addresses, subject, body_text, body_html, template, service_id)
  values (p_app_id, v_acc.username, v_from, array[v_acc.email], left(replace(replace(meta.mail_fill(p_subject, v_vals, false), E'\r', ''), E'\n', ' '), 998),
          meta.mail_fill(p_body, v_vals, false), meta.mail_fill(p_body_html, v_vals, true), 'PASSWORD_RESET', v_svc)
  returning id into v_id;
  perform pg_notify('pgkiln_mail', v_id::text);
end
$$;
