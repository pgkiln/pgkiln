-- =====================================================================
-- Sample app "Sample Sign-in" (App Gallery → Sample Apps)
--
-- Custom authentication against the users of another system: the users
-- live in a Django-style auth_user table with the password hashes Django
-- and PHP wrote (pbkdf2_sha256$… and $2y$…). The application's password
-- hash query returns the stored hash for p_username; pgkiln checks the
-- password in the server (quickly, in constant time), and post-
-- authentication code records the sign-in. Changing a password writes a new
-- hash with meta.make_password_hash, in the format the other system reads.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-sign-in.sql
-- then open /a/sample-sign-in and sign in as demo / demo (a Django hash)
-- or php / php (a PHP password_hash hash).
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_sign_in;

-- the shape of Django's auth_user (the columns this sample needs)
create table sample_sign_in.auth_user (
  id          int generated always as identity primary key,
  username    text not null unique check (username = lower(username)),
  password    text not null,
  first_name  text not null default '',
  last_name   text not null default '',
  is_active   boolean not null default true,
  date_joined timestamptz not null default now(),
  last_login  timestamptz
);

-- the hashes as Django 5.2 (make_password) and PHP 8 (password_hash) wrote them
insert into sample_sign_in.auth_user (username, password, first_name, last_name, is_active) values
  ('demo', 'pbkdf2_sha256$1000000$pgkilnsampledemo$ds9C0GBcu8KbUtYdEfUcMntOnT60xLA9sEbvc+uSxPA=', 'Demo', 'User', true),
  ('php', '$2y$10$7T.eWbo030yyR2U9IYKiaebR33Lu0pZnGZdpCGYPFvcGUD3qWHHOS', 'From', 'PHP', true),
  ('former', 'pbkdf2_sha256$1000000$Jn8kYLINZMJPu6rAf8mU66$Qwkg9O1T5RJVM8XCPqPVn264Cyzi0Q+PpeOlBsrHJhw=', 'Former', 'Colleague', false);

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_sign_in') then create role app_sample_sign_in nologin; end if;
end $$;
grant app_sample_sign_in to pgkiln_runtime;
grant usage on schema sample_sign_in to app_sample_sign_in;
grant select on sample_sign_in.auth_user to app_sample_sign_in;
grant update (password, last_login) on sample_sign_in.auth_user to app_sample_sign_in;

-- 3. The application ----------------------------------------------------------
-- Authentication "custom" with a password hash query; the post-authentication code records the sign-in and names the
-- user in lower case (Demo and demo are one user)
insert into meta.app (alias, name, home_page, authentication, db_role, version, custom_auth_hash_query, custom_auth_post_code)
values ('sample-sign-in', 'Sample Sign-in', 1, 'custom', 'app_sample_sign_in', '1.0',
        'select password from sample_sign_in.auth_user where username = lower(p_username) and is_active',
        E'update sample_sign_in.auth_user set last_login = now() where username = lower(p_username);\nperform meta.set_auth_user(lower(p_username));');

insert into meta.page (app_id, page_no, name, title)
select a.id, p.no, p.name, p.name
  from meta.app a, (values (1, 'Sample Sign-in'), (2, 'Users'), (3, 'Change my password')) as p (no, name)
 where a.alias = 'sample-sign-in';
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-sign-in') and page_no in (2, 3);

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values (10, 'Home', 'home', 1), (20, 'Users', 'users', 2), (30, 'Change my password', 'key', 3)) as n (seq, label, icon, page)
 where a.alias = 'sample-sign-in';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id)
select pg_temp.page_id('sample-sign-in', r.page), r.seq, r.title, r.type, 12, r.template, r.source, r.config::jsonb, r.sid
  from (values
  (1, 10, 'Sample Sign-in', 'static', 'hero',
   '<p>This application signs its users in against the users of another system: a Django-style <code>auth_user</code> table with the password hashes Django and PHP wrote. You are signed in as <strong>&APP_USER.</strong>.</p>',
   '{"icon": "key"}', null),
  (1, 20, 'How it works', 'static', 'standard',
   '<p>Shared Components → Authentication is <strong>Custom</strong> with a <strong>password hash query</strong>:</p><p><code>select password from sample_sign_in.auth_user</code><br><code>where username = lower(p_username) and is_active</code></p><p>The query runs as the application''s role and returns the stored hash; pgkiln checks the password against it in the server, in constant time: Django''s <code>pbkdf2_sha256$</code> and <code>pbkdf2_sha1$</code>, and bcrypt <code>$2a$</code>, <code>$2b$</code> and <code>$2y$</code> (PHP''s <code>password_hash</code>). An unknown or inactive user gets the same answer after the same time as a wrong password, and every failure counts for the sign-in throttling. The post-authentication code records the sign-in and names the user in lower case with <code>meta.set_auth_user</code>.</p><p>Sign out and try <strong>php</strong> / <strong>php</strong>: a user whose hash PHP wrote. <strong>former</strong> is inactive: the query returns no hash, so the sign-in is refused.</p>',
   '{}', null),
  (2, 5, 'About this page', 'static', 'plain',
   '<p class="lead">The users of the other system, with the format of their password hash (never the hash itself) and their last sign-in, which the post-authentication code records.</p>', '{}', null),
  (2, 10, 'Users', 'report', 'standard',
   E'select username, first_name || '' '' || last_name as name,\n       case when password like ''pbkdf2_sha256$%'' then ''Django PBKDF2-SHA256, '' || split_part(password, ''$'', 2) || '' iterations''\n            when password like ''$2y$%'' then ''bcrypt (PHP password_hash)''\n            when password like ''$2a$%'' then ''bcrypt (meta.make_password_hash)''\n            else split_part(password, ''$'', 1) end as hash_format,\n       is_active, last_login\n  from sample_sign_in.auth_user order by username',
   '{"headings": {"hash_format": "Hash format", "is_active": "Active", "last_login": "Last sign-in"}}', null),
  (3, 5, 'About this page', 'static', 'plain',
   '<p class="lead">A new password is stored as a hash the other system reads too: <code>meta.make_password_hash(password, ''pbkdf2_sha256'')</code> writes Django''s format (1,000,000 iterations, about a second), <code>''bcrypt''</code> one that PHP''s <code>password_verify</code> accepts.</p>', '{}', null),
  (3, 10, 'New password', 'static', 'standard', '', '{}', 'new-password')
  ) as r (page, seq, title, type, template, source, config, sid);

insert into meta.item (page_id, region_id, seq, name, label, type, lov, default_value, help)
select pg_temp.page_id('sample-sign-in', 3), r.id, i.seq, i.name, i.label, i.type, i.lov, i.def, i.help
  from meta.region r, (values
  (10, 'P3_PASSWORD', 'New password', 'password', null, null, 'At least 8 characters.'),
  (20, 'P3_CONFIRM', 'New password again', 'password', null, null, null),
  (30, 'P3_FORMAT', 'Store as', 'radio', 'STATIC:Django PBKDF2-SHA256;pbkdf2_sha256,bcrypt (PHP);bcrypt', 'pbkdf2_sha256', 'The format of the new hash.')
  ) as i (seq, name, label, type, lov, def, help)
 where r.page_id = pg_temp.page_id('sample-sign-in', 3) and r.static_id = 'new-password';

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select r.page_id, r.id, 10, 'SAVE', 'Change password', 'submit', true
  from meta.region r where r.page_id = pg_temp.page_id('sample-sign-in', 3) and r.static_id = 'new-password';

insert into meta.validation (page_id, seq, name, item_name, type, expression, message, when_button)
select pg_temp.page_id('sample-sign-in', 3), v.seq, v.name, v.item, v.type, v.expr, v.message, 'SAVE'
  from (values
  (10, 'A new password', 'P3_PASSWORD', 'not_null', null, 'Type the new password.'),
  (20, 'Long enough', 'P3_PASSWORD', 'regex', '^.{8,}$', 'A password has at least 8 characters.'),
  (30, 'Typed twice', 'P3_CONFIRM', 'function_error', E'begin\n  return case when :P3_PASSWORD is distinct from :P3_CONFIRM then ''The two passwords differ.'' end;\nend', 'The two passwords differ.')
  ) as v (seq, name, item, type, expr, message);

insert into meta.process (page_id, seq, name, type, code, when_button, success_message)
select pg_temp.page_id('sample-sign-in', 3), 10, 'Store the new hash', 'sql',
       'update sample_sign_in.auth_user set password = meta.make_password_hash(:P3_PASSWORD, :P3_FORMAT) where username = :APP_USER',
       'SAVE', 'Your password is changed: sign in with it next time.';
