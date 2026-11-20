-- =====================================================================
-- HR example, part 104: a visitor sign-in kiosk (sprint 241, MG-10,
-- MG-11, MG-13; migration 197; docs/guide/04-pages-and-regions.md
-- "Page templates", 05-items.md "Placeholders" and "Labels")
--
-- Page 68 "Visitor sign-in" is the screen of a tablet at the reception:
--   - page template no_navigation: no header, navigation menu or title
--     bar, but still the application's page (PWA, push, footer);
--   - placeholders in the empty fields (name@example.com, a date hint)
--     and as the select list's empty choice ("Who are you visiting?");
--   - labels an administrator keeps in hr.kiosk_label: each label is
--     &P68_LABEL_xxx., an item a computation fills from that table, so
--     the form needs no static region per field. Change a row of
--     hr.kiosk_label and the label changes (values are escaped).
-- Sign in stores the visit in hr.visitor.
-- =====================================================================

create table hr.kiosk_label (
  field text primary key,
  label text not null check (length(label) between 1 and 100)
);
insert into hr.kiosk_label (field, label) values
  ('NAME', 'Your name'),
  ('EMAIL', 'Your e-mail address'),
  ('HOST', 'Who are you visiting?'),
  ('VISIT_DATE', 'Date of your visit'),
  ('NOTE', 'Anything we should know?');

create table hr.visitor (
  id         int generated always as identity primary key,
  name       text not null check (length(name) <= 200),
  email      text check (length(email) <= 200),
  host_empno int references hr.emp (empno),
  visit_date date not null default current_date,
  note       text check (length(note) <= 2000),
  created_by text not null default current_setting('pgkiln.app_user', true),
  created_at timestamptz not null default now()
);
grant select on hr.kiosk_label to hr_app;
grant select, insert on hr.visitor to hr_app;

insert into meta.page (app_id, page_no, name, title, page_template)
select id, 68, 'Visitor sign-in', 'Welcome', 'no_navigation' from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source)
select p.id, 10, 'Welcome', 'static', 12, 'standard',
       '<p>Please sign in. Your host gets a message that you have arrived.</p>'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 68;

insert into meta.item (page_id, region_id, seq, name, label, placeholder, type, lov, required, config)
select p.id, r.id, i.seq, i.name, i.label, i.placeholder, i.type, i.lov, i.required, i.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Welcome', (values
  (10, 'P68_NAME', '&P68_LABEL_NAME.', 'First and last name', 'text', null, true, '{}'),
  (20, 'P68_EMAIL', '&P68_LABEL_EMAIL.', 'name@example.com', 'email', null, false, '{}'),
  (30, 'P68_HOST', '&P68_LABEL_HOST.', '- Choose your host -', 'select',
   'select initcap(ename) as d, empno as r from hr.emp order by ename', true, '{}'),
  (40, 'P68_VISIT_DATE', '&P68_LABEL_VISIT_DATE.', 'Today, or the day you come', 'date', null, false, '{}'),
  (50, 'P68_NOTE', '&P68_LABEL_NOTE.', 'Accessibility needs, a parking space, …', 'textarea', null, false, '{"rows": 3}'),
  (60, 'P68_LABEL_NAME', null, null, 'hidden', null, false, '{}'),
  (61, 'P68_LABEL_EMAIL', null, null, 'hidden', null, false, '{}'),
  (62, 'P68_LABEL_HOST', null, null, 'hidden', null, false, '{}'),
  (63, 'P68_LABEL_VISIT_DATE', null, null, 'hidden', null, false, '{}'),
  (64, 'P68_LABEL_NOTE', null, null, 'hidden', null, false, '{}')
  ) as i (seq, name, label, placeholder, type, lov, required, config)
 where a.alias = 'hr' and p.page_no = 68;

-- the labels from the administrator's table, every time the page is shown
insert into meta.computation (page_id, seq, item_name, point, type, expression)
select p.id, c.seq, 'P68_LABEL_' || c.field, 'before_header', 'sql_query',
       format('select label from hr.kiosk_label where field = %L', c.field)
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'NAME'), (20, 'EMAIL'), (30, 'HOST'), (40, 'VISIT_DATE'), (50, 'NOTE')
  ) as c (seq, field)
 where a.alias = 'hr' and p.page_no = 68;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'SIGN_IN', 'Sign in', 'submit', true
  from meta.page p join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = 'Welcome'
 where p.page_no = 68;

insert into meta.process (page_id, seq, name, type, point, code, when_button, success_message)
select p.id, 10, 'Store the visit', 'sql', 'submit',
       $c$insert into hr.visitor (name, email, host_empno, visit_date, note)
values (:P68_NAME, nullif(:P68_EMAIL, ''), nullif(:P68_HOST, '')::int, coalesce(nullif(:P68_VISIT_DATE, '')::date, current_date), nullif(:P68_NOTE, ''))$c$,
       'SIGN_IN', 'Thank you, &P68_NAME.: your host knows you are here.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 68;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 98, 'Visitor sign-in (kiosk)', 'user', 68 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Visitor sign-in', 'Bezoekersregistratie'),
  ('Visitor sign-in (kiosk)', 'Bezoekersregistratie (kiosk)'),
  ('Welcome', 'Welkom'),
  ('Sign in', 'Aanmelden'),
  ('First and last name', 'Voor- en achternaam'),
  ('- Choose your host -', '- Kies uw gastheer of gastvrouw -'),
  ('Today, or the day you come', 'Vandaag, of de dag dat u komt')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
