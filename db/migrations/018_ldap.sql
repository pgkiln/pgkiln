-- LDAP directories (APEX: LDAP Directory authentication). An application's
-- password form can check passwords against one or more directories as well
-- as against local accounts. pgkiln searches the user (as a service account,
-- or anonymously), binds as that user with the password given, and reads the
-- user's groups, which map to roles like single sign-on groups
-- (meta.app_group_role). Only the owner reads this table (bind passwords).

create table meta.ldap_directory (
  id                      serial primary key,
  name                    text not null unique check (name ~ '^[a-z][a-z0-9_-]{0,39}$'),
  display_name            text not null,
  url                     text not null check (url ~ '^ldaps?://'),
  start_tls               boolean not null default false,
  tls_verify              boolean not null default true,
  -- the service account for the user search; NULL = anonymous search
  bind_dn                 text,
  bind_password           text,
  user_base               text not null,
  -- {username} is replaced by the escaped username (RFC 4515)
  user_filter             text not null default '(uid={username})' check (user_filter like '%{username}%'),
  username_attribute      text not null default 'uid',
  display_name_attribute  text default 'cn',
  email_attribute         text default 'mail',
  -- groups: an attribute of the user (memberOf: group DNs, their first value is the name) …
  group_attribute         text default 'memberOf',
  -- … and/or a search: {dn} is the user's escaped DN, the group name is group_name_attribute
  group_base              text,
  group_filter            text default '(|(member={dn})(uniqueMember={dn}))',
  group_name_attribute    text not null default 'cn',
  auto_create             boolean not null default false,
  enabled                 boolean not null default true,
  created_at              timestamptz not null default now()
);
revoke all on meta.ldap_directory from public;

-- which account a directory entry belongs to (by entryUUID, or the DN when the server has none)
create table meta.ldap_identity (
  directory_id int  not null references meta.ldap_directory on delete cascade,
  subject      text not null,
  account_id   int  not null references meta.account on delete cascade,
  linked_at    timestamptz not null default now(),
  primary key (directory_id, subject),
  unique (account_id, directory_id)
);
revoke all on meta.ldap_identity from public;

alter table meta.app add column ldap_directories text[] not null default '{}';
comment on column meta.app.ldap_directories is 'LDAP directories the password form checks (names in meta.ldap_directory), after local accounts';
