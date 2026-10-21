-- ---------------------------------------------------------------------
-- 128: two-factor sign-in for developers (sprint 126, SEC-2 and SEC-6;
-- beyond APEX, which has no built-in second factor for the builder).
--
-- meta.developer_factor: a developer's second factors. This sprint: an
-- authenticator app (TOTP, RFC 6238), its secret encrypted with the
-- instance key (PGKILN_SECRET_KEY, like web credentials). last_step is the
-- last 30-second step a code was accepted for, so a code works only once.
--
-- meta.developer_recovery_code: ten one-time codes per developer, stored
-- as SHA-256 of the code (the codes are random, 50 bits each), so they keep
-- working when the instance key is lost. confirmed: the developer said they
-- saved them; until then the codes don't count as a factor.
--
-- The policy (meta.setting): mfa_required = off | admins | all,
-- mfa_required_since (when it was turned on) and mfa_grace_days (default 7):
-- developers without a factor must enrol within the grace period.
--
-- Owner-only, like meta.developer: the runtime role never reads them.
-- Installation data: not exported with an application or a workspace.
-- ---------------------------------------------------------------------
create table meta.developer_factor (
  id           int generated always as identity primary key,
  username     text not null references meta.developer on update cascade on delete cascade,
  kind         text not null check (kind in ('totp')),
  name         text not null check (length(name) between 1 and 60),
  secret_enc   text not null,
  last_step    bigint,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index on meta.developer_factor (username);
comment on table meta.developer_factor is
  'A developer''s second factors (128): authenticator apps (TOTP) with the secret encrypted with the instance key.';

create table meta.developer_recovery_code (
  username   text not null references meta.developer on update cascade on delete cascade,
  code_hash  text not null,
  confirmed  boolean not null default false,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  primary key (username, code_hash)
);
comment on table meta.developer_recovery_code is
  'One-time recovery codes of developers (128), as sha256 hex of the normalised code.';

insert into meta.setting (name, value) values ('mfa_required', 'off'), ('mfa_grace_days', '7')
on conflict (name) do nothing;
