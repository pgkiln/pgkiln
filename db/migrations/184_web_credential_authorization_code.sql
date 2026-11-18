-- Sprint 222 (parity: REST data sources, "Missing: the OAuth2 authorization code flow (consent in the browser)"):
-- a web credential of grant type authorization_code. A developer clicks Authorize in the builder, signs in at the
-- service and gives consent; the service sends the browser back to pgkiln with a code, which pgkiln exchanges (with
-- PKCE) for an access token and a refresh token. The refresh token is kept encrypted (refresh_token_enc, as for the
-- refresh_token grant) and renewed as the service rotates it; every call of the application then uses it.
--
--   authorize_url   the service's authorization endpoint (its own query parameters, e.g. access_type=offline, kept)
--
-- meta.web_credential_pending: authorizations in flight (state, PKCE verifier, the developer and builder session that
-- started it); one-time and ten minutes, deleted when used. Builder only, like meta.sso_pending.

alter table meta.web_credential drop constraint web_credential_grant_type_check,
  add constraint web_credential_grant_type_check check (grant_type in ('client_credentials', 'password', 'refresh_token', 'authorization_code')),
  add column authorize_url text check (length(authorize_url) <= 2000 and authorize_url ~ '^https?://');
alter table meta.workspace_credential drop constraint workspace_credential_grant_type_check,
  add constraint workspace_credential_grant_type_check check (grant_type in ('client_credentials', 'password', 'refresh_token', 'authorization_code')),
  add column authorize_url text check (length(authorize_url) <= 2000 and authorize_url ~ '^https?://');

comment on column meta.web_credential.authorize_url is
  'oauth2 authorization_code (184): the authorization endpoint where a developer gives consent in the browser';
comment on column meta.workspace_credential.authorize_url is
  'oauth2 authorization_code (184): the authorization endpoint where a developer gives consent in the browser';

create table meta.web_credential_pending (
  -- sha256 of the state sent to the service
  state_hash     text primary key,
  -- an application's credential (app_id set) or a workspace's (workspace = true)
  app_id         int references meta.app on delete cascade,
  workspace      boolean not null default false,
  credential_id  bigint not null,
  username       text not null,
  -- sha256 of the builder session that started it: the callback must come back to the same session
  session_hash   text not null,
  code_verifier  text not null,
  created_at     timestamptz not null default now(),
  check ((app_id is null) = workspace)
);
create index on meta.web_credential_pending (created_at);
revoke all on meta.web_credential_pending from public;
alter table meta.web_credential_pending enable row level security;
create policy meta_owner_only on meta.web_credential_pending using ((select meta.meta_owner_member())) with check ((select meta.meta_owner_member()));
comment on table meta.web_credential_pending is
  'Authorization code flows of web credentials in flight (184): one-time state, PKCE verifier, ten minutes; builder only';
