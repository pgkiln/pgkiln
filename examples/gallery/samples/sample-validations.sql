-- =====================================================================
-- Sample app "Sample Validations" (App Gallery → Sample Apps)
--
-- The registration desk of a small conference, KilnConf:
--   page 1  a public home page: what shows depends on whether you are
--           signed in and on your language (user_signed_in, user_public,
--           language_in, language_not_in, never);
--   page 2  the registrations, a button that is there while seats are
--           left (function_body) and the change log;
--   page 3  the registration form, a modal dialog: every declarative
--           validation type, the three display locations, validations,
--           computations and a process with server-side conditions;
--   page 4  the check-in desk: regions that show by the attendee's values
--           (item_equals, item_in_list, item_zero, item_equals_item, …)
--           and buttons by rows in the table (exists, not_exists).
-- Application computations fill in the seats left (page_in), your own
-- ticket (user_signed_in) and the number checked in (page_not_in).
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-validations.sql
-- then open /a/sample-validations and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;
create or replace function pg_temp.region_id(p_alias text, p_page int, p_static text) returns int language sql stable as
  $$ select r.id from meta.region r where r.page_id = pg_temp.page_id(p_alias, p_page) and r.static_id = p_static $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_validations;

create table sample_validations.workshop (
  code  text primary key,
  title text not null,
  seats int not null check (seats > 0)
);

create table sample_validations.promo_code (
  code         text primary key,
  discount_pct int not null,
  valid_until  date not null
);

create table sample_validations.registration (
  id            int generated always as identity primary key,
  username      text not null unique,
  full_name     text not null,
  email         text not null,
  phone         text,
  ticket        text not null check (ticket in ('STANDARD', 'STUDENT', 'SPEAKER')),
  student_no    text,
  talk_title    text,
  talk_slot     timestamp,
  tickets       int not null default 1 check (tickets > 0),
  guests        int not null default 0 check (guests >= 0),
  donation      numeric(8, 2) check (donation > 0),
  shirt_size    text,
  promo_code    text references sample_validations.promo_code,
  workshop      text references sample_validations.workshop,
  arrival       date,
  checked_in_at timestamp
);

create table sample_validations.change_log (
  id              int generated always as identity primary key,
  registration_id int,
  action          text not null,
  by_user         text not null,
  at              timestamp not null default localtimestamp(0)
);

insert into sample_validations.workshop (code, title, seats) values
  ('SQL', 'Advanced SQL', 30), ('PERF', 'Query performance (2 seats)', 2), ('APEX', 'From APEX to pgkiln', 25);

insert into sample_validations.promo_code (code, discount_pct, valid_until) values
  ('COMMUNITY', 15, date '2099-12-31'), ('SPEAKERFRIEND', 25, date '2099-12-31'), ('EARLYBIRD', 30, date '2026-10-01');

insert into sample_validations.registration
  (username, full_name, email, phone, ticket, student_no, talk_title, talk_slot, tickets, guests, donation, shirt_size, promo_code, workshop, arrival, checked_in_at) values
  ('ada', 'Ada Lovelace', 'ada@example.org', '+44 20 7946 0001', 'SPEAKER', null, 'Engines that compute: a history of SQL planners', timestamp '2027-03-15 10:00', 1, 1, null, 'M', null, 'PERF', date '2027-03-14', localtimestamp(0)),
  ('grace', 'Grace Hopper', 'grace@example.org', '+1 202 555 0142', 'STANDARD', null, null, null, 2, 0, 25, 'S', 'COMMUNITY', 'PERF', date '2027-03-15', null),
  ('edsger', 'Edsger Dijkstra', 'edsger@example.org', null, 'STUDENT', '20261234', null, null, 1, 2, null, 'L', null, 'SQL', null, null),
  ('barbara', 'Barbara Liskov', 'barbara@example.org', '+1 617 555 0199', 'STANDARD', null, null, null, 1, 0, 10, 'M', null, 'APEX', date '2027-03-15', null);

insert into sample_validations.change_log (registration_id, action, by_user)
select id, 'CREATE', 'demo' from sample_validations.registration order by id;

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_validations') then create role app_sample_validations nologin; end if;
end $$;
grant app_sample_validations to pgkiln_runtime;
grant usage on schema sample_validations to app_sample_validations;
grant select on all tables in schema sample_validations to app_sample_validations;
grant insert, update, delete on sample_validations.registration to app_sample_validations;
grant insert on sample_validations.change_log to app_sample_validations;

-- 3. The application ----------------------------------------------------------
-- translated languages nl and de: with ?lang=nl (or a Dutch browser) the home page shows its language_not_in region
insert into meta.app (alias, name, home_page, authentication, db_role, languages)
values ('sample-validations', 'Sample Validations', 1, 'app_users', 'app_sample_validations', '{nl,de}');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-validations';

insert into meta.app_item (app_id, name, description)
select a.id, i.name, i.description
  from meta.app a, (values
  ('AI_OPEN_SEATS', 'Workshop seats left (application computation, pages 1 and 2)'),
  ('AI_MY_TICKET', 'The signed-in user''s own ticket (application computation, signed-in users)'),
  ('AI_CHECKED_IN', 'How many attendees have checked in (application computation, not on the dialog)')
  ) as i (name, description)
 where a.alias = 'sample-validations';

-- application computations: the same server-side conditions as a page's components
insert into meta.app_computation (app_id, seq, item_name, point, type, expression, condition_type, condition_value, comments)
select a.id, c.seq, c.item, 'before_header', 'sql_query', c.expr, c.ctype, c.cvalue, c.comments
  from meta.app a, (values
  (10, 'AI_OPEN_SEATS',
   'select sum(w.seats - (select count(*) from sample_validations.registration r where r.workshop = w.code)) from sample_validations.workshop w',
   'page_in', '1,2', 'Only the pages that show it run the query.'),
  (20, 'AI_MY_TICKET',
   E'select coalesce((select initcap(ticket) || '' ticket, '' || tickets || '' place(s)'' from sample_validations.registration where username = :APP_USER),\n                ''no ticket yet: register under Registrations as username '' || :APP_USER)',
   'user_signed_in', null, 'A visitor who isn''t signed in has no ticket.'),
  (30, 'AI_CHECKED_IN',
   'select count(*) from sample_validations.registration where checked_in_at is not null',
   'page_not_in', '3', 'Every page but the registration dialog shows it.')
  ) as c (seq, item, expr, ctype, cvalue, comments)
 where a.alias = 'sample-validations';

insert into meta.page (app_id, page_no, name, title, parent_page, requires_auth)
select a.id, p.no, p.name, p.name, p.parent, p.auth
  from meta.app a, (values
  (1, 'Sample Validations', null, false), (4, 'Check-in desk', 1, true)
  ) as p (no, name, parent, auth)
 where a.alias = 'sample-validations';

-- page 2 (report) and page 3 (its form, a modal dialog): the Report and form wizard
select meta.generate_page('sample-validations', 'report_form', 'sample_validations.registration', 2, '{"label": "Registrations", "form_page": 3, "nav": false}');
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-validations') and page_no = 2;
update meta.page set name = 'Registration', title = 'Registration' where app_id = (select id from meta.app where alias = 'sample-validations') and page_no = 3;
update meta.region set source = 'select id, username, full_name, ticket, tickets, guests, workshop, case when checked_in_at is not null then ''Yes'' end as checked_in from sample_validations.registration order by id',
       config = config || '{"headings": {"id": "ID", "username": "Username", "full_name": "Name", "ticket": "Ticket", "tickets": "Places", "guests": "Dinner guests", "workshop": "Workshop", "checked_in": "Checked in"}}',
       static_id = 'registrations'
 where page_id = pg_temp.page_id('sample-validations', 2) and type = 'report';
update meta.region set static_id = 'form' where page_id = pg_temp.page_id('sample-validations', 3) and type = 'form';

-- the form's items: text items for the date and the slot, so that the validations valid_date and
-- valid_timestamp (not the date item's own check) test them; lists for the ticket and the workshop
delete from meta.item where page_id = pg_temp.page_id('sample-validations', 3) and name = 'P3_CHECKED_IN_AT';
update meta.item i
   set label = x.label, type = x.type, lov = x.lov, help = x.help, required = x.required, default_value = x.def,
       config = i.config || x.config::jsonb
  from (values
  ('P3_USERNAME', 'Username', 'text', null, 'Letters and digits, not a reserved name, not taken.', true, null, '{}'),
  ('P3_FULL_NAME', 'Name', 'text', null, 'As on your badge: no digits or brackets.', true, null, '{}'),
  ('P3_EMAIL', 'E-mail', 'text', null, 'Checked with an @ (chars_any), then a regular expression.', true, null, '{}'),
  ('P3_PHONE', 'Phone', 'text', null, 'Digits, spaces, + - ( ) only.', false, null, '{}'),
  ('P3_TICKET', 'Ticket', 'select', 'STATIC:Standard;STANDARD,Student;STUDENT,Speaker;SPEAKER', null, true, 'STANDARD', '{}'),
  ('P3_STUDENT_NO', 'Student number', 'text', null, 'Students only: digits.', false, null, '{}'),
  ('P3_TALK_TITLE', 'Talk title', 'text', null, 'Speakers only: at least 10 characters.', false, null, '{}'),
  ('P3_TALK_SLOT', 'Preferred slot', 'text', null, 'Speakers only: YYYY-MM-DD HH:MI, e.g. 2027-03-15 14:30.', false, null, '{}'),
  ('P3_TICKETS', 'Places', 'number', null, 'How many places you book: not empty, not 0.', false, '1', '{}'),
  ('P3_GUESTS', 'Dinner guests', 'number', null, 'People you bring to the conference dinner.', false, '0', '{}'),
  ('P3_DONATION', 'Donation to the diversity fund', 'number', null, 'Optional: leave it empty rather than 0.', false, null, '{}'),
  ('P3_SHIRT_SIZE', 'T-shirt size', 'text', null, 'XS, S, M, L, XL or XXL.', false, null, '{}'),
  ('P3_PROMO_CODE', 'Promo code', 'text', null, 'Try COMMUNITY, or the expired EARLYBIRD.', false, null, '{}'),
  ('P3_WORKSHOP', 'Workshop', 'select', 'select title, code from sample_validations.workshop order by title', 'Query performance has 2 seats, both taken.', false, null, '{"null_label": "No workshop"}'),
  ('P3_ARRIVAL', 'Arrival date', 'text', null, 'YYYY-MM-DD, e.g. 2027-03-14.', false, null, '{}')
  ) as x (name, label, type, lov, help, required, def, config)
 where i.page_id = pg_temp.page_id('sample-validations', 3) and i.name = x.name;

-- not a column: the code of conduct, asked for a new registration only (an item condition)
insert into meta.item (page_id, region_id, seq, name, label, type, condition_type, condition_expr)
select pg_temp.page_id('sample-validations', 3), pg_temp.region_id('sample-validations', 3, 'form'), 990,
       'P3_CONDUCT', 'I accept the code of conduct', 'checkbox', 'item_null', 'P3_ID';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id, condition_type, condition_value)
select pg_temp.page_id('sample-validations', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb, r.sid, r.ctype, r.cvalue
  from (values
  -- 1 Home (public)
  (1, 10, 'Sample Validations', 'static', 12, 'hero',
   '<p><strong>KilnConf</strong> registers its attendees with pgkiln. The registration form checks what you type with <strong>validations</strong>: declarative types such as <em>alphanumeric</em>, <em>in list</em> or <em>valid date</em>, and SQL or PL/pgSQL for the rest. What a page shows is decided by <strong>server-side conditions</strong>: on who you are, your language, an item''s value or a query, for regions, items, buttons, validations, processes, computations, branches and dynamic actions alike.</p>',
   '{"icon": "check"}', null, null, null),
  (1, 20, 'Welcome back', 'static', 6, 'standard',
   '<p>Signed in as <strong>&APP_USER.</strong>: &AI_MY_TICKET.. Workshop seats left: <strong>&AI_OPEN_SEATS.</strong>; checked in so far: <strong>&AI_CHECKED_IN.</strong>.</p><p class="muted">Condition <code>user_signed_in</code>; the values come from application computations with the conditions <code>user_signed_in</code>, <code>page_in 1,2</code> and <code>page_not_in 3</code>.</p>',
   '{}', 'welcome', 'user_signed_in', null),
  (1, 30, 'Register for KilnConf', 'static', 6, 'standard',
   '<p>This page is public. <a href="login">Sign in</a> as <strong>demo</strong> / demo to register and to open the check-in desk. Workshop seats left: <strong>&AI_OPEN_SEATS.</strong>.</p><p class="muted">Condition <code>user_public</code>: only a visitor who isn''t signed in sees this region.</p>',
   '{}', 'sign-in', 'user_public', null),
  (1, 40, 'Language', 'static', 6, 'standard',
   '<p>The talks are in English, like this page. Open it <a href="1?lang=nl">in Dutch</a> to see the region for other languages.</p><p class="muted">Condition <code>language_in en</code>.</p>',
   '{}', 'lang-en', 'language_in', 'en'),
  (1, 41, 'Language', 'static', 6, 'standard',
   '<p>KilnConf is held in English: the talks and these texts are English, while pgkiln''s own texts follow your language. <a href="1?lang=en">Back to English</a>.</p><p class="muted">Condition <code>language_not_in en</code>.</p>',
   '{}', 'lang-other', 'language_not_in', 'en'),
  (1, 50, 'Call for papers', 'static', 6, 'standard',
   '<p>Submit your talk before 1 December.</p>',
   '{}', 'cfp', 'never', null),
  (1, 60, 'Topics', 'list', 12, 'plain', null, '{"list": "VALIDATION_TOPICS", "template": "cards"}', null, null, null),

  -- 2 Registrations
  (2, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">A report and its form, made by the <em>Report and form</em> wizard. <strong>Create</strong> has the condition <code>function_body</code> (<code>return (select count(*) …) &lt; 50;</code>): it disappears when the conference is full. Workshop seats left: <strong>&AI_OPEN_SEATS.</strong> (an application computation with the condition <code>page_in 1,2</code>). Every save is in the change log below, written by a process with the condition <code>request_not_in DELETE</code>.</p>',
   '{}', null, null, null),
  (2, 30, 'Change log', 'report', 12, 'collapsible',
   'select l.at, l.action, coalesce(r.username, ''(deleted)'') as registration, l.by_user from sample_validations.change_log l left join sample_validations.registration r on r.id = l.registration_id order by l.id desc',
   '{"headings": {"at": "When", "action": "Request", "registration": "Registration", "by_user": "By"}}', 'log', null, null),

  -- 3 Registration (modal dialog)
  (3, 1, 'About this dialog', 'static', 12, 'plain',
   '<p class="lead">Each field has its own validation type; the help text says what it accepts. Try a username with a dash or <em>admin</em>, the name <em>R2D2</em>, an e-mail without @, the shirt size <em>XXXL</em>, <em>0</em> places, the promo code <em>EARLYBIRD</em>, the full workshop <em>Query performance</em> or the date <em>2027-02-30</em>. Most errors show next to the field (<code>inline</code>); a taken username and the code of conduct also at the top (<code>inline_and_notification</code>); a full workshop only at the top (<code>notification</code>). This region has the condition <code>page_is_dialog</code>; the button <em>Back to the list</em> has <code>page_is_not_dialog</code>, so it only appears if the page''s mode is set to normal.</p>',
   '{}', 'about', 'page_is_dialog', null),

  -- 4 Check-in desk
  (4, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The desk looks up an attendee: computations before the page is shown fill in the items, and the regions below show by their values, without SQL: <code>item_equals</code>, <code>item_in_list</code> and <code>item_not_in_list</code> on the ticket, <code>item_zero</code> and <code>item_not_zero</code> on the guests, <code>item_null_or_zero</code> and <code>item_not_null_or_zero</code> on the donation, <code>item_equals_item</code> and <code>item_not_equals_item</code> on the e-mail address. <strong>Check in</strong> shows while the attendee isn''t checked in (<code>not_exists</code>), <strong>Undo the check-in</strong> once they are (<code>exists</code>). Checked in so far: &AI_CHECKED_IN..</p>',
   '{}', null, null, null),
  (4, 10, 'Attendee', 'static', 6, 'standard', null, '{}', 'attendee', null, null),
  (4, 20, 'Registration', 'static', 6, 'standard', null, '{}', 'registration', null, null)
  ) as r (page, seq, title, type, cols, template, source, config, sid, ctype, cvalue);

-- the check-in desk's instructions, each a region with a condition on the attendee's items
insert into meta.region (page_id, seq, title, type, columns, template, source, static_id, condition_type, condition, condition_value)
select pg_temp.page_id('sample-validations', 4), r.seq, r.title, 'static', 6, 'standard', r.source, r.sid, r.ctype, r.expr, r.cvalue
  from (values
  (30, 'Speaker', '<p>Hand out the <strong>speaker lanyard</strong> and the room plan. Talk: <em>&P4_TALK_TITLE.</em></p><p class="muted"><code>item_equals P4_TICKET SPEAKER</code></p>',
   'speaker', 'item_equals', 'P4_TICKET', 'SPEAKER'),
  (31, 'Attendee', '<p>A <strong>&P4_TICKET.</strong> ticket: the blue lanyard.</p><p class="muted"><code>item_not_equals P4_TICKET SPEAKER</code></p>',
   'not-speaker', 'item_not_equals', 'P4_TICKET', 'SPEAKER'),
  (40, 'Lunch', '<p>Lunch is included: hand out a <strong>lunch voucher</strong>.</p><p class="muted"><code>item_in_list P4_TICKET STUDENT:SPEAKER</code></p>',
   'lunch-free', 'item_in_list', 'P4_TICKET', 'STUDENT:SPEAKER'),
  (41, 'Lunch', '<p>Lunch is not included with this ticket: 15 euro at the bar.</p><p class="muted"><code>item_not_in_list P4_TICKET STUDENT:SPEAKER</code></p>',
   'lunch-paid', 'item_not_in_list', 'P4_TICKET', 'STUDENT:SPEAKER'),
  (50, 'Dinner', '<p>No dinner guests.</p><p class="muted"><code>item_zero P4_GUESTS</code></p>',
   'no-guests', 'item_zero', 'P4_GUESTS', null),
  (51, 'Dinner', '<p>Hand out <strong>&P4_GUESTS.</strong> guest wristband(s) for the dinner.</p><p class="muted"><code>item_not_zero P4_GUESTS</code></p>',
   'guests', 'item_not_zero', 'P4_GUESTS', null),
  (60, 'Diversity fund', '<p>No donation: mention the diversity fund.</p><p class="muted"><code>item_null_or_zero P4_DONATION</code></p>',
   'no-donation', 'item_null_or_zero', 'P4_DONATION', null),
  (61, 'Diversity fund', '<p>Thank them for their donation of <strong>&P4_DONATION.</strong>: a sticker.</p><p class="muted"><code>item_not_null_or_zero P4_DONATION</code></p>',
   'donation', 'item_not_null_or_zero', 'P4_DONATION', null),
  (70, 'Identity', '<p>The address matches the registration: hand out the badge.</p><p class="muted"><code>item_equals_item P4_EMAIL P4_GIVEN_EMAIL</code></p>',
   'identity-ok', 'item_equals_item', 'P4_EMAIL', 'P4_GIVEN_EMAIL'),
  (71, 'Identity', '<p>Ask for the e-mail address of the booking and type it under <em>Attendee</em>: it doesn''t match yet. (The comparison is exact; <em>Check in</em> compares without case.)</p><p class="muted"><code>item_not_equals_item P4_EMAIL P4_GIVEN_EMAIL</code></p>',
   'identity-check', 'item_not_equals_item', 'P4_EMAIL', 'P4_GIVEN_EMAIL')
  ) as r (seq, title, source, sid, ctype, expr, cvalue);

insert into meta.item (page_id, region_id, seq, name, label, type, lov, help, config)
select pg_temp.page_id('sample-validations', 4), pg_temp.region_id('sample-validations', 4, i.region),
       i.seq, i.name, i.label, i.type, i.lov, i.help, i.config::jsonb
  from (values
  ('attendee', 10, 'P4_USERNAME', 'Attendee', 'select', 'select full_name || '' ('' || username || '')'', username from sample_validations.registration order by full_name', null,
   '{"submit_on_change": true, "warn_unsaved": false}'),
  ('attendee', 20, 'P4_GIVEN_EMAIL', 'E-mail address they give', 'text', null, 'The address the attendee tells you: compared with the booking.', '{"warn_unsaved": false}'),
  ('attendee', 30, 'P4_EMAIL', null, 'hidden', null, null, '{}'),
  ('registration', 10, 'P4_FULL_NAME', 'Name', 'display', null, null, '{}'),
  ('registration', 20, 'P4_TICKET', 'Ticket', 'display', null, null, '{}'),
  ('registration', 30, 'P4_TALK_TITLE', 'Talk', 'display', null, null, '{}'),
  ('registration', 40, 'P4_GUESTS', 'Dinner guests', 'display', null, null, '{}'),
  ('registration', 50, 'P4_DONATION', 'Donation', 'display', null, null, '{}'),
  ('registration', 60, 'P4_CHECKED_IN', 'Checked in', 'display', null, null, '{}')
  ) as i (region, seq, name, label, type, lov, help, config);

-- before the page is shown: the first attendee when none is chosen, then their registration
insert into meta.computation (page_id, seq, item_name, point, type, expression, condition_type, condition_expr)
select pg_temp.page_id('sample-validations', 4), c.seq, c.item, 'before_header', 'sql_query', c.expr, c.ctype, c.cexpr
  from (values
  (10, 'P4_USERNAME', 'select username from sample_validations.registration order by full_name limit 1', 'item_null', 'P4_USERNAME'),
  (20, 'P4_FULL_NAME', 'select full_name from sample_validations.registration where username = :P4_USERNAME', null, null),
  (30, 'P4_TICKET', 'select ticket from sample_validations.registration where username = :P4_USERNAME', null, null),
  (40, 'P4_TALK_TITLE', 'select talk_title from sample_validations.registration where username = :P4_USERNAME', null, null),
  (50, 'P4_GUESTS', 'select guests from sample_validations.registration where username = :P4_USERNAME', null, null),
  (60, 'P4_DONATION', 'select donation from sample_validations.registration where username = :P4_USERNAME', null, null),
  (70, 'P4_EMAIL', 'select email from sample_validations.registration where username = :P4_USERNAME', null, null),
  (80, 'P4_CHECKED_IN', 'select to_char(checked_in_at, ''YYYY-MM-DD HH24:MI'') from sample_validations.registration where username = :P4_USERNAME', null, null)
  ) as c (seq, item, expr, ctype, cexpr);

-- Check in while not checked in (not_exists), Undo once checked in (exists)
insert into meta.button (page_id, region_id, seq, name, label, action, hot, condition_type, condition)
select pg_temp.page_id('sample-validations', 4), pg_temp.region_id('sample-validations', 4, 'attendee'), b.seq, b.name, b.label, 'submit', b.hot, b.ctype, b.expr
  from (values
  (10, 'CHECK_IN', 'Check in', true, 'not_exists',
   'select 1 from sample_validations.registration where username = :P4_USERNAME and checked_in_at is not null'),
  (20, 'UNDO', 'Undo the check-in', false, 'exists',
   'select 1 from sample_validations.registration where username = :P4_USERNAME and checked_in_at is not null')
  ) as b (seq, name, label, hot, ctype, expr);

insert into meta.validation (page_id, seq, name, item_name, type, expression, message, when_button)
select pg_temp.page_id('sample-validations', 4), 10, 'The address of the booking', 'P4_GIVEN_EMAIL', 'exists',
       'select 1 from sample_validations.registration where username = :P4_USERNAME and lower(email) = lower(trim(:P4_GIVEN_EMAIL))',
       'This is not the e-mail address of the booking: ask again.', 'CHECK_IN';

insert into meta.process (page_id, seq, name, type, code, when_button, success_message)
select pg_temp.page_id('sample-validations', 4), p.seq, p.name, 'sql', p.code, p.button, p.msg
  from (values
  (10, 'Check in', 'update sample_validations.registration set checked_in_at = localtimestamp(0) where username = :P4_USERNAME', 'CHECK_IN', '&P4_FULL_NAME. is checked in: hand out the badge.'),
  (20, 'Undo the check-in', 'update sample_validations.registration set checked_in_at = null where username = :P4_USERNAME', 'UNDO', 'The check-in is undone.')
  ) as p (seq, name, code, button, msg);

-- the last one checked in: back to the list (a branch with the condition not_exists)
insert into meta.branch (page_id, seq, name, point, when_button, condition_type, condition_expr, target_type, target_page)
select pg_temp.page_id('sample-validations', 4), 10, 'Everybody is here: to the list', 'after_processing', 'CHECK_IN',
       'not_exists', 'select 1 from sample_validations.registration where checked_in_at is null', 'page', 2;

-- page 2: Create while there are places (function_body)
update meta.button set condition_type = 'function_body', condition = 'return (select count(*) from sample_validations.registration) < 50;'
 where page_id = pg_temp.page_id('sample-validations', 2) and name = 'CREATE';

-- page 3: a button for when the page is not a dialog
insert into meta.button (page_id, region_id, seq, name, label, action, target_page, condition_type)
select pg_temp.page_id('sample-validations', 3), pg_temp.region_id('sample-validations', 3, 'form'), 5, 'BACK', 'Back to the list', 'redirect', 2, 'page_is_not_dialog';

-- page 3: computations after the submit, before the validations
insert into meta.computation (page_id, seq, item_name, point, type, expression, condition_type, condition_expr, condition_value)
select pg_temp.page_id('sample-validations', 3), c.seq, c.item, 'after_submit', c.type, c.expr, c.ctype, c.cexpr, c.cvalue
  from (values
  -- codes are kept in capitals, whatever was typed
  (10, 'P3_PROMO_CODE', 'sql_expression', 'upper(nullif(trim(:P3_PROMO_CODE), ''''))', 'always', null, null),
  -- only students keep a student number, only speakers a talk
  (20, 'P3_STUDENT_NO', 'static', null, 'item_not_equals', 'P3_TICKET', 'STUDENT'),
  (30, 'P3_TALK_TITLE', 'static', null, 'item_not_equals', 'P3_TICKET', 'SPEAKER'),
  (40, 'P3_TALK_SLOT', 'static', null, 'item_not_equals', 'P3_TICKET', 'SPEAKER'),
  -- an empty number of guests is none
  (50, 'P3_GUESTS', 'static', '0', 'item_null_or_zero', 'P3_GUESTS', null)
  ) as c (seq, item, type, expr, ctype, cexpr, cvalue);

-- page 3: the validations, one or more per field
insert into meta.validation (page_id, seq, name, item_name, type, expression, message, display_location, condition_type, condition_expr, condition_value)
select pg_temp.page_id('sample-validations', 3), v.seq, v.name, v.item, v.type, v.expr, v.message, v.loc, v.ctype, v.cexpr, v.cvalue
  from (values
  (10, 'Username: letters and digits', 'P3_USERNAME', 'alphanumeric', null,
   'A username has only letters and digits.', 'inline', null, null, null),
  (11, 'Username: not reserved', 'P3_USERNAME', 'not_in_list', 'admin:root:system:staff',
   'This username is reserved: choose another one.', 'inline', null, null, null),
  (12, 'Username: not taken', 'P3_USERNAME', 'not_exists',
   'select 1 from sample_validations.registration where lower(username) = lower(:P3_USERNAME) and id is distinct from nullif(:P3_ID, '''')::int',
   'The username &P3_USERNAME. is taken: choose another one.', 'inline_and_notification', null, null, null),
  (20, 'Name: no digits or brackets', 'P3_FULL_NAME', 'chars_none', '0123456789<>{}[]@#',
   'A name has no digits, brackets, @ or #.', 'inline', null, null, null),
  (30, 'E-mail: has an @', 'P3_EMAIL', 'chars_any', '@',
   'An e-mail address has an @.', 'inline', null, null, null),
  (31, 'E-mail: looks like an address', 'P3_EMAIL', 'regex', '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$',
   'This doesn''t look like an e-mail address (name@example.org).', 'inline', null, null, null),
  (40, 'Phone: digits and + - ( )', 'P3_PHONE', 'chars_only', '0123456789 +-()',
   'A phone number has digits, spaces and + - ( ) only.', null, null, null, null),
  (50, 'Students: a student number', 'P3_STUDENT_NO', 'not_null', null,
   'A student ticket needs your student number.', 'inline', 'item_equals', 'P3_TICKET', 'STUDENT'),
  (51, 'Student number: digits', 'P3_STUDENT_NO', 'numeric', null,
   'A student number has digits only.', 'inline', null, null, null),
  (60, 'Speakers: a talk title', 'P3_TALK_TITLE', 'function_body',
   E'return coalesce(:P3_TICKET, '''') <> ''SPEAKER''\n    or length(trim(coalesce(:P3_TALK_TITLE, ''''))) >= 10;',
   'A speaker ticket needs a talk title of at least 10 characters.', 'inline', null, null, null),
  (61, 'Slot: a valid timestamp', 'P3_TALK_SLOT', 'valid_timestamp', null,
   'Give the slot as YYYY-MM-DD HH:MI, e.g. 2027-03-15 14:30.', 'inline', null, null, null),
  (70, 'Places: at least one', 'P3_TICKETS', 'not_null_or_zero', null,
   'Book at least one place.', 'inline', null, null, null),
  (80, 'Donation: not zero', 'P3_DONATION', 'not_zero', null,
   'A donation of 0? Leave the field empty instead.', 'inline', null, null, null),
  (90, 'T-shirt: a known size', 'P3_SHIRT_SIZE', 'in_list', 'XS:S:M:L:XL:XXL',
   'T-shirt sizes are XS, S, M, L, XL and XXL.', 'inline', 'item_not_null', 'P3_SHIRT_SIZE', null),
  (100, 'Promo code: no spaces', 'P3_PROMO_CODE', 'no_spaces', null,
   'A promo code has no spaces.', 'inline', null, null, null),
  (101, 'Promo code: not the early bird', 'P3_PROMO_CODE', 'not_equals', 'EARLYBIRD',
   'The early-bird code ended on 1 October 2026.', 'inline', null, null, null),
  (102, 'Promo code: a valid code', 'P3_PROMO_CODE', 'exists',
   'select 1 from sample_validations.promo_code where code = :P3_PROMO_CODE and valid_until >= current_date',
   'Unknown promo code.', 'inline', 'item_not_null', 'P3_PROMO_CODE', null),
  (110, 'Workshop: a seat left', 'P3_WORKSHOP', 'function_error',
   E'declare\n  v_left int;\nbegin\n  if :P3_WORKSHOP is null then\n    return null;\n  end if;\n  select w.seats - (select count(*) from sample_validations.registration r\n                     where r.workshop = w.code and r.id is distinct from nullif(:P3_ID, '''')::int)\n    into v_left\n    from sample_validations.workshop w where w.code = :P3_WORKSHOP;\n  if v_left <= 0 then\n    return format(''The workshop %s is full: choose another one, or none.'', (select title from sample_validations.workshop where code = :P3_WORKSHOP));\n  end if;\n  return null;\nend',
   'unused: the function returns the message', 'notification', null, null, null),
  (120, 'Arrival: a valid date', 'P3_ARRIVAL', 'valid_date', null,
   'Give the arrival date as YYYY-MM-DD, e.g. 2027-03-14.', 'inline', null, null, null),
  (130, 'The code of conduct', 'P3_CONDUCT', 'equals', 'true',
   'Accept the code of conduct to register.', 'inline_and_notification', null, null, null)
  ) as v (seq, name, item, type, expr, message, loc, ctype, cexpr, cvalue);

-- page 3: every save in the change log, except a delete (the row is gone)
insert into meta.process (page_id, seq, name, type, code, condition_type, condition_value)
select pg_temp.page_id('sample-validations', 3), 20, 'Record the change', 'sql',
       'insert into sample_validations.change_log (registration_id, action, by_user) values (:P3_ID::int, :REQUEST, :APP_USER)',
       'request_not_in', 'DELETE';

-- page 3: show the student number for students and the talk for speakers (in the browser)
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, condition_value, action, affected_items, server_condition_type)
select pg_temp.page_id('sample-validations', 3), d.seq, d.name, 'change', 'P3_TICKET', 'equals', d.value, 'show', d.items, 'always'
  from (values
  (10, 'Student number for students', 'STUDENT', 'P3_STUDENT_NO'),
  (20, 'The talk for speakers', 'SPEAKER', 'P3_TALK_TITLE,P3_TALK_SLOT')
  ) as d (seq, name, value, items);

-- navigation and the topics on the home page
insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values (10, 'Home', 'home', 1), (20, 'Registrations', 'list', 2), (30, 'Check-in desk', 'check', 4)) as n (seq, label, icon, page)
 where a.alias = 'sample-validations';

insert into meta.list (app_id, name, type, description)
select id, 'VALIDATION_TOPICS', 'static', 'The pages of Sample Validations' from meta.app where alias = 'sample-validations';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'VALIDATION_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Registrations', 'list', 2, 'Register in a dialog whose fields each have a validation type; a change log written on a condition.'),
  (20, 'Check-in desk', 'check', 4, 'Regions, buttons and a branch that show or apply by the attendee''s values and rows.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-validations';
