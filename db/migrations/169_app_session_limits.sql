-- =====================================================================
-- 169: session limits, deep linking and expiring bookmarks per
--      application (sprint 189, NX-S5)
--
-- APEX: Security Attributes → Session Management (Maximum Session Length,
-- Maximum Session Idle Time, Session Timeout URL), Deep Linking, and
-- Session State Protection → Expire Bookmarks. Until now the idle time
-- and the maximum length were the instance's only.
--
--   session_idle_minutes  1–1440, null: the instance's. Never longer than
--   session_max_hours     1–720,  null: the instance's.  the instance's.
--   session_timeout_page  a page of the application without sign-in that
--                         opens when a request comes with a session that
--                         has ended (null: the sign-in page, as before)
--   deep_linking          false: after signing in, always the home page,
--                         never the address the user asked for
--   url_epoch             raised by Expire bookmarks: part of every URL
--                         checksum of the application, so links made
--                         before fail (0: the checksums of before 169)
--   bookmarks_expired_at  when Expire bookmarks was last pressed
--
-- meta.url_checksum takes url_epoch into account, as urlChecksum() in
-- src/security.ts does. Exports carry the columns; an export made before
-- 169 imports with the defaults (trigger below, see 054).
-- =====================================================================

alter table meta.app
  add column session_idle_minutes int check (session_idle_minutes between 1 and 1440),
  add column session_max_hours int check (session_max_hours between 1 and 720),
  add column session_timeout_page int check (session_timeout_page > 0),
  add column deep_linking boolean not null default true,
  add column url_epoch int not null default 0 check (url_epoch >= 0),
  add column bookmarks_expired_at timestamptz;
comment on column meta.app.session_idle_minutes is 'Idle time of a session in minutes (169); null: the instance''s; never more than the instance''s';
comment on column meta.app.session_max_hours is 'Maximum session length in hours (169); null: the instance''s; never more than the instance''s';
comment on column meta.app.session_timeout_page is 'A page without sign-in shown when a session has ended (169); null: the sign-in page';
comment on column meta.app.deep_linking is 'Deep linking (169): false sends every sign-in to the home page';
comment on column meta.app.url_epoch is 'Raised by Expire bookmarks (169): part of the application''s URL checksums';
comment on column meta.app.bookmarks_expired_at is 'When Expire bookmarks was last used (169)';

create function meta.app_session_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.deep_linking := coalesce(new.deep_linking, true);
  new.url_epoch := coalesce(new.url_epoch, 0);
  return new;
end $$;
create trigger app_session_defaults before insert or update on meta.app
  for each row execute function meta.app_session_defaults();

create or replace function meta.url_checksum(p_app_id int, p_page int, p_user text, p_items jsonb) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select substr(encode(public.hmac(
           format('v2:%s%s:%s:%s:%s', p_app_id,
             coalesce((select '.' || a.url_epoch from meta.app a where a.id = p_app_id and a.url_epoch > 0), ''),
             p_page, lower(p_user),
             coalesce((select string_agg(octet_length(upper(key)) || ':' || upper(key) || '='
                                         || octet_length(coalesce(value #>> '{}', '')) || ':' || coalesce(value #>> '{}', ''),
                                         '&' order by upper(key) collate "C")
                         from jsonb_each(p_items)), '')),
           (select value from meta.instance_setting where name = 'url_secret'), 'sha256'), 'hex'), 1, 32)
$$;
revoke all on function meta.url_checksum(int, int, text, jsonb) from public;
