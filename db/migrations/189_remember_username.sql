-- =====================================================================
-- 189: "Remember username" on the sign-in form (sprint 231, AX-13; APEX:
--      the login page's P9999_REMEMBER item and its username cookie)
--
--   remember_username  true (the default, as APEX's generated login
--                      page): the built-in sign-in page and the Login
--                      region of the application's own login page show
--                      a "Remember username" checkbox. Checked, a
--                      successful sign-in keeps the user name in a
--                      cookie of the application's path
--                      (pgkiln_user_<app id>, 180 days, nothing secret)
--                      and the form is filled in with it next time;
--                      unchecked, the cookie is removed. false: no
--                      checkbox, and the cookie is neither read nor set.
--
-- "Keep me signed in" (APEX: persistent authentication, P9999_PERSISTENT_AUTH)
-- stays remember_me_days (migration 017). Exports carry the column; an
-- export made before 189 imports with the default (trigger below, see 054
-- and 173).
-- =====================================================================

alter table meta.app add column remember_username boolean not null default true;
comment on column meta.app.remember_username is 'The sign-in form offers "Remember username" (189): a cookie of the app''s path keeps the user name, nothing secret';

create function meta.app_remember_username_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.remember_username := coalesce(new.remember_username, true);
  return new;
end $$;
create trigger app_remember_username_default before insert or update on meta.app
  for each row execute function meta.app_remember_username_default();
