-- "Remember me" (APEX: persistent authentication). An application can let
-- users stay signed in for a number of days: the sign-in page offers a
-- checkbox, and a long-lived cookie holds a random token whose sha256 is
-- stored here. When the session has ended, the token starts a new one and
-- is replaced by a fresh token (rotation). Only the owner reads this table
-- (Node, owner pool); the runtime role has no access.

alter table meta.app add column remember_me_days int check (remember_me_days between 1 and 365);
comment on column meta.app.remember_me_days is 'Days a "Remember me" sign-in lasts; NULL = no Remember me checkbox';

create table meta.persistent_login (
  id           bigserial primary key,
  app_id       int  not null references meta.app on delete cascade,
  account_id   int  not null references meta.account on delete cascade,
  token_hash   text not null unique,
  -- identity-provider groups of the original sign-in (mapped to roles again on each use)
  groups       text[] not null default '{}',
  method       text not null default 'password',
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz not null
);
create index on meta.persistent_login (account_id);
revoke all on meta.persistent_login from public;

-- A new password, a deactivated account or removed access ends every remembered sign-in.
create function meta.persistent_login_revoke_account() returns trigger
language plpgsql security definer set search_path = meta, pg_temp as $$
begin
  delete from persistent_login where account_id = new.id;
  return new;
end $$;

create trigger persistent_login_revoke
  after update of password_hash, active on meta.account
  for each row
  when (new.password_hash is distinct from old.password_hash or (old.active and not new.active))
  execute function meta.persistent_login_revoke_account();

create function meta.persistent_login_revoke_access() returns trigger
language plpgsql security definer set search_path = meta, pg_temp as $$
begin
  delete from persistent_login where account_id = old.account_id and app_id = old.app_id;
  return old;
end $$;

create trigger persistent_login_revoke
  after delete on meta.app_access
  for each row execute function meta.persistent_login_revoke_access();
