-- Sprint 223 (parity: Workspace preferences, "Missing: the account login controls"): APEX's Account Login Control
-- per workspace. A workspace's administrators can make the installation's rules stricter for the applications of
-- their workspace; never looser. Null: the installation's rule.
--
--   login_max_failures      failed sign-ins of one user name (within the installation's window) before an application
--                           of the workspace refuses it (APEX: Maximum Login Failures Allowed); the lower of this and
--                           the installation's LOGIN_MAX_FAILURES_PER_USER applies
--   password_lifetime_days  days after which an account must change its password when it signs in to an application
--                           of the workspace (APEX: End User Account Lifetime); the shorter of this and the
--                           installation's password_lifetime_days applies (0 there: this one)
--   password_min_length     the shortest new password an application of the workspace accepts; the longer of this
--                           and the installation's password_min_length applies
--
-- Accounts are the installation's: an account that signs in to applications of two workspaces meets each one's rules.

alter table meta.workspace
  add column login_max_failures int check (login_max_failures between 1 and 1000),
  add column password_lifetime_days int check (password_lifetime_days between 1 and 3650),
  add column password_min_length int check (password_min_length between 6 and 128);

comment on column meta.workspace.login_max_failures is
  'Account login control (185): failed sign-ins per user before the workspace''s applications refuse it (null: the installation''s)';
comment on column meta.workspace.password_lifetime_days is
  'Account login control (185): password lifetime in days for the workspace''s applications (null: the installation''s)';
comment on column meta.workspace.password_min_length is
  'Account login control (185): minimum new password length in the workspace''s applications (null: the installation''s)';

-- Days until the password of an account expires for an application (NULL: never): the stricter lifetime of the
-- installation and the application's workspace.
create function meta.password_days_left(p_username text, p_app_id int) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select case when a.must_change_password then 0
              when l.days > 0 and a.password_changed_at is not null
                then greatest(0, l.days - extract(day from now() - a.password_changed_at)::int)
         end
    from meta.account a,
         -- least() skips nulls: the shorter of the two lifetimes that are set
         (select coalesce(least(nullif(coalesce(meta.setting('password_lifetime_days'), '0')::int, 0),
                                (select w.password_lifetime_days from meta.workspace w where w.id = meta.app_workspace(p_app_id))), 0) as days) l
   where lower(a.username) = lower(p_username)
$$;
-- as the one-argument version (006): applications' own logins (isolated workspaces) call it too
grant execute on function meta.password_days_left(text, int) to public;
comment on function meta.password_days_left(text, int) is
  'Days until an account''s password expires for an application (185): the stricter lifetime of the installation and the application''s workspace';

-- The login controls of an application's workspace, for the runtime (it can't read meta.workspace)
create function meta.app_login_controls(p_app_id int, out login_max_failures int, out password_lifetime_days int, out password_min_length int)
language sql stable security definer set search_path = meta, pg_catalog as $$
  select w.login_max_failures, w.password_lifetime_days, w.password_min_length
    from meta.workspace w where w.id = meta.app_workspace(p_app_id)
$$;
grant execute on function meta.app_login_controls(int) to public;
