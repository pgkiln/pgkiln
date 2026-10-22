-- ---------------------------------------------------------------------
-- 131: signing in to the builder through an identity provider, with a
-- break-glass administrator (sprint 129, SEC-1; APEX: the workspace's
-- authentication scheme).
--
-- meta.auth_provider / meta.ldap_directory.builder: the provider (OpenID
-- Connect, SAML) or directory also signs developers in to the builder.
--   builder_auto_create: a person without a developer account gets one on
--     the first sign-in, when builder_group is empty or one of their groups;
--   builder_link_existing: a developer with the same username is linked on
--     the first sign-in (never a break-glass developer); otherwise developers
--     link the identity themselves on the Security page;
--   builder_admin_group: members are instance administrators (checked on
--     every sign-in; break-glass developers are never demoted).
-- meta.developer_identity: the identities linked to a developer, by the
-- provider's or directory's stable subject (as meta.account_identity and
-- meta.ldap_identity for application accounts).
-- meta.developer.break_glass: may still sign in with the pgkiln password
-- (and passkey) where a workspace requires single sign-on; for when the
-- identity provider is down or misconfigured.
-- meta.workspace.sso_only: the workspace's developers must sign in through
-- an identity provider or directory (break-glass developers excepted).
-- `pgkiln admin builder-sign-in password` clears it everywhere.
-- meta.sso_pending.app_id null: a sign-in to the builder; link_username: the
-- signed-in developer who links an identity from the Security page.
-- ---------------------------------------------------------------------
alter table meta.auth_provider
  add column builder boolean not null default false,
  add column builder_auto_create boolean not null default false,
  add column builder_link_existing boolean not null default false,
  add column builder_group text check (length(builder_group) between 1 and 200),
  add column builder_admin_group text check (length(builder_admin_group) between 1 and 200);

alter table meta.ldap_directory
  add column builder boolean not null default false,
  add column builder_auto_create boolean not null default false,
  add column builder_link_existing boolean not null default false,
  add column builder_group text check (length(builder_group) between 1 and 200),
  add column builder_admin_group text check (length(builder_admin_group) between 1 and 200);

comment on column meta.auth_provider.builder is 'Developers can sign in to the builder with this provider (131).';
comment on column meta.ldap_directory.builder is 'Developers can sign in to the builder with this directory (131).';

create table meta.developer_identity (
  id           serial primary key,
  provider_id  integer references meta.auth_provider (id) on delete cascade,
  directory_id integer references meta.ldap_directory (id) on delete cascade,
  subject      text not null check (length(subject) between 1 and 500),
  username     text not null references meta.developer (username) on update cascade on delete cascade,
  linked_at    timestamptz not null default now(),
  check ((provider_id is null) <> (directory_id is null))
);
create unique index developer_identity_provider_subject on meta.developer_identity (provider_id, subject) where provider_id is not null;
create unique index developer_identity_directory_subject on meta.developer_identity (directory_id, subject) where directory_id is not null;
create unique index developer_identity_provider_user on meta.developer_identity (provider_id, username) where provider_id is not null;
create unique index developer_identity_directory_user on meta.developer_identity (directory_id, username) where directory_id is not null;
create index developer_identity_username on meta.developer_identity (username);

comment on table meta.developer_identity is 'Identities at providers or directories linked to a developer, by stable subject (131).';

alter table meta.developer add column break_glass boolean not null default false;
comment on column meta.developer.break_glass is 'May sign in with the pgkiln password where a workspace requires single sign-on (131).';

alter table meta.workspace add column sso_only boolean not null default false;
comment on column meta.workspace.sso_only is 'Developers of this workspace must sign in through an identity provider or directory (131).';

alter table meta.sso_pending alter column app_id drop not null;
alter table meta.sso_pending add column link_username text references meta.developer (username) on update cascade on delete cascade;
comment on column meta.sso_pending.app_id is 'The application signed in to; null: the builder (131).';
