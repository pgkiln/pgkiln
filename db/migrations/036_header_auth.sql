-- HTTP-header authentication (APEX: HTTP Header Variable). An app behind a
-- reverse proxy or single sign-on gateway trusts a request header with the
-- user name (for example X-Remote-User), but only from the proxy addresses in
-- PGKILN_AUTH_HEADER_PROXIES; the session is bound to the header value.
-- The new columns are nullable so exports from older versions still import.

alter table meta.app drop constraint app_authentication_check;
alter table meta.app add constraint app_authentication_check check (authentication in ('none', 'app_users', 'header'));

alter table meta.app add column header_name text check (header_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$');
alter table meta.app add column header_auto_create boolean default false;
alter table meta.app add column logout_url text check (logout_url ~ '^(https?://|/)' and logout_url !~ '^//' and length(logout_url) <= 2000);

comment on column meta.app.header_name is 'header authentication: the request header with the user name (NULL = X-Remote-User)';
comment on column meta.app.header_auto_create is 'header authentication: create unknown accounts (with access to this app)';
comment on column meta.app.logout_url is 'header authentication: where "Sign out" goes after the session ends (the proxy''s sign-out page)';
