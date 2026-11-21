-- =====================================================================
-- 206: redirect all mail of an application, and absolute URLs
-- (sprint 250, MG-24 and MG-25)
--
-- MG-24. meta.app.mail_redirect_to: one e-mail address. When it is set,
-- the server sends every mail of the application (meta.send_mail and the
-- other functions, Send e-mail processes, workflows, task events,
-- automations, sign-in codes) only to that address, whatever mail
-- service it goes through: the subject starts with [TEST], the original
-- To, Cc and Bcc go in the headers X-Original-To/-Cc/-Bcc and in a line at
-- the top of the body (src/mail/redirect.ts). The environment variable
-- MAIL_REDIRECT_TO does the same for every mail of the installation and
-- wins over the application's setting. The redirect is applied when the
-- server sends, not when the mail is queued: the queue keeps the original
-- recipients, and meta.mail_queue.redirected_to records where each mail
-- went (Activity → Mail shows it). An ordinary column of meta.app:
-- exported and imported with the application.
--
-- MG-25. meta.page_url(…, p_absolute => true) and meta.app_url() start
-- with the installation's public address: meta.public_url(), the value
-- the server records at start-up from PUBLIC_URL (src/public-url.ts; its
-- fallback http://127.0.0.1:<PORT> when PUBLIC_URL is not set), in
-- meta.instance_setting 'public_url'. Never the request's Host header, and
-- not a setting application code could change. An error when no server
-- has recorded it (pg_cron before the first start).
-- =====================================================================

alter table meta.app add column mail_redirect_to text
  check (mail_redirect_to is null or (length(mail_redirect_to) <= 254 and mail_redirect_to ~ '^[^\s@,;<>"()\[\]]+@[^\s@,;<>"()\[\]]+\.[^\s@,;<>"()\[\]]+$'));
comment on column meta.app.mail_redirect_to is
  'mail (206): when set, every mail of the application goes only to this address ([TEST] subject, X-Original-To/-Cc/-Bcc); MAIL_REDIRECT_TO wins over it';

alter table meta.mail_queue add column redirected_to text;
comment on column meta.mail_queue.redirected_to is
  'mail (206): the address the mail was sent to instead of its recipients (MAIL_REDIRECT_TO or the application''s mail_redirect_to), at its last attempt';

-- the installation's public address, as the server recorded it (no trailing slash)
create function meta.public_url() returns text
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v text := (select value from meta.instance_setting where name = 'public_url');
begin
  if v is null or v !~ '^https?://[^\s/?#]+(/[^\s?#]*)?$' then
    raise exception 'The public address of pgkiln is not known here: set PUBLIC_URL (e.g. https://apps.example.com) and start the server, which records it.'
      using errcode = '55000';
  end if;
  return rtrim(v, '/');
end
$$;
revoke all on function meta.public_url() from public;
grant execute on function meta.public_url() to public;

drop function meta.page_url(int, jsonb, boolean);

-- Link to a page of the current application, setting items (with checksum),
-- e.g. in a report: select '<a href="' || meta.page_url(3, jsonb_build_object('P3_ID', id)) || '">'
-- (206) p_absolute: with the public address in front, for links in mail
create function meta.page_url(p_page int, p_items jsonb default '{}', p_clear boolean default true, p_absolute boolean default false) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select case when p_absolute then meta.public_url() else '' end
      || format('/a/%s/%s', a.alias, p_page)
      || case when p_items = '{}'::jsonb and not p_clear then '' else '?' end
      || concat_ws('&',
           case when p_clear then 'clear=1' end,
           (select string_agg(upper(key) || '=' || meta.url_encode(coalesce(value #>> '{}', '')), '&' order by upper(key) collate "C")
              from jsonb_each(p_items)),
           case when p_items <> '{}'::jsonb
                then 'cs=' || meta.url_checksum(a.id, p_page, meta.app_user(), p_items) end)
    from meta.app a
   where a.id = meta.app_id()
$$;
revoke all on function meta.page_url(int, jsonb, boolean, boolean) from public;
grant execute on function meta.page_url(int, jsonb, boolean, boolean) to public;

-- (206) the current application's address: its home page (absolute by default)
create function meta.app_url(p_absolute boolean default true) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select case when p_absolute then meta.public_url() else '' end || format('/a/%s', a.alias)
    from meta.app a
   where a.id = meta.app_id()
$$;
revoke all on function meta.app_url(boolean) from public;
grant execute on function meta.app_url(boolean) to public;
