-- =====================================================================
-- 197: item placeholders, the page template "No navigation" and the canonical user name of a custom
-- authentication scheme (sprint 241, MG-10, MG-13, MG-15; found migrating an Appsmith application).
--
-- MG-10  meta.item.placeholder (APEX: Value Placeholder): the hint inside an empty text, number, e-mail,
--        telephone, URL, password, combobox, textarea or date field; for a select list, popup LOV and
--        select one the text of the empty choice (config.null_label, when set, still wins; false still
--        leaves the empty choice out). &ITEM. substitutions, escaped; translated like a label.
--        Null (and every export made before 197) is no placeholder: a date item shows its date format.
-- MG-11  item labels take &ITEM. substitutions (no change here: the runtime substitutes them).
-- MG-13  meta.page.page_template 'no_navigation': the Standard page without its header, navigation menu
--        and title bar; unlike 'minimal' (a sign-in page) it keeps the application's progressive web
--        app and push notification attributes, live badges, the footer and the developer toolbar.
-- MG-15  meta.set_auth_user(text) (APEX: apex_custom_auth.set_user): custom authentication's
--        post-authentication code names the session's user, e.g. lower(p_username), so one person who
--        types Jan@X.nl or jan@x.nl is one user (roles, authorization schemes, APP_USER, created_by).
--
-- meta.set_auth_user only records the name in a setting of the current transaction. The server reads it
-- in one place: right after the post-authentication code of the application being signed into ran
-- (src/customauth.ts), in the same transaction, after clearing it first; it checks the name again. Called
-- anywhere else (a page process, an Ajax callback, the SQL Workshop, another application, the check
-- function itself) it raises an error, and even a setting forged with set_config is never read there.
-- =====================================================================

alter table meta.item add column placeholder text check (length(placeholder) <= 500);
comment on column meta.item.placeholder is 'Value Placeholder (197): the hint in an empty field, or a select list''s empty choice; &ITEM. substitutions, escaped';

alter table meta.page drop constraint page_page_template_check;
alter table meta.page add constraint page_page_template_check
  check (page_template in ('standard', 'minimal', 'left_side_column', 'right_side_column', 'no_navigation'));
comment on column meta.page.page_template is 'standard, left_side_column, right_side_column, minimal (no header and navigation: a sign-in page) or no_navigation (197: Standard without header, navigation menu and title bar; keeps PWA and push)';

-- the rules of a user name set by post-authentication; src/customauth.ts authUserProblem() checks the same
create function meta.auth_user_problem(p_name text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case
    when p_name is null or btrim(p_name) = '' then 'the user name is empty'
    when length(btrim(p_name)) > 100 then 'the user name is longer than 100 characters'
    -- control characters, line and paragraph separators, zero-width and bidirectional formatting characters
    when btrim(p_name) ~ '[\x01-\x1f\x7f-\x9f­؜᠎​-‏ -‮⁠-⁯﻿]' then 'the user name contains a control or formatting character'
    when lower(btrim(p_name)) = 'nobody' then 'nobody is the name of a user who is not signed in'
  end
$$;
comment on function meta.auth_user_problem(text) is 'Custom authentication (197): why a user name can''t be the session''s user (null: it can)';
grant execute on function meta.auth_user_problem(text) to public;

create function meta.set_auth_user(p_name text) returns void
language plpgsql set search_path = pg_catalog as $$
declare
  v_problem text := meta.auth_user_problem(p_name);
begin
  if coalesce(current_setting('pgkiln.auth_phase', true), '') <> 'post_authentication' then
    raise exception 'meta.set_auth_user works only in the post-authentication code of a custom authentication scheme, while a user signs in';
  end if;
  if v_problem is not null then
    raise exception 'meta.set_auth_user: %', v_problem;
  end if;
  perform set_config('pgkiln.auth_user', btrim(p_name), true),
          set_config('pgkiln.app_user', btrim(p_name), true);
end $$;
comment on function meta.set_auth_user(text) is 'Custom authentication (197; APEX apex_custom_auth.set_user): in post-authentication code, the user name the session gets (e.g. lower(p_username)); an error anywhere else';
grant execute on function meta.set_auth_user(text) to public;
