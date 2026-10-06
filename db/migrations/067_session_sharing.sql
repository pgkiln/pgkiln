-- =====================================================================
-- 067: session sharing between applications (APEX: session sharing of an
-- authentication scheme)
--
-- Applications with the same session_group (and the user directory as
-- authentication) share a sign-in: after signing in to one, opening another
-- signs the user in silently, with that application's own access check and
-- roles. A group cookie (path /) holds a random token; meta.shared_login
-- keeps its sha256, the account, the identity provider's groups (for
-- group-mapped roles) and the sign-in method. It ends after the session idle
-- time without use, after the maximum session length, or when the user signs
-- out of any application of the group (which also ends the group's sessions
-- that came from it). The group name is part of the application's
-- definition (exported); shared sign-ins are installation data.
-- =====================================================================

alter table meta.app add column session_group text check (session_group ~ '^[a-z][a-z0-9_]{0,29}$');

create table meta.shared_login (
  token_hash    text primary key,
  session_group text not null,
  account_id    int not null references meta.account (id) on delete cascade,
  groups        text[] not null default '{}',
  method        text not null default 'password',
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);
create index shared_login_account_idx on meta.shared_login (account_id);
revoke all on meta.shared_login from public;

comment on column meta.app.session_group is 'Session sharing: applications with the same group share a sign-in (user directory authentication only)';
comment on table meta.shared_login is 'Shared sign-ins of session sharing groups (067): sha256 of the group cookie''s token. Installation data.';
