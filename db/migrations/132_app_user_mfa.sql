-- ---------------------------------------------------------------------
-- 132: two-step sign-in for application users (sprint 130, SEC-3 part 1;
-- beyond APEX, which has no second factor for application accounts).
--
-- meta.account_factor: an account's second factors. This sprint: an
-- authenticator app (TOTP, RFC 6238), its secret encrypted with the
-- instance key (PGKILN_SECRET_KEY), like a developer's (128). last_step is
-- the last 30-second step a code was accepted for, so a code works once.
-- An account's factors serve every application it may use.
--
-- meta.account_recovery_code: ten one-time codes per account, as SHA-256
-- of the normalised code; confirmed: the user said they saved them.
--
-- meta.app.mfa, per application (exported with it):
--   off      : no second step (the default)
--   optional : users who added an authenticator app give a code
--   required : every user gives a code; without an app, they add one while
--              signing in
--   roles    : required for users with one of mfa_roles, optional for others
-- It covers the user directory's passwords and LDAP directories; an identity
-- provider (OpenID Connect, SAML) decides on its own second factor.
--
-- Owner-only, like meta.persistent_login: the runtime roles never read them.
-- Installation data: not exported with an application or a workspace.
-- ---------------------------------------------------------------------
create table meta.account_factor (
  id           int generated always as identity primary key,
  account_id   int not null references meta.account on delete cascade,
  kind         text not null check (kind in ('totp')),
  name         text not null check (length(name) between 1 and 60),
  secret_enc   text not null,
  last_step    bigint,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index on meta.account_factor (account_id);
revoke all on meta.account_factor from public;
comment on table meta.account_factor is
  'An application account''s second factors (132): authenticator apps (TOTP) with the secret encrypted with the instance key.';

create table meta.account_recovery_code (
  account_id int not null references meta.account on delete cascade,
  code_hash  text not null,
  confirmed  boolean not null default false,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  primary key (account_id, code_hash)
);
revoke all on meta.account_recovery_code from public;
comment on table meta.account_recovery_code is
  'One-time recovery codes of application accounts (132), as sha256 hex of the normalised code.';

alter table meta.app
  add column mfa text not null default 'off' check (mfa in ('off', 'optional', 'required', 'roles')),
  add column mfa_roles text[] not null default '{}';
comment on column meta.app.mfa is
  'Two-step sign-in for the application''s users (132): off, optional, required, or roles (required for mfa_roles).';
comment on column meta.app.mfa_roles is 'Roles (lower case) that must use two-step sign-in when mfa = roles.';
