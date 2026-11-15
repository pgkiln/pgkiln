-- =====================================================================
-- 173: signing in to an application with a passkey alone (sprint 199,
--      NX-U6; beyond APEX, whose sign-in page has no passkeys)
--
--   passkey_signin  true: the built-in sign-in page (and an application's
--                   own login page) offers "Sign in with a passkey" above
--                   the user name and password. Only for the user
--                   directory's own accounts (authentication app_users
--                   with password sign-in on). The authenticator must
--                   verify the user (fingerprint, face, PIN), so the
--                   passkey counts as both factors; the browser offers
--                   the passkeys it holds for the site (discoverable
--                   credentials), so no user name is typed.
--
-- The passkeys are the accounts' own (meta.account_factor, migration
-- 133). Exports carry the column; an export made before 173 imports with
-- the default, off (trigger below, see 054 and 169).
-- =====================================================================

alter table meta.app add column passkey_signin boolean not null default false;
comment on column meta.app.passkey_signin is 'Users may sign in with a passkey alone, user-verified (173); only for the user directory''s accounts';

create function meta.app_passkey_signin_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.passkey_signin := coalesce(new.passkey_signin, false);
  return new;
end $$;
create trigger app_passkey_signin_default before insert or update on meta.app
  for each row execute function meta.app_passkey_signin_default();
