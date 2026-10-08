-- =====================================================================
-- 075: fixes from the security review of 2026-10-08
--
-- 1. Single sign-on no longer links an existing account to a new identity
--    just because the username (or e-mail) claim matches: a provider must
--    allow it (link_existing). Otherwise anyone who can choose that claim at
--    the identity provider (self-registration, an editable preferred_username,
--    a multi-tenant provider) could take over a local account of the same
--    name. Providers that exist before this migration keep linking, so
--    sign-in keeps working after an upgrade: review them in the builder
--    (Users → Identity providers) and turn it off once accounts are linked.
--
-- 2. The checksum of item values in URLs (meta.url_checksum, and
--    urlChecksum() in src/security.ts) joined names and values as k=v&k=v,
--    so the value "1&P3_OTHER=2" signed the same text as two items. Each
--    name and value now carries its length in bytes, and the text starts
--    with a version, so old checksums no longer validate (links made before
--    the upgrade, e.g. in a bookmark or a notification, ask for a new one).
-- =====================================================================

alter table meta.auth_provider add column link_existing boolean not null default false;
comment on column meta.auth_provider.link_existing is
  'link an existing account with the same username to an identity of this provider on its first sign-in (trust the username claim)';
update meta.auth_provider set link_existing = true;

create or replace function meta.url_checksum(p_app_id int, p_page int, p_user text, p_items jsonb) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select substr(encode(public.hmac(
           format('v2:%s:%s:%s:%s', p_app_id, p_page, lower(p_user),
             coalesce((select string_agg(octet_length(upper(key)) || ':' || upper(key) || '='
                                         || octet_length(coalesce(value #>> '{}', '')) || ':' || coalesce(value #>> '{}', ''),
                                         '&' order by upper(key) collate "C")
                         from jsonb_each(p_items)), '')),
           (select value from meta.instance_setting where name = 'url_secret'), 'sha256'), 'hex'), 1, 32)
$$;
revoke all on function meta.url_checksum(int, int, text, jsonb) from public;
